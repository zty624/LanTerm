"""Read-only Git status and diffs for the directory a pane is in.

Commands never take locks, run hooks, external diff drivers or textconv filters, and
treat paths literally. Output is bounded so a huge diff cannot exhaust memory.
"""

import logging
import os
import subprocess
import threading
from pathlib import Path

from terminal.sessions import SessionError

LOG = logging.getLogger(__name__)
LIMIT = 1024 * 1024
FILES = 1000
TIMEOUT = 10
EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
BASE = [
    "git",
    "--no-optional-locks",
    "--literal-pathspecs",
    "-c",
    "core.quotePath=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "color.ui=false",
]


def capture(root: Path, args: list[str], codes: set[int], limit: int) -> tuple[bytes, bool]:
    """Run git in root; return at most `limit` bytes of stdout and whether it was cut."""
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"}
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        env.pop(key, None)
    try:
        proc = subprocess.Popen(
            [*BASE, *args],
            cwd=root,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError as exc:
        raise SessionError("LanTerm 主机未安装 git，无法查看代码变更", 503) from exc
    with proc:
        watchdog = threading.Timer(TIMEOUT, proc.kill)
        watchdog.start()
        try:
            data = proc.stdout.read(limit + 1)
            truncated = len(data) > limit
            if truncated:
                proc.kill()
            error = proc.stderr.read(4096)
            code = proc.wait()
        finally:
            watchdog.cancel()
    if truncated:
        return data[:limit], True
    if code not in codes:
        message = error.decode("utf-8", "replace").strip().splitlines()
        LOG.info("git %s failed in %s: %s", args[0], root, message[:1])
        raise SessionError(f"Git 命令失败：{message[0] if message else code}", 422)
    return data, False


def repository(cwd: str) -> Path | None:
    folder = Path(cwd)
    if not folder.is_dir():
        raise SessionError("分屏当前目录不存在或不可访问", 404)
    # Outside a work tree (or an untrusted one) rev-parse exits 128 and prints nothing.
    out, _ = capture(folder, ["rev-parse", "--show-toplevel"], {0, 128}, 4096)
    return Path(out.decode().strip()) if out.strip() else None


def counts(root: Path, base: str) -> dict[str, tuple[int | None, int | None]]:
    out, _ = capture(root, ["diff", "--numstat", "-z", "-M", "--no-ext-diff", base], {0}, LIMIT)
    fields = out.split(b"\0")
    result = {}
    index = 0
    while index < len(fields) - 1:
        added, deleted, path = fields[index].split(b"\t", 2)
        index += 1
        if not path:  # A rename: the old and new paths follow as separate fields.
            path = fields[index + 1]
            index += 2
        binary = added == b"-"
        result[path.decode("utf-8", "replace")] = (
            None if binary else int(added),
            None if binary else int(deleted),
        )
    return result


def status(cwd: str) -> dict:
    root = repository(cwd)
    if root is None:
        return {"repo": False, "cwd": cwd}
    out, cut = capture(
        root,
        ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
        {0},
        LIMIT * 4,
    )
    info = {"oid": "", "head": "", "upstream": "", "ahead": 0, "behind": 0}
    files = []
    fields = out.split(b"\0")
    if cut:
        fields.pop()  # The last record may be incomplete.
    index = 0
    while index < len(fields):
        entry = fields[index].decode("utf-8", "replace")
        index += 1
        if not entry:
            continue
        kind = entry[0]
        if kind == "#":
            key, _, value = entry[2:].partition(" ")
            if key == "branch.oid":
                info["oid"] = value
            elif key == "branch.head":
                info["head"] = value
            elif key == "branch.upstream":
                info["upstream"] = value
            elif key == "branch.ab":
                ahead, behind = value.split()
                info["ahead"], info["behind"] = int(ahead), -int(behind)
            continue
        if len(files) >= FILES:
            cut = True
            continue
        if kind == "?":
            files.append({"path": entry[2:], "orig": None, "status": "?", "staged": False})
        elif kind in "12u":
            parts = entry.split(" ", {"1": 8, "2": 9, "u": 10}[kind])
            xy, path = parts[1], parts[-1]
            orig = None
            if kind == "2":
                orig = fields[index].decode("utf-8", "replace")
                index += 1
            letter = "U" if kind == "u" else (xy[1] if xy[1] != "." else xy[0])
            files.append(
                {"path": path, "orig": orig, "status": letter, "staged": xy[0] not in ".?"}
            )
    initial = info["oid"] in ("", "(initial)")
    numbers = counts(root, EMPTY_TREE if initial else "HEAD")
    for item in files:
        added, deleted = numbers.get(item["path"], (None, None))
        item.update(added=added, deleted=deleted)
    return {
        "repo": True,
        "cwd": cwd,
        "root": str(root),
        "branch": info["head"],
        "head": "" if initial else info["oid"][:9],
        "upstream": info["upstream"],
        "ahead": info["ahead"],
        "behind": info["behind"],
        "files": files,
        "truncated": cut,
    }


def inside(root: Path, path: str) -> Path:
    target = (root / path).resolve()
    if Path(path).is_absolute() or not target.is_relative_to(root.resolve()):
        raise SessionError("路径不在仓库内", 400)
    return target


def diff(cwd: str, path: str, orig: str) -> dict:
    root = repository(cwd)
    if root is None:
        raise SessionError("当前目录不在 Git 仓库中", 404)
    target = inside(root, path)
    paths = [path]
    if orig:
        inside(root, orig)
        paths.insert(0, orig)  # Both sides let rename detection pair them.
    tracked, _ = capture(root, ["ls-files", "-z", "--", path], {0}, 4096)
    known, _ = capture(root, ["rev-parse", "--verify", "--quiet", "HEAD"], {0, 1}, 4096)
    if tracked or not target.exists():
        base = "HEAD" if known else EMPTY_TREE
        args = ["diff", "--no-ext-diff", "--no-textconv", "-M", base, "--", *paths]
        out, cut = capture(root, args, {0}, LIMIT)
    else:
        # Untracked: compare against nothing. --no-index exits 1 when files differ.
        args = ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", path]
        out, cut = capture(root, args, {0, 1}, LIMIT)
    text = out.decode("utf-8", "replace")
    binary = "\nBinary files " in f"\n{text}" and "\n@@" not in f"\n{text}"
    return {"path": path, "diff": text, "truncated": cut, "binary": binary}
