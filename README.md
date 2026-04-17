# RMM C2 Server

**Component 2 of 3** — The telemetry ingestion and routing engine for the Remote Monitoring & Management platform.

---

## Architecture Overview

```
Python Agent  ──WS──►  /agent namespace  ──DB write──►  PostgreSQL
                            │
                            └──broadcast──►  /admin namespace  ──►  Next.js Dashboard
                  ──HTTP──►  REST API  ──DB write──►  PostgreSQL
```

The server is a dual-protocol engine:
- **Primary path**: WebSocket (`socket.io`) for real-time keystroke streaming
- **Fallback path**: REST `POST /api/logs/batch` for buffered delivery when WS fails

---

## Project Structure

```
c2-server/
├── prisma/
│   └── schema.prisma          # DB models: Agent, Log, Admin
├── src/
│   ├── controllers/
│   │   ├── agentController.js # Agent registration + listing
│   │   ├── logController.js   # Batch ingest + paginated retrieval
│   │   └── authController.js  # Admin login / JWT issuance
│   ├── middleware/
│   │   ├── agentAuth.js       # X-Agent-API-Key header validation
│   │   ├── adminAuth.js       # JWT Bearer token validation
│   │   └── errorHandler.js    # Centralised Express error handler
│   ├── routes/
│   │   └── index.js           # All route registrations + rate limiters
│   ├── sockets/
│   │   └── index.js           # /agent and /admin namespace logic
│   ├── utils/
│   │   ├── logger.js          # Winston structured logger
│   │   ├── prisma.js          # PrismaClient singleton
│   │   └── jwt.js             # sign / verify helpers
│   └── server.js              # Entry point: composes everything
├── .env.example
├── render.yaml                # Render.com Blueprint
└── package.json
```

---

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your local Postgres credentials and a strong JWT_SECRET

# 3. Apply DB schema
npm run db:push        # dev: push schema without migrations
# — OR —
npm run db:migrate     # prod: apply migration files

# 4. Start dev server (with hot reload)
npm run dev

# 5. Create your first admin account
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"supersecret123!"}'
```

---

## REST API Reference

### Public

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/api/auth/login` | Admin login → JWT |
| POST | `/api/auth/register` | Create admin account |
| POST | `/api/agents/register` | Agent self-registration → API key |

### Agent (requires `X-Agent-API-Key` header)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/logs/batch` | Bulk log upload (WS fallback) |

### Admin (requires `Authorization: Bearer <jwt>`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/auth/me` | Current admin info |
| GET | `/api/agents` | List all agents |
| GET | `/api/agents/:id` | Get single agent |
| GET | `/api/logs` | Paginated logs (`?agentId=&log_type=&limit=&cursor=`) |
| DELETE | `/api/logs/:agentId` | Purge agent logs |

---

## Socket.io Events

### `/agent` namespace (Python Agent → Server)

| Event | Payload | Description |
|-------|---------|-------------|
| `new_log` | `{ window_title, log_type, content, metadata?, timestamp? }` | Single log event |
| `heartbeat` | — | Keep-alive, updates `last_seen` |

**Connection auth**: pass `X-Agent-API-Key` as a header, or `{ api_key }` in the `auth` object.

### `/admin` namespace (Server → Dashboard)

| Event | Payload | Description |
|-------|---------|-------------|
| `new_log` | `{ agent_id, agent_hostname, log_type, content, ... }` | Real-time log broadcast |
| `agent_status` | `{ agent_id, hostname, status, last_seen }` | Online/offline notifications |

**Connection auth**: pass `Authorization: Bearer <jwt>` header, or `{ token }` in the `auth` object.

---

## Render.com Deployment

1. Push this repo to GitHub.
2. In Render dashboard → **New Blueprint** → point to your repo.
3. Render reads `render.yaml` and creates the Web Service + Postgres database automatically.
4. Set `ALLOWED_ORIGINS` to your deployed Next.js dashboard URL.
5. Run database migrations via the Render shell: `npm run db:migrate`.

**Important**: `PORT` and `DATABASE_URL` are injected by Render automatically — do not hardcode them.

---

## Security Considerations

- Agent API keys are UUIDs generated at registration; store them securely on the agent.
- The `/api/auth/register` endpoint should be removed or secured behind an env flag after initial setup.
- Set strong, randomly-generated values for `JWT_SECRET` (Render's `generateValue: true` does this).
- Lock `ALLOWED_ORIGINS` to your dashboard domain before going to production.
- All Postgres connections from Render use SSL by default (`?sslmode=require`).
