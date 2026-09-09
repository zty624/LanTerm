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
                panes = [
                    Pane(item["id"], pane["id"], pane["pid"], pane["dead"], pane["tty"])
                    for item in items
                    for pane in item["panes"]
                ]
                for plugin in self.providers:
                    for sid, values in (await plugin.sample(panes)).items():
                        badges.setdefault(sid, []).extend(values)
            self.data = {"plugins": self.catalog(), "sessions": badges, "sampled_at": time.time()}
            self.deadline = time.monotonic() + self.interval
            return self.data
