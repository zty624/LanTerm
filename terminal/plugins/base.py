from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class Pane:
    session: str
    id: str
    pid: int
    dead: bool
    tty: str

    @property
    def key(self) -> tuple[str, str, int]:
        return self.session, self.id, self.pid


class StatusPlugin(Protocol):
    id: str
    name: str
    version: str

    async def sample(self, panes: list[Pane]) -> dict[str, list[dict]]: ...
