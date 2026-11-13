#!/usr/bin/env python3
import argparse
import logging
import os
from pathlib import Path

import uvicorn

from terminal.app import create_app
from terminal.config import ASSETS, prepare
from terminal.plugins.registry import PROVIDERS


def main() -> None:
    parser = argparse.ArgumentParser(description="LanTerm — 真实的多会话 Web 终端")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument(
        "--shell", choices=["bash", "zsh"], default=Path(os.getenv("SHELL", "bash")).name
    )
    parser.add_argument("--cwd", type=Path, default=Path.cwd())
    parser.add_argument("--state-dir", type=Path)
    parser.add_argument("--max-sessions", type=int, default=32)
    parser.add_argument("--public-url", default="", help="反向代理后的完整访问地址，含路径前缀")
    parser.add_argument(
        "--plugins", default="codex,claude", help="状态插件，逗号分隔；none 关闭全部插件"
    )
    parser.add_argument(
        "--ssh",
        "--experimental-ssh",
        dest="ssh",
        action="store_true",
        help="启用浏览器 SSH 隧道（兼容 --experimental-ssh）",
    )
    parser.add_argument("--ssh-target-port", type=int, default=22, help="本机 sshd 的回环目标端口")
    parser.add_argument(
        "--ssh-listen-port", type=int, default=2222, help="本机回环 SSH 转发监听端口"
    )
    parser.add_argument(
        "--ssh-resume-seconds", type=int, default=120, help="隧道无消息时保留 TCP 的秒数"
    )
    args = parser.parse_args()
    if not (1 <= args.ssh_target_port <= 65535 and 1 <= args.ssh_listen_port <= 65535):
        parser.error("SSH 端口必须在 1–65535")
    if args.ssh and args.ssh_target_port == args.ssh_listen_port:
        parser.error("sshd 目标端口不能与 SSH 转发监听端口相同")
    if not 15 <= args.ssh_resume_seconds <= 600:
        parser.error("ssh-resume-seconds 必须在 15–600")
    plugins = [] if args.plugins == "none" else list(dict.fromkeys(args.plugins.split(",")))
    if any(name not in PROVIDERS for name in plugins):
        parser.error(f"可用插件：{', '.join(PROVIDERS)}；或使用 none")
    if not 1 <= args.port <= 65535 or not 1 <= args.max_sessions <= 256:
        parser.error("port 必须在 1–65535，max-sessions 必须在 1–256")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not (ASSETS / "app.js").is_file():
        parser.error("前端尚未构建，请运行 npm ci && npm run build，或使用 ./launch.sh")
    base = Path(os.getenv("XDG_RUNTIME_DIR", f"/tmp/lan-terminal-{os.getuid()}"))
    state = args.state_dir or base / f"lan-terminal-{args.port}"
    config = prepare(state, args.cwd, args.shell, args.max_sessions, args.port, args.public_url)
    logging.info("Web UI: http://%s:%s（内网访问请使用本机的内网 IP）", args.host, args.port)
    if not os.getenv("LAN_TERMINAL_PASSWORD"):
        logging.info("访问密码保存在 %s", config.state / "access-token")
    logging.info("退出 Web 服务会保留终端会话；在 Web UI 中关闭会话才会终止对应进程。")
    uvicorn.run(
        create_app(
            config,
            plugins,
            (args.ssh_target_port, args.ssh_listen_port, args.ssh_resume_seconds)
            if args.ssh
            else None,
        ),
        host=args.host,
        port=args.port,
        workers=1,
        access_log=False,
        proxy_headers=False,
        ws_max_size=131072,
        ws_max_queue=16,
        timeout_graceful_shutdown=5,
    )


if __name__ == "__main__":
    main()
