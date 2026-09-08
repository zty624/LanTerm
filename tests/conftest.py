import asyncio
import secrets
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

import httpx
import pytest
import uvicorn
from websockets.asyncio.client import connect

from terminal.app import create_app
from terminal.config import Config


class Server:
    def __init__(self, config: Config, url: str, app, client: httpx.AsyncClient):
        self.config = config
        self.url = url
        self.app = app
        self.client = client

    async def login(self) -> None:
        response = await self.client.post("/api/login", json={"password": self.config.password})
        response.raise_for_status()

    async def create(self, name: str, shell: str) -> dict:
        response = await self.client.post(
            "/api/sessions", json={"name": name, "shell": shell, "cwd": str(self.config.cwd)}
        )
        response.raise_for_status()
        return response.json()

    def websocket(self, sid: str):
        cookie = "; ".join(f"{key}={value}" for key, value in self.client.cookies.items())
        return connect(
            f"{self.url.replace('http:', 'ws:')}/ws/{sid}?cols=100&rows=30",
            origin=self.url,
            additional_headers={"Cookie": cookie},
        )


@pytest.fixture
async def server():
    with tempfile.TemporaryDirectory(prefix="lt-test-", dir="/tmp") as folder:
        path = Path(folder)
        config = Config(
            path, path, shutil.which("bash"), secrets.token_urlsafe(24), 8, "lt_test", ""
        )
        app = create_app(config, ["codex"])
        sock = socket.socket()
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        runner = uvicorn.Server(
            uvicorn.Config(app, log_level="critical", access_log=False, ws_max_size=131072)
        )
        task = asyncio.create_task(runner.serve(sockets=[sock]))
        async with asyncio.timeout(10):
            while not runner.started:
                if task.done():
                    task.result()
                await asyncio.sleep(0.01)
        url = f"http://127.0.0.1:{port}"
        try:
            async with httpx.AsyncClient(base_url=url, headers={"Origin": url}) as client:
                yield Server(config, url, app, client)
        finally:
            try:
                await app.state.sessions.run(["kill-server"])
            except subprocess.CalledProcessError as exc:
                if "no server running" not in exc.stderr and "No such file" not in exc.stderr:
                    raise
            runner.should_exit = True
            await asyncio.wait_for(task, 10)
