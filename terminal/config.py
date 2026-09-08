import os
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Config:
    state: Path
    cwd: Path
    shell: str
    password: str
    max_sessions: int
    cookie: str

    @property
    def socket(self) -> Path:
        return self.state / "tmux.sock"


def available_shells() -> dict[str, str]:
    return {name: path for name in ("bash", "zsh") if (path := shutil.which(name))}


def prepare(state: Path, cwd: Path, shell: str, max_sessions: int, port: int) -> Config:
    if not shutil.which("tmux"):
        raise ValueError("请先安装 tmux（Arch: sudo pacman -S tmux）")
    shells = available_shells()
    if shell not in shells:
        raise ValueError(f"未安装 shell: {shell}")
    cwd = cwd.expanduser().resolve(strict=True)
    if not cwd.is_dir():
        raise ValueError(f"工作目录不是文件夹: {cwd}")
    state = state.expanduser().resolve()
    if len(os.fsencode(state / "tmux.sock")) > 100:
        raise ValueError("state-dir 路径过长，请指定一个更短的绝对路径")
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    state.chmod(0o700)
    info = state.stat()
    if info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError("state-dir 必须支持 Unix 私有权限，请使用 /run/user/<UID> 下的目录")
    password = os.environ.get("LAN_TERMINAL_PASSWORD", "")
    if not password:
        path = state / "access-token"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            password = path.read_text().strip()
        else:
            password = secrets.token_urlsafe(24)
            with os.fdopen(fd, "w") as file:
                file.write(password + "\n")
        path.chmod(0o600)
    if len(password) < 12:
        raise ValueError("访问密码至少需要 12 个字符")
    return Config(state, cwd, shells[shell], password, max_sessions, f"lan_terminal_{port}")
