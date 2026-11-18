# EduSports V2.0
# Phase 1：自營遊戲跨區域多人競賽平台
## Software Requirements Specification（SRS）V2.0.1

> **實作狀態與文件索引（以實際程式碼為準）**
> - **實作規劃與架構對照**：[docs/implementation-plan.md](./docs/implementation-plan.md)
> - **REST API 與 Socket.IO 協議規範**：[docs/protocol.md](./docs/protocol.md)
> - **Raspberry Pi 5 開發與容器部署指南**：[docs/deployment-pi5.md](./docs/deployment-pi5.md)
> - **個人網頁子路徑部署說明（`/games-server` & `/sports-server`）**：[docs/deployment-subpath.md](./docs/deployment-subpath.md)
> - **Code Review 與最佳化紀錄**：[docs/code-review-and-optimization.md](./docs/code-review-and-optimization.md)
> - **實作與初版 SRS 差異說明**：單一 `ClientInstance` 本地玩家上限已由初版 4 人擴充為 **6 人**（`MAX_LOCAL_PLAYERS_PER_CLIENT=6`）；賽局倒數階段房間狀態使用 `RoomState.STARTING`、賽局狀態使用 `MatchState.COUNTDOWN`；狀態與計分廣播整合於 `MatchManager` 與 `PersistenceService`。

**文件狀態：** 開發規格草案  
**開發階段：** Phase 1  
**平台定位：** AIoT Sports Education & Multiplayer Game Platform  
**核心原則：** 保留既有遊戲、統一通訊介面、中央競賽管理、預留第三方擴充能力。

---

# 1. 專案目標

## 1.1 專案背景

EduSports 目前已有多款獨立 HTML 跳繩互動遊戲，各遊戲具有自己的 JavaScript 程式與遊戲邏輯。

目前已完成的基礎能力包括：

- BLE 跳繩裝置連線。
- 一台電腦可同時建立最多四個 BLE GATT 連線。
- 單一 Game Engine 管理四位本地玩家。
- 遊戲端接收感測資料並進行即時計算。
- 多種獨立 HTML 遊戲模式。

目前遊戲主要以單機或本地環境執行，尚需建立跨電腦、跨網路的多人競賽能力。

## 1.2 Phase 1 開發目標

建立 EduSports 中央雲端競賽平台，使不同地點的玩家能透過網頁參與同一場遊戲。

同時建立統一的 Multiplayer SDK 與通訊協議，讓目前所有自營 HTML 遊戲都能透過相同介面連接雲端。

## 1.3 Phase 1 不包含

以下功能保留在未來階段：

- 第三方遊戲商註冊入口。
- 公開 SDK 開發者文件。
- 遊戲商城。
- 遊戲付費與授權管理。
- 金流與營收分潤。
- 第三方遊戲自動審核與上架。
- 完整商業會員管理系統。

但系統設計不得阻礙上述功能未來加入。

---

# 2. 系統架構

## 2.1 整體架構

系統分為四個主要層次。

### Layer 1：Game Client

目前每款遊戲維持獨立 HTML 與 JavaScript。

負責：

- 遊戲畫面與動畫。
- BLE GATT 裝置連線。
- 感測資料接收。
- 本地 Game Engine。
- 遊戲特有規則與互動。
- 本地即時計算。
- 呼叫 Multiplayer SDK 與雲端交換資料。

原則：不得因新增多人競賽功能而重寫既有 Game Engine。

### Layer 2：Multiplayer SDK

建立共用 JavaScript SDK。

負責：

- Socket.IO 連線。
- 身分與 Token 管理。
- 加入及離開房間。
- 玩家狀態管理。
- 比賽開始與結束通知。
- 遊戲事件傳輸。
- 遊戲狀態同步。
- 斷線重連。
- 錯誤處理。

每款遊戲只需載入共用 SDK，不必各自重新實作網路通訊。

### Layer 3：Competition Server

使用 Node.js 建立中央競賽伺服器。

建議技術：

- Node.js LTS
- Socket.IO
- REST API
- PostgreSQL（正式資料庫）
- Redis（未來多實例部署時使用，Phase 1 可暫不導入）

負責：

- Player Manager
- Room Manager
- Match Manager
- Game Mode Manager
- Game Event Manager
- Game State Manager
- Team Manager
- Score Manager
- Match History Manager

### Layer 4：Database

負責保存：

