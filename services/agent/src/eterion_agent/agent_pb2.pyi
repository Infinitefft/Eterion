from google.protobuf.internal import containers as _containers
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Iterable as _Iterable, Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class RunRequest(_message.Message):
    __slots__ = ("run_id", "chat_id", "messages")
    RUN_ID_FIELD_NUMBER: _ClassVar[int]
    CHAT_ID_FIELD_NUMBER: _ClassVar[int]
    MESSAGES_FIELD_NUMBER: _ClassVar[int]
    run_id: str
    chat_id: str
    messages: _containers.RepeatedCompositeFieldContainer[ChatMessage]
    def __init__(self, run_id: _Optional[str] = ..., chat_id: _Optional[str] = ..., messages: _Optional[_Iterable[_Union[ChatMessage, _Mapping]]] = ...) -> None: ...

class ChatMessage(_message.Message):
    __slots__ = ("role", "content")
    ROLE_FIELD_NUMBER: _ClassVar[int]
    CONTENT_FIELD_NUMBER: _ClassVar[int]
    role: str
    content: str
    def __init__(self, role: _Optional[str] = ..., content: _Optional[str] = ...) -> None: ...

class RunEvent(_message.Message):
    __slots__ = ("started", "content_delta", "completed", "failed")
    STARTED_FIELD_NUMBER: _ClassVar[int]
    CONTENT_DELTA_FIELD_NUMBER: _ClassVar[int]
    COMPLETED_FIELD_NUMBER: _ClassVar[int]
    FAILED_FIELD_NUMBER: _ClassVar[int]
    started: RunStarted
    content_delta: ContentDelta
    completed: RunCompleted
    failed: RunFailed
    def __init__(self, started: _Optional[_Union[RunStarted, _Mapping]] = ..., content_delta: _Optional[_Union[ContentDelta, _Mapping]] = ..., completed: _Optional[_Union[RunCompleted, _Mapping]] = ..., failed: _Optional[_Union[RunFailed, _Mapping]] = ...) -> None: ...

class RunStarted(_message.Message):
    __slots__ = ("model",)
    MODEL_FIELD_NUMBER: _ClassVar[int]
    model: str
    def __init__(self, model: _Optional[str] = ...) -> None: ...

class ContentDelta(_message.Message):
    __slots__ = ("delta",)
    DELTA_FIELD_NUMBER: _ClassVar[int]
    delta: str
    def __init__(self, delta: _Optional[str] = ...) -> None: ...

class RunCompleted(_message.Message):
    __slots__ = ("full_text",)
    FULL_TEXT_FIELD_NUMBER: _ClassVar[int]
    full_text: str
    def __init__(self, full_text: _Optional[str] = ...) -> None: ...

class RunFailed(_message.Message):
    __slots__ = ("code", "message", "retryable")
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    RETRYABLE_FIELD_NUMBER: _ClassVar[int]
    code: str
    message: str
    retryable: bool
    def __init__(self, code: _Optional[str] = ..., message: _Optional[str] = ..., retryable: _Optional[bool] = ...) -> None: ...
