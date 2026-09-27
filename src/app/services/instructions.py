import json
from typing import Any

from fastapi import HTTPException, status
from groq import Groq

from src.app.core.config import get_settings
from src.app.schemas.voice import InstructionPayload

_COLLECTION_METHODS = {"GET", "POST"}
_ITEM_METHODS = {"PUT", "PATCH", "DELETE"}


def route_transcription(transcription: str) -> InstructionPayload:
    settings = get_settings()
    client = Groq(api_key=settings.groq_api_key)

    try:
        completion = client.chat.completions.create(
            model=settings.groq_model,
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an intent router for a task API. Return only a JSON object "
                        "with endpoint, method, and params. Supported routes are GET /tasks, "
                        "POST /tasks, and PUT, PATCH, or DELETE /tasks/{task_id}. Never execute "
                        "an action and never include markdown or explanations."
                    ),
                },
                {"role": "user", "content": transcription},
            ],
            timeout=settings.request_timeout_seconds,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Instruction service failed.",
        ) from exc

    content = completion.choices[0].message.content if completion.choices else None
    if not content:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Instruction model returned an empty response.",
        )

    try:
        raw: Any = json.loads(content)
    except (TypeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Instruction model returned invalid JSON.",
        ) from exc

    if not isinstance(raw, dict):
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Instruction model returned an invalid routing object.",
        )

    try:
        instruction = InstructionPayload.model_validate(raw)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Instruction model returned an invalid routing payload.",
        ) from exc

    validate_instruction(instruction, invalid_status=status.HTTP_502_BAD_GATEWAY)
    return instruction


def validate_instruction(
    instruction: InstructionPayload,
    *,
    invalid_status: int = status.HTTP_400_BAD_REQUEST,
) -> None:
    endpoint = instruction.endpoint
    task_id_route = _is_task_route(endpoint)
    valid_collection_route = endpoint == "/tasks" and instruction.method in _COLLECTION_METHODS
    valid_item_route = task_id_route and instruction.method in _ITEM_METHODS

    if not valid_collection_route and not valid_item_route:
        raise HTTPException(
            status_code=invalid_status,
            detail="Instruction model returned an unsupported endpoint and method combination."
            if invalid_status == status.HTTP_502_BAD_GATEWAY
            else "Unsupported instruction endpoint and method combination.",
        )


def _is_task_route(endpoint: str) -> bool:
    parts = endpoint.strip("/").split("/")
    return len(parts) == 2 and parts[0] == "tasks" and parts[1].isdigit()
