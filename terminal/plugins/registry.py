import asyncio
import time

from terminal.plugins.base import Pane, StatusPlugin
from terminal.plugins.codex import CodexStatus
from terminal.sessions import Sessions

PROVIDERS = {"codex": CodexStatus}


class Plugins:
    def __init__(self, sessions: Sessions, names: list[str], interval: float):
        self.sessions = sessions
        self.providers: list[StatusPlugin] = [PROVIDERS[name](sessions) for name in names]
        self.interval = interval
        self.lock = asyncio.Lock()
        self.deadline = 0.0
        self.data: dict = {}

    def catalog(self) -> list[dict]:
        return [
            {"id": plugin.id, "name": plugin.name, "version": plugin.version}
            for plugin in self.providers
        ]

    async def get(self) -> dict:
        async with self.lock:
            if time.monotonic() < self.deadline:
                return self.data
            badges: dict[str, list[dict]] = {}
            if self.providers:
                items = await self.sessions.list()
                ids = {item["id"] for item in items}
                panes = await self.panes(ids) if ids else []
                for plugin in self.providers:
                    for sid, values in (await plugin.sample(panes)).items():
                        badges.setdefault(sid, []).extend(values)
            self.data = {"plugins": self.catalog(), "sessions": badges, "sampled_at": time.time()}
            self.deadline = time.monotonic() + self.interval
            return self.data

    async def panes(self, ids: set[str]) -> list[Pane]:
        fmt = "#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_tty}"
        out = await self.sessions.run(["list-panes", "-a", "-F", fmt])
        panes = []
        for line in out.splitlines():
            name, pane, pid, dead, tty = line.split("\t")
            if name.startswith("lt-") and name[3:] in ids:
                panes.append(Pane(name[3:], pane, int(pid), dead == "1", tty))
        return panes
