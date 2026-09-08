import logging
import secrets
import subprocess
import time
from collections import defaultdict, deque
from contextlib import suppress
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response, WebSocket
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator
from starlette.requests import HTTPConnection
from starlette.websockets import WebSocketDisconnect, WebSocketState

from terminal.config import ROOT, Config, available_shells
from terminal.pty import Terminal
from terminal.sessions import SessionError, Sessions

LOG = logging.getLogger(__name__)
TTL = 7 * 24 * 3600


class Login(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


class Rename(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise ValueError("会话名称不能为空或包含控制字符")
        return value


class Create(Rename):
    shell: str
    cwd: str = Field(min_length=1, max_length=4096)


class Auth:
    def __init__(self, config: Config):
        self.config = config
        self.tokens: dict[str, float] = {}
        self.attempts: dict[str, deque] = defaultdict(deque)
        self.sockets: dict[str, set[WebSocket]] = defaultdict(set)

    def origin_ok(self, request: HTTPConnection) -> bool:
        origin = request.headers.get("origin")
        if not origin:
            return request.scope["type"] != "websocket"
        parsed = urlsplit(origin)
        scheme = "https" if request.url.scheme in ("https", "wss") else "http"
        return parsed.scheme == scheme and parsed.netloc == request.headers.get("host")

    def valid(self, request: HTTPConnection) -> bool:
        if not self.origin_ok(request):
            return False
        token = request.cookies.get(self.config.cookie, "")
        return self.tokens.get(token, 0) > time.time()

    async def require(self, request: Request) -> None:
        if not self.origin_ok(request):
            raise HTTPException(403, "不允许跨站访问")
        if not self.valid(request):
            raise HTTPException(401, "请先登录")


def create_app(config: Config) -> FastAPI:
    app = FastAPI(title="LAN Terminal", docs_url=None, redoc_url=None, openapi_url=None)
    sessions = Sessions(config)
    auth = Auth(config)
    app.state.sessions = sessions
    app.state.auth = auth

    @app.middleware("http")
    async def headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.update(
            {
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "no-referrer",
                "Content-Security-Policy": (
                    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                    "connect-src 'self'; img-src 'self' data:; font-src 'self'; "
                    "frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
                ),
            }
        )
        return response

    @app.exception_handler(SessionError)
    async def session_error(request: Request, exc: SessionError):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status)

    @app.exception_handler(subprocess.CalledProcessError)
    async def tmux_error(request: Request, exc: subprocess.CalledProcessError):
        LOG.error("tmux %s failed: %s", exc.cmd, exc.stderr)
        return JSONResponse({"detail": "tmux 操作失败，请查看服务日志"}, status_code=503)

    @app.get("/")
    async def index():
        return FileResponse(ROOT / "static/index.html")

    @app.get("/api/health")
    async def health():
        return {"status": "ok"}

    @app.post("/api/login")
    async def login(body: Login, request: Request, response: Response):
        if not auth.origin_ok(request):
            raise HTTPException(403, "不允许跨站访问")
        now = time.time()
        auth.tokens = {token: expiry for token, expiry in auth.tokens.items() if expiry > now}
        for host in list(auth.attempts):
            queue = auth.attempts[host]
            while queue and queue[0] <= now - 60:
                queue.popleft()
            if not queue:
                del auth.attempts[host]
        host = request.client.host
        queue = auth.attempts[host]
        if len(queue) >= 8:
            raise HTTPException(429, "尝试次数过多，请一分钟后重试")
        if not secrets.compare_digest(body.password.encode(), config.password.encode()):
            queue.append(now)
            raise HTTPException(401, "访问密码错误")
        if len(auth.tokens) >= 1024:
            raise HTTPException(429, "登录设备数量达到上限")
        token = secrets.token_urlsafe(32)
        auth.tokens[token] = now + TTL
        response.set_cookie(
            config.cookie,
            token,
            httponly=True,
            samesite="strict",
            max_age=TTL,
            secure=request.url.scheme == "https",
        )
        return {"status": "ok"}

    api = APIRouter(prefix="/api", dependencies=[Depends(auth.require)])

    @api.post("/logout")
    async def logout(request: Request, response: Response):
        token = request.cookies.get(config.cookie, "")
        auth.tokens.pop(token, None)
        for ws in list(auth.sockets.get(token, set())):
            if ws.application_state == WebSocketState.CONNECTED:
                with suppress(WebSocketDisconnect):
                    await ws.close(4001, "Logged out")
        response.delete_cookie(config.cookie)
        return {"status": "ok"}

    @api.get("/config")
    async def settings():
        return {
            "shells": list(available_shells()),
            "shell": Path(config.shell).name,
            "cwd": str(config.cwd),
            "max_sessions": config.max_sessions,
        }

    @api.get("/sessions")
    async def listing():
        return await sessions.list()

    @api.post("/sessions", status_code=201)
    async def create(body: Create):
        return await sessions.create(body.name, body.shell, body.cwd)

    @api.patch("/sessions/{sid}")
    async def rename(sid: str, body: Rename):
        return await sessions.rename(sid, body.name)

    @api.delete("/sessions/{sid}", status_code=204)
    async def close(sid: str):
        await sessions.close(sid)

    @api.post("/sessions/{sid}/restart")
    async def restart(sid: str):
        return await sessions.restart(sid)

    @api.get("/sessions/{sid}/history", response_class=PlainTextResponse)
    async def history(sid: str):
        return await sessions.history(sid)

    @app.websocket("/ws/{sid}")
    async def terminal(
        ws: WebSocket,
        sid: str,
        cols: Annotated[int, Field(ge=10, le=500)] = 120,
        rows: Annotated[int, Field(ge=2, le=200)] = 30,
    ):
        if not auth.valid(ws):
            await ws.close(1008)
            return
        try:
            item = await sessions.get(sid)
        except SessionError:
            await ws.close(1008)
            return
        if item["clients"] >= 8:
            await ws.close(1008)
            return
        await ws.accept()
        token = ws.cookies[config.cookie]
        auth.sockets[token].add(ws)
        try:
            await Terminal(sessions, sid, ws, cols, rows).run()
        finally:
            auth.sockets[token].discard(ws)
            if not auth.sockets[token]:
                auth.sockets.pop(token)
            if ws.application_state == WebSocketState.CONNECTED:
                with suppress(WebSocketDisconnect):
                    await ws.close()

    app.include_router(api)
    app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
    return app
