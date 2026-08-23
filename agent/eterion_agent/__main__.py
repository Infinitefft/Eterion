"""Run the Agent service using settings from agent/.env."""

from __future__ import annotations

import uvicorn

from .api.app import create_app
from .config import Settings


def main() -> None:
    try:
        settings = Settings.from_env()
    except ValueError as error:
        raise SystemExit(str(error)) from error
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
