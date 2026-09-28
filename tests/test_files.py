import asyncio
import base64
import os
import shlex

from fixtures.preview_files import create
from test_terminal import command

from terminal.files import TEXT_LIMIT


async def test_preview_uses_live_pane_directory_and_requires_login(server):
    assert (
        await server.client.get(
            "/api/sessions/none/file",
            params={
                "path": "/etc/hostname",
                "pane": "%0",
            },
        )
    ).status_code == 401
    await server.login()
    item = await server.create("preview", "bash")
    folder = server.config.cwd / "project with spaces"
    folder.mkdir()
    path = folder / "中文.md"
    path.write_text("# Preview\n<script>window.injected = true</script>\n")
    route = f"/api/sessions/{item['id']}/file"
    async with server.websocket(item["id"]) as ws:
        await command(ws, f'cd {shlex.quote(str(folder))}; printf "cwd:%s\\n" ready', b"cwd:ready")
        response = await server.client.get(
            route, params={"path": "./中文.md", "pane": item["active_pane"]}
        )
        response.raise_for_status()
        data = response.json()
        assert data["path"] == str(path)
        assert data["content"] == path.read_text()
        assert data["kind"] == "text"
        listing = await server.client.get(route, params={"path": ".", "pane": item["active_pane"]})
        assert listing.json()["entries"] == [{"name": "中文.md", "directory": False}]
        link = folder / "alias.md"
        link.symlink_to(path)
        assert (
            await server.client.get(
                route,
                params={
                    "path": str(link),
                    "pane": item["active_pane"],
                },
            )
        ).json()["content"] == path.read_text()
    other = await server.create("other", "bash")
    assert (
        await server.client.get(
            route,
            params={
                "path": str(path),
                "pane": other["active_pane"],
            },
        )
    ).status_code == 404
    await server.client.post("/api/logout")
    assert (
        await server.client.get(
            route,
            params={
                "path": str(path),
                "pane": item["active_pane"],
            },
        )
    ).status_code == 401


async def test_preview_bounds_special_files_images_and_missing_paths(server):
    await server.login()
    item = await server.create("files", "bash")
    route = f"/api/sessions/{item['id']}/file"
    folder = server.config.cwd
    (folder / "large.txt").write_bytes(b"a" * (TEXT_LIMIT + 100))
    (folder / "binary.bin").write_bytes(b"\0abc")
    os.mkfifo(folder / "pipe")
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1kAAAAASUVORK5CYII="
    )
    (folder / "pixel.png").write_bytes(png)

    async def read(path):
        return await server.client.get(route, params={"path": path, "pane": item["active_pane"]})

    data = (await read("large.txt")).json()
    assert data["truncated"] and len(data["content"]) == TEXT_LIMIT
    assert base64.b64decode((await read("pixel.png")).json()["src"].split(",")[1]) == png
    assert (await read("binary.bin")).status_code == 415
    async with asyncio.timeout(2):
        assert (await read("pipe")).status_code == 415
    assert (await read("not-here.txt")).status_code == 404
    assert (await read("bad\0path")).status_code == 422


async def test_tables_preserve_cells_sheets_and_formulas(server):
    create(server.config.cwd, False)
    await server.login()
    item = await server.create("tables", "bash")
    route = f"/api/sessions/{item['id']}/file"

    async def read(name, sheet):
        response = await server.client.get(
            route, params={"path": name, "pane": item["active_pane"], "sheet": sheet}
        )
        response.raise_for_status()
        return response.json()

    csv = await read("results.csv", "")
    assert csv["kind"] == "table" and not csv["truncated"]
    assert csv["rows"][1] == ["alpha", "0.91", "hello, world"]
    assert csv["rows"][2][2] == "two\nlines"
    assert (await read("results.tsv", ""))["rows"][1] == ["任务 A", "12"]
    book = await read("results.xlsx", "")
    assert book["sheets"] == ["指标", "明细"]
    assert book["sheet"] == "指标" and not book["truncated"]
    assert book["rows"][1] == ["accuracy", "0.91", "validation"]
    assert (await read("results.xlsx", "明细"))["rows"][1] == ["1", "=2+3"]
    assert (
        await server.client.get(
            route, params={"path": "results.xlsx", "pane": item["active_pane"], "sheet": "missing"}
        )
    ).status_code == 404
    (server.config.cwd / "large.csv").write_text("a,b\n" * 600)
    large = await read("large.csv", "")
    assert large["truncated"] and len(large["rows"]) == 500
    (server.config.cwd / "invalid.xlsx").write_bytes(b"not a workbook")
    assert (
        await server.client.get(route, params={"path": "invalid.xlsx", "pane": item["active_pane"]})
    ).status_code == 422


async def test_media_streams_ranges_and_stays_authenticated(server):
    create(server.config.cwd, False)
    await server.login()
    item = await server.create("media", "bash")
    route = f"/api/sessions/{item['id']}/file"
    params = {"path": "tone.wav", "pane": item["active_pane"]}
    meta = (await server.client.get(route, params=params)).json()
    assert meta["kind"] == "audio" and "content" not in meta
    raw = (server.config.cwd / "tone.wav").read_bytes()
    response = await server.client.get(
        route + "/content", params=params, headers={"Range": "bytes=100-199"}
    )
    assert response.status_code == 206 and response.content == raw[100:200]
    assert response.headers["content-range"] == f"bytes 100-199/{len(raw)}"
    response = await server.client.get(
        route + "/content", params=params, headers={"Range": "bytes=-30"}
    )
    assert response.status_code == 206 and response.content == raw[-30:]
    assert (
        await server.client.get(
            route + "/content", params=params, headers={"Range": "bytes=999999-"}
        )
    ).status_code == 416
    head = await server.client.head(route + "/content", params=params)
    assert head.status_code == 200 and head.headers["accept-ranges"] == "bytes"
    params["path"] = "report.pdf"
    response = await server.client.get(route + "/content", params=params)
    assert response.content.startswith(b"%PDF-")
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["x-frame-options"] == "SAMEORIGIN"
    assert "frame-ancestors 'self'" in response.headers["content-security-policy"]
    params["path"] = "unsafe.html"
    (server.config.cwd / "unsafe.html").write_text("<script>alert(1)</script>")
    assert (await server.client.get(route + "/content", params=params)).status_code == 415
    params["path"] = "tone.wav"
    await server.client.post("/api/logout")
    assert (await server.client.get(route + "/content", params=params)).status_code == 401
