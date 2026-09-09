import asyncio
import errno
import fcntl
import logging
import os
import struct
import sys
import termios
from contextlib import suppress
from typing import Annotated, Literal

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, ValidationError

from terminal.config import ROOT
from terminal.sessions import Sessions, child_env

LIMIT = 256 * 1024
LOG = logging.getLogger(__name__)


class Resize(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["resize"]
    cols: int = Field(ge=10, le=500)
    rows: int = Field(ge=2, le=200)
    width: int = Field(default=0, ge=0, le=65535)
    height: int = Field(default=0, ge=0, le=65535)


class Ack(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    type: Literal["ack"]
    size: int = Field(ge=1, le=LIMIT)


CONTROL = TypeAdapter(Annotated[Resize | Ack, Field(discriminator="type")])


async def ready(fd: int, write: bool) -> None:
    loop = asyncio.get_running_loop()
    future = loop.create_future()

    def wake() -> None:
        if not future.done():
            future.set_result(None)

    add = loop.add_writer if write else loop.add_reader
    remove = loop.remove_writer if write else loop.remove_reader
    add(fd, wake)
    try:
        await future
    finally:
        remove(fd)


class Terminal:
    """A browser gets a PTY-backed tmux client, never ownership of the shell."""

    def __init__(
        self,
        sessions: Sessions,
        sid: str,
        ws: WebSocket,
        cols: int,
        rows: int,
        width: int,
        height: int,
    ):
        self.sessions = sessions
        self.sid = sid
        self.ws = ws
        self.cols = cols
        self.rows = rows
        self.width = width
        self.height = height
        self.pending = 0
        self.flow = asyncio.Event()
        self.flow.set()
        self.fd = -1
        self.queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=128)

    def resize(self, cols: int, rows: int, width: int, height: int) -> None:
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, width, height))

    async def output(self) -> None:
        while True:
            await self.flow.wait()
            await ready(self.fd, False)
            try:
                data = os.read(self.fd, 16384)
            except BlockingIOError:
                continue
            except OSError as exc:
                if exc.errno == errno.EIO:
                    return
                raise
            if not data:
                return
            self.pending += len(data)
            if self.pending >= LIMIT - 16384:
                self.flow.clear()
            await self.ws.send_bytes(data)

    async def input(self) -> None:
        while True:
            message = await self.ws.receive()
            if message["type"] == "websocket.disconnect":
                try:
                    async with asyncio.timeout(1):
                        await self.queue.join()
                except TimeoutError:
                    LOG.warning("Terminal detached with blocked input: %s", self.sid)
                return
            data = message.get("bytes")
            if data is not None:
                if not data:
                    continue
                try:
                    self.queue.put_nowait(data)
                except asyncio.QueueFull:
                    await self.ws.close(1009, "Too much pending terminal input")
                    return
                continue
            try:
                event = CONTROL.validate_json(message.get("text", ""))
            except ValidationError:
                await self.ws.close(1008, "Invalid terminal control message")
                return
            if event.type == "resize":
                self.resize(event.cols, event.rows, event.width, event.height)
                continue
            if event.size > self.pending:
                await self.ws.close(1008, "Invalid acknowledgement")
                return
            self.pending -= event.size
            if self.pending < LIMIT // 2:
                self.flow.set()

    async def write(self) -> None:
        # Writing must not block receipt of output ACKs, even during a large paste.
        while True:
            view = memoryview(await self.queue.get())
            try:
                while view:
                    await ready(self.fd, True)
                    try:
                        size = os.write(self.fd, view)
                    except BlockingIOError:
                        continue
                    except OSError as exc:
                        if exc.errno == errno.EIO:
                            return
                        raise
                    view = view[size:]
            finally:
                self.queue.task_done()

    async def run(self) -> None:
        self.fd, slave = os.openpty()
        proc = None
        tasks = []
        try:
            try:
                os.set_blocking(self.fd, False)
                self.resize(self.cols, self.rows, self.width, self.height)
                proc = await asyncio.create_subprocess_exec(
                    sys.executable,
                    str(ROOT / "terminal/attach.py"),
                    *self.sessions.cmd,
                    "-T",
                    "RGB,sixel",
                    "attach-session",
                    "-t",
                    f"lt-{self.sid}",
                    stdin=slave,
                    stdout=slave,
                    stderr=slave,
                    start_new_session=True,
                    env=child_env(),
                )
            finally:
                os.close(slave)
            tasks = [
                asyncio.create_task(self.input()),
                asyncio.create_task(self.output()),
                asyncio.create_task(self.write()),
            ]
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for task in tasks:
                task.cancel()
            # Join everything before closing the FD. Propagate task errors below.
            await asyncio.gather(*tasks, return_exceptions=True)
            os.close(self.fd)
            if proc is not None:
                await self.reap(proc)
        for task in tasks:
            if not task.cancelled():
                with suppress(WebSocketDisconnect):
                    task.result()

    async def reap(self, proc: asyncio.subprocess.Process) -> None:
        if proc.returncode is None:
            with suppress(ProcessLookupError):
                proc.terminate()
        try:
            async with asyncio.timeout(3):
                await proc.wait()
        except TimeoutError:
            if proc.returncode is None:
                with suppress(ProcessLookupError):
                    proc.kill()
            await proc.wait()
