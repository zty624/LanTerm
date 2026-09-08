import asyncio
import json
import re
import secrets
import shutil

import httpx
import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from terminal.sessions import Sessions


async def until(ws, marker: bytes) -> bytes:
    output = bytearray()
    try:
        async with asyncio.timeout(12):
            while marker not in output:
                chunk = await ws.recv()
                assert type(chunk) is bytes
                output.extend(chunk)
                await ws.send(json.dumps({"type": "ack", "size": len(chunk)}))
    except TimeoutError as exc:
        raise AssertionError(f"Missing {marker!r}, received {bytes(output[-4000:])!r}") from exc
    return bytes(output)


async def command(ws, text: str, marker: bytes) -> bytes:
    await ws.send((text + "\r").encode())
    return await until(ws, marker)


async def test_authentication_and_cross_site_rejection(server):
    assert (await server.client.get("/api/sessions")).status_code == 401
    assert (await server.client.post("/api/sessions", json={})).status_code == 401
    assert (await server.client.post("/api/login", json={"password": "wrong"})).status_code == 401
    await server.login()
    item = await server.create("auth", "bash")
    url = server.url.replace("http:", "ws:") + "/ws/" + item["id"]
    with pytest.raises(InvalidStatus):
        async with connect(url, origin=server.url):
            pytest.fail("Unauthenticated WebSocket was accepted")
    cookie = f"{server.config.cookie}={server.client.cookies[server.config.cookie]}"
    with pytest.raises(InvalidStatus):
        async with connect(
            url, origin="http://untrusted.example", additional_headers={"Cookie": cookie}
        ):
            pytest.fail("Cross-site WebSocket was accepted")
    response = await server.client.post(
        "/api/sessions",
        headers={"Origin": "http://untrusted.example"},
        json={"name": "blocked", "shell": "bash", "cwd": str(server.config.cwd)},
    )
    assert response.status_code == 403
    async with server.websocket(item["id"]) as ws:
        await until(ws, b"\x1b")
        assert (await server.client.post("/api/logout")).status_code == 200
        with pytest.raises(ConnectionClosed):
            while True:
                await ws.recv()
    assert (await server.client.get("/api/sessions")).status_code == 401


@pytest.mark.parametrize("shell", ["bash", "zsh"])
async def test_real_tty_job_control_resize_and_unicode(server, shell):
    if not shutil.which(shell):
        pytest.skip(f"{shell} is not installed")
    await server.login()
    item = await server.create("交互终端", shell)
    async with server.websocket(item["id"]) as ws:
        output = await command(
            ws,
            "stty -echo; if test -t 0 && test -t 1 && test -t 2; then printf 'tty:%s\\n' yes; fi",
            b"tty:yes",
        )
        assert b"no job control" not in output
        await ws.send(json.dumps({"type": "resize", "cols": 110, "rows": 37}))
        async with asyncio.timeout(5):
            while (
                await server.app.state.sessions.run(
                    [
                        "display-message",
                        "-p",
                        "-t",
                        f"lt-{item['id']}",
                        "#{pane_height} #{pane_width}",
                    ]
                )
                != "37 110"
            ):
                await asyncio.sleep(0.05)
        # tmux publishes its layout before its deferred kernel PTY resize completes.
        await command(
            ws,
            "for i in {1..100}; do size=$(stty size); "
            "[ \"$size\" = '37 110' ] && break; sleep 0.05; done; "
            "printf 'size:%s\\n' \"$size\"",
            b"size:37 110",
        )
        await command(
            ws, "printf 'unicode:%s\\n' '中文你好 λ 🚀'", "unicode:中文你好 λ 🚀".encode()
        )
        await ws.send(b"sleep 30\r")
        await asyncio.sleep(0.15)
        await ws.send(b"\x1a")
        await asyncio.sleep(0.15)
        output = await command(ws, "jobs; printf 'jobs:%s\\n' done", b"jobs:done")
        assert re.search(rb"[Ss](?:topped|uspended)", output)
        await ws.send(b"fg\r")
        await asyncio.sleep(0.15)
        await ws.send(b"\x03")
        await command(ws, "printf 'interrupt:%s\\n' ok", b"interrupt:ok")
        await command(ws, "printf 'prefix:%s\\n' passed", b"prefix:passed")


