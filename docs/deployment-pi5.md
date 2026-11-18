# EduSports V2.0 — Raspberry Pi 5 開發與雲端部署指南

---

## 1. 環境需求

- **作業系統**：Raspberry Pi OS (64-bit / `aarch64`) 或 Ubuntu / Debian Linux
- **Node.js**：v22 LTS（或 v20+ LTS）
- **Docker & Docker Compose**：用於運行 PostgreSQL 16（支援 ARM64 原生映像 `postgres:16-alpine`）

---

## 2. 本機 / Raspberry Pi 5 快速啟動步驟

### 2.1 準備環境變數
複製 `.env.example` 為 `.env` 並依實際環境修改密鑰與資料庫連線：
```bash
cp .env.example .env
```
重要參數說明：
- `PORT=3100`：Competition Server HTTP & Socket.IO 監聽埠。
- `DATABASE_URL=postgresql://edusports:edusports_pass@127.0.0.1:5432/edusports`
- `JWT_SECRET`：正式環境請務必更換為高強度隨機字串。
- `JWT_EXPIRES_IN_SECONDS=7200`：JWT 有效秒數。
- `MAX_LOCAL_PLAYERS_PER_CLIENT=6`：單一瀏覽器（Client Instance）可管理之本地跳繩玩家上限。
- `DISCONNECT_GRACE_PERIOD_MS=30000`：斷線重連保留時間（毫秒）。

### 2.2 啟動 PostgreSQL 容器
```bash
docker compose up -d
docker compose ps
```
確認 `edusports-postgres` 狀態為 `healthy`。

### 2.3 安裝相依套件並編譯建置
```bash
npm install
npm run build
```
建置完成後會產出：
- `packages/shared/dist/`
- `packages/sdk/dist/edusports-sdk.global.js`（純 HTML `<script>` 使用）與 `packages/sdk/dist/index.js`（ESM）
- `packages/server/dist/`

### 2.4 啟動伺服器與測試網頁
```bash
npm start
```
啟動時伺服器會自動執行冪等資料庫建表 (`ensureDatabaseSchema`) 並寫入遊戲模式 Metadata (`seedGameModes`)。
- 健康檢查：`http://localhost:3100/health`
- 測試遊戲台：`http://localhost:3100/test-client/`
- 共用 SDK 靜態路徑：`http://localhost:3100/sdk/edusports-sdk.global.js`

---

## 3. HTTPS / WSS 反向代理設定（Web Bluetooth 必要條件）

瀏覽器 **Web Bluetooth API 僅允許於 `https://` 安全來源（或 `http://localhost`）下執行**。於區域網路或網際網路讓多台電腦連線至 Raspberry Pi 5 時，須透過 Caddy 或 Nginx 提供 HTTPS / WSS：

### Caddy 反向代理範例（支援自動 WebSocket / Socket.IO 升級）
```caddyfile
edusports.your-domain.example {
    reverse_proxy 127.0.0.1:3100
}
```

---

## 4. 雲端部署與多實例擴充注意事項

1. **無硬體相依性**：遊戲邏輯與通訊皆為純 Node.js + PostgreSQL，可無縫遷移至雲端 VM、Kubernetes 或託管容器服務（建議搭配託管 PostgreSQL 如 RDS / Cloud SQL）。
2. **靜態前端分離**：未來正式營運時，可將 `packages/sdk/dist/edusports-sdk.global.js` 與各獨立 HTML 遊戲部署至 CDN，僅透過 `serverUrl` 指向 Competition Server。
3. **多實例水平擴充**：若未來單機負載飽和需部署多個 Node.js Server 實例，僅需將 `RoomManager` / `MatchManager` 的熱狀態與 Socket.IO 廣播層接上 `@socket.io/redis-adapter`（搭配 Sticky Sessions）。
4. **PostgreSQL 備份**：建議每日定期透過 `pg_dump` 備份 `edusports` 資料庫：
   ```bash
   docker exec edusports-postgres pg_dump -U edusports edusports > backup_$(date +%F).sql
   ```