- 玩家資料。
- 遊戲模式資料。
- 房間資料。
- 比賽資料。
- 玩家參賽紀錄。
- 團隊資料。
- 比賽結果。
- 必要的遊戲事件與狀態快照。

---

# 3. 遊戲模式管理

## 3.1 Game Mode Registry

所有自營遊戲必須具有唯一的 Game Mode ID。

例如：

| Game Mode ID | 遊戲名稱 | 模式類型 |
|---|---|---|
| duel | 雙人大亂鬥 | 對戰 |
| multiplayer | 多人對戰 | 排名 |
| island-relay | 環島接力賽 | 團隊接力 |
| rhythm-master | 節奏大師 | 節奏 |
| neon-war | 霓虹戰線 | 團隊對戰 |
| bomb-pass | 定時傳炸彈 | 限時傳遞 |
| territory-war | 領地爭奪戰 | 領地競賽 |
| star-shield | 星盾防衛戰 | 團隊合作／對戰 |
| rhythm-heart | 節奏心跳 | 協作 |
| deep-sea | 深海潛艇 | 任務合作 |

以上清單應以現有遊戲實際名稱與程式為準，開發前進行盤點，不得自行假設所有模式都已具備多人網路能力。

## 3.2 Game Mode Metadata

每種遊戲應具有以下資訊：

- modeId
- name
- version
- minPlayers
- maxPlayers
- teamMode
- requiredDevices
- supportedFeatures
- scoringType
- defaultConfig
- clientEntry
- serverRuleModule

## 3.3 Game Mode Server Module

不同遊戲規則不同，必須採用模組化設計。

建議統一生命週期介面：

- initialize()
- playerJoined()
- playerLeft()
- playerReady()
- start()
- handleEvent()
- getState()
- finish()
- recover()

不要求所有遊戲都使用相同的內部演算法，但必須符合共用介面。

遊戲規則可分為：

1. Client-side Logic：動畫、感測、輸入、即時呈現。
2. Server-side Logic：共享狀態、重要事件驗證、勝負判定及必要的遊戲規則。

不得將所有遊戲運算都搬到雲端。

---

# 4. BLE Device Management

## 4.1 BLE 連線架構

保留現有 BLE GATT 連線機制。

一台 Client 可以管理 1～4 支跳繩。

每支跳繩對應一位本地玩家，但系統不得假設一個 Client 永遠只代表一位玩家。

## 4.2 裝置識別

現有裝置名稱：

Rope_abcd

abcd 為 MAC Address 後四碼。

系統可使用此名稱協助本地辨識設備，但不可將其視為安全認證資訊。

## 4.3 Device State

每個裝置應能識別：

- deviceId
- deviceType
- connectionStatus
- assignedPlayerId
- localClientId
- lastDataTimestamp

## 4.4 BLE 與雲端分工

BLE 感測資料應優先在本地處理。

雲端只接收遊戲所需的資料，例如：

- Jump Count
- RPM
- Energy
- Device Status
- Game Events

不應無條件將所有 BLE 原始感測資料傳送至雲端。

---

# 5. Client Instance 與 Player Management

## 5.1 Client Instance

每個瀏覽器遊戲執行個體應具有唯一的 clientInstanceId。

Client Instance 可以代表一個本地遊戲工作站。

## 5.2 Player

每位參賽者必須具有獨立的 playerId。

Player 與 Client Instance 為不同概念。

資料關係：

- 一個 Client Instance 可以管理多位 Player。
- 一位 Player 在同一場比賽中只能有一個有效參賽身分。
- 一位 Player 可以關聯一支或多支經遊戲規則允許的設備。
- 一個 Client Instance 可以同時管理最多四位本地玩家，Phase 1 以現有能力為基礎。

## 5.3 玩家匿名名稱

玩家可自行設定顯示名稱。

預設名稱可以使用跳繩設備編號或系統產生的匿名名稱。

顯示名稱不可直接作為唯一身分識別。

---

# 6. Room Management

## 6.1 房間功能

系統應提供：

- 建立房間。
- 取得房間資訊。
- 加入房間。
- 離開房間。
- 玩家列表。
- 房間人數。
- 遊戲模式選擇。
- 房間狀態。
- 房間關閉。

## 6.2 Room State

建議狀態：

- WAITING
- READY
- STARTING
- PLAYING
- FINISHED
- CLOSED

## 6.3 房間規則

