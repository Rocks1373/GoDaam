## GoDam AI Plugin (Python)

This is a **safe AI assistant** service for your warehouse delivery application. It exposes a small HTTP API and uses a **strict tool layer** to read/check data and generate reports.

### What it does

- **Chat command panel**: backend calls the plugin with a natural language command; the plugin picks a tool and returns a structured result.
- **Data checking**: generates reports for pending deliveries, mismatches, missing driver, GAPP confirmation issues, and notification failures.
- **Safety**:
  - Only approved tools can run.
  - “Dangerous” tools require a `confirm_token` (confirmation gating).
  - Every action is logged into `ai_action_logs` (SQLite).

### Environment variables

Create a `.env` (or export env vars) in the repo root or run directory:

```bash
# LLM provider
AI_PROVIDER=openai            # openai | anthropic | gemini
AI_MODEL=gpt-4.1
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...

# DB
DB_PATH=./warehouse.db        # or GODAM_DB_PATH

# Optional: backend (for future “dangerous” tools delegation)
BACKEND_BASE_URL=http://127.0.0.1:3001
BACKEND_JWT=                  # admin JWT if you want tool actions via backend

# Safety
AUTO_FIX=false
AI_PLUGIN_SHARED_SECRET=change-me

# Server
AI_PLUGIN_HOST=127.0.0.1
AI_PLUGIN_PORT=8011
```

### Run the plugin

From repo root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r ai_plugin/requirements.txt
python -m ai_plugin.main --host 127.0.0.1 --port 8011
```

### Backend integration

Backend routes added:

- `POST /api/ai/chat`
- `GET /api/ai/check-orders`
- `POST /api/ai/run-tool`
- `GET /api/ai/logs`

Backend expects:

```bash
AI_PLUGIN_URL=http://127.0.0.1:8011
AI_PLUGIN_SHARED_SECRET=change-me
```

### Sample commands

- `check all pending deliveries`
- `find mismatched orders`
- `verify GAPP delivery status`
- `show driver notification issue`
- `run full order check`

