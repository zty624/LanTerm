import asyncio
import json
import os
import shlex
import signal
import sys
from pathlib import Path

from test_terminal import command

from terminal.plugins.registry import Plugins
from terminal.plugins.rollout import LIMIT, Rollout

DRIVER = Path(__file__).parent / "fixtures/codex_process.py"


async def status(server, sid: str, expected: str) -> dict:
    async with asyncio.timeout(8):
        while True:
            response = await server.client.get("/api/plugins/status")
            response.raise_for_status()
            badges = response.json()["sessions"].get(sid, [])
            if badges and badges[0]["state"] == expected:
                assert "PRIVATE_" not in response.text
                assert "private project" not in response.text
                return badges[0]
            await asyncio.sleep(0.1)


async def test_codex_lifecycle_in_real_detached_tmux_survives_plugin_restart(server):
    assert (await server.client.get("/api/plugins/status")).status_code == 401
    await server.login()
    item = await server.create("agent", "bash")
    other = await server.create("plain shell", "bash")
    target = f"lt-{item['id']}"
    manager = server.app.state.sessions
    async with server.websocket(item["id"]) as ws:
        await command(ws, shlex.join([sys.executable, str(DRIVER)]), b"fixture:ready")
        first = await status(server, item["id"], "waiting_input")
        assert first["source"] == "lifecycle"
        for key, state in [
            ("w", "working"),
            ("a", "needs_attention"),
            ("u", "waiting_input"),
            ("r", "working"),
            ("x", "interrupted"),
            ("w", "working"),
            ("i", "waiting_input"),
        ]:
            await ws.send(key.encode())
            await status(server, item["id"], state)
    # Inactive tabs and disconnected browsers still get their Codex status.
    await manager.run(["send-keys", "-t", target, "w"])
    await status(server, item["id"], "working")
    restored = Plugins(manager, ["codex"], 0.0)
    snapshot = await restored.get()
    assert snapshot["sessions"][item["id"]][0]["state"] == "working"
    assert other["id"] not in snapshot["sessions"]
    disabled = await Plugins(manager, [], 0.0).get()
    assert disabled["plugins"] == [] and disabled["sessions"] == {}
    await manager.run(["send-keys", "-t", target, "q"])
    await status(server, item["id"], "exited")
    # Ending Codex does not end the shell or another session.
    assert (await manager.get(item["id"]))["status"] == "running"
    assert (await manager.get(other["id"]))["status"] == "running"


async def test_unknown_without_compatible_events_and_title_fallback(server):
    await server.login()
    item = await server.create("unknown", "bash")
    async with server.websocket(item["id"]) as ws:
        await command(ws, shlex.join([sys.executable, str(DRIVER), "--no-log"]), b"fixture:ready")
        await status(server, item["id"], "unknown")
        await ws.send(b"t")
        badge = await status(server, item["id"], "working")
        assert badge["source"] == "terminal_title"
        await ws.send(b"q")


async def test_two_codex_processes_in_same_directory_and_paused_agent(server):
    await server.login()
    first = await server.create("one", "bash")
    second = await server.create("two", "bash")
    async with server.websocket(first["id"]) as one, server.websocket(second["id"]) as two:
        start = shlex.join([sys.executable, str(DRIVER)])
        await command(one, start, b"fixture:ready")
        await command(two, start, b"fixture:ready")
        await one.send(b"w")
        running = await status(server, first["id"], "working")
        idle = await status(server, second["id"], "waiting_input")
        assert running["pid"] != idle["pid"]
        os.kill(running["pid"], signal.SIGSTOP)
        try:
            await status(server, first["id"], "paused")
            await status(server, second["id"], "waiting_input")
        finally:
            # A bare SIGCONT leaves the job in the background, where read() triggers SIGTTIN.
            await one.send(b"fg\r")
        await status(server, first["id"], "working")
        await one.send(b"q")
        await two.send(b"q")


def event(kind: str, **payload) -> bytes:
    return (json.dumps({"type": kind, "payload": payload}) + "\n").encode()


def test_rollout_partial_writes_rotation_and_large_tool_output(tmp_path):
    path = tmp_path / "rollout-fixture.jsonl"
    path.write_bytes(
        event("session_meta", source="cli")
        + event("event_msg", type="task_started", turn_id="first")
    )
    reader = Rollout(path)
    assert reader.read() == "working"
    complete = event("event_msg", type="task_complete", turn_id="first")
    with path.open("ab") as stream:
        stream.write(complete[:20])
    assert reader.read() == "working"
    with path.open("ab") as stream:
        stream.write(complete[20:])
    assert reader.read() == "waiting_input"
    with path.open("ab") as stream:
        stream.write(event("event_msg", type="task_started", turn_id="second"))
        stream.write(event("response_item", type="function_call_output", output="x" * (LIMIT * 2)))
        stream.write(event("event_msg", type="task_complete", turn_id="second"))
    assert reader.read() == "waiting_input"
    replacement = path.with_suffix(".new")
    replacement.write_bytes(
        event("session_meta", source="cli")
        + event("event_msg", type="task_started", turn_id="third")
    )
    replacement.replace(path)
    assert reader.read() == "working"
    path.write_bytes(b"new incompatible format\n")
    assert reader.read() == "unknown"
