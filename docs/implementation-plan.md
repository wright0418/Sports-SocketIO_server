# EduSports V2.0 — Competition Server & Multiplayer SDK 實作規劃書

**文件版本：** 1.1（已納入 6 項架構與效能最佳化）  
**依據規格：** [README.md](../README.md)（EduSports V2.0 Phase 1 SRS V2.0.1）  
**規劃範圍：** Competition Server、Multiplayer SDK、共用協議層與測試驗證遊戲（既有 HTML 遊戲將於後續階段整合）

---

## 1. 規劃共識與核心決策摘要

經過需求對焦與架構審查後，本專案第一階段實作將遵循以下技術與架構決策：

| 項目 | 決策內容 | 備註 |
|---|---|---|
| **開發起點** | 先建置 Competition Server + Multiplayer SDK + 測試網頁遊戲，驗證架構與協議後再整合既有 HTML 遊戲 | 預留 `docs/` 供未來 Phase 0 分析既有遊戲使用 |
| **技術棧** | **TypeScript**（Node.js LTS + Express + Socket.IO + Zod）；SDK 編譯為單一 JS Bundle（IIFE/Global + ESM） | 既有純 HTML 遊戲可直接以 `<script>` 引入 SDK |
| **資料庫與持久化** | **PostgreSQL**（Docker Compose 部署，相容本機與 Raspberry Pi 5 ARM64）+ **Drizzle ORM** | 採事件分級：關鍵事件每 500ms 批次寫入 `game_events`，高頻遙測僅更新記憶體並定期快照至 `game_states` |
| **連線與多工架構** | 單一 `clientInstanceId` 建立**一條共用 Socket.IO 連線**，多工管理 **1～6 位本地玩家**（`MAX_LOCAL_PLAYERS_PER_CLIENT=6`） | 更新自 SRS 預設 4 人上限，支援同房續玩（`room:reset`）而不中斷 Web Bluetooth GATT 連線 |
| **身分與安全認證** | 前端呼叫 REST `POST /api/auth/session` 取得短效 **JWT**（含 `clientInstanceId`、`allowedModeIds`、`origin`），Server 驗證 `playerId` 歸屬權 | 前端不存放任何永久 API Secret；預留第三方平台跨網域擴充 |
| **通訊與時鐘同步** | 控制事件統一使用 **Socket.IO Ack Callback**（`{ ok, data?, error? }`）；透過 `client:heartbeat` 計算 `serverTimeOffset` | 所有開賽與炸彈倒數皆依 `sdk.getServerNow()` 換算 |
| **首波驗證遊戲模式** | 1. `multiplayer`（一般多人排名賽）<br>2. `bomb-pass`（定時傳炸彈） | 同時驗證「高頻分數同步」與「Server 權威事件狀態機」 |
| **斷線重連策略** | 預設 **30 秒**斷線保留期；重連一律以 Server **State Snapshot** 恢復；斷線期間事件補送由各 Game Mode Module 決定 | `multiplayer` 有限度驗證補送；`bomb-pass` 拒絕補送 |
| **專案結構** | **npm workspaces Monorepo**（`packages/shared`、`packages/sdk`、`packages/server`、`packages/test-client`） | Server 與 SDK 共用協議型別、事件分類與 Zod Schema |

---

## 2. Monorepo 目錄結構規劃

