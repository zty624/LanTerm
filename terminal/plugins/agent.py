"""Process discovery and exit retention shared by terminal agent CLIs."""

import asyncio
import time
from pathlib import Path

import psutil

from terminal.plugins.base import Pane
from terminal.sessions import Sessions

LABELS = {
    "starting": "启动中",
    "working": "Working · 工作中",
    "waiting_input": "等待输入",
    "needs_attention": "等待确认 / 输入",
    "interrupted": "已中断 · 等待输入",
    "paused": "已暂停",
    "exited": "已退出",
    "unknown": "状态未知",
}
EXIT_SECONDS = 30
Key = tuple[str, str, int | None]


def stat_fields(pid: int) -> list[bytes]:
    # Fields after the parenthesized comm, which may itself contain spaces.
    return Path(f"/proc/{pid}/stat").read_bytes().rsplit(b") ", 1)[1].split()


def tty_device(pid: int) -> int:
    return int(stat_fields(pid)[4]) & 0xFFFFFFFF  # stat field 7: controlling tty


def start_ticks(pid: int) -> int:
    return int(stat_fields(pid)[19])  # stat field 22: start time since boot


class AgentStatus:
    """Badge each agent CLI that owns a pane's terminal; keep exited agents for 30 s."""

    id: str
    name: str
    version: str
    title: str  # Short product name shown on badges.
    process: str  # Linux comm of the CLI.

    def __init__(self, sessions: Sessions):
        self.sessions = sessions
        self.last: dict[Key, list[dict]] = {}
        self.exited: dict[Key, float] = {}

    def helper(self, proc: psutil.Process) -> bool:
        """A process with the CLI's name that is not an interactive session."""
        return False

    def state(self, proc: psutil.Process, used: set) -> dict | None:
        """Return {"state", "source"} with optional fixed "label" / "detail"; None skips."""
        raise NotImplementedError

    def prune(self, used: set) -> None:
        """Drop per-process readers that no live agent used in this sample."""

    async def refine(self, pane: Pane, badges: list[dict]) -> None:
        """Adjust live badges with pane-level signals such as the terminal title."""

    def detail(self, state: str) -> str:
        return ""

    def processes(self, pane: Pane) -> list[psutil.Process] | None:
        if pane.dead:
            return []
        try:
            root = psutil.Process(pane.pid)
            tree = [root, *root.children(recursive=True)]
            device = Path(pane.tty).stat().st_rdev
        except (psutil.NoSuchProcess, FileNotFoundError):
            return []
        except (psutil.AccessDenied, PermissionError):
            return None
        found: list[psutil.Process] = []
        for proc in tree:
            try:
                # psutil's cached tty path map can omit PTYs created after its first sample.
                if proc.name() != self.process or tty_device(proc.pid) != device:
                    continue
                if not self.helper(proc):
                    found.append(proc)
            except (psutil.NoSuchProcess, FileNotFoundError):
                continue
            except (psutil.AccessDenied, PermissionError):
                return None
        # A tool of the CLI can itself start the same CLI; the outermost one owns the pane.
        pids = {proc.pid for proc in found}
        outer = []
        for proc in found:
            try:
                if not any(parent.pid in pids for parent in proc.parents()):
                    outer.append(proc)
            except psutil.NoSuchProcess:
                continue
        return outer

    def identity(self, pane: Pane) -> Key:
        # tmux 3.8 clears the pid of a dead pane; keep the identity it had while alive.
        if pane.pid is None:
            return next((key for key in self.last if key[:2] == pane.key[:2]), pane.key)
        return pane.key

    def inspect(self, panes: list[Pane]) -> dict[str, list[dict]]:
        result = {}
        used: set = set()
        for pane in panes:
            processes = self.processes(pane)
            if processes is None:
                result[pane.id] = [
                    {"pid": badge["pid"], "state": "unknown", "source": "process"}
                    for badge in self.last.get(self.identity(pane), [])
                ]
                continue
            badges = []
            for proc in processes:
                try:
                    badge = self.state(proc, used)
                    if badge is None:
                        continue
                    if proc.status() == psutil.STATUS_STOPPED:
                        badge = {"state": "paused", "source": "process"}
                    badges.append({"pid": proc.pid, **badge})
                except psutil.NoSuchProcess:
                    continue
                except (psutil.AccessDenied, FileNotFoundError, PermissionError):
                    badges.append({"pid": proc.pid, "state": "unknown", "source": "process"})
            result[pane.id] = badges
        self.prune(used)
        return result

    async def sample(self, panes: list[Pane]) -> dict[str, list[dict]]:
        inspected = await asyncio.to_thread(self.inspect, panes)
        result: dict[str, list[dict]] = {}
        now = time.time()
        keys = {pane.id: self.identity(pane) for pane in panes}
        live = set(keys.values())
        self.last = {key: badges for key, badges in self.last.items() if key in live}
        self.exited = {key: stamp for key, stamp in self.exited.items() if key in live}
        for pane in panes:
            key = keys[pane.id]
            badges = inspected[pane.id]
            if badges:
                self.exited.pop(key, None)
                await self.refine(pane, badges)
                self.last[key] = badges
            elif key in self.last:
                ended = self.exited.setdefault(key, now)
                if now - ended < EXIT_SECONDS:
                    badges = [
                        {"pid": badge["pid"], "state": "exited", "source": "process"}
                        for badge in self.last[key]
                    ]
                else:
                    self.last.pop(key)
                    self.exited.pop(key)
            for badge in badges:
                state = badge["state"]
                result.setdefault(pane.session, []).append(
                    {
                        **badge,
                        "plugin": self.id,
                        "name": self.title,
                        "pane": pane.id,
                        "label": badge.get("label") or LABELS[state],
                        "detail": badge.get("detail") or self.detail(state),
                        "observed_at": now,
                    }
                )
        return result
