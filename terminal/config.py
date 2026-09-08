import os
import secrets
import shutil
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parent.parent
ASSETS = Path(os.getenv("LAN_TERMINAL_STATIC_DIR", str(ROOT / "static"))).resolve()


@dataclass(frozen=True)
class Config:
    state: Path
    cwd: Path
    shell: str
    password: str
    max_sessions: int
    cookie: str
    public_url: str

    @property
    def socket(self) -> Path:
        return self.state / "tmux.sock"


def available_shells() -> dict[str, str]:
    return {name: path for name in ("bash", "zsh") if (path := shutil.which(name))}


def prepare(
    state: Path, cwd: Path, shell: str, max_sessions: int, port: int, public_url: str
) -> Config:
    if public_url:
        url = urlsplit(public_url)
        if (
            url.scheme not in ("http", "https")
            or not url.netloc
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ValueError("public-url 必须为不含凭证、查询参数和片段的完整 HTTP(S) 地址")
        public_url = urlunsplit(
            (url.scheme, url.netloc.lower(), url.path.rstrip("/") + "/", "", "")
        )
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
    return Config(
        state, cwd, shells[shell], password, max_sessions, f"lan_terminal_{port}", public_url
    )
