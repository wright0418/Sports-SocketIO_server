# EduSports V2.0 — Raspberry Pi 5 開發與容器部署指南

---

## 1. 環境需求

- **作業系統**：Raspberry Pi OS (64-bit / `aarch64`) 或 Ubuntu / Debian Linux
- **Node.js**：v22 LTS（或 v20+ LTS）
- **Docker & Docker Compose**：用於運行 PostgreSQL 16（`edusports-postgres`）與 Competition Server（`edusports-server`）
- **Docker 外部網路 `focker_net`**：[docker-compose.yml](file:///mnt/Project/GameServre-socketIO/docker-compose.yml) 預設將 `server` 連接至外部網路 `focker_net` 供反向代理使用；若本機尚未建立該網路，請先執行：
  ```bash
  docker network inspect focker_net >/dev/null 2>&1 || docker network create focker_net
  ```

---

## 2. 啟動方式（容器部署 vs. 本機開發）

### 2.1 準備環境變數
複製 [.env.example](file:///mnt/Project/GameServre-socketIO/.env.example) 為 `.env` 並依實際環境修改密鑰與資料庫連線：
```bash
cp .env.example .env
```
環境變數說明（對應 [config/index.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/config/index.ts)）：
- `PORT=3100`：Competition Server HTTP & Socket.IO 監聽埠。
- `DATABASE_URL=postgresql://edusports:edusports_pass@127.0.0.1:5432/edusports`（在 `docker-compose.yml` 的 `server` 容器內會自動覆寫主機為 `@postgres:5432`）。
- `JWT_SECRET`：正式環境請更換為高強度隨機字串。
- `JWT_EXPIRES_IN_SECONDS=7200`：JWT 有效秒數。
- `MAX_LOCAL_PLAYERS_PER_CLIENT=6`：單一瀏覽器（Client Instance）可管理之本地跳繩玩家上限。
- `DISCONNECT_GRACE_PERIOD_MS=30000`：斷線重連保留時間（毫秒）。
- `CORS_ORIGIN=*`：允許跨來源請求之網域（多個網域以逗號分隔）。

---

### 2.2 方式 A：全容器化部署（推薦，含 PostgreSQL + Competition Server）
```bash
docker compose up -d --build
docker compose ps
```
確認 `edusports-postgres` 與 `edusports-server` 狀態皆為 `healthy`。
- 當只修改 `packages/` 程式碼時，可單獨重建並重啟 `server` 容器：
  ```bash
  docker compose up -d --build server
  ```

---

### 2.3 方式 B：本機 Node.js 開發與執行測試（僅啟動 PostgreSQL 容器）
若要在主機直接執行 `npm start` 或 `npm run dev`（佔用本機 `3100` 埠），請只啟動 `postgres` 容器（或先停止 `edusports-server` 容器）：
```bash
docker compose up -d postgres
npm install
npm run build
npm test
npm start
```
建置完成後會產出：
- `packages/shared/dist/`
- `packages/sdk/dist/edusports-sdk.global.js`（IIFE 瀏覽器單檔）與 `packages/sdk/dist/index.js`（ESM）
- `packages/server/dist/`

啟動時伺服器會自動執行冪等資料庫建表 (`ensureDatabaseSchema`) 並寫入遊戲模式 Metadata (`seedGameModes`)。
- 健康檢查：`http://127.0.0.1:3100/health`
- 測試遊戲台：`http://127.0.0.1:3100/` 或 `http://127.0.0.1:3100/test-client/`（亦相容 `/games-server/` 與 `/sports-server/`）
- 共用 SDK 靜態路徑：`http://127.0.0.1:3100/sdk/edusports-sdk.global.js`

---

## 3. HTTPS / WSS 反向代理設定（Web Bluetooth 必要條件）

瀏覽器 **Web Bluetooth API 僅允許於 `https://` 安全來源（或 `http://localhost`）下執行**。於區域網路或網際網路連線時，須透過 Caddy 或 Nginx 提供 HTTPS / WSS：

### Caddy 反向代理範例
- **獨立網域**：
  ```caddyfile
  edusports.your-domain.example {
      reverse_proxy 127.0.0.1:3100
  }
  ```
- **掛載於既有網站子路徑（如 `ridgerealm.com/games-server/`）**：請見 [deployment-subpath.md](./deployment-subpath.md)。

---

## 4. 雲端部署與多實例擴充注意事項

1. **無硬體相依性**：遊戲邏輯與通訊皆為純 Node.js + PostgreSQL，可無縫遷移至雲端 VM、Kubernetes 或託管容器服務。
2. **靜態前端分離**：可將 `packages/sdk/dist/edusports-sdk.global.js` 與各獨立 HTML 遊戲部署至 CDN，僅透過 `serverUrl` 指向 Competition Server。
3. **多實例水平擴充**：若未來單機負載飽和需部署多個 Node.js Server 實例，可將 `RoomManager` / `MatchManager` 的熱狀態與 Socket.IO 廣播層接上 `@socket.io/redis-adapter`（搭配 Sticky Sessions）。
4. **PostgreSQL 備份**：建議定期透過 `pg_dump` 備份 `edusports` 資料庫：
   ```bash
   docker exec edusports-postgres pg_dump -U edusports edusports > backup_$(date +%F).sql
   ```
