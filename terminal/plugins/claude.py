"""Claude Code adapter. Reads the CLI's own session registry, never its transcripts.

Each interactive Claude Code process keeps `<config>/sessions/<pid>.json` with a `status`
of busy, idle or waiting. Under tmux the terminal title is static, so it is not a signal.
"""

import json
import logging
from pathlib import Path

import psutil

from terminal.plugins.agent import AgentStatus, start_ticks
from terminal.sessions import Sessions

LOG = logging.getLogger(__name__)
LIMIT = 64 * 1024
STATUS = {"busy": "working", "idle": "waiting_input"}
# `waitingFor` values seen in Claude Code 2.1.323. Only these fixed labels leave the server:
# other values may be built from tool input or commands and are never forwarded.
WAITING = {
    "permission prompt": (
        "needs_attention",
        "等待授权",
        "Claude Code 请求使用工具；请打开终端允许或拒绝",
    ),
    "input needed": ("needs_attention", "等待回答", "Claude Code 需要你补充信息；请打开终端查看"),
    "dialog open": ("waiting_input", "", ""),
}
GENERIC = ("needs_attention", "等待操作", "Claude Code 正在等待你的操作；请打开终端查看")


def badge(record: dict) -> dict:
    status = record.get("status")
    if status != "waiting":
        return {"state": STATUS.get(status, "unknown"), "source": "session_registry"}
    reason = record.get("waitingFor")
    state, label, detail = WAITING.get(reason, GENERIC) if isinstance(reason, str) else GENERIC
    result = {"state": state, "source": "session_registry"}
    if label:
        result.update(label=label, detail=detail)
    return result


class ClaudeStatus(AgentStatus):
    id = "claude"
    name = "Claude Code 状态"
    version = "1.0.0"
    title = "Claude"
    process = "claude"

    def __init__(self, sessions: Sessions):
        super().__init__(sessions)
        self.folders: dict[tuple[int, int], Path] = {}
        self.known: dict[tuple[int, int], dict] = {}

    def folder(self, key: tuple[int, int], proc: psutil.Process) -> Path:
        if key not in self.folders:
            # The registry follows the process's own environment, not this server's.
            env = proc.environ()
            if root := env.get("CLAUDE_CONFIG_DIR"):
                self.folders[key] = Path(root) / "sessions"
            else:
                self.folders[key] = Path(env.get("HOME") or Path.home()) / ".claude/sessions"
        return self.folders[key]

    def state(self, proc: psutil.Process, used: set) -> dict | None:
        key = (proc.pid, start_ticks(proc.pid))
        used.add(key)
        path = self.folder(key, proc) / f"{proc.pid}.json"
        try:
            with path.open("rb") as stream:
                record = json.loads(stream.read(LIMIT))
        except FileNotFoundError:
            # Helpers and versions without a registry have no file: no badge. A file that
            # vanished under a live session leaves its state unknown.
            if key not in self.known:
                return None
            self.known[key] = {"state": "unknown", "source": "process"}
            return self.known[key]
        except (json.JSONDecodeError, UnicodeDecodeError):
            # A record caught mid-write; keep the last complete state.
            return self.known.get(key)
        if (
            not isinstance(record, dict)
            or record.get("pid") != proc.pid
            or record.get("kind") != "interactive"
        ):
            return None
        started = record.get("procStart")
        if started is not None and str(started) != str(key[1]):
            return None  # Left behind by an earlier process that had the same pid.
        self.known[key] = badge(record)
        return self.known[key]

    def prune(self, used: set) -> None:
        self.folders = {key: path for key, path in self.folders.items() if key in used}
        self.known = {key: value for key, value in self.known.items() if key in used}

    def detail(self, state: str) -> str:
        if state == "unknown":
            return "已检测到 Claude Code，当前版本未提供可识别的状态"
        return ""
