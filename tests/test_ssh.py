import asyncio
import json
import os
import pwd
import secrets
import shutil
import socket
import tempfile
from contextlib import asynccontextmanager, suppress
from pathlib import Path

import httpx
import pytest
import uvicorn
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from terminal.app import create_app
from terminal.config import Config


@asynccontextmanager
async def service(path, target, ttl):
    config = Config(path, path, shutil.which("bash"), secrets.token_urlsafe(24), 8, "lt_ssh", "")
    app = create_app(config, [], (target, 0, ttl))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    runner = uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False))
    task = asyncio.create_task(runner.serve(sockets=[sock]))
    try:
        async with asyncio.timeout(10):
            while not runner.started:
                if task.done():
                    task.result()
                await asyncio.sleep(0.01)
        async with httpx.AsyncClient(
            base_url=f"http://127.0.0.1:{port}", trust_env=False
        ) as client:
            response = await client.post("/api/login", json={"password": config.password})
            response.raise_for_status()
            yield app, client, f"ws://127.0.0.1:{port}"
    finally:
        runner.should_exit = True
        await asyncio.wait_for(task, 10)


class Browser:
    def __init__(self, local, remote, pair):
        self.local = local
        self.remote = remote
        self.pair = pair
        self.sockets = []
        self.tasks = []
        self.paused = False
        self.drop_acks = False
        self.hold = asyncio.Event()

    async def start(self):
        origin = str(self.remote[1].base_url).rstrip("/")
        cookie = "; ".join(f"{key}={value}" for key, value in self.remote[1].cookies.items())
        one = await connect(f"{self.local[2]}/ssh/bridge/local", origin=origin)
        self.sockets.append(one)
        await one.send(json.dumps({"id": self.pair["id"], "key": self.pair["key"]}))
        assert json.loads(await one.recv()) == {"ready": True}
        two = await connect(
            f"{self.remote[2]}/ssh/bridge/remote",
            origin=origin,
            additional_headers={"Cookie": cookie},
        )
        self.sockets.append(two)
        await two.send(json.dumps({"id": self.pair["id"]}))
        assert json.loads(await two.recv()) == {"ready": True}
        self.tasks = [
            asyncio.create_task(self.forward(one, two, False)),
            asyncio.create_task(self.forward(two, one, True)),
        ]

    async def forward(self, source, target, reverse):
        try:
            async for message in source:
                if self.paused:
                    await self.hold.wait()
                if reverse and self.drop_acks:
                    packet = json.loads(message)
                    packet["ack"] = 0
                    message = json.dumps(packet)
                await target.send(message)
        except ConnectionClosed:
            pass

    async def cut(self):
        for task in self.tasks:
            task.cancel()
        for task in self.tasks:
            with suppress(asyncio.CancelledError):
                await task
        for ws in self.sockets:
            ws.transport.abort()
            await ws.wait_closed()
        self.sockets = []
        self.tasks = []
        links = [self.local[0].state.tunnels.local, *self.remote[0].state.tunnels.remote.values()]
        async with asyncio.timeout(5):
            while any(link.lock.locked() for link in links):
                await asyncio.sleep(0.02)


@pytest.fixture
async def pair():
    async def echo(reader, writer):
        try:
            while data := await reader.read(16384):
                writer.write(data)
                await writer.drain()
        except ConnectionError:
            pass
        finally:
            writer.close()
            await writer.wait_closed()

    echo_server = await asyncio.start_server(echo, "127.0.0.1", 0)
    port = echo_server.sockets[0].getsockname()[1]
    try:
        with tempfile.TemporaryDirectory(prefix="lt-ssh-", dir="/tmp") as folder:
            path = Path(folder)
            async with service(path, port, 30) as local, service(path, port, 30) as remote:
                response = await local[1].post(
                    "/api/ssh/pair", json={"origin": str(remote[1].base_url)}
                )
                response.raise_for_status()
                browser = Browser(local, remote, response.json())
                try:
                    yield browser
                finally:
                    await browser.cut()
    finally:
        echo_server.close()
        await echo_server.wait_closed()


async def test_replay_after_ack_loss_keeps_exact_bytes_and_half_close(pair):
    pair.drop_acks = True
    await pair.start()
    reader, writer = await asyncio.open_connection("127.0.0.1", pair.pair["port"])
    data = bytes(range(256)) * 512
    writer.write(data)
    await writer.drain()
    assert await asyncio.wait_for(reader.readexactly(len(data)), 5) == data
    # The target has written all bytes, but its ACKs never reached the source.
    assert pair.local[0].state.tunnels.local.pending
    await pair.cut()
    pair.drop_acks = False
    writer.write(b"after-reconnect\n")
    await writer.drain()
    await pair.start()
    assert await asyncio.wait_for(reader.readexactly(16), 5) == b"after-reconnect\n"
    writer.write_eof()
    assert await asyncio.wait_for(reader.read(), 5) == b""
    writer.close()
    await writer.wait_closed()


async def test_multiple_streams_resume_under_buffer_pressure(pair):
    await pair.start()
    clients = [await asyncio.open_connection("127.0.0.1", pair.pair["port"]) for _ in range(3)]
    pair.paused = True
    payload = bytes(range(256)) * 8192

    async def transfer(reader, writer):
        writer.write(payload)
        await writer.drain()
        writer.write_eof()
        assert await reader.readexactly(len(payload)) == payload
        assert await reader.read() == b""
        writer.close()
        await writer.wait_closed()

    jobs = [asyncio.create_task(transfer(*client)) for client in clients]
    await asyncio.sleep(0.2)
    assert len(pair.local[0].state.tunnels.local.pending) <= 32
    await pair.cut()
    pair.paused = False
    await pair.start()
    await asyncio.wait_for(asyncio.gather(*jobs), 20)


