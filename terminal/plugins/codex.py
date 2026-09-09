"""Codex adapter. Uses local process ownership, lifecycle events and OSC titles."""

import asyncio
import logging
import re
import subprocess
import time
from pathlib import Path

import psutil

from terminal.plugins.base import Pane
from terminal.plugins.rollout import Rollout, is_root
from terminal.sessions import Sessions

LOG = logging.getLogger(__name__)
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
SPINNER = re.compile(r"^(?:● )?[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏](?:\s|$)")
ACTION = re.compile(r"^(?:● )?\[ [!.] \] Action Required(?:\s|$)")
STATUS = re.compile(r"^(?:codex\s*[|·]\s*)?(Starting|Working|Thinking|Waiting|Ready)(?:\s*[|·]|$)")


def title_state(title: str) -> str | None:
    title = title.strip()
    if ACTION.match(title):
        return "needs_attention"
    if SPINNER.match(title):
        return "working"
    match = STATUS.match(title)
    if not match:
        return None
    return {"Starting": "starting", "Ready": "waiting_input"}.get(match[1], "working")


def tty_device(pid: int) -> int:
    # /proc stat field 7 is the controlling tty, after the parenthesized comm.
    fields = Path(f"/proc/{pid}/stat").read_bytes().rsplit(b") ", 1)[1].split()
    return int(fields[4]) & 0xFFFFFFFF


class CodexStatus:
    id = "codex"
    name = "Codex 状态"
    version = "1.0.1"

    def __init__(self, sessions: Sessions):
        self.sessions = sessions
        self.logs: dict[Path, Rollout] = {}
        self.last: dict[tuple[str, str, int], list[dict]] = {}
        self.exited: dict[tuple[str, str, int], float] = {}

    def processes(self, pane: Pane) -> list[psutil.Process] | None:
        if pane.dead:
            return []
        try:
            root = psutil.Process(pane.pid)
            children = [root, *root.children(recursive=True)]
            device = Path(pane.tty).stat().st_rdev
        except (psutil.NoSuchProcess, FileNotFoundError):
            return []
        except (psutil.AccessDenied, PermissionError):
            return None
        found: list[psutil.Process] = []
        for proc in children:
            try:
                # psutil's cached tty path map can omit PTYs created after its first sample.
                if proc.name() != "codex" or tty_device(proc.pid) != device:
                    continue
                if any(arg in {"app-server", "mcp-server"} for arg in proc.cmdline()[1:3]):
                    continue
                # A Codex tool can itself start another Codex; prefer the outer CLI.
                if any(parent.pid in {p.pid for p in found} for parent in proc.parents()):
                    continue
                found.append(proc)
            except (psutil.NoSuchProcess, FileNotFoundError):
                continue
            except (psutil.AccessDenied, PermissionError):
                return None
        return found

    def lifecycle(self, proc: psutil.Process, used: set[Path]) -> tuple[str, str]:
        paths = []
        opened = [Path(file.path) for file in proc.open_files()]
        candidates = [p for p in opened if p.name.startswith("rollout-") and p.suffix == ".jsonl"]
        for path in candidates[:32]:
            try:
                if is_root(path):
                    paths.append(path)
            except (FileNotFoundError, PermissionError):
                continue
        if not paths:
            return "unknown", "process"
        # If a CLI switches/resumes threads, its most recently written root log is active.
        path = max(paths, key=lambda item: item.stat().st_mtime_ns)
        used.add(path)
        if path not in self.logs:
            self.logs[path] = Rollout(path)
        return self.logs[path].read(), "lifecycle"

    def inspect(self, panes: list[Pane]) -> dict[str, list[dict]]:
        result = {}
        used: set[Path] = set()
        for pane in panes:
            badges = []
            processes = self.processes(pane)
            if processes is None:
                result[pane.id] = [
                    {**badge, "state": "unknown", "source": "process"}
                    for badge in self.last.get(pane.key, [])
                ]
                continue
            for proc in processes:
                try:
                    state, source = self.lifecycle(proc, used)
                    if proc.status() == psutil.STATUS_STOPPED:
                        state, source = "paused", "process"
                    badges.append({"pid": proc.pid, "state": state, "source": source})
                except psutil.NoSuchProcess:
                    continue
                except (psutil.AccessDenied, FileNotFoundError, PermissionError):
                    badges.append({"pid": proc.pid, "state": "unknown", "source": "process"})
            result[pane.id] = badges
        self.logs = {path: reader for path, reader in self.logs.items() if path in used}
        return result

    async def sample(self, panes: list[Pane]) -> dict[str, list[dict]]:
        inspected = await asyncio.to_thread(self.inspect, panes)
        result: dict[str, list[dict]] = {}
        now = time.time()
        live = {pane.key for pane in panes}
        self.last = {pane: badges for pane, badges in self.last.items() if pane in live}
        self.exited = {pane: stamp for pane, stamp in self.exited.items() if pane in live}
        for pane in panes:
            badges = inspected[pane.id]
            if badges:
                self.exited.pop(pane.key, None)
                try:
                    title = await self.sessions.run(
                        ["display-message", "-p", "-t", pane.id, "#{pane_title}"]
                    )
                    signal = title_state(title)
                except subprocess.CalledProcessError:
                    LOG.debug("Pane disappeared during Codex status sampling: %s", pane.id)
                    signal = None
                # One pane title cannot identify two concurrent CLIs in the same pane.
                if len(badges) == 1 and signal and badges[0]["state"] != "paused":
                    badges[0].update(state=signal, source="terminal_title")
                self.last[pane.key] = badges
            elif pane.key in self.last:
                ended = self.exited.setdefault(pane.key, now)
                if now - ended < 30:
                    badges = [
                        {**badge, "state": "exited", "source": "process"}
                        for badge in self.last[pane.key]
                    ]
                else:
                    self.last.pop(pane.key)
                    self.exited.pop(pane.key)
            for badge in badges:
                state = badge["state"]
                detail = ""
                if state == "unknown":
                    detail = "已检测到 Codex，当前版本或权限未提供可识别的状态信号"
                elif state == "needs_attention":
                    detail = "Codex 请求操作；请打开终端查看审批或问题"
                result.setdefault(pane.session, []).append(
                    {
                        **badge,
                        "plugin": self.id,
                        "name": "Codex",
                        "pane": pane.id,
                        "label": LABELS[state],
                        "detail": detail,
                        "observed_at": now,
                    }
                )
        return result
