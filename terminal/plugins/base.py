from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Pane:
    session: str
    id: str
    pid: int
    dead: bool
    tty: str


class StatusPlugin(Protocol):
    id: str
    name: str
    version: str

    async def sample(self, panes: list[Pane]) -> dict[str, list[dict]]: ...
