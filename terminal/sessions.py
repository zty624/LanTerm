from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import subprocess
import uuid
from pathlib import Path

from terminal.config import ROOT, Config, available_shells

META = ("name", "shell", "cwd", "group", "tags", "pinned", "note")
LOG = logging.getLogger(__name__)


class SessionError(RuntimeError):
    def __init__(self, message: str, status: int):
        super().__init__(message)
        self.status = status


def child_env() -> dict[str, str]:
    env = os.environ.copy()
    for key in ("TMUX", "TMUX_PANE", "LAN_TERMINAL_PASSWORD"):
        env.pop(key, None)
    env.update(TERM="xterm-256color", COLORTERM="truecolor")
    return env


def directory(cwd: str) -> Path:
    path = Path(cwd).expanduser().resolve()
    if not path.is_dir() or not os.access(path, os.R_OK | os.X_OK):
        raise SessionError("初始目录不存在或不可访问", 400)
    return path


class Sessions:
    def __init__(self, config: Config):
        self.config = config
        self.lock = asyncio.Lock()
        self.cmd = ["tmux", "-u", "-S", str(config.socket), "-f", str(ROOT / "terminal/tmux.conf")]

    async def run(self, args: list[str]) -> str:
        proc = await asyncio.create_subprocess_exec(
            *self.cmd,
            *args,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=child_env(),
        )
        try:
            async with asyncio.timeout(10):
                out, err = await proc.communicate()
        except TimeoutError:
            proc.kill()
            await proc.wait()
            raise
        if proc.returncode:
            raise subprocess.CalledProcessError(proc.returncode, args[0], out, err.decode())
        return out.decode("utf-8", errors="replace").rstrip("\n")

    async def list(self) -> list[dict]:
        fmt = (
            "#{session_name}\t#{@lt_meta}\t#{session_created}\t#{session_attached}"
            "\t#{session_activity}"
        )
        out = await self.scan(["list-sessions", "-F", fmt])
        items = {}
        for line in out.splitlines():
            name, encoded, created, clients, activity = line.split("\t")
            if not name.startswith("lt-") or not encoded:
                continue
            meta = {
                "group": "",
                "tags": [],
                "pinned": False,
                "note": "",
                **json.loads(base64.urlsafe_b64decode(encoded)),
            }
            items[name] = dict(
                id=name[3:],
                **meta,
                created=int(created),
                clients=int(clients),
                activity=int(activity or created),
                panes=[],
            )
        if not items:
            return []
        fmt = (
            "#{session_name}\t#{window_id}\t#{window_active}\t#{window_zoomed_flag}"
            "\t#{pane_id}\t#{pane_index}\t#{pane_active}\t#{pane_dead}\t#{pane_pid}"
            "\t#{pane_tty}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}"
            "\t#{pane_current_command}"
        )
        for line in (await self.scan(["list-panes", "-a", "-F", fmt])).splitlines():
            fields = line.split("\t", 14)
            if fields[0] not in items:
                continue
            (
                name,
                window,
                visible,
                zoomed,
                pid,
                index,
                active,
                dead,
                process,
                tty,
                cols,
                rows,
                x,
                y,
                command,
            ) = fields
            items[name]["panes"].append(
                dict(
                    id=pid,
                    window=window,
                    visible=visible == "1",
                    zoomed=zoomed == "1",
                    index=int(index),
                    active=active == "1",
                    dead=dead == "1",
                    pid=int(process),
                    tty=tty,
                    cols=int(cols),
                    rows=int(rows),
                    x=int(x),
                    y=int(y),
                    command=command,
                )
            )
        result = []
        for item in items.values():
            panes = item["panes"]
            if not panes:  # The session may have closed between the two tmux reads.
                continue
            active = next((pane for pane in panes if pane["visible"] and pane["active"]), panes[0])
            item.update(
                pid=active["pid"],
                active_pane=active["id"],
                active_dead=active["dead"],
                pane_count=sum(pane["visible"] for pane in panes),
                status="running" if any(not pane["dead"] for pane in panes) else "exited",
            )
            result.append(item)
        return sorted(result, key=lambda item: (item["created"], item["id"]))

    async def scan(self, args: list[str]) -> str:
        try:
            return await self.run(args)
        except subprocess.CalledProcessError as exc:
            if "no server running" in exc.stderr or (
                "error connecting to" in exc.stderr
                and any(s in exc.stderr for s in ("No such file", "Connection refused"))
            ):
                return ""
            raise

    async def get(self, sid: str) -> dict:
        for item in await self.list():
            if item["id"] == sid:
                return item
        raise SessionError("会话不存在或已经关闭", 404)

    async def metadata(self, sid: str, meta: dict) -> None:
        encoded = base64.urlsafe_b64encode(json.dumps(meta).encode()).decode()
        await self.run(["set-option", "-t", f"lt-{sid}", "@lt_meta", encoded])

    async def create(self, name: str, shell: str, cwd: str, options: dict) -> dict:
        path = await asyncio.to_thread(directory, cwd)
        shells = available_shells()
        if shell not in shells:
            raise SessionError("此 shell 未安装", 400)
        async with self.lock:
            if len(await self.list()) >= self.config.max_sessions:
                raise SessionError("已达到会话数量上限，请先关闭不需要的会话", 409)
            sid = uuid.uuid4().hex
            await self.run(
                [
                    "new-session",
                    "-d",
                    "-s",
                    f"lt-{sid}",
                    "-c",
                    str(path),
                    "-x",
                    "120",
                    "-y",
                    "30",
                    "-e",
                    f"LAN_TERMINAL_SESSION={sid}",
                    shells[shell],
                    "-l",
                ]
            )
            await self.metadata(sid, dict(name=name, shell=shell, cwd=str(path), **options))
            return await self.get(sid)

    async def rename(self, sid: str, name: str) -> dict:
        return await self.update(sid, {"name": name})

    async def update(self, sid: str, changes: dict) -> dict:
        async with self.lock:
            item = await self.get(sid)
            meta = {key: item[key] for key in META}
            await self.metadata(sid, {**meta, **changes})
            return await self.get(sid)

    async def duplicate(self, sid: str) -> dict:
        item = await self.get(sid)
        cwd = item["cwd"]
        if item["status"] == "running":
            try:
                cwd = await asyncio.to_thread(os.readlink, f"/proc/{item['pid']}/cwd")
            except (FileNotFoundError, PermissionError):
                LOG.debug("Cannot inspect current directory for session %s", sid)
        return await self.create(
            item["name"][:76] + " 副本",
            item["shell"],
            cwd,
            {"group": item["group"], "tags": item["tags"], "note": item["note"], "pinned": False},
        )

    async def batch(self, ids: list[str], action: str, group: str) -> dict:
        async with self.lock:
            items = {item["id"]: item for item in await self.list()}
            if not set(ids) <= items.keys():
                raise SessionError("会话列表已变化，请刷新后重新选择", 409)
            done, failed = [], []
            for sid in ids:
                try:
                    if action == "close":
                        await self.run(["kill-session", "-t", f"lt-{sid}"])
                    else:
                        meta = {key: items[sid][key] for key in META}
                        if action == "group":
                            meta["group"] = group
                        else:
                            meta["pinned"] = action == "pin"
                        await self.metadata(sid, meta)
                    done.append(sid)
                except subprocess.CalledProcessError as exc:
                    LOG.error("Batch action %s failed for %s: %s", action, sid, exc.stderr)
                    failed.append({"id": sid, "message": "会话操作失败，请刷新后重试"})
            return {"succeeded": done, "failed": failed}

    async def close(self, sid: str) -> None:
        async with self.lock:
            await self.get(sid)
            await self.run(["kill-session", "-t", f"lt-{sid}"])

    async def restart(self, sid: str) -> dict:
        async with self.lock:
            item = await self.get(sid)
            if not item["active_dead"]:
                raise SessionError("只有已经退出的分屏才能重新启动", 409)
            await self.run(
                [
                    "respawn-pane",
                    "-t",
                    item["active_pane"],
                    "-e",
                    f"LAN_TERMINAL_SESSION={sid}",
                ]
            )
            return await self.get(sid)

    async def history(self, sid: str) -> str:
        item = await self.get(sid)
        return await self.run(["capture-pane", "-p", "-t", item["active_pane"], "-S", "-20000"])
