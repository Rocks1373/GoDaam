# GoDam Local Scanner Agent

Runs on the **same Windows/Mac PC** as the physical scanner. The **browser cannot drive TWAIN/WIA reliably**, so the web app sends a **scan job** to this agent (`127.0.0.1`), the agent runs your scanner CLI, then **uploads the PDF** to the GoDam API.

## Quick start

```bash
cd scanner-agent
cp .env.example .env
# Edit .env: GODAM_API_BASE, SCANNER_AGENT_TOKEN (must match server), scanner command or mock
npm install
npm start
```

## Environment (.env)

| Variable | Required | Description |
|---------|----------|-------------|
| `GODAM_API_BASE` | Yes | API root, e.g. `https://your-host.com/api` |
| `SCANNER_AGENT_TOKEN` | Yes | Same value as server `SCANNER_AGENT_TOKEN` |
| `GODAM_SCANNER_LISTEN_PORT` | No | Default `38471` |
| `GODAM_SCAN_COMMAND` | Yes* | Shell command that produces a PDF. Use `{output}` for the destination path. |
| `GODAM_ALLOW_MOCK_SCAN` | No | Set to `1` for a one-page blank PDF (development only). |

\* Either `GODAM_SCAN_COMMAND` or `GODAM_ALLOW_MOCK_SCAN=1`.

### Windows — example directions

- Install [NAPS2](https://www.naps2.com/) and use its CLI if available, or a WIA-based tool you trust.
- Example (adjust paths):  
  `GODAM_SCAN_COMMAND="C:\\Program Files\\NAPS2\\naps2.console.exe" scan -o {output}`  
  (Exact flags depend on your NAPS2 version.)

### macOS — example directions

- If SANE / `scanimage` is installed, you might use a pipeline to PDF (e.g. `scanimage` → `convert` → PDF).  
- Or use a commercial/proprietary CLI your scanner vendor provides.

## Server configuration

On the GoDam backend, set:

- `SCANNER_AGENT_TOKEN` — long random secret (`openssl rand -hex 32`)
- `SCANNER_AGENT_USER_ID` — a real `users.id` (service user recommended) used as `uploaded_by`
- Optional: `SCANNER_AGENT_WAREHOUSE_IDS=1,2` to limit which `warehouse_id` values the agent may send

## API

- `GET http://127.0.0.1:38471/health` — readiness
- `POST http://127.0.0.1:38471/v1/scan-job` — JSON body matches browser form (see web UI)

The agent posts to:

`POST {GODAM_API_BASE}/scanner-agent/sales-order-documents/upload`  
with header `X-Scanner-Agent-Token: <token>` and multipart field `file`.

## Security

- Agent binds **127.0.0.1 only**.
- **Never** put `SCANNER_AGENT_TOKEN` in the frontend; only in this agent and server env.
