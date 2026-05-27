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
AI_PROVIDER=openai            # openai | anthropic | gemini | ollama
AI_MODEL=gpt-4.1
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...
GEMINI_API_KEY=...

# Local testing with Ollama (no cloud API key)
# AI_PROVIDER=ollama
# AI_MODEL=gemma4:latest
# OLLAMA_BASE_URL=http://127.0.0.1:11434

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

### Ollama + Gemma 4 (testing only)

1. Install [Ollama](https://ollama.com) and pull the model:

```bash
ollama pull gemma4
# or: ollama pull gemma4:latest
```

2. Ensure Ollama is running (`ollama serve` — on macOS it often runs as a background app).

3. Start the AI plugin with Ollama env vars (from repo root):

```bash
./scripts/start-ai-ollama-test.sh
```

Or manually:

```bash
export AI_PROVIDER=ollama
export AI_MODEL=gemma4:latest
export OLLAMA_BASE_URL=http://127.0.0.1:11434
export AI_PLUGIN_SHARED_SECRET=change-me
python -m ai_plugin.main --host 127.0.0.1 --port 8011
```

4. In `backend/.env` (same secret as plugin):

```bash
AI_PLUGIN_URL=http://127.0.0.1:8011
AI_PLUGIN_SHARED_SECRET=change-me
```

5. Run the app (`./dev.sh web`), log in, open the **floating AI bot** (bottom-right), ask a warehouse question.

**Note:** First Gemma 4 reply can take 30–90s on CPU. Smaller models (`gemma4:e2b`) are faster for quick tests.

**Security:** Keep Ollama on `127.0.0.1` only — do not expose port 11434 to the internet.

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

