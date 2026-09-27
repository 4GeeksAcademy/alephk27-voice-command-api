from typing import Any

from fastapi import HTTPException, status

from src.app.schemas.voice import TaskCreate, TaskReplace, TaskUpdate, Task
from src.app.services import tasks
from src.app.services.instructions import validate_instruction


def execute_instruction(instruction: Any) -> Any:
    validate_instruction(instruction)
    endpoint = instruction.endpoint
    method = instruction.method
    params = dict(instruction.params)
    task_id = _task_id_from_endpoint(endpoint)

    try:
        if endpoint == "/tasks" and method == "GET":
            return tasks.list_tasks()
        if endpoint == "/tasks" and method == "POST":
            return tasks.create_task(TaskCreate.model_validate(params))
        if task_id is not None and method == "PUT":
            return tasks.replace_task(task_id, TaskReplace.model_validate(params))
        if task_id is not None and method == "PATCH":
            return tasks.update_task(task_id, TaskUpdate.model_validate(params))
        if task_id is not None and method == "DELETE":
            tasks.delete_task(task_id)
            return None
    except KeyError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task {exc.args[0]} not found.",
        ) from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Invalid task parameters.",
        ) from exc

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Unsupported instruction action.",
    )


def _task_id_from_endpoint(endpoint: str) -> int | None:
    parts = endpoint.strip("/").split("/")
    if len(parts) == 2 and parts[0] == "tasks" and parts[1].isdigit():
        return int(parts[1])
    return None
