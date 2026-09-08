"""Drive real process/PTY/lifecycle boundaries without a model or user credentials."""

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
    parser.add_argument("--no-log", action="store_true")
    parser.add_argument("--folder", type=Path, default=Path.cwd())
    args = parser.parse_args()
    # Linux comm, as seen by psutil, while this process retains a real tmux PTY.
    if ctypes.CDLL(None, use_errno=True).prctl(15, b"codex", 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "prctl")
    path = args.folder / f"rollout-fixture-{os.getpid()}.jsonl"
    child_path = args.folder / f"rollout-subagent-{os.getpid()}.jsonl"
    term = termios.tcgetattr(sys.stdin.fileno())
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
    with (
        path.open("a", buffering=1) as stream,
        child_path.open("w", buffering=1) as child,
    ):

        def emit(kind: str, **payload) -> None:
            if not args.no_log:
                stream.write(json.dumps({"type": kind, "payload": payload}) + "\n")

        def title(text: str) -> None:
            os.write(1, f"\x1b]0;{text}\x07".encode())

        emit("session_meta", source="cli", id="fixture-root")
        child.write(
            json.dumps(
                {"type": "session_meta", "payload": {"source": {"subagent": {"thread_spawn": {}}}}}
            )
            + "\n"
        )
        turn = 0
        try:
            tty.setraw(sys.stdin.fileno())
            title("")
            logging.info("fixture:ready")
            while key := os.read(sys.stdin.fileno(), 1):
                if key == b"q":
                    break
                if key == b"w":
                    turn += 1
                    title("")
                    emit("event_msg", type="task_started", turn_id=str(turn))
                elif key == b"i":
                    title("")
                    emit(
                        "event_msg",
                        type="task_complete",
                        turn_id=str(turn),
                        last_agent_message="PRIVATE_RESPONSE",
                    )
                    child.write(
                        json.dumps({"type": "event_msg", "payload": {"type": "task_started"}})
                        + "\n"
                    )
                elif key == b"a":
                    title("[ ! ] Action Required | private project name")
                elif key == b"u":
                    title("")
                    emit(
                        "response_item",
                        type="function_call",
                        name="request_user_input",
                        call_id="question",
                        arguments="PRIVATE_QUESTION",
                    )
                elif key == b"r":
                    title("")
                    emit(
                        "response_item",
                        type="function_call_output",
                        call_id="question",
                        output="PRIVATE_ANSWER",
                    )
                elif key == b"x":
                    title("")
                    emit("event_msg", type="turn_aborted", turn_id=str(turn))
                elif key == b"t":
                    title("⠋ project")
                elif key == b"\x1f":
                    logging.info("shortcut:1f")
        finally:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, term)
            title("")


if __name__ == "__main__":
    main()
