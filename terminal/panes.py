import subprocess

from terminal.config import available_shells
from terminal.sessions import SessionError, Sessions

MAX_PANES = 8


class Panes:
    def __init__(self, sessions: Sessions):
        self.sessions = sessions

    async def list(self, sid: str) -> dict:
        item = await self.sessions.get(sid)
        return {
            "name": item["name"],
            "active": item["active_pane"],
            "limit": MAX_PANES,
            "panes": [pane for pane in item["panes"] if pane["visible"]],
        }

    async def target(self, sid: str, pid: str) -> tuple[dict, dict]:
        item = await self.sessions.get(sid)
        for pane in item["panes"]:
            if pane["id"] == pid:
                if not pane["visible"]:
                    raise SessionError("当前窗口已变化，请重新打开分屏面板", 409)
                return item, pane
        raise SessionError("分屏不存在或不属于此会话", 404)

    async def split(self, sid: str, pid: str, direction: str) -> dict:
        async with self.sessions.lock:
            item, pane = await self.target(sid, pid)
            if pane["dead"]:
                raise SessionError("请先重新启动此分屏", 409)
            if item["pane_count"] >= MAX_PANES:
                raise SessionError(f"每个窗口最多 {MAX_PANES} 个分屏", 409)
            try:
                created = await self.sessions.run(
                    [
                        "split-window",
                        "-h" if direction == "horizontal" else "-v",
                        "-t",
                        pid,
                        "-c",
                        "#{pane_current_path}",
                        "-e",
                        f"LAN_TERMINAL_SESSION={sid}",
                        "-P",
                        "-F",
                        "#{pane_id}",
                        available_shells()[item["shell"]],
                        "-l",
                    ]
                )
            except subprocess.CalledProcessError as exc:
                if "no space" in exc.stderr:
                    raise SessionError("分屏空间不足，请放大窗口或减少分屏", 409) from exc
                raise
            for option, value in (
                ("pane-border-style", "fg=#596674"),
                ("pane-active-border-style", "fg=#8fdfb1"),
                ("pane-border-format", " #{pane_id} · #{pane_current_command} "),
                ("pane-border-status", "top"),
            ):
                await self.sessions.run(["set-window-option", "-t", pane["window"], option, value])
            _, result = await self.target(sid, created)
            return result

    async def action(self, sid: str, pid: str, action: str) -> dict:
        async with self.sessions.lock:
            _, pane = await self.target(sid, pid)
            if action == "select":
                await self.sessions.run(["select-pane", "-t", pid])
            elif action == "zoom":
                # Preserve zoom while selecting, then toggle it once.
                await self.sessions.run(["select-pane", "-Z", "-t", pid])
                await self.sessions.run(["resize-pane", "-Z", "-t", pid])
            elif action == "restart":
                if not pane["dead"]:
                    raise SessionError("只有已经退出的分屏才能重新启动", 409)
                await self.sessions.run(
                    [
                        "respawn-pane",
                        "-t",
                        pid,
                        "-e",
                        f"LAN_TERMINAL_SESSION={sid}",
                    ]
                )
            else:
                raise ValueError(f"Unknown pane action: {action}")
        return await self.list(sid)

    async def close(self, sid: str, pid: str) -> None:
        async with self.sessions.lock:
            item, pane = await self.target(sid, pid)
            if item["pane_count"] <= 1:
                raise SessionError("最后一个分屏请使用“关闭会话”结束", 409)
            await self.sessions.run(["kill-pane", "-t", pid])
            if item["pane_count"] == 2:
                await self.sessions.run(
                    [
                        "set-window-option",
                        "-t",
                        pane["window"],
                        "pane-border-status",
                        "off",
                    ]
                )