- 房間必須指定 Game Mode。
- 房間必須有玩家人數限制。
- 遊戲模式決定玩家與團隊限制。
- 滿員後，新加入者可以被設定為觀賽者。
- 觀賽者不得傳送參賽者專屬遊戲事件。
- 房間建立者可以管理房間設定。
- 房間狀態由 Server 維護。

---

# 7. Match Management

## 7.1 比賽生命週期

比賽必須有明確的生命週期：

1. 建立比賽。
2. 玩家加入。
3. 玩家準備。
4. Server 確認參賽條件。
5. 倒數。
6. 比賽開始。
7. 遊戲進行。
8. 比賽結束。
9. 結果計算。
10. 結果保存與廣播。

## 7.2 Server Authority

Server 是比賽共享狀態的權威來源。

Client 可以執行本地遊戲運算，但不得直接修改其他玩家的分數或比賽狀態。

重要規則應由 Server 驗證。

## 7.3 比賽時間

比賽開始與結束時間由 Server 決定。

Client 使用 Server 提供的時間資訊進行畫面同步。

不得以 Client 本機時間作為正式比賽開始或結束的唯一依據。

---

# 8. Multiplayer SDK

## 8.1 SDK 目標

所有自營遊戲使用相同 SDK。

SDK 必須與遊戲核心分離，不應直接依賴某一款遊戲的內部程式。

## 8.2 初始化

概念性 API：

```javascript
const game = new EduSportsMultiplayer({
    modeId: "territory-war",
    version: "1.0"
});
```

## 8.3 基本 API

建議提供：

```javascript
await game.connect();

await game.joinRoom(roomId);

await game.leaveRoom();

await game.setReady();

await game.emitGameEvent(event);

game.on("match:start", callback);

game.on("match:finish", callback);

game.on("game:state", callback);

game.on("score:update", callback);

game.disconnect();
```

以上為介面示意，實際 API 命名與參數需在 SDK 設計文件中定義。

## 8.4 SDK 主要責任

- 建立連線。
- 維護連線狀態。
- Token 管理。
- 發送事件。
- 接收事件。
- 自動重連。
- 同步狀態快照。
- 事件序號管理。
- 錯誤回報。
- SDK 版本識別。

SDK 不負責：

- BLE GATT 連線。
- 遊戲動畫。
- 遊戲畫面。
- 特定遊戲的完整規則。

---

# 9. Socket.IO 通訊協議

## 9.1 Client → Server Events

| Event | 用途 |
|---|---|
| client:register | 註冊 Client Instance |
| player:join | 玩家加入 |
| player:leave | 玩家離開 |
| player:ready | 玩家準備 |
| device:status | 裝置狀態 |
| room:create | 建立房間 |
| room:join | 加入房間 |
| room:leave | 離開房間 |
| match:request_start | 請求開始比賽 |
| game:event | 傳送遊戲事件 |
| game:state_request | 要求最新狀態 |
| client:heartbeat | 連線狀態維護 |

## 9.2 Server → Client Events

| Event | 用途 |
|---|---|
| client:registered | Client 註冊成功 |
| room:updated | 房間資訊更新 |
| player:joined | 玩家加入通知 |
| player:left | 玩家離開通知 |
| match:countdown | 比賽倒數 |
| match:start | 比賽開始 |
| game:event | 遊戲事件廣播 |
| game:state | 共享遊戲狀態 |
| score:broadcast | 分數同步 |
| match:finish | 比賽結束 |
| match:result | 比賽結果 |
| server:error | 錯誤訊息 |

實際事件清單可依遊戲需求擴充，但必須維持命名及版本管理規則。

## 9.3 Event Envelope

所有遊戲事件應使用統一外層結構：

```json
{
  "protocolVersion": "1.0",
  "eventId": "uuid",
  "eventType": "territory:capture",
  "matchId": "match-001",
  "roomId": "room-001",
  "playerId": "player-001",
  "clientInstanceId": "client-001",
  "sequence": 123,
  "clientTimestamp": 1794970000000,
  "payload": {
    "tileId": 5
  }
}
```

Server 必須驗證：

- Token 與參賽者身分。
- Match ID 與 Room ID。
- 玩家是否有權發送該事件。
- 比賽是否正在進行。
- Sequence 是否符合規則。
- Event ID 是否重複。
- Payload 是否符合該遊戲的 Schema。

Client Timestamp 僅供參考，不得直接作為可信任的比賽時間依據。

---

# 10. Game State Synchronization

## 10.1 同步原則

