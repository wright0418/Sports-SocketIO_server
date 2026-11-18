# EduSports V2.0 — 運動遊戲開發 SDK 整合指南（AI / 前端開發用）

本文件專為**運動遊戲前端開發者與開發 AI** 撰寫，完整說明如何載入 `@edusports/sdk`（[EduSportsMultiplayer.ts](file:///mnt/Project/GameServre-socketIO/packages/sdk/src/EduSportsMultiplayer.ts)），並依實際實作完成以下流程：

1. **連上 Server 與註冊本地玩家**
2. **看見開放房間、建立房間與加入房間**
3. **讀取競賽資料（即時狀態、分數、倒數與賽果）**
4. **上傳競賽資料（跳繩遙測與關鍵遊戲事件）**

---

## 1. 引入 SDK 與初始化

### 1.1 載入方式
- **純 HTML `<script>`（推薦既有 HTML 跳繩遊戲使用）**
  Server 已於 `/sdk/edusports-sdk.global.js`（及 `/games-server/sdk/edusports-sdk.global.js`、`/sports-server/sdk/edusports-sdk.global.js`）提供編譯後的全域檔案：
  ```html
  <script src="https://ridgerealm.com/games-server/sdk/edusports-sdk.global.js"></script>
  <script>
    const { EduSportsMultiplayer, SdkError } = window.EduSports;
  </script>
  ```
- **ESM / TypeScript 專案**
  ```ts
  import { EduSportsMultiplayer, SdkError } from '@edusports/sdk';
  ```

### 1.2 建立實例
```js
const sdk = new EduSportsMultiplayer({
  serverUrl: 'https://ridgerealm.com/games-server', // 或本機 'http://127.0.0.1:3100'
  modeId: 'multiplayer',                            // 遊戲模式 ID（例如 'multiplayer'、'bomb-pass'）
  tickThrottleMs: 200,                              // emitPlayerTick 節流間隔（預設 200ms）
  heartbeatIntervalMs: 5000,                        // 對時心跳間隔（預設 5000ms）
  ackTimeoutMs: 5000,                               // Ack 等待逾時（預設 5000ms）
  autoReconnect: true,                              // 斷線自動重連（預設 true）
  offlineEventBufferEnabled: true,                  // 斷線暫存事件佇列（預設 true）
});
```
> SDK 會自動拆解 `serverUrl` 的 Origin 與子路徑（如 `/games-server`），自動對 `${serverOrigin}${basePath}/api/auth/session` 取得短效 JWT，並以 `{ path: "${basePath}/socket.io" }` 建立 Socket.IO 連線。

---

## 2. 連上 Server 與註冊本地玩家

### 2.1 連線至伺服器
```js
const conn = await sdk.connect();
// 回傳：{ clientInstanceId, maxLocalPlayers, serverNow }
```
`connect()` 會自動依序完成：
1. 呼叫 `POST /api/auth/session` 取得 JWT。
2. 建立 Socket.IO 連線並帶入 `handshake.auth.token`。
3. 發送 `client:register` 註冊此瀏覽器執行個體。
4. 發送 `client:heartbeat` 完成首次對時，並啟動定時心跳。

### 2.2 註冊本地玩家（單機支援 1～6 位）
```js
const player = await sdk.registerLocalPlayer({
  displayName: '小明',
  deviceId: 'Rope_0001', // 選填，對應 BLE 跳繩設備 ID
  teamId: null,          // 選填，隊伍 ID
});
// 回傳 PlayerState：{ playerId, clientInstanceId, displayName, deviceId, teamId, role, ready, connectionStatus }
```
- 同一瀏覽器（`clientInstanceId`）上限由伺服器 `MAX_LOCAL_PLAYERS_PER_CLIENT`（預設 `6`）控制；超過會拋出 `SdkError`（`code: 'LOCAL_PLAYER_LIMIT_EXCEEDED'`）。
- 其他玩家／設備管理方法：
  - `sdk.getLocalPlayers()`：取得目前已註冊的本地玩家陣列。
  - `await sdk.removeLocalPlayer(playerId)`：移除本地玩家並退出其所在房間。
  - `await sdk.updateDeviceStatus({ deviceId, connectionStatus: 'CONNECTED' | 'DISCONNECTED' | 'UNKNOWN', assignedPlayerId })`：回報單支 BLE 跳繩連線狀態（不影響同機其他玩家）。

---

## 3. 看見房間、建立房間與加入房間

### 3.1 看見目前已建立的房間（REST 初始載入 + `rooms:updated` 即時推播）
1. 連線後先以 `fetch` 呼叫 `GET ${serverUrl}/api/rooms` 取得目前所有未關閉房間（`PublicRoomSummary[]`）：
```js
async function fetchOpenRooms(serverUrl) {
  const res = await fetch(`${serverUrl}/api/rooms`);
  const data = await res.json();
  if (!res.ok || !data.ok) {
    throw new Error(data?.error?.message || `HTTP ${res.status}`);
  }
  return data.rooms; // PublicRoomSummary[]
}
```
2. 訂閱 `sdk.on('rooms:updated', ({ rooms }) => ...)`，當任何玩家建立、加入、離開、準備、重置房間或開賽／完賽時，Server 會即時主動推播最新房間列表，不需再定時輪詢。

每筆 `PublicRoomSummary` 結構包含：
- `roomId`、`roomCode`（6 碼大寫房號）、`gameModeId`、`status`（`WAITING | READY | STARTING | PLAYING | FINISHED | CLOSED`）
- `maxPlayers`、`players`、`teams`、`activeMatchId`、`config`、`ownerPlayerId`

### 3.2 建立房間與加入房間
- **建立房間**（會自動將已註冊的本地玩家加入該房，若未傳 `playerIds` 則帶入全部本地玩家）：
  ```js
  const room = await sdk.createRoom({
    gameModeId: 'multiplayer',
    maxPlayers: 12,                 // 選填
    config: { durationMs: 30000 },  // 選填，賽局時間（毫秒）
  });
  // room.roomCode 即為分享給其他人的 6 碼房號
  ```
- **加入房間**（可用 6 碼 `roomCode` 或 `roomId`）：
  ```js
  const { room, joinedPlayers } = await sdk.joinRoom('ABC123', {
    asSpectator: false, // 設為 true 可用觀賽者身分加入
  });
  ```
- **離開房間**：
  ```js
  await sdk.leaveRoom();
  ```

### 3.3 準備與開始比賽
```js
// 設定單一本地玩家準備狀態
await sdk.setReady(player.playerId, true);

// 或一次設定所有本地玩家準備
await sdk.setAllLocalPlayersReady(true);

// 房主發起開賽倒數（預設 countdownMs = 1500，範圍 0 ~ 15000）
const { matchId, room, countdownMs } = await sdk.requestMatchStart(2000);
```
> 只有房主（`ownerClientInstanceId`）可呼叫 `requestMatchStart()`，且房內所有 `PLAYER` 皆須為 `ready: true`（房間狀態為 `READY`）並符合模式最低人數。

### 3.4 同房續玩（不中斷 BLE 連線）
比賽結束（`FINISHED`）後，房主可呼叫 `resetRoom` 讓同房所有玩家留在房內重新準備下一場：
```js
await sdk.resetRoom({
  gameModeId: 'bomb-pass',       // 選填，可切換模式
  config: { durationMs: 45000 }, // 選填
});
```

---

## 4. 讀取競賽資料（接收即時狀態與查詢賽果）

### 4.1 訂閱 SDK 事件（`sdk.on(event, handler)`）
`sdk.on(...)` 會回傳取消訂閱函式 `() => void`。

| 事件名稱 | Payload 內容 | 觸發時機與用途 |
|---|---|---|
| `connected` | `{ clientInstanceId, maxLocalPlayers, players, rejoinedRoomIds, serverNow }` | 首次連線與註冊完成 |
| `disconnected` | `{ reason }` | Socket 斷線通知 |
| `reconnected` | `{ reg, restoredSnapshot, replayResults }` | 斷線重連並恢復快照後 |
| `clock:synced` | `{ offsetMs, rttMs }` | 每次心跳對時完成 |
| `rooms:updated` | `{ rooms: PublicRoomSummary[] }` | Lobby 開放房間列表即時變更 |
| `room:updated` | `RoomSnapshot` | 房間成員、準備狀態或房間狀態變更 |
| `player:joined` | `{ roomId, players }` | 有玩家加入房間 |
| `player:left` | `{ roomId, playerIds }` | 有玩家離開或逾時移除 |
| `player:disconnected` | `{ roomId, playerIds, gracePeriodMs }` | 玩家斷線進入 30 秒保留期 |
| `player:reconnected` | `{ roomId, playerIds }` | 玩家於保留期內重連 |
| `device:updated` | `DeviceState` | 房間內 BLE 裝置狀態變更 |
| `match:countdown` | `{ matchId, roomId, gameModeId, countdownMs, startAtServerTime, serverNow }` | 開賽倒數開始（請用 `sdk.getServerNow()` 對照 `startAtServerTime`） |
| `match:start` | `MatchSnapshot` | 比賽正式開始（含初始分數與模式狀態） |
| `game:state` | `MatchSnapshot` | 伺服器權威狀態更新（如炸彈轉移、玩家淘汰） |
| `score:broadcast` | `{ matchId, roomId, serverNow, stateVersion, scores, teams }` | 約 4Hz 節流分數與排行廣播 |
| `game:event` | `{ matchId, roomId, eventType, payload, serverTimestamp }` | 關鍵遊戲事件廣播（如 `bomb:passed`、`bomb:exploded`） |
| `match:finish` | `{ matchId, roomId, reason, serverNow }` | 比賽結束通知 |
| `match:result` | `MatchResult` | 最終名次、總分與勝負結果 |
| `server:error` | `{ code, message, details? }` | 伺服器非 Ack 錯誤通知 |

### 4.2 主動讀取快取與同步時間
- `sdk.getServerNow()`：取得校正過 `serverTimeOffsetMs` 的伺服器目前時間（毫秒），**所有倒數計時器務必使用此值與 `snapshot.endsAt` / `startAtServerTime` 計算剩餘時間**。
- `sdk.getCurrentRoom()`：取得最新 `RoomSnapshot`。
- `sdk.getLatestSnapshot()`：取得最新 `MatchSnapshot`（內含 `status`、`scores`、`teams`、`modeState`、`endsAt`）。
- `await sdk.requestGameState({ roomId?, matchId? })`：主動向伺服器請求最新 `MatchSnapshot`（重連或畫面重整恢復用）。
- `GET ${serverUrl}/api/matches/${matchId}`：賽後查詢歷史賽果（命中快取回傳 `{ ok: true, result }`，查詢資料庫回傳 `{ ok: true, record }`）。

---

## 5. 上傳競賽資料（發送遙測與遊戲事件）

SDK 提供兩個方法上傳遊戲資料，會**自動封裝 `EventEnvelope`**（包含 `protocolVersion`、UUID `eventId`、嚴格遞增的 per-player `sequence`、與 `clientInstanceId`）：

### 5.1 高頻遙測節流上傳：`sdk.emitPlayerTick(playerId, eventType, payload)`
- 預設以 `tickThrottleMs`（`200ms`）合併同一 `(playerId, eventType)` 的最新狀態後送出，避免 BLE 原始資料洗頻。
- 適合 `multiplayer` 模式上傳累計跳繩進度（`category: 'telemetry'`）：
  ```js
  sdk.emitPlayerTick(player.playerId, 'jump:tick', {
    totalJumps: 42, // 累計總跳數（非負整數）
    deltaJumps: 2,  // 選填，增量跳數（非負整數）
    rpm: 150,       // 0 ~ 600
    energy: 84,     // 選填，預設 0
  });
  ```

### 5.2 關鍵／即時事件上傳：`await sdk.emitGameEvent(playerId, eventType, payload, options?)`
- 回傳 `Promise<{ matchId, accepted, stateVersion }>`；若斷線且開啟 `offlineEventBufferEnabled`，會暫存於離線佇列待重連補送（是否接受補送由各模式 `offlineEventPolicy` 決定）。
- 適合關鍵動作（`category: 'critical'`，預設）或即時遊戲事件（`category: 'telemetry'`）：
  ```js
  // bomb-pass：回報跳繩（telemetry）
  await sdk.emitGameEvent(
    player.playerId,
    'bomb:jump',
    { deltaJumps: 1, rpm: 145 },
    { category: 'telemetry' },
  );

  // bomb-pass：跳滿門檻後傳遞炸彈（critical）
  await sdk.emitGameEvent(
    player.playerId,
    'bomb:pass',
    { targetPlayerId: undefined }, // targetPlayerId 選填，不傳則由 Server 依序傳給下一位存活玩家
    { category: 'critical' },
  );
  ```

### 5.3 現有遊戲模式與 Payload 規格一覽

| `modeId` | 事件 `eventType` | 建議發送方式 | Payload Schema（Zod 驗證） |
|---|---|---|---|
| `multiplayer` | `jump:tick` | `emitPlayerTick` | `{ totalJumps: int >= 0, deltaJumps?: int >= 0, rpm: 0..600, energy?: number >= 0 }` |
| `bomb-pass` | `bomb:jump` | `emitGameEvent(..., { category: 'telemetry' })` | `{ deltaJumps: int 1..100, rpm?: 0..600 }` |
| `bomb-pass` | `bomb:pass` | `emitGameEvent(..., { category: 'critical' })` | `{ targetPlayerId?: string }` |

---

## 6. 最小完整整合範例（Vanilla JS）

```js
const { EduSportsMultiplayer } = window.EduSports;

const sdk = new EduSportsMultiplayer({
  serverUrl: 'https://ridgerealm.com/games-server',
  modeId: 'multiplayer',
});

// 1. 訂閱賽局資料
sdk.on('room:updated', (room) => console.log('房間更新:', room));
sdk.on('match:countdown', (d) => console.log('倒數至:', d.startAtServerTime));
sdk.on('match:start', (snap) => console.log('開賽:', snap));
sdk.on('score:broadcast', (d) => console.log('即時分數:', d.scores));
sdk.on('game:state', (snap) => console.log('狀態更新:', snap.modeState));
sdk.on('match:result', (res) => console.log('最終結果:', res.participants));

// 2. 連線並註冊本地玩家
await sdk.connect();
const me = await sdk.registerLocalPlayer({ displayName: 'Player 1', deviceId: 'Rope_A1B2' });

// 3. 看見房間並加入（或自己建立）
const roomsRes = await fetch('https://ridgerealm.com/games-server/api/rooms').then((r) => r.json());
if (roomsRes.rooms.length > 0) {
  await sdk.joinRoom(roomsRes.rooms[0].roomCode);
} else {
  await sdk.createRoom({ gameModeId: 'multiplayer', config: { durationMs: 30000 } });
}

// 4. 準備與開始
await sdk.setReady(me.playerId, true);
// 若為房主且全員已準備：await sdk.requestMatchStart(2000);

// 5. 比賽進行中上傳跳繩資料（例如收到 BLE 通知時）
function onBleJump(totalJumps, deltaJumps, rpm) {
  if (sdk.getCurrentRoom()?.status !== 'PLAYING') return;
  sdk.emitPlayerTick(me.playerId, 'jump:tick', {
    totalJumps,
    deltaJumps,
    rpm,
    energy: totalJumps * 2,
  });
}
```

---

## 7. 錯誤處理建議

所有非同步控制方法失敗時皆會拋出 `SdkError`（含 `err.code` 與 `err.message`），常見錯誤碼如下：
- `LOCAL_PLAYER_LIMIT_EXCEEDED`：超過單機本地玩家上限（6 人）。
- `ROOM_NOT_FOUND` / `ROOM_FULL`：房號不存在或已滿。
- `PLAYERS_NOT_READY` / `INVALID_PLAYER_COUNT` / `UNAUTHORIZED`：未全體準備、人數不足或非房主呼叫開賽。
- `MATCH_NOT_PLAYING` / `SPECTATOR_CANNOT_EMIT`：非比賽中狀態或觀賽者試圖發送遊戲事件。
- `INVALID_GAME_ACTION` / `INVALID_PAYLOAD`：違反模式規則（例如跳繩速率超過限制、未跳滿炸彈傳遞門檻）。
- `DISCONNECTED` / `ACK_TIMEOUT`：尚未連線或伺服器回應逾時。