```text
GameServre-socketIO/
├── README.md
├── GEMINI.md                     # 專案自動測試與容器部署規範
├── package.json                  # npm workspaces 根設定與共用腳本
├── tsconfig.base.json            # 共用 TypeScript 編譯設定
├── Dockerfile                    # Node.js 22 Alpine 多階段建置映像
├── docker-compose.yml            # PostgreSQL 16 (5432) + Competition Server (3100, focker_net)
├── .env.example                  # 環境變數範本（PORT, JWT_SECRET, DATABASE_URL, MAX_LOCAL_PLAYERS_PER_CLIENT, CORS_ORIGIN）
├── docs/
│   ├── implementation-plan.md            # 本實作規劃書
│   ├── protocol.md                       # Socket.IO 與 REST API 協議文件
│   ├── deployment-pi5.md                 # Raspberry Pi 5 開發與容器部署指南
│   ├── deployment-subpath.md             # 子路徑反向代理部署說明 (/games-server, /sports-server)
│   └── code-review-and-optimization.md   # Code Review 與最佳化紀錄
└── packages/
    ├── shared/                   # @edusports/shared：型別、Event Envelope、Zod Schema、Ack 規範、錯誤碼
    │   ├── package.json
    │   ├── tsconfig.json
    │   └── src/
    │       ├── types/            # GameModeMetadata, RoomState, MatchState, DeviceState, RoomSnapshot
    │       ├── schemas/          # EventEnvelopeSchema, C2S Control Schemas, Mode Payload Schemas
    │       ├── errors.ts         # ErrorCode, PlatformError 與 AckResponse<T> 工具
    │       └── index.ts
    ├── sdk/                      # @edusports/sdk：瀏覽器端 EduSportsMultiplayer SDK（與 Server 同步開發驗證）
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── tsup.config.ts        # 打包為 ESM 與 IIFE 單一瀏覽器檔（edusports-sdk.global.js）
    │   └── src/
    │       ├── EduSportsMultiplayer.ts
    │       └── index.ts
    ├── server/                   # @edusports/server：中央競賽伺服器
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── drizzle.config.ts
    │   ├── vitest.config.ts
    │   ├── src/
    │   │   ├── config/           # 環境變數設定（含 MAX_LOCAL_PLAYERS_PER_CLIENT=6）
    │   │   ├── db/               # Drizzle Schema（10 張資料表）、Idempotent Migration、PersistenceService
    │   │   ├── auth/             # JWT 簽發/驗證 (jwt.ts)
    │   │   ├── http/             # Express REST API & 靜態檔託管 (/, /test-client, /games-server, /sports-server)
    │   │   ├── socket/           # Socket.IO Gateway（標準 Ack 回應與心跳對時）
    │   │   ├── managers/         # PlayerManager, TeamManager, RoomManager, MatchManager, GameEventManager
    │   │   ├── modes/            # Game Mode Server Modules（registry, types, multiplayerMode, bombPassMode）
    │   │   ├── app.ts            # createPlatformServer 組裝入口
    │   │   └── index.ts          # CLI 啟動入口
    │   └── test/
    │       └── platform.test.ts  # Vitest 整合與安全性測試（直接透過真實 SDK 執行）
    └── test-client/              # 純 HTML + Vanilla JS 測試網頁（模擬 1~6 支 BLE 跳繩、開放房間列表）
        ├── index.html
        ├── app.js
        └── styles.css
```

---

## 3. 系統架構與最佳化設計細節

### 3.1 `@edusports/shared`（共用協議與驗證層）

- **Event Envelope Schema（Zod）**：
  - `protocolVersion`（`"1.0"`）
  - `eventId`（UUID v4，用於 Server 端冪等性去重）
  - `eventType`（例如 `"jump:tick"`, `"bomb:jump"`, `"bomb:pass"`）
  - `category`（`'critical' | 'telemetry'`：決定高頻進度是否批次落盤至 `game_events`）
  - `matchId`、`roomId`、`playerId`、`clientInstanceId`
  - `sequence`（依 **`(matchId, playerId)` 維度各自單調遞增**，避免多工玩家互相阻塞）
  - `clientTimestamp`（僅供參考）
  - `isOfflineReplay`（選填布林值，標記斷線補送事件）
  - `payload`（由各 Game Mode 註冊對應的 Zod Schema 驗證）
- **標準化 Socket.IO Ack Callback**：
  - 所有 C2S 控制事件回傳 `AckResponse<T>`：`{ ok: true, data: T } | { ok: false, error: { code, message, details? } }`。
- **常數與狀態列舉**：
  - `RoomState`: `WAITING | READY | STARTING | PLAYING | FINISHED | CLOSED`（支援 `FINISHED -> WAITING` 續玩重置）
  - `MatchState`: `CREATED | COUNTDOWN | PLAYING | FINISHED | ABORTED`
  - `PlayerRole`: `PLAYER | SPECTATOR`
  - `ErrorCode`: `UNAUTHORIZED`, `TOKEN_EXPIRED`, `ROOM_FULL`, `ROOM_NOT_FOUND`, `PLAYER_NOT_OWNED`, `LOCAL_PLAYER_LIMIT_EXCEEDED`, `INVALID_SEQUENCE`, `DUPLICATE_EVENT`, `MATCH_NOT_PLAYING`, `SPECTATOR_CANNOT_EMIT`, `INVALID_GAME_ACTION`, `INVALID_PAYLOAD` 等。

---

### 3.2 `@edusports/sdk`（Multiplayer SDK）

