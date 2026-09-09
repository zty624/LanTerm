import asyncio
import shlex
import sys
from pathlib import Path
from urllib.parse import quote

from test_terminal import command

from terminal.sessions import Sessions


async def panes(server, sid: str) -> dict:
    response = await server.client.get(f"/api/sessions/{sid}/panes")
    response.raise_for_status()
    return response.json()


async def split(server, sid: str, pid: str, direction: str) -> dict:
    response = await server.client.post(
        f"/api/sessions/{sid}/panes", json={"pane": pid, "direction": direction}
    )
    response.raise_for_status()
    return response.json()


async def action(server, sid: str, pid: str, value: str) -> dict:
    response = await server.client.post(
        f"/api/sessions/{sid}/panes/action", json={"pane": pid, "action": value}
    )
    response.raise_for_status()
    return response.json()


async def close(server, sid: str, pid: str) -> None:
    response = await server.client.delete(f"/api/sessions/{sid}/panes/{quote(pid, safe='')}")
    response.raise_for_status()


async def test_native_splits_keep_shells_directories_metrics_and_reconnect(server):
    await server.login()
    item = await server.create("split", "bash")
    sid = item["id"]
    first = item["panes"][0]
    async with server.websocket(sid) as ws:
        await command(
            ws,
            "mkdir nested; cd nested; export LT_SPLIT=left; printf 'left:%s\\n' ready",
            b"left:ready",
        )
        right = await split(server, sid, first["id"], "horizontal")
        assert right["x"] > first["x"] and right["pid"] != first["pid"]
        await command(ws, "printf 'right:%s\\n' \"${LT_SPLIT:-fresh}\"; pwd", b"right:fresh")
        cwd = await asyncio.to_thread(Path(f"/proc/{right['pid']}/cwd").resolve)
        assert cwd == server.config.cwd / "nested"
        await command(ws, "sleep 30 & printf 'child:%s\\n' started", b"child:started")
        await action(server, sid, first["id"], "select")
        await command(ws, "printf 'left:%s\\n' \"$LT_SPLIT\"", b"left:left")
        lower = await split(server, sid, first["id"], "vertical")
        assert lower["y"] > first["y"] and lower["x"] == first["x"]
        await command(ws, "export LT_SPLIT=lower; printf 'lower:%s\\n' ready", b"lower:ready")
        metrics = await server.client.get("/api/metrics")
        metrics.raise_for_status()
        processes = metrics.json()["sessions"][sid]["processes"]
        assert {first["pid"], right["pid"], lower["pid"]} <= {proc["pid"] for proc in processes}
        assert any(proc["name"] == "sleep" for proc in processes)
    saved = await Sessions(server.config).get(sid)
    assert saved["pane_count"] == 3 and saved["status"] == "running"
    assert {pane["pid"] for pane in saved["panes"]} == {first["pid"], right["pid"], lower["pid"]}
    async with server.websocket(sid) as ws:
        await command(ws, "printf 'restored:%s\\n' \"$LT_SPLIT\"", b"restored:lower")
        await close(server, sid, lower["id"])
        zoomed = await action(server, sid, right["id"], "zoom")
        assert all(pane["zoomed"] for pane in zoomed["panes"])
        restored = await action(server, sid, right["id"], "zoom")
        assert not any(pane["zoomed"] for pane in restored["panes"])
        await ws.send(b"exit\r")
        async with asyncio.timeout(5):
            while not (await server.app.state.sessions.get(sid))["active_dead"]:
                await asyncio.sleep(0.05)
        assert (await server.app.state.sessions.get(sid))["status"] == "running"
        await action(server, sid, right["id"], "restart")
        await command(ws, "printf 'respawn:%s\\n' ready", b"respawn:ready")
        current = await panes(server, sid)
        new_right = next(pane for pane in current["panes"] if pane["id"] == right["id"])
        assert new_right["pid"] != right["pid"]
        cwd = await asyncio.to_thread(Path(f"/proc/{new_right['pid']}/cwd").resolve)
        assert cwd == server.config.cwd / "nested"
        await close(server, sid, right["id"])
        await command(ws, "printf 'survivor:%s\\n' \"$LT_SPLIT\"", b"survivor:left")
        assert (await server.app.state.sessions.get(sid))["pid"] == first["pid"]


async def test_pane_actions_validate_ownership_last_pane_and_limit(server):
    assert (await server.client.get("/api/sessions/missing/panes")).status_code == 401
    await server.login()
    owner = await server.create("owner", "bash")
    other = await server.create("other", "bash")
    sid, foreign = owner["id"], other["active_pane"]
    url = f"/api/sessions/{sid}/panes"
    assert (
        await server.client.post(url, json={"pane": foreign, "direction": "horizontal"})
    ).status_code == 404
    for value in ("select", "zoom", "restart"):
        assert (
            await server.client.post(url + "/action", json={"pane": foreign, "action": value})
        ).status_code == 404
    assert (await server.client.delete(url + "/" + quote(foreign, safe=""))).status_code == 404
    assert (
        await server.client.delete(url + "/" + quote(owner["active_pane"], safe=""))
    ).status_code == 409
    assert (
        await server.client.post(url, json={"pane": owner["active_pane"], "direction": "diagonal"})
    ).status_code == 422
    assert (
        await server.client.post(
            url + "/action", json={"pane": owner["active_pane"], "action": "restart"}
        )
    ).status_code == 409
    while len((data := await panes(server, sid))["panes"]) < data["limit"]:
        target = max(data["panes"], key=lambda pane: pane["cols"] * pane["rows"])
        direction = "horizontal" if target["cols"] > 2 * target["rows"] else "vertical"
        await split(server, sid, target["id"], direction)
    assert (
        await server.client.post(url, json={"pane": data["active"], "direction": "horizontal"})
    ).status_code == 409
    assert (await server.app.state.sessions.get(other["id"]))["pid"] == other["pid"]


async def test_codex_plugin_tracks_both_panes_after_one_is_closed(server):
    await server.login()
    item = await server.create("agents", "bash")
    sid, first = item["id"], item["active_pane"]
    driver = Path(__file__).parent / "fixtures/codex_process.py"
    start = shlex.join([sys.executable, str(driver)])
    async with server.websocket(sid) as ws:
        await command(ws, start, b"fixture:ready")
        right = await split(server, sid, first, "horizontal")
        await command(ws, start, b"fixture:ready")
        await server.app.state.sessions.run(["send-keys", "-t", first, "w"])
        async with asyncio.timeout(8):
            while True:
                response = await server.client.get("/api/plugins/status")
                response.raise_for_status()
                badges = response.json()["sessions"].get(sid, [])
                states = {badge["pane"]: badge["state"] for badge in badges}
                if states == {first: "working", right["id"]: "waiting_input"}:
                    break
                await asyncio.sleep(0.1)
        await close(server, sid, right["id"])
        async with asyncio.timeout(8):
            while True:
                response = await server.client.get("/api/plugins/status")
                badges = response.json()["sessions"].get(sid, [])
                if len(badges) == 1 and badges[0]["pane"] == first:
                    assert badges[0]["state"] == "working"
                    break
                await asyncio.sleep(0.1)
