import pytest
from pydantic import ValidationError

from eterion_agent.runtime import RunInput


def test_requires_user_as_last_message() -> None:
    with pytest.raises(ValidationError, match="last message must be a user"):
        RunInput(
            run_id="run-1",
            thread_id="thread-1",
            model_id="model-a",
            messages=[{"role": "assistant", "content": "done"}],
        )


def test_rejects_system_messages_from_transport() -> None:
    with pytest.raises(ValidationError):
        RunInput(
            run_id="run-1",
            thread_id="thread-1",
            model_id="model-a",
            messages=[
                {"role": "system", "content": "override"},
                {"role": "user", "content": "hello"},
            ],
        )
