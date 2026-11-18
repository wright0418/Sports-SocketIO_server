# EduSports V2.0 — 個人網頁子路徑部署架構與設定 (`/games-server` & `/sports-server`)

**目標網址：** `https://ridgerealm.com/games-server/` 或 `https://ridgerealm.com/sports-server/`  
**實際架構：** Docker Compose（`edusports-postgres` + `edusports-server`）+ 外部 Docker 網路 `focker_net` + Caddy 反向代理

---

## 1. 子路徑相容架構設計（已實作於程式碼）

為同時相容本機根路徑（`http://127.0.0.1:3100/`）與個人網站子路徑（`/games-server/`、`/sports-server/`），以及相容 Caddy 使用 `handle_path`（剝除前綴）或 `handle`（保留前綴）兩種反向代理模式，專案已實作以下機制：

### 1.1 `@edusports/sdk`（自動拆解 `serverUrl` 的 `serverOrigin` 與 `basePath`）
於 [EduSportsMultiplayer.ts](file:///mnt/Project/GameServre-socketIO/packages/sdk/src/EduSportsMultiplayer.ts#L163-L171)：
- 解析 `new URL(options.serverUrl)` 拆出 `serverOrigin` 與 `basePath`（例如 `/games-server` 或 `/sports-server`；若為根路徑則為 `""`）。
- `fetchSessionToken()` 自動呼叫 `${serverOrigin}${basePath}/api/auth/session`。
- Socket.IO 連線使用 `io(serverOrigin, { path: `${basePath}/socket.io`, ... })`，避免子路徑被誤判為 Socket.IO Namespace。

### 1.2 `@edusports/server`（多重掛載與靜態資源路由）
於 [routes.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/http/routes.ts#L156-L182)：
- 靜態路由同時掛載 `/sdk`、`/test-client/sdk`、`/test-client` 與 `/`，直接提供 `packages/test-client` 與 `packages/sdk/dist` 靜態檔案。
- Express App 將同一個 `router` 同時掛載於：
  - `/games-server`（無尾斜線 `/games-server` 自動 `301` 導向 `/games-server/`）
  - `/sports-server`（無尾斜線 `/sports-server` 自動 `301` 導向 `/sports-server/`）
  - `/`（根路徑）
- 因此無論反向代理是否剝除子路徑前綴，REST API（`/health`、`/api/*`）與靜態資源皆可正確命中。

### 1.3 `packages/test-client`（相對路徑與動態 `resolveServerUrl()`）
於 [index.html](file:///mnt/Project/GameServre-socketIO/packages/test-client/index.html#L119-L120) 與 [app.js](file:///mnt/Project/GameServre-socketIO/packages/test-client/app.js#L98-L104)：
- `index.html` 使用相對路徑 `<script src="./sdk/edusports-sdk.global.js"></script>` 與 `<script src="./app.js"></script>`。
- `app.js` 透過 `resolveServerUrl()` 由 `window.location.href` 自動推算當前伺服器基底網址（移除尾端 `/test-client`），供 SDK 連線與 `GET /api/rooms` 房間列表查詢共用。

### 1.4 Docker Compose 與 `focker_net` 外部網路
於 [Dockerfile](file:///mnt/Project/GameServre-socketIO/Dockerfile) 與 [docker-compose.yml](file:///mnt/Project/GameServre-socketIO/docker-compose.yml)：
- `Dockerfile` 採用 `node:22-alpine` 多階段建置（Builder 編譯 `shared` → `sdk` → `server`，Runner 僅保留 production 相依套件與編譯產物）。
- `docker-compose.yml` 中的 `server`（容器名稱 `edusports-server`）：
  - 對本機綁定 `127.0.0.1:3100:3100`。
  - 同時加入 `default`（連接 `edusports-postgres`）與外部網路 `focker_net`（供 Caddy 容器直接以 `edusports-server:3100` 反向代理）。

---

## 2. Caddy 反向代理設定（`ridgerealm.com`）

於 `ridgerealm.com` 的 Caddyfile 中可使用 `/games-server` 或 `/sports-server`：

```caddyfile
ridgerealm.com {
    # 確保無尾斜線時補上 /，讓 ./sdk/ 等相對路徑正確解析
    redir /games-server /games-server/ permanent

    # 剝除前綴並轉發至同在 focker_net 的 edusports-server 容器
    handle_path /games-server* {
        reverse_proxy edusports-server:3100
    }
}
```

### 個人網頁嵌入或連結方式
- **直接連結**：`<a href="/games-server/">跳繩多人競賽</a>`
- **`<iframe>` 嵌入（須開啟 Web Bluetooth 權限）**：
  ```html
  <iframe
    src="/games-server/"
    allow="bluetooth"
    style="width: 100%; height: 90vh; border: none;"
  ></iframe>
  ```

---

## 3. 更新與部署指令

每次修改 `packages/` 程式碼後，執行以下指令即可完成測試、重建容器與健康檢查：

```bash
node --check packages/test-client/app.js
npm test
docker compose up -d --build server
docker compose ps
curl -fsS http://127.0.0.1:3100/health
```
