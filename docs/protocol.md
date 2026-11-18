# EduSports V2.0 — REST & Socket.IO 通訊協議文件 (Protocol v1.0)

本文件依據實際實作之 `@edusports/shared`、`@edusports/server` 與 `@edusports/sdk` 撰寫。

---

## 1. 認證流程與 REST API

前端 HTML/JS 不存放任何永久 API Secret，須透過 REST API 取得短效 JWT，再於 Socket.IO Handshake 攜帶該 Token。

### 1.1 `GET /health`
健康檢查端點。
- **Response (`200 OK`)**:
  ```json
  {
    "ok": true,
    "status": "healthy",
    "serverNow": 1794970000000,
    "maxLocalPlayersPerClient": 6
  }
  ```

### 1.2 `POST /api/auth/session`
核發或續期 `clientInstanceId` 專用短效 JWT。
- **Request Body**:
  ```json
  {
    "clientInstanceId": "client-xxxx",
    "modeId": "multiplayer"
  }
  ```
  （兩欄位皆選填；未傳入 `clientInstanceId` 時由 Server 自動產生）
- **Response (`200 OK`)**:
  ```json
  {
    "ok": true,
    "clientInstanceId": "client-a1b2c3d4e5f6",
    "token": "<JWT>",
    "expiresAt": 1794977200000,
    "maxLocalPlayers": 6,
    "serverNow": 1794970000000
  }
  ```

### 1.3 `GET /api/modes`
取得已註冊之遊戲模式 Metadata 列表（含版本、人數上下限、離線補送政策與第三方擴充欄位）。

### 1.4 `GET /api/rooms` 與 `GET /api/rooms/:codeOrId`
查詢目前未關閉的房間列表，或依 `roomId` / 6 碼 `roomCode` 取得單一房間快照。

### 1.5 `GET /api/matches/:matchId`
查詢已結束比賽之結果與參與者紀錄（優先讀取記憶體快取，否則查詢 PostgreSQL `matches`、`match_participants` 與最新 `game_states`）。

---

## 2. Socket.IO 連線與標準 Ack 回應規範

### 2.1 連線驗證
建立 Socket.IO 連線時，須於 `handshake.auth.token` 傳入 `POST /api/auth/session` 取得之 JWT：
```javascript
const socket = io(serverUrl, { auth: { token } });
```
驗證失敗會拒絕握手並回傳 `<ErrorCode>: <message>`（例如 `TOKEN_EXPIRED`、`UNAUTHORIZED`）。

### 2.2 標準 Ack 回應格式 (`AckResponse<T>`)
所有 Client → Server 控制事件皆支援 Socket.IO Acknowledgement Callback：
- 成功：`{ "ok": true, "data": { ... } }`
- 失敗：`{ "ok": false, "error": { "code": "<ErrorCode>", "message": "...", "details": ... } }`

---

## 3. Client → Server Events

| Event | Payload 結構 | 說明 |
|---|---|---|
| `client:register` | `{ clientInstanceId, sdkVersion?, modeId? }` | 註冊/恢復 Client Instance，並於斷線重連時自動重新加入原房間 Socket Room |
| `client:heartbeat` | `{ t0 }` | 回傳 `{ t0, serverNow }` 供 SDK 計算 RTT 與 `serverTimeOffset` |
| `player:join` | `{ playerId?, displayName, deviceId?, teamId? }` | 在同一 Client 下註冊本地玩家（上限受 `MAX_LOCAL_PLAYERS_PER_CLIENT=6` 限制） |
| `player:leave` | `{ playerId }` | 移除本地玩家並離開所在房間 |
| `player:ready` | `{ playerId, ready }` | 設定單一本地玩家準備狀態 |
| `device:status` | `{ deviceId, deviceType?, connectionStatus, assignedPlayerId?, lastDataTimestamp? }` | 回報單支 BLE 跳繩設備連線狀態（斷線隔離，不影響同機其他玩家） |
| `room:create` | `{ gameModeId, maxPlayers?, config?, playerIds? }` | 建立房間，自動以註冊之本地玩家加入 |
| `room:join` | `{ roomCodeOrId, asSpectator?, playerIds? }` | 加入房間（滿員、開賽中或指定 `asSpectator` 時賦予 `SPECTATOR` 角色） |
| `room:leave` | `{ roomId? }` | 離開房間 |
| `room:reset` | `{ roomId, gameModeId?, config? }` | 房主專用：將 `FINISHED` 房間重置為 `WAITING` 以續玩下一局（保留 Web Bluetooth 連線） |
| `match:request_start` | `{ roomId, countdownMs? }` | 房主專用：檢查最低人數與全體準備狀態後啟動開賽倒數 |
| `game:event` | `EventEnvelope` | 傳送遊戲事件（詳見第 5 節） |
| `game:state_request` | `{ roomId?, matchId? }` | 主動要求最新 `MatchSnapshot`（重連恢復用） |

