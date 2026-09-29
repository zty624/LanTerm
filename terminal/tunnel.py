"""Experimental resumable byte streams. WebSocket lifetime never owns a TCP stream."""

import asyncio
import base64
import logging
import secrets
import time
from collections import OrderedDict
from contextlib import suppress
from typing import Literal

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from starlette.websockets import WebSocketState

LOG = logging.getLogger(__name__)
CHUNK = 16384
WINDOW = 32  # At most 512 KiB of raw unacknowledged bytes per direction.
CHANNELS = 16


class Packet(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    ack: int = Field(ge=0)
    seq: int = Field(default=0, ge=0)
    op: Literal["ack", "open", "data", "fin", "reset"] = "ack"
    channel: int = Field(default=0, ge=0)
    data: str = Field(default="", max_length=21848)


class ProtocolError(ValueError):
    pass


class Stream:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader = reader
        self.writer = writer
        self.eof = False
        self.fin = False
        self.task: asyncio.Task | None = None


class Tunnel:
    def __init__(self, target: int, ttl: int):
        self.target = target  # Zero denotes the endpoint accepting local SSH clients.
        self.ttl = ttl
        self.id = secrets.token_urlsafe(24)
        self.tx = 0
        self.rx = 0
        self.acked = 0
        self.serial = 0
        self.pending: OrderedDict[int, dict] = OrderedDict()
        self.streams: dict[int, Stream] = {}
        self.changed = asyncio.Event()
        self.space = asyncio.Condition()
        self.lock = asyncio.Lock()
        self.ws: WebSocket | None = None
        self.sender: asyncio.Task | None = None
        self.seen = time.monotonic()
        self.closed = False
        self.tasks: set[asyncio.Task] = set()

    async def emit(self, op: str, channel: int, data: bytes) -> None:
        async with self.space:
            await self.space.wait_for(
                lambda: self.closed or op != "data" or len(self.pending) < WINDOW
            )
            if self.closed:
                return
            if len(self.pending) < WINDOW + CHANNELS * 4:
                self.tx += 1
                self.pending[self.tx] = {
                    "seq": self.tx,
                    "op": op,
                    "channel": channel,
                    "data": base64.b64encode(data).decode("ascii"),
                }
                self.changed.set()
                return
        # Release the condition before closing: close() wakes blocked producers.
        LOG.warning("Closing SSH tunnel: control queue full")
        await self.close()

    def track(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.done)
        return task

    def done(self, task: asyncio.Task) -> None:
        self.tasks.discard(task)
        if not task.cancelled():
            task.result()  # Unexpected failures remain visible to the event loop.

    async def accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self.closed or len(self.streams) >= CHANNELS or len(self.pending) >= WINDOW:
            writer.close()
            await writer.wait_closed()
            return
        self.serial += 1
        channel = self.serial
        stream = Stream(reader, writer)
        self.streams[channel] = stream
        await self.emit("open", channel, b"")
        if not self.closed:
            stream.task = self.track(self.read(channel, stream))

    async def read(self, channel: int, stream: Stream) -> None:
        try:
            while not self.closed:
                data = await stream.reader.read(CHUNK)
                if not data:
                    await self.emit("fin", channel, b"")
                    stream.eof = True
                    if stream.fin:
                        self.drop(channel, False)
                    return
                await self.emit("data", channel, data)
        except (ConnectionError, OSError) as exc:
            LOG.info("SSH TCP read ended: %s", exc)
            self.drop(channel, True)
            await self.emit("reset", channel, b"")

    def drop(self, channel: int, abort: bool) -> None:
        stream = self.streams.pop(channel, None)
        if stream is None:
            return
        if abort:
            stream.writer.transport.abort()
        else:
            stream.writer.close()
        if stream.task is not None and stream.task is not asyncio.current_task():
            stream.task.cancel()

    async def receive(self, packet: Packet) -> None:
        if packet.ack < self.acked or packet.ack > self.tx:
            raise ProtocolError("Invalid acknowledgement")
        async with self.space:
            self.acked = packet.ack
            while self.pending and next(iter(self.pending)) <= packet.ack:
                self.pending.popitem(last=False)
            self.space.notify_all()
        self.seen = time.monotonic()
        if packet.op == "ack":
            if packet.seq or packet.channel or packet.data:
                raise ProtocolError("Invalid acknowledgement frame")
            return
        if not packet.seq or not packet.channel:
            raise ProtocolError("Missing stream sequence")
        if packet.seq <= self.rx:
            self.changed.set()
            return
        if packet.seq != self.rx + 1:
            raise ProtocolError("Stream sequence gap")
        try:
            data = base64.b64decode(packet.data, validate=True)
        except ValueError as exc:
            raise ProtocolError("Invalid payload") from exc
        if len(data) > CHUNK or (packet.op != "data" and data):
            raise ProtocolError("Invalid payload size")
        channel = packet.channel
        if packet.op == "open":
            if not self.target or channel <= self.serial:
                raise ProtocolError("Invalid stream open")
            self.serial = channel
            if len(self.streams) >= CHANNELS:
                await self.emit("reset", channel, b"")
            else:
                try:
                    async with asyncio.timeout(5):
                        reader, writer = await asyncio.open_connection("127.0.0.1", self.target)
                except (OSError, TimeoutError) as exc:
                    LOG.info("SSH target unavailable: %s", exc)
                    await self.emit("reset", channel, b"")
                else:
                    if self.closed:
                        writer.close()
                        await writer.wait_closed()
                        return
                    stream = Stream(reader, writer)
                    self.streams[channel] = stream
                    stream.task = self.track(self.read(channel, stream))
        elif packet.op == "reset":
            self.drop(channel, True)
        elif (stream := self.streams.get(channel)) is not None:
            try:
                if packet.op == "data":
                    if stream.fin:
                        raise ProtocolError("Data after EOF")
                    stream.writer.write(data)
                    # Do not cancel this operation on a WebSocket disconnect. Commit
                    # rx before a replacement transport can replay the same bytes.
                    async with asyncio.timeout(self.ttl):
                        await stream.writer.drain()
                elif packet.op == "fin":
                    stream.fin = True
                    stream.writer.write_eof()
                    if stream.eof:
                        self.drop(channel, False)
            except (OSError, TimeoutError) as exc:
                LOG.info("SSH TCP write ended: %s", exc)
                self.drop(channel, True)
                await self.emit("reset", channel, b"")
        self.rx = packet.seq
        self.changed.set()

    async def send(self, ws: WebSocket) -> None:
        cursor = self.acked
        while not self.closed:
            self.changed.clear()
            for seq, packet in list(self.pending.items()):
                if seq > cursor:
                    await ws.send_json({**packet, "ack": self.rx})
                    cursor = seq
            await ws.send_json({"ack": self.rx})
            try:
                async with asyncio.timeout(2):
                    await self.changed.wait()
            except TimeoutError:
                pass  # Heartbeats also detect half-open transports in the browser.

    async def attach(self, ws: WebSocket) -> None:
        if self.lock.locked() or self.closed:
            await ws.close(4409, "Tunnel busy or expired")
            return
        async with self.lock:
            self.ws = ws
            await ws.send_json({"ready": True})
            sender = asyncio.create_task(self.send(ws))
            self.sender = sender

            # A failed sender closes the socket, waking the receiving handler.
            async def sending() -> None:
                try:
                    await sender
                except (WebSocketDisconnect, OSError):
                    if ws.application_state == WebSocketState.CONNECTED:
                        with suppress(WebSocketDisconnect, OSError):
                            await ws.close()

            guard = asyncio.create_task(sending())
            try:
                while not self.closed:
                    async with asyncio.timeout(15):
                        message = await ws.receive()
                        if message["type"] == "websocket.disconnect":
                            raise WebSocketDisconnect(message.get("code", 1006))
                        raw = message.get("text")
                        if raw is None:
                            raise ProtocolError("Expected text frame")
                    await self.receive(Packet.model_validate_json(raw))
            except WebSocketDisconnect as exc:
                if exc.code == 4002:
                    await self.close()
            except (OSError, TimeoutError):
                pass  # Keep TCP streams and unacknowledged data for reconnection.
            except (ValidationError, ProtocolError) as exc:
                LOG.warning("Rejected SSH tunnel protocol: %s", type(exc).__name__)
                await self.close()
                if ws.application_state == WebSocketState.CONNECTED:
                    with suppress(WebSocketDisconnect, OSError):
                        await ws.close(4400, "Tunnel state invalid; pair again")
            finally:
                sender.cancel()
                guard.cancel()
                with suppress(asyncio.CancelledError):
                    await guard
                with suppress(asyncio.CancelledError, WebSocketDisconnect, OSError):
                    await sender
                self.ws = None
                self.sender = None
                if ws.application_state == WebSocketState.CONNECTED:
                    with suppress(WebSocketDisconnect, OSError):
                        await ws.close()

    async def close(self) -> None:
        self.closed = True
        async with self.space:
            self.space.notify_all()
        for channel in list(self.streams):
            self.drop(channel, True)
        tasks = [task for task in self.tasks if task is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        self.pending.clear()
        self.changed.set()
        if self.sender is not None:
            self.sender.cancel()
        if self.ws is not None and self.ws.application_state == WebSocketState.CONNECTED:
            with suppress(WebSocketDisconnect, OSError):
                await self.ws.close(4408, "Tunnel closed or expired")


class Tunnels:
    def __init__(self, target: int, port: int, ttl: int):
        self.target = target
        self.port = port
        self.ttl = ttl
        self.local: Tunnel | None = None
        self.key = ""
        self.origin = ""
        self.owner = ""
        self.remote: dict[tuple[str, str], Tunnel] = {}
        self.server: asyncio.Server | None = None

    async def start(self) -> None:
        self.server = await asyncio.start_server(self.accept, "127.0.0.1", self.port)
        self.port = self.server.sockets[0].getsockname()[1]

    async def accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        link = self.local
        if link is None or link.closed:
            writer.close()
            await writer.wait_closed()
            return
        task = link.track(link.accept(reader, writer))
        await task

    async def pair(self, origin: str, owner: str) -> dict:
        if self.local is not None:
            await self.local.close()
        self.local = Tunnel(0, self.ttl)
        self.key = secrets.token_urlsafe(32)
        self.origin = origin
        self.owner = owner
        return {"key": self.key, "id": self.local.id, "port": self.port, "ttl": self.ttl}

    async def revoke(self, owner: str) -> None:
        if self.owner == owner and self.local is not None:
            await self.local.close()
            self.key = ""
        for (token, _), link in list(self.remote.items()):
            if token == owner:
                await link.close()

    async def sweep(self, tokens) -> None:
        while True:
            await asyncio.sleep(1)
            if self.local is not None:
                if (
                    time.monotonic() - self.local.seen > self.ttl
                    or tokens().get(self.owner, 0) <= time.time()
                ):
                    await self.local.close()
                    self.key = ""
            for key, link in list(self.remote.items()):
                if (
                    link.closed
                    or time.monotonic() - link.seen > self.ttl
                    or tokens().get(key[0], 0) <= time.time()
                ):
                    await link.close()
                    del self.remote[key]

    async def close(self) -> None:
        if self.server is not None:
            self.server.close()
        for link in [self.local, *self.remote.values()]:
            if link is not None:
                await link.close()
        if self.server is not None:
            await self.server.wait_closed()
