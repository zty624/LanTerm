import asyncio
import base64
import json
import os
import subprocess
import uuid
from pathlib import Path

from terminal.config import ROOT, Config, available_shells


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
        fmt = "#{session_name}\t#{@lt_meta}\t#{session_created}\t#{session_attached}\t#{pane_dead}"
        try:
            out = await self.run(["list-sessions", "-F", fmt])
        except subprocess.CalledProcessError as exc:
            if "no server running" in exc.stderr or (
                "error connecting to" in exc.stderr
                and any(s in exc.stderr for s in ("No such file", "Connection refused"))
            ):
                return []
            raise
        items = []
        for line in out.splitlines():
            name, encoded, created, clients, dead = line.split("\t")
            if not name.startswith("lt-") or not encoded:
                continue
            meta = json.loads(base64.urlsafe_b64decode(encoded))
            items.append(
                dict(
                    id=name[3:],
                    **meta,
                    created=int(created),
                    clients=int(clients),
                    status="exited" if dead == "1" else "running",
                )
            )
        return sorted(items, key=lambda item: (item["created"], item["id"]))

    async def get(self, sid: str) -> dict:
        for item in await self.list():
            if item["id"] == sid:
                return item
        raise SessionError("会话不存在或已经关闭", 404)

    async def metadata(self, sid: str, meta: dict) -> None:
        encoded = base64.urlsafe_b64encode(json.dumps(meta).encode()).decode()
        await self.run(["set-option", "-t", f"lt-{sid}", "@lt_meta", encoded])

    async def create(self, name: str, shell: str, cwd: str) -> dict:
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
            await self.metadata(sid, dict(name=name, shell=shell, cwd=str(path)))
            return await self.get(sid)

    async def rename(self, sid: str, name: str) -> dict:
        async with self.lock:
            item = await self.get(sid)
            await self.metadata(sid, dict(name=name, shell=item["shell"], cwd=item["cwd"]))
            return await self.get(sid)

    async def close(self, sid: str) -> None:
        async with self.lock:
            await self.get(sid)
            await self.run(["kill-session", "-t", f"lt-{sid}"])

    async def restart(self, sid: str) -> dict:
        async with self.lock:
            item = await self.get(sid)
            if item["status"] != "exited":
                raise SessionError("只有已经退出的会话才能重新启动", 409)
            await self.run(
                [
                    "respawn-pane",
                    "-t",
                    f"lt-{sid}",
                    "-c",
                    item["cwd"],
                    available_shells()[item["shell"]],
                    "-l",
                ]
            )
            return await self.get(sid)

    async def history(self, sid: str) -> str:
        await self.get(sid)
        return await self.run(["capture-pane", "-p", "-t", f"lt-{sid}", "-S", "-20000"])
