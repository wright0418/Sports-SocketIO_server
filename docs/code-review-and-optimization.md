# EduSports V2.0 — Code Review 與最佳化紀錄

本文件整理針對 `@edusports/server`、`@edusports/sdk` 與 `packages/test-client` 進行程式碼檢視（Code Review）後所發現的問題、已完成之最佳化項目，以及後續建議追蹤事項。

---

## 1. 已完成之最佳化項目

### 1.1 Server 端穩定性與記憶體管理

1. **Tick Loop 防重入保護與未捕捉 Promise 處理**（[MatchManager.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/managers/MatchManager.ts)）
   - 在 `processTicks()` 加入 `isTicking` 旗標，避免高負載或資料庫寫入延遲時，100ms `setInterval` 觸發重疊的 `tick` 執行。
   - 為倒數計時器內呼叫的 `beginPlaying(matchId)` 補上 `.catch()` 錯誤紀錄，避免發生 Unhandled Promise Rejection。
   - 為 `finishedResults` 記憶體快取加上容量上限（`MAX_FINISHED_RESULTS_CACHE = 200`），超過時淘汰最舊紀錄，防止長時間運行造成記憶體持續增長（完整賽果仍會寫入 PostgreSQL）。

2. **已關閉房間之記憶體清理**（[RoomManager.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/managers/RoomManager.ts)）
   - 當房間最後一位玩家離開使狀態轉為 `CLOSED` 時，同步從 `this.rooms` 與 `this.roomCodeToId` 移除索引，避免空房物件累積於記憶體。

3. **週期性事件寫入錯誤捕捉**（[persistence.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/db/persistence.ts)）
   - 在 `start()` 的週期性 `flushEvents()` 呼叫加上 `.catch()` 錯誤處理，確保暫時性資料庫連線異常不會導致未捕捉異常中斷行程。

4. **玩家離開時同步退出 Socket.IO Room**（[gateway.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/socket/gateway.ts)）
   - 處理 `player:leave` 事件時，若該 `clientInstanceId` 在該房間已無任何本地玩家，立即呼叫 `socket.leave(roomId)`，避免後續仍收到該房間的廣播。

---

### 1.2 測試遊戲台（`packages/test-client`）安全性、效能與程式碼整潔度

1. **XSS 防護**（[app.js](file:///mnt/Project/GameServre-socketIO/packages/test-client/app.js)）
   - 新增 `escapeHtml()` 工具函式，對所有動態插入 `innerHTML` 的字串（包含玩家 `displayName`、`deviceId`、`playerId`、`roomCode`、`gameModeId`、`status`、`role`、`outcome`）進行 HTML 跳脫處理。

2. **計時器與狀態清理**（[app.js](file:///mnt/Project/GameServre-socketIO/packages/test-client/app.js)）
   - 斷線時（`setConnStatus(false)`）同步清除 `uiTicker` 與 `roomListTimer`。
   - 離開房間與 `room:reset` 時重設 `countdownEndServerTime = null`。
   - 限制事件日誌（`eventLog`）最多保留 200 筆（`MAX_LOG_ENTRIES = 200`），避免長時間測試造成 DOM 膨脹。

3. **消除重複邏輯與減少不必要輪詢**（[app.js](file:///mnt/Project/GameServre-socketIO/packages/test-client/app.js)）
   - 抽出共用函式 `getReadyButtonState()`，統一單一玩家「準備」按鈕與「全部本地玩家準備」按鈕的狀態與文案計算。
   - 抽出共用函式 `joinRoomByCode()`，統一房間列表「加入」按鈕與手動輸入房號「加入房間」的流程。
   - 房間處於 `STARTING`（或 `COUNTDOWN`）與 `PLAYING` 狀態時暫停 `/api/rooms` 3 秒輪詢，減少賽局進行中的無效 HTTP 請求。

---

## 2. 第二階段伺服器全面補強項目（已完成）

1. **公開房間列表遮罩 `clientInstanceId` 與環境密鑰檢查**（[routes.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/http/routes.ts)、[RoomManager.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/managers/RoomManager.ts)、[config/index.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/config/index.ts)）
   - 新增 `PublicRoomSummary`（`listPublicRooms()`），對外列表不回傳 `ownerClientInstanceId` 與玩家 `clientInstanceId`。
   - `NODE_ENV=production` 時若未提供 `JWT_SECRET` 直接拒絕啟動，若仍使用預設開發密鑰則輸出警告。
2. **Lobby 即時房間列表推播（`rooms:updated`）**（[gateway.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/socket/gateway.ts)、[MatchManager.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/managers/MatchManager.ts)、[EduSportsMultiplayer.ts](file:///mnt/Project/GameServre-socketIO/packages/sdk/src/EduSportsMultiplayer.ts)、[app.js](file:///mnt/Project/GameServre-socketIO/packages/test-client/app.js)）
   - 連線註冊後自動加入 `lobby` Room，房間建立／加入／離開／準備／重置／開賽／完賽時即時廣播 `rooms:updated`，並移除前端 3 秒輪詢定時器。
3. **重複連線清理、保留期到期記憶體回收與裝置解綁**（[PlayerManager.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/managers/PlayerManager.ts)、[gateway.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/socket/gateway.ts)）
   - 同一 `clientInstanceId` 建立新連線時主動斷開舊 Socket；30 秒斷線保留期到期後清理離線 `clients` / `players` / `devices`；`assignedPlayerId: null` 時同步清除原玩家 `deviceId`。
4. **模式時間基準同步與資料庫批次寫入**（[multiplayerMode.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/modes/multiplayerMode.ts)、[bombPassMode.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/modes/bombPassMode.ts)、[persistence.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/db/persistence.ts)）
   - `start(serverNow)` 同步重算 `endsAt` 與實際開賽時間對齊；`finishMatch()` 改為單次多筆批次寫入 `match_participants`；`toSnapshot()` 改為純讀取不就地改寫 `room.teams`；補齊 DB 寫入錯誤日誌。

---

## 3. 後續可選擴充方向

1. **多實例水平擴充**：未來單機負載飽和需部署多個 Server 實例時，導入 `@socket.io/redis-adapter` 搭配 Sticky Sessions。
2. **新遊戲模式擴充**：依 `GameModeServerModule` 介面實作更多遊戲模式。