---

## 4. Server → Client Events

| Event | 說明 |
|---|---|
| `client:registered` | Client 註冊成功，包含 `maxLocalPlayers`、目前本地玩家與重連房間清單 |
| `room:updated` | 房間快照更新（`RoomSnapshot`） |
| `player:joined` | 玩家加入房間通知 |
| `player:left` | 玩家永久離開或超過 30 秒斷線保留期被移除通知 |
| `player:disconnected` | 玩家網路斷線通知（進入保留期） |
| `player:reconnected` | 玩家於保留期內重連成功通知 |
| `device:updated` | BLE 設備狀態變更通知 |
| `match:countdown` | 比賽倒數通知（含 `startAtServerTime` 與 `serverNow`） |
| `match:start` | 比賽正式開始（含初始 `MatchSnapshot`） |
| `game:state` | 權威共享狀態快照（`MatchSnapshot`） |
| `score:broadcast` | 節流分數與排行廣播（約 4Hz） |
| `game:event` | 關鍵遊戲事件廣播（如 `bomb:passed`、`bomb:exploded`） |
| `match:finish` | 比賽結束通知 |
| `match:result` | 最終名次與勝負結果（`MatchResult`） |
| `server:error` | 未攜帶 Ack 時的錯誤通知 |

---

## 5. Event Envelope 與 8 步驟驗證管線

```json
{
  "protocolVersion": "1.0",
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "eventType": "jump:tick",
  "category": "telemetry",
  "matchId": "match-12345678",
  "roomId": "room-12345678",
  "playerId": "player-12345678",
  "clientInstanceId": "client-12345678",
  "sequence": 1,
  "clientTimestamp": 1794970000000,
  "isOfflineReplay": false,
  "payload": {
    "totalJumps": 12,
    "deltaJumps": 2,
    "rpm": 140,
    "energy": 24
  }
}
```

### Server 驗證順序
1. `EventEnvelopeSchema` 格式與欄位驗證（`INVALID_PAYLOAD`）。
2. `envelope.clientInstanceId` 必須與 JWT 認證連線一致（`UNAUTHORIZED`）。
3. `envelope.playerId` 必須歸屬於該 `clientInstanceId`（`PLAYER_NOT_FOUND` / `PLAYER_NOT_OWNED`）。
4. 比賽存在且狀態為 `PLAYING`（`MATCH_NOT_FOUND` / `MATCH_NOT_PLAYING`）。
5. 發送者角色必須為 `PLAYER`，不得為 `SPECTATOR`（`SPECTATOR_CANNOT_EMIT`）。
6. `eventId` 冪等去重（`DUPLICATE_EVENT`）。
7. 依 `(matchId, playerId)` 維度檢查 `sequence` 必須嚴格單調遞增（`INVALID_SEQUENCE`）。
8. 依模式 `offlineEventPolicy` 檢查 `isOfflineReplay`（`OFFLINE_REPLAY_REJECTED`），再交由模式 Module 執行 Zod Payload 與遊戲規則驗證（如跳繩速率上限、`INVALID_GAME_ACTION`）。
