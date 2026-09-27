import asyncio

from fastapi import APIRouter, HTTPException, Request, status

from src.app.schemas.voice import InstructionRequest, TranscribeFlowResponse
from src.app.services.actions import execute_instruction
from src.app.services.instructions import route_transcription
from src.app.utils.language import normalize_transcription_language
from src.app.core.config import get_settings
from groq import Groq

router = APIRouter(tags=["transcribe"])


@router.get("/")
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/transcribe", response_model=TranscribeFlowResponse)
async def transcribe_and_run_flow(
    request: Request,
) -> TranscribeFlowResponse:
    """Transcribe audio or process a manually supplied transcription.

    The browser normally sends multipart audio. The frontend also exposes a
    manual fallback, which sends JSON to this same public entry point.
    """
    content_type = request.headers.get("content-type", "").lower()
    filename = "audio.webm"
    mime_type = "application/octet-stream"

    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        upload = form.get("file")
        if upload is None or not hasattr(upload, "read"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="An audio file is required.")
        audio = await upload.read()
        filename = getattr(upload, "filename", None) or filename
        mime_type = getattr(upload, "content_type", None) or mime_type
        language = form.get("language")
    elif content_type.startswith("application/json"):
        try:
            payload = InstructionRequest.model_validate(await request.json())
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Expected JSON with a non-empty 'transcription'.",
            ) from exc
        instruction = await asyncio.to_thread(route_transcription, payload.transcription)
        result = execute_instruction(instruction)
        return TranscribeFlowResponse(
            transcription=payload.transcription.strip(),
            instruction=instruction,
            result=result,
        )
    else:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="Use multipart/form-data with an audio file or application/json with a transcription.",
        )

    if not audio:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The uploaded audio file is empty.")

    settings = get_settings()
    language_code = normalize_transcription_language(language)
    client = Groq(api_key=settings.groq_api_key)
    kwargs = {
        "file": (filename, audio, mime_type),
        "model": settings.groq_transcription_model,
        "response_format": "json",
        "timeout": settings.request_timeout_seconds,
    }
    if language_code:
        kwargs["language"] = language_code

    try:
        transcription_response = await asyncio.to_thread(
            client.audio.transcriptions.create,
            **kwargs,
        )
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Speech transcription service failed.") from exc

    transcription = getattr(transcription_response, "text", "").strip()
    if not transcription:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Speech transcription returned no text.")

    instruction = await asyncio.to_thread(route_transcription, transcription)
    result = execute_instruction(instruction)
    return TranscribeFlowResponse(transcription=transcription, instruction=instruction, result=result)
