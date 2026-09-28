"""Bounded, read-only previews for files readable by the terminal's system user."""

import base64
import errno
import os
import stat
from contextlib import contextmanager
from pathlib import Path

from terminal.sessions import SessionError
from terminal.tables import delimited, workbook

TEXT_LIMIT = 1024 * 1024
IMAGE_LIMIT = 8 * 1024 * 1024
ENTRY_LIMIT = 500
IMAGES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}

MEDIA = {
    ".pdf": ("pdf", "application/pdf"),
    ".wav": ("audio", "audio/wav"),
    ".mp3": ("audio", "audio/mpeg"),
    ".flac": ("audio", "audio/flac"),
    ".ogg": ("audio", "audio/ogg"),
    ".opus": ("audio", "audio/ogg"),
    ".m4a": ("audio", "audio/mp4"),
    ".aac": ("audio", "audio/aac"),
    ".mp4": ("video", "video/mp4"),
    ".webm": ("video", "video/webm"),
    ".ogv": ("video", "video/ogg"),
    ".mov": ("video", "video/quicktime"),
    ".mkv": ("video", "video/x-matroska"),
}


def resolve(raw: str, cwd: str) -> Path:
    if any(ord(char) < 32 for char in raw):
        raise SessionError("路径不能包含控制字符", 422)
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = Path(cwd) / path
    try:
        return path.resolve(strict=True)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise SessionError("文件不存在，请检查路径及分屏的当前目录", 404) from exc
    except PermissionError as exc:
        raise SessionError("当前系统用户没有权限读取此文件", 403) from exc


@contextmanager
def regular(path: Path):
    fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise SessionError("只支持预览普通文件", 415)
        with os.fdopen(fd, "rb", closefd=False) as stream:
            yield stream
    finally:
        os.close(fd)


def media(raw: str, cwd: str) -> tuple[Path, str]:
    path = resolve(raw, cwd)
    item = MEDIA.get(path.suffix.lower())
    if item is None:
        raise SessionError("此格式不支持媒体播放", 415)
    try:
        with regular(path):
            pass
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise SessionError("文件不存在，请检查路径", 404) from exc
    except PermissionError as exc:
        raise SessionError("当前系统用户没有权限读取此文件", 403) from exc
    return path, item[1]


def preview(raw: str, cwd: str, sheet: str) -> dict:
    path = resolve(raw, cwd)
    try:
        if path.is_dir():
            entries = []
            with os.scandir(path) as scan:
                for entry in scan:
                    entries.append({"name": entry.name, "directory": entry.is_dir()})
                    if len(entries) > ENTRY_LIMIT:
                        break
            return {
                "kind": "directory",
                "path": str(path),
                "entries": sorted(
                    entries[:ENTRY_LIMIT], key=lambda e: (not e["directory"], e["name"].lower())
                ),
                "truncated": len(entries) > ENTRY_LIMIT,
            }
        # Opening a FIFO or device must never hang a preview worker.
        with regular(path) as stream:
            info = os.fstat(stream.fileno())
            suffix = path.suffix.lower()
            result = {"path": str(path), "size": info.st_size}
            if suffix in MEDIA:
                kind, mime = MEDIA[suffix]
                return {**result, "kind": kind, "mime": mime, "truncated": False}
            if suffix == ".xlsx":
                return {**result, **workbook(stream, sheet, info.st_size)}
            mime = IMAGES.get(suffix)
            limit = IMAGE_LIMIT if mime else TEXT_LIMIT
            data = stream.read(limit + 1)
    except (FileNotFoundError, NotADirectoryError) as exc:
        raise SessionError("文件不存在，请检查路径及分屏的当前目录", 404) from exc
    except PermissionError as exc:
        raise SessionError("当前系统用户没有权限读取此文件", 403) from exc
    except OSError as exc:
        if exc.errno in {errno.ELOOP, errno.ENAMETOOLONG, errno.ENXIO, errno.ENODEV}:
            raise SessionError("无法预览此路径", 400) from exc
        raise
    result = {"path": str(path), "size": info.st_size, "truncated": len(data) > limit}
    if mime:
        if result["truncated"]:
            raise SessionError("图片超过 8 MiB，请使用本机图片查看器", 413)
        return {
            **result,
            "kind": "image",
            "src": f"data:{mime};base64," + base64.b64encode(data).decode("ascii"),
        }
    if b"\0" in data:
        raise SessionError("此文件为二进制格式，暂不支持预览", 415)
    content = data[:limit].decode("utf-8-sig", errors="replace")
    if suffix in {".csv", ".tsv"}:
        return {**result, **delimited(content, suffix, result["truncated"])}
    return {**result, "kind": "text", "content": content}
