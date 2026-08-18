"""Run the Agent service using AGENT_HOST and AGENT_PORT from .env."""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
import uvicorn


def main() -> None:
    agent_root = Path(__file__).resolve().parents[1]
    load_dotenv(agent_root / ".env")
    host = os.getenv("AGENT_HOST", "127.0.0.1").strip() or "127.0.0.1"
    raw_port = os.getenv("AGENT_PORT", "8001").strip()
    try:
        port = int(raw_port)
    except ValueError as error:
        raise SystemExit("AGENT_PORT must be an integer") from error
    if not 1 <= port <= 65535:
        raise SystemExit("AGENT_PORT must be between 1 and 65535")
    uvicorn.run("eterion_agent.app:app", host=host, port=port)


if __name__ == "__main__":
    main()
