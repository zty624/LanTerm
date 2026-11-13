import subprocess
from pathlib import Path

import pytest

from terminal.git import LIMIT, status
from terminal.sessions import SessionError


def git(folder: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=LanTerm", "-c", "user.email=lt@example.invalid", *args],
        cwd=folder,
        check=True,
        capture_output=True,
    )


async def open_session(server, folder: Path) -> tuple[str, str]:
    response = await server.client.post(
        "/api/sessions", json={"name": "repo", "shell": "bash", "cwd": str(folder)}
    )
    response.raise_for_status()
    item = response.json()
    return item["id"], item["active_pane"]


async def test_status_and_diffs_of_the_pane_work_tree(server):
    assert (await server.client.get("/api/sessions/x/git?pane=%0")).status_code == 401
    await server.login()
    plain, pane = await open_session(server, server.config.cwd)
    response = await server.client.get(f"/api/sessions/{plain}/git", params={"pane": pane})
    assert response.json() == {"repo": False, "cwd": str(server.config.cwd)}

    repo = server.config.cwd / "project"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / "a.txt").write_text("keep\nold line\n")
    (repo / "b.txt").write_text("remove me\n")
    (repo / "old.txt").write_text("same content for rename detection\n" * 5)
    git(repo, "add", ".")
    git(repo, "commit", "-q", "-m", "init")
    (repo / "a.txt").write_text("keep\nnew line\n")
    (repo / "n.txt").write_text("staged\n")
    git(repo, "add", "n.txt")
    (repo / "b.txt").unlink()
    git(repo, "mv", "old.txt", "new.txt")
    (repo / "sp ace.txt").write_text("hello\n")
    (repo / "中文.md").write_text("# 标题\n")
    sid, pane = await open_session(server, repo)

    response = await server.client.get(f"/api/sessions/{sid}/git", params={"pane": pane})
    response.raise_for_status()
    data = response.json()
    assert (data["repo"], data["root"], data["branch"]) == (True, str(repo), "main")
    assert len(data["head"]) == 9 and not data["truncated"]
    files = {item["path"]: item for item in data["files"]}
    assert files["a.txt"] == {
        "path": "a.txt",
        "orig": None,
        "status": "M",
        "staged": False,
        "added": 1,
        "deleted": 1,
    }
    assert (files["n.txt"]["status"], files["n.txt"]["staged"]) == ("A", True)
    assert files["b.txt"]["status"] == "D"
    assert (files["new.txt"]["status"], files["new.txt"]["orig"]) == ("R", "old.txt")
    assert files["sp ace.txt"]["status"] == "?" and files["中文.md"]["status"] == "?"

    async def diff(path: str, orig: str) -> dict:
        query = {"pane": pane, "path": path, "orig": orig}
        response = await server.client.get(f"/api/sessions/{sid}/git/diff", params=query)
        response.raise_for_status()
        return response.json()

    changed = (await diff("a.txt", ""))["diff"]
    assert "-old line" in changed and "+new line" in changed
    assert "+hello" in (await diff("sp ace.txt", ""))["diff"]
    assert "+# 标题" in (await diff("中文.md", ""))["diff"]
    assert "rename from old.txt" in (await diff("new.txt", "old.txt"))["diff"]
    assert "-remove me" in (await diff("b.txt", ""))["diff"]
    # Pathspec magic is literal: it must not select every changed file.
    assert (await diff(":(glob)*", ""))["diff"] == ""
    for outside in ("../outside.txt", "/etc/passwd"):
        response = await server.client.get(
            f"/api/sessions/{sid}/git/diff", params={"pane": pane, "path": outside}
        )
        assert response.status_code == 400

    (repo / "big.log").write_bytes(b"z" * 127 + b"\n" + b"y" * 2 * LIMIT)
    big = await diff("big.log", "")
    assert big["truncated"] and len(big["diff"].encode()) <= LIMIT


def test_missing_git_binary_is_a_clear_error(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    with pytest.raises(SessionError) as error:
        status(str(tmp_path))
    assert error.value.status == 503
