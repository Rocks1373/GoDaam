from __future__ import annotations

import argparse
import os

import uvicorn
from dotenv import load_dotenv


def main() -> None:
    load_dotenv()
    p = argparse.ArgumentParser(description="GoDam AI plugin service")
    p.add_argument("--host", default=os.getenv("AI_PLUGIN_HOST") or "127.0.0.1")
    p.add_argument("--port", type=int, default=int(os.getenv("AI_PLUGIN_PORT") or "8011"))
    args = p.parse_args()

    uvicorn.run("ai_plugin.service:app", host=args.host, port=args.port, reload=False, log_level="info")


if __name__ == "__main__":
    main()

