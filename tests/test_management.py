import asyncio
from pathlib import Path

from test_terminal import command

from terminal.sessions import Sessions


async def test_metadata_survives_rename_and_manager_restart(server):
    await server.login()
    item = await server.create("development", "bash")
    updates = {"group": "实验", "tags": ["GPU", "推理"], "pinned": True, "note": "下一步检查结果"}
    response = await server.client.patch(f"/api/sessions/{item['id']}", json=updates)
    response.raise_for_status()
    await server.client.patch(f"/api/sessions/{item['id']}", json={"name": "renamed"})
    restored = await Sessions(server.config).get(item["id"])
    assert restored["name"] == "renamed"
    assert {key: restored[key] for key in updates} == updates
    assert restored["pid"] > 0


async def test_duplicate_uses_current_directory_and_fresh_shell(server):
    await server.login()
    item = await server.create("source", "bash")
    await server.client.patch(
        f"/api/sessions/{item['id']}", json={"group": "train", "tags": ["run"], "pinned": True}
    )
    async with server.websocket(item["id"]) as ws:
        await command(
            ws,
            "mkdir nested; cd nested; export LT_CLONE=old; printf 'ready:%s\\n' copy",
            b"ready:copy",
        )
        response = await server.client.post(f"/api/sessions/{item['id']}/duplicate")
        response.raise_for_status()
        clone = response.json()
        assert clone["id"] != item["id"] and clone["pid"] != item["pid"]
        assert clone["cwd"] == str(server.config.cwd / "nested")
        assert clone["group"] == "train" and clone["tags"] == ["run"] and not clone["pinned"]
        async with server.websocket(clone["id"]) as copied:
            await command(copied, "printf 'clone:%s\\n' \"${LT_CLONE:-fresh}\"", b"clone:fresh")
        await command(ws, "printf 'original:%s\\n' \"$LT_CLONE\"", b"original:old")


async def test_batch_validates_selection_and_preserves_unselected(server):
    await server.login()
    first = await server.create("one", "bash")
    second = await server.create("two", "bash")
    third = await server.create("keep", "bash")
    ids = [first["id"], second["id"]]
    response = await server.client.post(
        "/api/sessions/batch", json={"ids": ids, "action": "group", "group": "训练"}
    )
    assert response.json()["succeeded"] == ids
    await server.client.post("/api/sessions/batch", json={"ids": ids, "action": "pin"})
    invalid = await server.client.post(
        "/api/sessions/batch", json={"ids": [*ids, "missing"], "action": "close"}
    )
    assert invalid.status_code == 409
    assert len((await server.client.get("/api/sessions")).json()) == 3
    await server.client.post("/api/sessions/batch", json={"ids": ids, "action": "close"})
    remaining = (await server.client.get("/api/sessions")).json()
    assert [item["id"] for item in remaining] == [third["id"]]
    assert remaining[0]["group"] == "" and not remaining[0]["pinned"]


async def test_resources_require_login_and_include_real_child_process(server):
    assert (await server.client.get("/api/metrics")).status_code == 401
    await server.login()
    item = await server.create("resources", "bash")
    async with server.websocket(item["id"]) as ws:
        await command(ws, "sleep 30 & printf 'child:%s\\n' started", b"child:started")
        response = await server.client.get("/api/metrics")
        response.raise_for_status()
        metrics = response.json()
        usage = metrics["sessions"][item["id"]]
        assert usage["process_count"] >= 2
        assert "sleep" in [proc["name"] for proc in usage["processes"]]
        assert usage["rss_bytes"] > 0
        assert usage["cwd"] == str(server.config.cwd)
        assert metrics["disk"]["total"] > metrics["disk"]["used"] > 0
        assert metrics["cpu"]["cores_limit"] > 0
        assert (await server.client.get("/api/metrics")).json()["timestamp"] == metrics["timestamp"]
        await asyncio.sleep(3.1)
        second = (await server.client.get("/api/metrics")).json()
        assert second["cpu"]["percent"] is not None
        assert len(second["history"]) >= 2
        detail = (await server.client.get(f"/api/sessions/{item['id']}")).json()
        assert detail["resources"]["process_count"] >= 2


async def test_old_session_metadata_is_upgraded_in_memory(server):
    await server.login()
    item = await server.create("legacy", "bash")
    manager = server.app.state.sessions
    await manager.metadata(
        item["id"], {"name": "legacy", "shell": "bash", "cwd": str(Path("/tmp"))}
    )
    restored = await manager.get(item["id"])
    assert restored["group"] == "" and restored["tags"] == [] and restored["note"] == ""
    await manager.rename(item["id"], "upgraded")
    assert (await manager.get(item["id"]))["name"] == "upgraded"
