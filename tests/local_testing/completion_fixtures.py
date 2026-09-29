import json
from dataclasses import dataclass
from typing import Final

import httpx
import respx
from pydantic import BaseModel

LEGACY_COMPLETION_BASE: Final = "https://legacy-completions.test/v1"
LEGACY_COMPLETION_TEXT: Final = "synthetic completion"


class CompletionRequest(BaseModel):
    model: str
    prompt: str | tuple[str, ...] | tuple[int, ...] | tuple[tuple[int, ...], ...]
    max_tokens: int | None = None
    logprobs: int | None = None
    echo: bool = False
    stream: bool = False
    stream_options: dict[str, bool] | None = None


@dataclass(frozen=True, slots=True)
class LegacyCompletionAPI:
    route: respx.Route

    @property
    def options(self) -> dict[str, str]:
        return {"api_base": LEGACY_COMPLETION_BASE, "api_key": "synthetic-completion-key"}

    @property
    def requests(self) -> tuple[CompletionRequest, ...]:
        return tuple(CompletionRequest.model_validate_json(call.request.content) for call in self.route.calls)


def completion_reply(request: httpx.Request) -> httpx.Response:
    body: Final = CompletionRequest.model_validate_json(request.content)
    batched: Final = isinstance(body.prompt, tuple) and bool(body.prompt) and isinstance(body.prompt[0], (str, tuple))
    count: Final = len(body.prompt) if batched else 1
    text: Final = "hello " + LEGACY_COMPLETION_TEXT if body.echo else LEGACY_COMPLETION_TEXT
    logprobs: Final = (
        {
            "tokens": ["synthetic"],
            "token_logprobs": [-0.25],
            "top_logprobs": [{"synthetic": -0.25}],
            "text_offset": [0],
        }
        if body.logprobs is not None
        else None
    )
    envelope: Final = {"id": "cmpl-synthetic", "object": "text_completion", "created": 1, "model": body.model}
    usage: Final = {"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7}
    choices: Final = [
        {"index": index, "text": text, "finish_reason": "stop", "logprobs": logprobs} for index in range(count)
    ]
    if not body.stream:
        return httpx.Response(200, json={**envelope, "choices": choices, "usage": usage})
    text_event: Final = {**envelope, "choices": [{**choices[0], "finish_reason": None}]}
    finish_event: Final = {**envelope, "choices": [{**choices[0], "text": ""}]}
    usage_events: Final = (
        ({**envelope, "choices": [], "usage": usage},)
        if body.stream_options and body.stream_options.get("include_usage")
        else ()
    )
    events: Final = (text_event, finish_event, *usage_events)
    content: Final = "".join(f"data: {json.dumps(event)}\n\n" for event in events) + "data: [DONE]\n\n"
    return httpx.Response(200, content=content, headers={"content-type": "text/event-stream"})