- **核心與安全設計**：
  - `await sdk.connect()`：呼叫 `POST /api/auth/session` 取得短效 JWT，建立單一 Socket.IO 連線完成 `client:register`，並啟動心跳對時。
  - **時鐘同步**：透過 `client:heartbeat`（`{ t0 }` → `{ t0, serverNow }`）計算 RTT 與 `serverTimeOffset`，提供 `sdk.getServerNow()`。
  - **本地 1～6 玩家多工與 BLE 隔離**：
    - `registerLocalPlayer()` / `removeLocalPlayer()` 管理同台電腦 1～6 位玩家。
    - `updateDeviceStatus()` 回報單一跳繩 BLE 連線狀態，不影響同電腦其他玩家。
  - **高頻事件節流與立即事件**：
    - `emitGameEvent(playerId, eventType, payload, options)`：關鍵事件立即送出（`category: 'critical'`）。
    - `emitPlayerTick(playerId, eventType, payload)`：內建 per-player 節流合併（預設 200ms），以 `category: 'telemetry'` 送出最新累計值，避免 BLE 原始感測高頻洗頻。
  - **同房續玩與斷線重連**：
    - `resetRoom()`：房主於賽後將房間重置為 `WAITING`，無需重整頁面即可繼續下一場或切換模式。
    - 重連後自動重新註冊、發送 `game:state_request` 取得最新 Snapshot，並依該模式政策決定是否補送離線緩衝事件。

---

### 3.3 `@edusports/server`（Competition Server）

#### A. 核心 Managers 分工

1. **Auth & Session Service**（`auth/jwt.ts`、`http/routes.ts`、`socket/gateway.ts`）：核發與驗證含 `clientInstanceId`、`allowedModeIds`、`origin` 之短效 JWT，並保護 Socket.IO 連線。
2. **PlayerManager & Device Registry**（`managers/PlayerManager.ts`）：追蹤 `ClientInstance`、限制單一連線最多 `MAX_LOCAL_PLAYERS_PER_CLIENT`（預設 6）位本地玩家、管理單獨 BLE `DeviceState`、管理 30 秒斷線保留計時器。
3. **RoomManager**（`managers/RoomManager.ts`）：管理房間開關、滿員轉 `SPECTATOR`、房主移轉、無人自動關閉清理，以及 `FINISHED -> WAITING` 續玩重置（可切換遊戲模式）。
4. **MatchManager & Tick Loop**（`managers/MatchManager.ts`）：控制 `CREATED → COUNTDOWN → PLAYING → FINISHED`（對應房間狀態 `STARTING → PLAYING → FINISHED`），以 Server 時間驅動 100ms Tick（含防重入保護）、4Hz（250ms）`score:broadcast` 節流廣播、每 5 秒與賽後寫入 `game_states` 快照，以及賽後結果記憶體快取（上限 200 筆）與持久化。
5. **GameModeRegistry & Server Rule Modules**（`modes/registry.ts`、`modes/multiplayerMode.ts`、`modes/bombPassMode.ts`）：實作統一生命週期介面並支援第三方 Metadata 欄位（`developerId`、`protocolVersion`、`allowedOrigins`、`clientEntryUrl`）。
6. **GameEventManager**（`managers/GameEventManager.ts`）：執行 8 步驟驗證管線（Schema → 連線身分 → 玩家歸屬權 → 比賽進行中 → 非觀賽者 → `eventId` 去重 → `(matchId, playerId)` 序號遞增 → 離線補送政策與 Mode 規則驗證）；`critical` 事件排入 `PersistenceService` 500ms 批次寫入佇列。
7. **TeamManager & PersistenceService**（`managers/TeamManager.ts`、`db/persistence.ts`）：支援個人與動態隊伍計分彙整，並負責將房間、賽局、參賽者成績（`matches`、`match_participants`）、關鍵事件（`game_events`）與狀態快照（`game_states`）寫入 PostgreSQL。

#### B. 首波實作的兩個 Game Mode Modules

| Mode ID | 名稱 | 核心機制與驗證重點 | 同步與斷線政策 |
|---|---|---|---|
| `multiplayer` | 一般多人對戰 | 接收 `jump:tick`，驗證最高跳繩速率（預設 `12 jumps/s`）以防作弊，計算即時分數與排名 | 每 250ms（4Hz）節流廣播；重連後允許於 `斷線秒數 × 最高速率` 內補送累計增量 |
| `bomb-pass` | 定時傳炸彈 | Server 維護炸彈持有者 `bombHolderPlayerId`、引爆時間與傳遞門檻跳數；跳滿門檻才允許 `bomb:pass` 轉移；時間到淘汰持有者直至剩餘 1 人或結束 | 狀態變更即時廣播 `game:state`；**拒絕**補送斷線期間事件（`REJECT_ALL`） |

