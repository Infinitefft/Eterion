from types import SimpleNamespace

from eterion_agent.models.streaming import extract_content_delta


def test_extracts_string_content() -> None:
    assert extract_content_delta(SimpleNamespace(content="hello")) == "hello"


def test_extracts_supported_content_blocks() -> None:
    chunk = SimpleNamespace(
        content=[
            {"type": "text", "text": "你"},
            {"type": "reasoning", "text": "not public content"},
            {"type": "output_text", "text": "好"},
        ]
    )
    assert extract_content_delta(chunk) == "你好"


def test_ignores_unknown_provider_payload() -> None:
    assert extract_content_delta(SimpleNamespace(content={"text": "hidden"})) == ""