系統採用：

Event Stream + State Snapshot。

Event Stream：記錄遊戲事件。

State Snapshot：保存某個時間點的完整共享狀態。

## 10.2 狀態同步

新加入或重新連線的 Client，應能取得最新的比賽狀態。

不得要求 Client 從比賽開始重新接收所有事件才能恢復。

## 10.3 同步頻率

不同遊戲可以使用不同同步頻率。

建議原則：

- 一般分數：每秒約 2～5 次。
- RPM：依遊戲需求進行節流或彙整。
- 重要遊戲事件：事件發生時即時傳送。
- 大型狀態：採增量更新或定期快照。

實際頻率需依測試結果調整。

---

# 11. Game Mode Rules

每種遊戲必須有自己的 Server Rule Module。

例如：

### 11.1 一般多人對戰

Server 管理：

- 玩家跳繩數量。
- 玩家分數。
- 比賽時間。
- 排名。
- 結果。

### 11.2 定時傳炸彈

Server 管理：

- 炸彈持有者。
- 傳遞事件。
- 持有者變更。
- 倒數時間。
- 結束時結果判定。

### 11.3 領地爭奪戰

Server 管理：

- 玩家能量。
- 領地狀態。
- 佔領事件。
- 領地數量。
- 最終勝負。

### 11.4 節奏心跳

Server 管理：

- 玩家 RPM。
- 協作狀態。
- RPM 彙整資料。
- 合體條件。
- 協作結果。

### 11.5 深海潛艇

Server 管理：

- 團隊任務狀態。
- 玩家角色。
- 任務進度。
- 團隊共享資源。
- 成功與失敗條件。

### 11.6 接力類遊戲

Server 管理：

- 隊伍。
- 玩家順序。
- 交棒事件。
- 團隊進度。
- 比賽結果。

上述規則是架構示例。正式開發前，必須依現有遊戲程式逐款盤點並定義實際事件及狀態。

---

# 12. Team Management

支援：

- 個人競賽。
- 雙人組隊。
- 多人團隊。
- 1 對 1。
- 2 對 2。
- 3 對 3。
- 合作模式。

實際人數與隊伍限制由 Game Mode 設定。

Team Manager 負責：

- 建立隊伍。
- 玩家分隊。
- 隊伍狀態。
- 隊伍分數。
- 隊伍結果。

不應將固定隊伍人數寫死在共用 Server 程式中。

---

# 13. Database Design

建議採用 PostgreSQL。

主要資料表：

### 13.1 users

- id
- display_name
- created_at
- status

### 13.2 game_modes

- id
- mode_id
- name
- version
- min_players
- max_players
- configuration
- status

### 13.3 client_instances

- id
- client_instance_id
- last_seen_at
- status

### 13.4 devices

- id
- device_id
- device_type
- device_status

### 13.5 rooms

- id
- room_code
- game_mode_id
- owner_id
- status
- max_players
- created_at

### 13.6 room_players

- id
- room_id
- player_id
- client_instance_id
- role
- team_id
- status

### 13.7 matches

- id
- room_id
- game_mode_id
- status
- started_at
- ended_at
- result

### 13.8 match_participants

- id
- match_id
- player_id
- team_id
- final_score
- result

### 13.9 game_events

- id
- match_id
- player_id
- event_id
- sequence
- event_type
- payload
- server_timestamp

### 13.10 game_states

- id
- match_id
- state_version
- state_data
- created_at

資料庫應保留必要索引、唯一性約束及外鍵。

不得只依賴 Client 傳送的結果建立正式比賽紀錄。

---

# 14. Security Requirements

## 14.1 通訊安全

- 正式環境使用 HTTPS / WSS。
- Token 必須具備期限。
- Token 必須限制用途與權限。
- 不可將永久伺服器 API Secret 放在 HTML 或 JavaScript。
- Server 必須驗證玩家與房間的關係。

## 14.2 遊戲事件安全

- 不接受未授權玩家的事件。
- 不接受比賽結束後的遊戲事件。
- 避免重複事件造成重複計分。
- 驗證事件順序。
- 驗證事件資料格式。
- 重要勝負條件由 Server 判斷。

## 14.3 BLE 安全

Rope_abcd 不可作為唯一設備身分認證。

未來若韌體支援，應增加可靠的 Device ID 與裝置認證機制。

---

# 15. Network Recovery

## 15.1 斷線處理

當 Client 斷線：

