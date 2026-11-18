# Project Deployment Rule

When you modify any code under `packages/` in this repository:

1. Run the appropriate verification checks (such as `node --check` for edited JS files and `npm test` for server/SDK/shared changes).
2. Automatically rebuild and redeploy the live server container for `ridgerealm.com` using:
   ```bash
   docker compose up -d --build server
   ```
3. Verify the deployment by checking `docker compose ps` and `curl -fsS http://127.0.0.1:3100/health` before reporting completion.
