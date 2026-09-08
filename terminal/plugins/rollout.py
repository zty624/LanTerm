"""Bounded, incremental reader for Codex lifecycle records, never chat content output."""

import os
from pathlib import Path

from pydantic import BaseModel, ValidationError

LIMIT = 1024 * 1024
HEADER_LIMIT = 64 * 1024


class Payload(BaseModel):
    type: str | None = None
    source: str | dict | None = None
    turn_id: str | None = None
    name: str | None = None
    call_id: str | None = None


class Record(BaseModel):
    type: str
    payload: Payload


def record(line: bytes) -> Record | None:
    try:
        return Record.model_validate_json(line)
    except ValidationError:
        # Logs may be from a different Codex version; never log their content.
        return None


class Rollout:
    def __init__(self, path: Path):
        self.path = path
        self.inode = (0, 0)
        self.offset = 0
        self.state = "unknown"
        self.turn: str | None = None
        self.pending: set[str] = set()

    def read(self) -> str:
        with self.path.open("rb") as stream:
            stat = os.fstat(stream.fileno())
            inode = (stat.st_dev, stat.st_ino)
            reset = inode != self.inode or stat.st_size < self.offset
            if reset:
                self.inode = inode
                self.offset = 0
                self.state = "unknown"
                self.turn = None
                self.pending.clear()
            if stat.st_size - self.offset > LIMIT:
                self.offset = stat.st_size - LIMIT
                self.state = "unknown"
                self.turn = None
                self.pending.clear()
                stream.seek(self.offset)
                stream.readline(LIMIT)  # A seek into a JSON record is not a complete event.
                self.offset = stream.tell()
            stream.seek(self.offset)
            data = stream.read(LIMIT)
            end = data.rfind(b"\n") + 1
            self.offset += end  # Retry the unfinished last record on the next sample.
            for line in data[:end].splitlines():
                event = record(line)
                if event is not None:
                    self.apply(event)
                else:
                    self.state = "unknown"
                    self.turn = None
                    self.pending.clear()
        return self.state

    def apply(self, event: Record) -> None:
        data = event.payload
        kind = data.type
        if event.type == "session_meta":
            self.state = "waiting_input"
            return
        if event.type == "event_msg":
            if kind == "task_started":
                self.turn = data.turn_id
                self.pending.clear()
                self.state = "working"
            elif kind in {"task_complete", "turn_aborted"}:
                if self.turn and data.turn_id not in {None, self.turn}:
                    return
                self.pending.clear()
                self.state = "interrupted" if kind == "turn_aborted" else "waiting_input"
            return
        if event.type != "response_item":
            return
        call = data.call_id
        if not call:
            return
        if kind == "function_call" and data.name in {
            "request_user_input",
            "functions.request_user_input",
        }:
            self.pending.add(call)
            self.state = "waiting_input"
        elif kind == "function_call_output" and call in self.pending:
            self.pending.remove(call)
            self.state = "waiting_input" if self.pending else "working"


def is_root(path: Path) -> bool:
    with path.open("rb") as stream:
        meta = record(stream.readline(HEADER_LIMIT))
    if meta is None or meta.type != "session_meta":
        return False
    # Subagent hooks/transcripts must never replace the parent CLI's status.
    source = meta.payload.source
    return source == "cli" or source == "exec"