- Server 更新連線狀態。
- 保留合理的重新連線期限。
- 不立即刪除玩家的比賽紀錄。
- 其他玩家收到必要的斷線通知。

## 15.2 重新連線

Client 重新連線後：

1. 重新驗證 Token。
2. 恢復 Client Instance。
3. 確認原 Room 與 Match。
4. 取得最新 State Snapshot。
5. 必要時補送可驗證的事件。
6. 恢復遊戲畫面。

## 15.3 重要限制

斷線期間本地仍可繼續接收 BLE 資料，但是否允許補送斷線期間的遊戲事件，必須依遊戲公平性與驗證能力決定。

不可一律相信 Client 補送的結果。

---

# 16. Deployment Architecture

## 16.1 開發環境

初期使用 Raspberry Pi 5 作為中央開發伺服器。

提供：

- Node.js
- Socket.IO
- REST API
- PostgreSQL
- HTTPS / WSS
- Log Management

## 16.2 正式環境

未來移至雲端。

架構應避免將遊戲核心與特定 Raspberry Pi 硬體綁定。

建議：

- Server 使用可部署的 Node.js 服務。
- Database 獨立部署。
- 靜態 HTML 可由網站或 CDN 提供。
- Socket.IO Server 獨立管理。
- 預留 Redis Adapter 與多實例擴充能力。

---

# 17. Performance Requirements

Phase 1 初步驗收目標：

| 項目 | 目標 |
|---|---|
| 單一房間玩家數 | 至少 10 人 |
| 本地 Client 玩家數 | 最多 4 人 |
| 同時進行房間 | 至少 5 個測試房間 |
| 一般分數同步 | 2～5 次／秒 |
| 重要事件 | 即時傳送 |
| 重連 | 可恢復比賽狀態 |
| 遊戲模式 | 支援多種獨立模式 |

以上是初步工程目標，不代表尚未測試的效能保證。

必須透過實際測試驗證。

---

# 18. Development Phases

## Phase 0：Existing System Analysis

只讀分析，不修改程式。

Agent 必須完成：

- 現有遊戲清單。
- HTML / JavaScript 架構。
- BLE GATT 連線架構。
- Game Engine 分析。
- 多玩家資料流。
- 各遊戲計分方式。
- 遊戲狀態及事件分析。
- 既有遊戲之間的共通點。

交付：

- docs/system-architecture.md
- docs/game-inventory.md
- docs/game-engine-analysis.md
- docs/data-flow.md
- docs/game-mode-analysis.md
- docs/multiplayer-extension-plan.md
- docs/risks-and-unknowns.md

## Phase 1：Multiplayer SDK

建立：

- Socket.IO Client。
- Multiplayer SDK。
- 共用事件格式。
- Token 驗證介面。
- 房間與玩家介面。
- 重連機制。

先使用測試遊戲驗證，不修改全部正式遊戲。

## Phase 2：Competition Server

建立：

- Room Manager。
- Player Manager。
- Match Manager。
- Game Mode Manager。
- Game Event Manager。
- Game State Manager。
- Score Manager。

完成資料庫設計與 REST API。

## Phase 3：Game Integration

挑選一款規則較簡單的既有遊戲，完成多人競賽整合。

確認 SDK 與原有 Game Engine 不衝突。

通過測試後，再逐款整合其他遊戲。

## Phase 4：Multi-Game Testing

測試不同遊戲模式：

- 個人排名。
- 多人對戰。
- 團隊合作。
- 接力。
- 共享狀態遊戲。
- 即時事件遊戲。

## Phase 5：Cloud Deployment

完成：

- 雲端部署。
- HTTPS / WSS。
- Database 備份。
- Log。
- 斷線恢復。
- 跨網路測試。

---

# 19. Testing Requirements

## 19.1 BLE 測試

- 一支跳繩。
- 四支跳繩。
- 裝置斷線。
- 裝置重新連線。
- 多玩家獨立計數。

## 19.2 Multiplayer 測試

- 兩台不同電腦加入同一房間。
- 不同網路加入同一房間。
- 多人同時準備。
- Server 統一開始。
- 比分同步。
- 玩家離開。
- Client 斷線與恢復。

## 19.3 Game Mode 測試

每款遊戲必須測試：

- 初始化。
- 玩家加入。
- 比賽開始。
- 遊戲事件。
- 狀態同步。
- 比賽結束。
- 勝負判定。
- 結果保存。

