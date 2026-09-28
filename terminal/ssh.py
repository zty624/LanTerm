"""HTTP and browser bridge entry points for the opt-in SSH tunnel."""

import asyncio
import secrets
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, WebSocket
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.websockets import WebSocketDisconnect

from terminal.config import ASSETS
from terminal.tunnel import Tunnel, Tunnels


class Pair(BaseModel):
    origin: str = Field(max_length=2048)


class Hello(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    key: str = Field(default="", max_length=128)


def install(app: FastAPI, auth, hub: Tunnels) -> None:
    api = APIRouter(prefix="/api/ssh", dependencies=[Depends(auth.require)])

    @app.get("/ssh")
    async def page():
        return FileResponse(ASSETS / "ssh.html")

    @api.get("")
    async def status():
        local = hub.local
        return {
            "target": hub.target,
            "port": hub.port,
            "ttl": hub.ttl,
            "paired": local is not None and not local.closed,
            "connected": local is not None and local.ws is not None and not local.closed,
            "streams": len(local.streams) if local else 0,
        }

    @api.post("/pair")
    async def pair(body: Pair, request: Request):
        try:
            url = urlsplit(body.origin)
        except ValueError as exc:
            raise HTTPException(422, "无效的远端地址") from exc
        if (
            url.scheme not in ("http", "https")
            or not url.netloc
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise HTTPException(422, "请输入远端 LanTerm 的完整 HTTP(S) 地址")
        origin = f"{url.scheme}://{url.netloc.lower()}"
        return await hub.pair(origin, request.cookies[auth.config.cookie])

    @api.delete("/pair")
    async def revoke(request: Request):
        await hub.revoke(request.cookies[auth.config.cookie])
        return {"status": "ok"}

    @app.websocket("/ssh/bridge/{side}")
    async def bridge(ws: WebSocket, side: str):
        if side not in ("local", "remote"):
            await ws.close(1008)
            return
        if side == "remote" and not auth.valid(ws):
            await ws.close(1008)
            return
        if side == "local" and (
            ws.client.host not in ("127.0.0.1", "::1")
            or not hub.key
            or ws.headers.get("origin") != hub.origin
        ):
            await ws.close(1008)
            return
        await ws.accept()
        try:
            async with asyncio.timeout(5):
                message = await ws.receive()
                if message["type"] == "websocket.disconnect":
                    return
                raw = message.get("text")
                if raw is None:
                    await ws.close(4400, "Expected text pairing")
                    return
                hello = Hello.model_validate_json(raw)
        except (ValidationError, TimeoutError):
            await ws.close(4400, "Invalid pairing")
            return
        except WebSocketDisconnect:
            return
        if side == "local":
            link = hub.local
            if (
                link is None
                or hello.id != link.id
                or not secrets.compare_digest(hello.key, hub.key)
                or not hub.key
            ):
                await ws.close(4403, "Pairing expired or invalid")
                return
            await link.attach(ws)
            return
        token = ws.cookies[auth.config.cookie]
        key = (token, hello.id)
        link = hub.remote.get(key)
        if link is None:
            if len(hub.remote) >= 8:
                await ws.close(4429, "Too many tunnels")
                return
            link = Tunnel(hub.target, hub.ttl)
            hub.remote[key] = link
        auth.sockets[token].add(ws)
        try:
            await link.attach(ws)
        finally:
            auth.sockets[token].discard(ws)
            if not auth.sockets[token]:
                auth.sockets.pop(token, None)

    app.include_router(api)
