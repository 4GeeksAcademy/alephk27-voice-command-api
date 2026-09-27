import asyncio

from fastapi import APIRouter, File, Form, HTTPException, UploadFile, status

from src.app.schemas.voice import TranscribeFlowResponse
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
    file: UploadFile = File(...),
    language: str | None = Form(default=None),
) -> TranscribeFlowResponse:
    audio = await file.read()
    if not audio:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="The uploaded audio file is empty.")

    settings = get_settings()
    language_code = normalize_transcription_language(language)
    client = Groq(api_key=settings.groq_api_key)
    kwargs = {
        "file": (file.filename or "audio.webm", audio, file.content_type or "application/octet-stream"),
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