async def test_sessions_isolation_rename_and_reconnect(server):
    await server.login()
    first = await server.create("first", "bash")
    second = await server.create("second", "bash")
    value = secrets.token_hex(5)
    async with server.websocket(first["id"]) as ws:
        await command(
            ws,
            f"export LT_PROBE={value}; printf 'value:%s\\n' \"$LT_PROBE\"",
            f"value:{value}".encode(),
        )
        await command(ws, "printf 'pid:%s\\n' \"$$\"", b"pid:")
    renamed = await server.client.patch(
        f"/api/sessions/{first['id']}", json={"name": "Codex · 开发"}
    )
    assert renamed.json()["id"] == first["id"]
    assert renamed.json()["name"] == "Codex · 开发"
    # A brand-new manager discovers the sessions entirely from the running tmux server.
    recovered = await Sessions(server.config).get(first["id"])
    assert recovered["name"] == "Codex · 开发"
    async with server.websocket(first["id"]) as ws:
        await command(
            ws, "printf 'reconnected:%s\\n' \"$LT_PROBE\"", f"reconnected:{value}".encode()
        )
    async with server.websocket(second["id"]) as ws:
        await command(ws, "printf 'isolated:%s\\n' \"${LT_PROBE:-empty}\"", b"isolated:empty")
    history = await server.client.get(f"/api/sessions/{first['id']}/history")
    assert f"reconnected:{value}" in history.text
    assert (await server.client.delete(f"/api/sessions/{first['id']}")).status_code == 204
    assert [item["id"] for item in (await server.client.get("/api/sessions")).json()] == [
        second["id"]
    ]


async def test_vim_edit_save_and_shell_exit_restart(server):
    await server.login()
    item = await server.create("vim", "bash")
    async with server.websocket(item["id"]) as ws:
        await command(ws, "stty -echo; printf 'start:%s\\n' vim", b"start:vim")
        await ws.send(b"vim -Nu NONE -n sample.txt\r")
        await asyncio.sleep(0.4)
        await ws.send("i真正的终端\rsecond line\x1b:wq\r".encode())
        await asyncio.sleep(0.2)
        await command(
            ws, "printf 'file:%s\\n' \"$(head -1 sample.txt)\"", "file:真正的终端".encode()
        )
        await ws.send(b"exit\r")
        async with asyncio.timeout(5):
            while (await server.app.state.sessions.get(item["id"]))["status"] != "exited":
                await asyncio.sleep(0.05)
    assert (await server.client.post(f"/api/sessions/{item['id']}/restart")).status_code == 200
    async with server.websocket(item["id"]) as ws:
        await command(ws, "printf 'restarted:%s\\n' ok", b"restarted:ok")


async def test_two_clients_and_output_backpressure(server):
    await server.login()
    item = await server.create("shared", "bash")
    async with server.websocket(item["id"]) as first, server.websocket(item["id"]) as second:
        await command(first, "stty -echo; printf 'shared:%s\\n' output", b"shared:output")
        await until(second, b"shared:output")
        await first.send(b"yes\r")
        # Do not acknowledge output temporarily: memory stays bounded by the window.
        await asyncio.sleep(0.3)
        await first.send(b"\x03")
        await command(first, "printf 'flood:%s\\n' stopped", b"flood:stopped")


async def test_invalid_messages_and_input_validation(server):
    await server.login()
    assert (
        await server.client.post(
            "/api/sessions", json={"name": " ", "shell": "bash", "cwd": "/tmp"}
        )
    ).status_code == 422
    assert (
        await server.client.post(
            "/api/sessions",
            json={"name": "bad", "shell": "bash", "cwd": "/nonexistent/lan-terminal-test"},
        )
    ).status_code == 400
    item = await server.create("validation", "bash")
    async with server.websocket(item["id"]) as ws:
        await ws.send(json.dumps({"type": "resize", "cols": -1, "rows": 0}))
        with pytest.raises(ConnectionClosed) as error:
            while True:
                await ws.recv()
        assert error.value.rcvd.code == 1008
    assert (await server.client.get("/api/sessions")).status_code == 200
    assert (await server.client.post(f"/api/sessions/{item['id']}/restart")).status_code == 409


async def test_login_rate_limit(server):
    async with httpx.AsyncClient(base_url=server.url) as client:
        for _ in range(8):
            assert (await client.post("/api/login", json={"password": "wrong"})).status_code == 401
        assert (await client.post("/api/login", json={"password": "wrong"})).status_code == 429
