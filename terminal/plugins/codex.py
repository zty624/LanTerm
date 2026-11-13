"""Codex adapter. Uses local process ownership, lifecycle events and OSC titles."""

import logging
import re
import subprocess
from pathlib import Path

import psutil

from terminal.plugins.agent import AgentStatus
from terminal.plugins.base import Pane
from terminal.plugins.rollout import Rollout, is_root
from terminal.sessions import Sessions

LOG = logging.getLogger(__name__)
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


class CodexStatus(AgentStatus):
    id = "codex"
    name = "Codex 状态"
    version = "1.2.0"
    title = "Codex"
    process = "codex"

    def __init__(self, sessions: Sessions):
        super().__init__(sessions)
        self.logs: dict[Path, Rollout] = {}

    def helper(self, proc: psutil.Process) -> bool:
        return any(arg in {"app-server", "mcp-server"} for arg in proc.cmdline()[1:3])

    def state(self, proc: psutil.Process, used: set) -> dict:
        state, source = self.lifecycle(proc, used)
        return {"state": state, "source": source}

    def lifecycle(self, proc: psutil.Process, used: set[Path]) -> tuple[str, str]:
        paths = []
        # Newer CLIs delegate the session to their own detached app-server.
        # Only direct children belong to this CLI; nested CLI tools and shared
        # servers must not supply its status.
        owners = [(proc, {"cli", "exec"})]
        for child in proc.children():
            try:
                if child.name() == "codex" and "app-server" in child.cmdline()[1:3]:
                    owners.append((child, {"cli", "exec", "vscode"}))
            except psutil.NoSuchProcess:
                continue
        for owner, sources in owners:
            try:
                opened = [Path(file.path) for file in owner.open_files()]
            except psutil.NoSuchProcess:
                continue
            candidates = [
                p for p in opened if p.name.startswith("rollout-") and p.suffix == ".jsonl"
            ]
            for path in candidates[:32]:
                try:
                    if is_root(path, sources):
                        paths.append((path.stat().st_mtime_ns, path))
                except (FileNotFoundError, PermissionError):
                    continue
        if not paths:
            return "unknown", "process"
        # If a CLI switches/resumes threads, its most recently written root log is active.
        _, path = max(paths)
        used.add(path)
        if path not in self.logs:
            self.logs[path] = Rollout(path)
        return self.logs[path].read(), "lifecycle"

    def prune(self, used: set) -> None:
        self.logs = {path: reader for path, reader in self.logs.items() if path in used}

    async def refine(self, pane: Pane, badges: list[dict]) -> None:
        # One pane title cannot identify two concurrent CLIs in the same pane.
        if len(badges) != 1 or badges[0]["state"] == "paused":
            return
        try:
            title = await self.sessions.run(
                ["display-message", "-p", "-t", pane.id, "#{pane_title}"]
            )
        except subprocess.CalledProcessError:
            LOG.debug("Pane disappeared during Codex status sampling: %s", pane.id)
            return
        signal = title_state(title)
        if signal:
            badges[0].update(state=signal, source="terminal_title")

    def detail(self, state: str) -> str:
        if state == "unknown":
            return "已检测到 Codex，当前版本或权限未提供可识别的状态信号"
        if state == "needs_attention":
            return "Codex 请求操作；请打开终端查看审批或问题"
        return ""
