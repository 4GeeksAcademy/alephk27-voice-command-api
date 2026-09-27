from typing import Any, Literal

from pydantic import BaseModel, Field


class TaskCreate(BaseModel):
    title: str = Field(..., min_length=1)
    done: bool = False


class TaskReplace(BaseModel):
    title: str = Field(..., min_length=1)
    done: bool


class TaskUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1)
    done: bool | None = None


class Task(BaseModel):
    id: int
    title: str
    done: bool


class InstructionRequest(BaseModel):
    transcription: str = Field(..., min_length=1)


class InstructionPayload(BaseModel):
    endpoint: str = Field(..., min_length=1)
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    params: dict[str, Any] = Field(default_factory=dict)


class TranscribeFlowResponse(BaseModel):
    transcription: str = Field(..., min_length=1)
    instruction: InstructionPayload
    result: Any