---

## 4. 資料庫設計（PostgreSQL + Drizzle ORM）

完整對應 README 第 13 節的 10 張資料表，並預留第三方擴充欄位與索引：

1. `users`（`id`, `display_name`, `status`, `created_at`）
2. `game_modes`（`id`, `mode_id` UNIQUE, `name`, `version`, `developer_id`, `protocol_version`, `min_players`, `max_players`, `allowed_origins` JSONB, `client_entry_url`, `configuration` JSONB, `status`）
3. `client_instances`（`id`, `client_instance_id` UNIQUE, `last_seen_at`, `status`）
4. `devices`（`id`, `device_id` UNIQUE, `device_type`, `device_status`, `assigned_player_id`, `local_client_id`, `last_data_timestamp`）
5. `rooms`（`id`, `room_code` UNIQUE, `game_mode_id`, `owner_id`, `status`, `max_players`, `created_at`）
6. `room_players`（`id`, `room_id`, `player_id`, `client_instance_id`, `role`, `team_id`, `status`）
7. `matches`（`id`, `room_id`, `game_mode_id`, `status`, `started_at`, `ended_at`, `result` JSONB）
8. `match_participants`（`id`, `match_id`, `player_id`, `team_id`, `final_score`, `result` JSONB）
9. `game_events`（`id`, `match_id`, `player_id`, `event_id` UNIQUE, `sequence`, `event_type`, `payload` JSONB, `server_timestamp`）— 索引：`(match_id, player_id, sequence)`
10. `game_states`（`id`, `match_id`, `state_version`, `state_data` JSONB, `created_at`）— 索引：`(match_id, state_version)`

---

## 5. 分階段開發與驗證計畫（SDK 提前並進）

### Milestone 1：Monorepo 骨架、Docker PostgreSQL 與 `@edusports/shared`
- 建立 workspaces 根設定、`tsconfig.base.json`、`docker-compose.yml`（PostgreSQL 16）。
- 建立 `@edusports/shared`（Event Envelope、Per-Player Sequence 規格、Ack 回應格式、所有 Zod Schema 與 ErrorCode）。

### Milestone 2：PostgreSQL Schema、Auth（JWT）與 Room/Match 核心 + `@edusports/sdk` 核心骨架
- 建立 Drizzle 10 張資料表與冪等建表腳本、`PersistenceService`（含 500ms 批次寫入佇列）。
- 實作 `POST /api/auth/session`、Socket.IO Auth & Heartbeat 對時、`PlayerManager`（1～6 本地玩家）、`RoomManager`（含 `room:reset` 續玩）、`MatchManager`。
- 同步建立 `@edusports/sdk` 核心骨架（連線、JWT 管理、對時、Ack Promise 封裝、1～6 玩家註冊）。

### Milestone 3：Game Mode 雙模式實作與事件安全驗證管線
- 實作 `GameModeRegistry`、`GameEventManager`（8 步驟驗證）、`GameStateManager`、`ScoreManager`、`TeamManager`、`MatchHistoryManager`。
- 實作 `multiplayer` 與 `bomb-pass` 兩個 Server Rule Modules。
- 補齊 `@edusports/sdk` 節流發送（`emitPlayerTick`）、斷線自動恢復與 Snapshot 同步。

### Milestone 4：Test HTML Game Client（模擬 1～6 支 BLE 跳繩）
- 建立 `packages/test-client` 純 HTML/JS 測試網頁：
  - 引入編譯後的 `edusports-sdk.global.js`。
  - 模擬 1～6 支跳繩（獨立 BLE 狀態開關、手動跳繩與自動 RPM）。
  - 支援開房/加房、觀賽、遊玩 `multiplayer` 與 `bomb-pass`、斷線重連測試與同房續玩（`room:reset`）。

### Milestone 5：自動化整合/安全測試與部署文件
- 使用 Vitest + 真實 `@edusports/sdk` 執行端到端與安全性測試（涵蓋 README 19.2～19.4 所有項目）。
- 交付 `docs/protocol.md` 與 `docs/deployment-pi5.md`。
