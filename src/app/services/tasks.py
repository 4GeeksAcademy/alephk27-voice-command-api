from src.app.schemas.voice import Task, TaskCreate, TaskReplace, TaskUpdate


_tasks: list[Task] = []
_next_task_id = 1


def list_tasks() -> list[Task]:
    return list(_tasks)


def create_task(payload: TaskCreate) -> Task:
    global _next_task_id
    task = Task(id=_next_task_id, title=payload.title, done=payload.done)
    _next_task_id += 1
    _tasks.append(task)
    return task


def get_task(task_id: int) -> Task:
    for task in _tasks:
        if task.id == task_id:
            return task
    raise KeyError(task_id)


def replace_task(task_id: int, payload: TaskReplace) -> Task:
    task = get_task(task_id)
    replacement = Task(id=task.id, title=payload.title, done=payload.done)
    _tasks[_tasks.index(task)] = replacement
    return replacement


def update_task(task_id: int, payload: TaskUpdate) -> Task:
    task = get_task(task_id)
    updated = task.model_copy(
        update=payload.model_dump(exclude_unset=True, exclude_none=True)
    )
    _tasks[_tasks.index(task)] = updated
    return updated


def delete_task(task_id: int) -> None:
    task = get_task(task_id)
    _tasks.remove(task)


def reset_tasks() -> None:
    """Reset in-memory state for tests and local development."""
    global _next_task_id
    _tasks.clear()
    _next_task_id = 1
