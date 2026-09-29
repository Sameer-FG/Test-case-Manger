# AWS Deployment Notes

Test-case-Manager deploys as its own docker-compose stack (`app` + `mongo`,
see [docker-compose.yml](docker-compose.yml)) onto the shared internal EC2
box. Mongo data lives in the `mongo` container's own named volume — no
external database to provision.

## Target server

- Shared internal EC2 box (hosts other unrelated services too):
  ```
  ssh -i ~/Downloads/felicity-internal-tools.pem ec2-user@100.50.27.177
  ```
  (internal hostname `ip-172-31-21-23`)
- Existing services already running there under `/opt/tools/`, each its own
  docker-compose stack — **do not touch these** while deploying this project:
  - `felistate-admin` (nginx + oauth2-proxy + app, port 3001 upstream)
  - `analytics-dashboard` (nginx + backend + worker + postgres + oauth2-proxy)
  - `homepage` (dashboard/homepage tool)

### Ports already in use on that box (from `docker ps`, 2026-09-24)

Check before picking a host port for Test-case-Manager:

| Published (host) port | Service |
|---|---|
| 4180 | analytics-dashboard-oauth2-proxy |
| 4181 | felistate-admin-oauth2-proxy |
| 5173 | analytics-dashboard-frontend (vite dev server) |
| 4080 | homepage-oauth2-proxy |

Other containers (felistate app 3001, homepage 3000, nginx 80s, postgres
5432, backend/worker 8000) are internal-only — not published to the host, so
they don't conflict with a new published port but do confirm those numbers
are already in use *inside* the Docker network on this box.

Full container list seen: `felistate-admin-felistate-1`,
`felistate-admin-nginx-1`, `felistate-admin-oauth2-proxy-1`,
`analytics-dashboard-nginx-1`, `analytics-dashboard-backend-1`,
`analytics-dashboard-worker-1`, `analytics-dashboard-oauth2-proxy-1`,
`analytics-dashboard-postgres-1`, `analytics-dashboard-frontend-1`,
`homepage-homepage-1`, `homepage-oauth2-proxy-1`. No container related to
Test-case-Manager exists on this box yet — confirmed via full `docker ps`.

## Gotcha already hit

[docker-compose.yml](docker-compose.yml) originally mapped
`"${PORT:-3000}:3000"` — hardcoding the container side to 3000 while
[server.js](server.js) listens on whatever `PORT` is set to. Since `.env`
sets `PORT=3010`, the app listened on 3010 inside the container but Docker
only forwarded to 3000, causing `Connection reset by peer`. Fixed by
changing both sides to `"${PORT:-3000}:${PORT:-3000}"` — and the
[Dockerfile](Dockerfile) `HEALTHCHECK` had the same hardcoded-3000 bug, fixed
the same way.

## Deploy checklist

1. `mkdir -p /opt/tools/test-case-manager && cd /opt/tools/test-case-manager`
2. Bring over the repo (or at least `docker-compose.yml`, `Dockerfile`,
   `server.js`, `index.html`, `package.json`, `package-lock.json`).
3. Copy `.env.example` to `.env`, set `PORT` to an unused host port (see
   table above), and set real values for `MONGO_INITDB_ROOT_USERNAME`,
   `MONGO_INITDB_ROOT_PASSWORD`, `MONGODB_URI` (must match the mongo
   credentials), and `TEAM_KEY`.
4. `docker compose up -d`
5. Verify: `curl localhost:PORT/api/ping` → should report `isDb: true`.

## Backups

`mongo_data` is a named Docker volume local to the EC2 instance — it is not
automatically backed up. Periodic `docker compose exec mongo mongodump
--out=/data/db-backup` (or an equivalent host-side snapshot) is worth setting
up before relying on this in production.
