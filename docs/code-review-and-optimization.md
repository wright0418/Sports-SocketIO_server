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
   - 房間處於 `COUNTDOWN` 或 `PLAYING` 狀態時暫停 `/api/rooms` 3 秒輪詢，減少賽局進行中的無效 HTTP 請求。

---

## 2. 後續建議追蹤項目（尚未變更架構）

以下項目涉及通訊協議或正式環境驗證策略，保留於下一階段依需求評估調整：

1. **Session Token 簽發與環境密鑰強化**
   - 建議在正式環境強制要求設定 `JWT_SECRET`（移除開發預設字串回退），並評估將 `POST /api/auth/session` 改為由後端隨機核發或綁定驗證資訊，避免 `RoomSnapshot` 中的 `ownerClientInstanceId` 被他人用來冒名簽發 Token。
2. **離線／跨局計數器與過期玩家清理**
   - `PlayerManager` 在斷線保留期（30 秒）到期後可進一步清理無關聯的離線 `clients` / `players` / `devices` 快取；SDK 的 `lastTickSentAt` 與 `sequenceCounters` 亦可依房間／賽局結束時機清理。
3. **批次準備與資料庫寫入最佳化**
   - SDK 的 `setAllLocalPlayersReady` 目前逐一發送 `player:ready`，未來可擴充支援批次事件以減少多次 `room:updated` 廣播；`PersistenceService.finishMatch` 可將迴圈 `upsert` 改為單次多筆批次寫入。
4. **Socket 重複連線處理與 `toSnapshot` 純函數化**
   - 同一 `clientInstanceId` 建立新 Socket 連線時，可考慮主動踢除或清理舊 Socket 的房間訂閱；`RoomManager.toSnapshot()` 建議避免在純查詢路徑中就地改寫 `room.teams`。
