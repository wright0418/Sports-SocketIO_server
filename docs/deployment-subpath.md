# EduSports V2.0 — 個人網頁子路徑部署計畫 (`/sports-server`)

**目標網址形式：** `https://<你的個人網域>/sports-server/`  
**架構方案：** Docker Compose（PostgreSQL 16 + Node.js Competition Server）+ Caddy 反向代理（`handle_path /sports-server*`）

---

## 1. 為什麼需要調整才能掛在 `/sports-server`？

目前程式預設部署在根路徑 `/`（例如 `http://localhost:3100/test-client/`），若直接掛在個人網頁的子路徑 `/sports-server/` 下，會遇到三個技術問題：

1. **Socket.IO Namespace 與 Path 衝突**：
   `io("https://example.com/sports-server")` 會被 `socket.io-client` 解讀為連線到 `/sports-server` **Namespace**，實際封包仍會打向根路徑 `/socket.io/` 而與主站衝突；必須改為 `io(origin, { path: "/sports-server/socket.io" })`。
2. **HTML 相對路徑問題**：
   [index.html](file:///mnt/Project/GameServre-socketIO/packages/test-client/index.html) 目前使用 `/sdk/edusports-sdk.global.js` 絕對路徑，在子路徑下會請求主站的 `/sdk/...` 而 404。
3. **Express 根路徑重導向**：
   [routes.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/http/routes.ts) 目前 `GET /` 會重導向至 `/test-client/`，若經由 Caddy `handle_path` 剝除前綴後，瀏覽器會被導向主站的 `/test-client/`。

---

## 2. 程式碼修改計畫（共 4 處微調，完全相容本機與測試）

### 2.1 `@edusports/sdk`（自動解析 `serverUrl` 的 `basePath`）
修改 [EduSportsMultiplayer.ts](file:///mnt/Project/GameServre-socketIO/packages/sdk/src/EduSportsMultiplayer.ts)：
- 解析 `new URL(options.serverUrl)` 拆出 `serverOrigin` 與 `basePath`（例如 `/sports-server`，若為根路徑則為 `""`）。
- `fetchSessionToken()` 改為呼叫 `${serverOrigin}${basePath}/api/auth/session`。
- `io(serverOrigin, { path: `${basePath}/socket.io`, ... })`：確保 WebSocket / Polling 握手正確走 `/sports-server/socket.io`。
- **向下相容性**：本機測試傳入 `http://127.0.0.1:3100` 時，`basePath` 為 `""`，行為與現有 6 項 Vitest 測試完全一致。

### 2.2 `packages/server`（Express 靜態與根路徑）
修改 [routes.ts](file:///mnt/Project/GameServre-socketIO/packages/server/src/http/routes.ts)：
- `GET /` 直接提供 `packages/test-client` 靜態首頁（保留 `/test-client` 別名相容原本習慣），不再發送根路徑 Redirect。
- 同時於 `/sdk` 提供 `packages/sdk/dist` 靜態檔案。

### 2.3 `packages/test-client`（改用相對路徑與動態 `serverUrl`）
修改 [index.html](file:///mnt/Project/GameServre-socketIO/packages/test-client/index.html) 與 [app.js](file:///mnt/Project/GameServre-socketIO/packages/test-client/app.js)：
- `index.html` 改為 `<script src="./sdk/edusports-sdk.global.js"></script>`（相對路徑）。
- `app.js` 計算 `baseUrl`（例如去掉結尾 `/test-client/...` 後的基礎 URL），使 `serverUrl` 自動帶入 `https://<網域>/sports-server` 或 `http://localhost:3100`。

### 2.4 Docker Compose 納入 Competition Server
1. 新增 `Dockerfile`（Node.js 22 Alpine 多階段建置 `@edusports/shared`、`@edusports/sdk`、`@edusports/server`）。
2. 更新 [docker-compose.yml](file:///mnt/Project/GameServre-socketIO/docker-compose.yml) 加入 `server` 服務：
   - 與 `edusports-postgres` 共用內部 Docker Network（`DATABASE_URL` 連線主機名為 `postgres:5432`）。
   - 對本機僅綁定 `127.0.0.1:3100:3100`（不直接對外暴露 3100，統一由 Caddy 提供 HTTPS/WSS）。
   - 設定 `CORS_ORIGIN` 允許你的個人網域。

---

## 3. Caddy 反向代理設定範例（加到現有 Caddyfile 主站區塊內）

在你的個人網站 Caddyfile 網域區塊中，加入以下規則：

```caddyfile
your-domain.com {
    # ... 你原有的個人網站設定 ...

    # 確保無尾斜線時補上 /，讓 ./sdk/ 等相對路徑正確解析
    redir /sports-server /sports-server/ permanent

    # 剝除 /sports-server 前綴並轉發至本機 3100 (支援 HTTP 與 WebSocket/WSS)
    handle_path /sports-server* {
        reverse_proxy 127.0.0.1:3100
    }
}
```

### 個人網頁分頁連結方式
- **分頁導覽列連結**：`<a href="/sports-server/">跳繩多人競賽</a>`
- **或嵌入個人網頁分頁（注意 Web Bluetooth 權限）**：
  若要直接嵌在主站分頁內的 `<iframe>`，需加上 `allow="bluetooth"`：
  ```html
  <iframe
    src="/sports-server/"
    allow="bluetooth"
    style="width: 100%; height: 90vh; border: none;"
  ></iframe>
  ```

---

## 4. 部署後驗證清單

1. `npm run build && npm test`：確認 SDK 修改後所有 6 項整合與安全測試依然全數通過。
2. `docker compose up -d --build`：確認 `edusports-postgres` 與 `edusports-server` 皆為 `Up (healthy)`。
3. 透過 `https://<你的網域>/sports-server/health` 確認回傳 `{"ok":true,"status":"healthy",...}`。
4. 瀏覽器開啟 `https://<你的網域>/sports-server/`：
   - 確認 Console 無 404 與 CORS 錯誤。
   - 確認按下「連線」後 Socket.IO 成功透過 `wss://<你的網域>/sports-server/socket.io/` 建立連線。
   - 確認可正常建立房間並進行 `multiplayer` / `bomb-pass` 測試。
