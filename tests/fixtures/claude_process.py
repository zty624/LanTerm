"""Act as an interactive Claude Code CLI: a real PTY process plus its session registry file.

Keys: w busy, i idle, p permission prompt, e input needed, d dialog open, o other wait,
g torn write, x unknown status, q quit. Private values must never reach the API.
"""

import argparse
import ctypes
import json
import logging
import os
import sys
import termios
import tty
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", default="interactive")
    parser.add_argument("--stale", action="store_true", help="write another process's start")
    parser.add_argument("--no-file", action="store_true")
    args = parser.parse_args()
    # Linux comm, as seen by psutil, while this process retains a real tmux PTY.
    if ctypes.CDLL(None, use_errno=True).prctl(15, b"claude", 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl")
    folder = Path(os.environ["CLAUDE_CONFIG_DIR"]) / "sessions"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{os.getpid()}.json"
    start = Path("/proc/self/stat").read_bytes().rsplit(b") ", 1)[1].split()[19].decode()
    record = {
        "pid": os.getpid(),
        "sessionId": "PRIVATE_SESSION",
        "cwd": "/private project",
        "procStart": str(int(start) + 1) if args.stale else start,
        "kind": args.kind,
        "name": "PRIVATE_NAME",
        "status": "idle",
    }

    def write(**changes) -> None:
        record.update(changes)
        if not args.no_file:
            path.write_text(json.dumps(record))

    term = termios.tcgetattr(0)
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    try:
        write()
        tty.setraw(0)
        logging.info("fixture:ready")
        while key := os.read(0, 1):
            if key == b"q":
                break
            if key == b"w":
                write(status="busy", waitingFor=None)
            elif key == b"i":
                write(status="idle", waitingFor=None)
            elif key == b"p":
                write(status="waiting", waitingFor="permission prompt")
            elif key == b"e":
                write(status="waiting", waitingFor="input needed")
            elif key == b"d":
                write(status="waiting", waitingFor="dialog open")
            elif key == b"o":
                write(status="waiting", waitingFor="PRIVATE_ approve rm -rf /private project")
            elif key == b"x":
                write(status="PRIVATE_future_status", waitingFor=None)
            elif key == b"g":
                path.write_text(json.dumps(record)[:25])
    finally:
        termios.tcsetattr(0, termios.TCSADRAIN, term)
        path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