## 19.4 Security Testing

- 未授權加入房間。
- 偽造 Player ID。
- 重複事件。
- 非參賽者發送事件。
- 非法比分。
- 比賽結束後傳送事件。
- Token 過期。

## 19.5 Acceptance Criteria

Phase 1 完成條件：

1. 不破壞原有單機遊戲。
2. 原有 BLE GATT 功能正常。
3. 一台電腦可以管理四位本地玩家。
4. 不同網路的 Client 可以加入同一房間。
5. Server 能統一控制比賽開始與結束。
6. 分數與遊戲狀態可以同步。
7. 至少一款遊戲完成完整多人整合。
8. 斷線後可以恢復必要的比賽狀態。
9. 不同遊戲可透過共用 SDK 連線。
10. Server 可以依 Game Mode 使用不同規則模組。
11. 比賽結果可以正確保存。
12. 原有遊戲不需要因多人通訊而重寫 Game Engine。

---

# 20. Future Compatibility：第三方開放平台預留

Phase 1 不實作完整第三方開發者平台，但必須保留以下設計：

- 每款遊戲具有獨立 Game ID。
- 遊戲具有獨立版本。
- SDK 與 Game Mode Protocol 有版本管理。
- 遊戲網址與伺服器規則模組分離。
- 遊戲商身分可獨立管理。
- Game Mode Metadata 可擴充。
- 遊戲規則模組可獨立載入。
- API 權限可以依開發者與遊戲區分。
- 遊戲事件必須經過 Schema 驗證。

未來第三方遊戲可以部署在自己的網站，例如：

https://game-company.com/rope-game/

再透過 EduSports SDK 連接中央競賽平台。

EduSports 不需要託管第三方 HTML，也不應讓第三方直接存取中央資料庫。

---

# 21. AI Agent Development Rules

本專案將使用 AI Agent 協助開發。

必須遵守以下規則：

1. Phase 0 只能分析，不可修改現有程式。
2. 必須先理解原有 Game Engine。
3. 不可擅自重寫 BLE GATT 模組。
4. 不可將多人網路功能直接混入 Game Engine。
5. Multiplayer SDK 必須獨立。
6. Server 與 Game Client 必須分離。
7. 每次修改前先提出檔案清單及修改計畫。
8. 每次修改後必須執行測試。
9. 不可一次修改所有遊戲。
10. 第一款遊戲通過驗收後，才開始其他遊戲整合。
11. 必須保留 Git 版本及可回復能力。
12. 未經確認，不可更改既有遊戲規則。

每個開發階段都必須提供：

- 修改檔案清單。
- 架構說明。
- API 說明。
- 測試紀錄。
- 已知問題。
- 下一階段建議。

---

# 22. Phase 1 最終交付成果

最終必須交付：

1. EduSports Multiplayer SDK。
2. EduSports Competition Server。
3. Game Mode Registry。
4. Room Manager。
5. Match Manager。
6. Player Manager。
7. Game Event Manager。
8. Game State Manager。
9. Score Manager。
10. PostgreSQL Schema。
11. REST API 文件。
12. Socket.IO Protocol 文件。
13. Game Mode Integration Guide。
14. 測試案例與測試報告。
15. Raspberry Pi 5 開發部署文件。
16. 雲端部署文件。

---

# 23. 最終架構原則

EduSports V2.0 Phase 1 必須遵循以下設計原則：

**一、遊戲獨立**

每個 HTML 遊戲可以獨立開發、維護與更新。

**二、通訊統一**

所有遊戲透過共用 Multiplayer SDK 與中央雲端溝通。

**三、競賽集中管理**

房間、玩家、比賽、重要事件、共享狀態及結果由中央 Server 管理。

**四、遊戲規則模組化**

不同遊戲可以有不同規則，不可將所有遊戲邏輯寫死在同一個 Game Engine。

**五、硬體與遊戲分離**

BLE 裝置資料由本地遊戲端處理，網路只同步必要的遊戲資料。

**六、預留商業擴充**

未來可以增加第三方遊戲商、SDK 授權、遊戲上架、會員、計費與分潤。

**七、先驗證，再擴大**

先完成一款遊戲的跨區域多人競賽，再逐步整合其他遊戲。

---

**本文件為 Phase 1 開發依據。實際開發前，必須先執行 Phase 0，依現有原始碼確認資料流、遊戲規則與模組邊界，不可只依本文件推測既有程式的實作方式。**