async def test_local_pair_origin_auth_expiry_and_logout(pair):
    with pytest.raises(InvalidStatus):
        async with connect(f"{pair.local[2]}/ssh/bridge/local", origin="https://wrong.invalid"):
            pass
    async with connect(
        f"{pair.local[2]}/ssh/bridge/local", origin=str(pair.remote[1].base_url).rstrip("/")
    ) as ws:
        await ws.send(json.dumps({"id": pair.pair["id"], "key": "incorrect"}))
        with pytest.raises(ConnectionClosed):
            await ws.recv()
    with pytest.raises(InvalidStatus):
        async with connect(f"{pair.remote[2]}/ssh/bridge/remote"):
            pass
    await pair.start()
    reader, writer = await asyncio.open_connection("127.0.0.1", pair.pair["port"])
    writer.write(b"alive")
    assert await reader.readexactly(5) == b"alive"
    pair.local[0].state.tunnels.local.ttl = 1
    pair.local[0].state.tunnels.ttl = 1
    await pair.cut()
    assert await asyncio.wait_for(reader.read(), 6) == b""
    writer.close()
    await writer.wait_closed()
    response = await pair.local[1].post(
        "/api/ssh/pair", json={"origin": str(pair.remote[1].base_url)}
    )
    pair.pair = response.json()
    await pair.start()
    await pair.local[1].post("/api/logout")
    async with asyncio.timeout(3):
        while not pair.local[0].state.tunnels.local.closed:
            await asyncio.sleep(0.01)


@asynccontextmanager
async def sshd(path):
    for name in ("host", "client"):
        keygen = await asyncio.create_subprocess_exec(
            "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(path / name)
        )
        assert await keygen.wait() == 0
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    config = path / "sshd_config"
    config.write_text(
        f"Port {port}\nListenAddress 127.0.0.1\nHostKey {path / 'host'}\n"
        f"PidFile {path / 'sshd.pid'}\nAuthorizedKeysFile {path / 'client.pub'}\n"
        "StrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n"
        "UsePAM no\nPrintMotd no\nSubsystem sftp internal-sftp\n"
    )
    (path / "known_hosts").write_text("lanterm-test " + (path / "host.pub").read_text())
    log = (path / "sshd.log").open("w+")
    proc = await asyncio.create_subprocess_exec(
        shutil.which("sshd"), "-D", "-e", "-f", str(config), stderr=log
    )
    try:
        async with asyncio.timeout(5):
            while True:
                if proc.returncode is not None:
                    log.seek(0)
                    pytest.fail(log.read())
                try:
                    _, writer = await asyncio.open_connection("127.0.0.1", port)
                except ConnectionRefusedError:
                    await asyncio.sleep(0.05)
                    continue
                writer.close()
                await writer.wait_closed()
                break
        yield port
    finally:
        if proc.returncode is None:
            proc.terminate()
        await proc.wait()
        log.close()


async def test_real_ssh_process_survives_transport_replacement(tmp_path):
    async with sshd(tmp_path) as port:
        async with service(tmp_path, port, 30) as local, service(tmp_path, port, 30) as remote:
            response = await local[1].post(
                "/api/ssh/pair", json={"origin": str(remote[1].base_url)}
            )
            browser = Browser(local, remote, response.json())
            await browser.start()
            proc = await asyncio.create_subprocess_exec(
                "ssh",
                "-T",
                "-p",
                str(browser.pair["port"]),
                "-i",
                str(tmp_path / "client"),
                "-o",
                "BatchMode=yes",
                "-o",
                "IdentitiesOnly=yes",
                "-o",
                "HostKeyAlias=lanterm-test",
                "-o",
                "StrictHostKeyChecking=yes",
                "-o",
                f"UserKnownHostsFile={tmp_path / 'known_hosts'}",
                f"{pwd.getpwuid(os.getuid()).pw_name}@127.0.0.1",
                "printf 'ready:%s\\n' $$; read line; printf 'done:%s:%s\\n' $$ \"$line\"",
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            try:
                first = await asyncio.wait_for(proc.stdout.readline(), 10)
                if not first:
                    pytest.fail((await proc.stderr.read()).decode())
                pid = first.decode().strip().split(":")[1]
                await browser.cut()
                proc.stdin.write(b"still-the-same-ssh\n")
                await proc.stdin.drain()
                await asyncio.sleep(0.2)
                assert proc.returncode is None
                await browser.start()
                result = await asyncio.wait_for(proc.stdout.readline(), 10)
                assert result == f"done:{pid}:still-the-same-ssh\n".encode()
                assert await asyncio.wait_for(proc.wait(), 5) == 0
            finally:
                if proc.returncode is None:
                    proc.kill()
                    await proc.wait()
                await browser.cut()


async def test_stop_releases_blocked_tcp_and_invalid_packets_end_tunnel(pair):
    await pair.start()
    reader, writer = await asyncio.open_connection("127.0.0.1", pair.pair["port"])
    writer.write(b"x" * (4 * 1024 * 1024))
    await writer.drain()
    await asyncio.sleep(0.1)
    # Do not read the echo: shutdown must discard pending writes instead of
    # waiting indefinitely for this stalled client to consume its output.
    await asyncio.wait_for(pair.local[0].state.tunnels.close(), 3)
    writer.transport.abort()
    await pair.cut()
    response = await pair.local[1].post(
        "/api/ssh/pair", json={"origin": str(pair.remote[1].base_url)}
    )
    pair.pair = response.json()
    await pair.start()
    await pair.sockets[0].send(b"invalid binary frame")
    async with asyncio.timeout(3):
        while not pair.local[0].state.tunnels.local.closed:
            await asyncio.sleep(0.01)
