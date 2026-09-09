# 使用

## 参数

| 参数 | 默认值 / 用途 |
| --- | --- |
| `--host` / `--port` | `0.0.0.0` / `8766` |
| `--shell` | 从 `$SHELL` 读取，支持 Bash / Zsh |
| `--cwd` | `launch.sh` 默认使用仓库目录 |
| `--state-dir` | 默认位于用户运行目录，存放密码与 tmux socket |
| `--max-sessions` | `32`，每个会话最多 8 个浏览器连接 |
| `--plugins` | 默认 `codex`；`none` 关闭插件 |
| `--public-url` | 反向代理的完整访问地址，见 [容器部署](cluster.md) |

`LAN_TERMINAL_PASSWORD` 可指定访问密码，至少 12 个字符。否则自动生成 `access-token`，路径见启动日志。

状态目录需支持 Unix 私有权限。代码在 NTFS / exFAT 上时，将状态目录放在 `/run/user/<UID>` 或其他 Linux 文件系统。多个实例应分别设置端口和状态目录。

## 后台运行

在仓库目录执行：

```bash
uv sync --frozen
npm ci
npm run build

systemd-run --user --unit=lan-terminal --collect \
  --property=KillMode=process \
  --property=Restart=on-failure \
  --working-directory="$PWD" \
  "$PWD/.venv/bin/python" "$PWD/launch.py" \
  --shell bash --cwd /path/to/workspace

systemctl --user restart lan-terminal
journalctl --user -u lan-terminal -f
systemctl --user stop lan-terminal
```

保留 `KillMode=process`，防止停服时连带结束 tmux。这是临时用户服务，机器重启后需重新创建。

浏览器断开、Web 服务重启会保留终端；再次启动时使用原状态目录。重启 Web 服务后需重新登录。机器或容器重启会结束进程；运行目录被清理后会生成新密码。

## 操作

| 操作 | 方式 |
| --- | --- |
| 新建 / 编辑会话 | `Ctrl+Shift+K` / 双击侧栏会话 |
| 选择 / 复制文本 | `Shift` + 鼠标拖选 / `Ctrl+Shift+C` |
| 粘贴 | 系统粘贴快捷键或顶部“粘贴” |
| 搜索 | `Ctrl+Shift+F` |
| 控制键 | 顶部“按键”，包括 Ctrl+W、Ctrl+T、Ctrl+N、Ctrl+/ |
| 分屏 | 顶部“分屏”，支持左右 / 上下分屏、切换、放大、重启和关闭 |
| 右键菜单 | 终端内使用 tmux 菜单；`Shift` + 右键打开浏览器菜单 |
| 历史 | 顶部“历史”，最近 20,000 行；tmux 复制模式按 `Esc` / `q` 返回 |
| 字号 | 右下角 `−` / `＋`，默认 16px，可调 10–28px |

“关闭”会结束会话及其进程。Shell 执行 `exit` 后保留输出，可重新启动。复制会话会新开 Shell，沿用当前目录、分组和标签。

分屏由 tmux 保存，一个窗口最多 8 个。新分屏沿用所选分屏的当前目录，启动同类型的新 Shell。点击终端切换焦点，拖动分隔线调整大小；关闭一个分屏会结束其中的程序，其余分屏继续运行。多个浏览器共享布局和焦点，历史面板显示当前分屏的输出。命令参考 [tmux 手册](https://man.openbsd.org/tmux#split-window)。

命令行接入已有会话：

```bash
state_dir="${XDG_RUNTIME_DIR:-/tmp/lan-terminal-$(id -u)}/lan-terminal-8766"
tmux -S "$state_dir/tmux.sock" list-sessions
tmux -S "$state_dir/tmux.sock" attach -t lt-实际ID
```

LanTerm 使用独立 tmux socket 和配置。同一会话的多个浏览器共享输入，最后一次窗口调整决定终端尺寸。

## 开发

```bash
uv sync --frozen
npm ci
npm run format:check
uv run ruff check .
uv run ruff format --check .
uv run pytest -q
npm run build
npx playwright install chromium
npm run test:e2e
```

前端用 `npm run format` 格式化，修改后重新构建。后端使用单个 Uvicorn worker。测试会创建独立端口和 tmux socket；可用 `PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome` 指定已有浏览器。
