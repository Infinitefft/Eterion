import asyncio
import json

from eterion_agent.api.sse import encode_sse, stream_with_heartbeats
from eterion_agent.runtime import AgentEvent


def test_encodes_normalized_event_without_ascii_escaping() -> None:
    encoded = encode_sse(
        AgentEvent("content.delta", "run-1", {"delta": "你好"})
    )

    lines = encoded.strip().splitlines()
    assert lines[0] == "event: content.delta"
    assert json.loads(lines[1].removeprefix("data: ")) == {
        "runId": "run-1",
        "payload": {"delta": "你好"},
    }


def test_emits_heartbeat_while_waiting_for_runtime() -> None:
    async def delayed_events():
        await asyncio.sleep(0.02)
        yield AgentEvent("run.completed", "run-1", {})

    async def run() -> None:
        chunks = [
            chunk
            async for chunk in stream_with_heartbeats(
                delayed_events(),
                heartbeat_seconds=0.001,
                run_id="run-1",
            )
        ]
        assert ": keepalive\n\n" in chunks
        assert any(chunk.startswith("event: run.completed") for chunk in chunks)

    asyncio.run(run())
