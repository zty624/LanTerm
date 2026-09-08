# LanTerm

<img src="web/lantern.svg" width="64" height="64" alt="LanTerm 灯笼 Logo" />

在浏览器里使用本机的真实终端。Python 后端通过 WebSocket 和 PTY 接入 tmux，前端使用 xterm.js。支持 Bash / Zsh、Vim、Codex、SSH、htop 等交互式命令行程序。

## 启动

运行环境：Linux、Python 3.11+、uv、tmux 3.3+，以及 Bash 或 Zsh。Node.js 20+ 和 npm 仅在首次构建前端时需要。命令行工具需要安装在运行服务的机器上。

```bash
# Arch Linux 尚未安装系统依赖时
sudo pacman -S tmux uv nodejs npm

cd /path/to/LanTerm
./launch.sh --host 0.0.0.0 --port 8766 --shell zsh --cwd /path/to/workspace
```

首次启动会安装锁定的依赖并构建前端。后续启动直接复用已构建的静态文件。默认监听 `0.0.0.0:8766`；默认工作目录是仓库目录，默认 shell 取自启动环境的 `$SHELL`。

项目名称为 **LanTerm**，Logo 为灯笼。运行状态目录、环境变量与已有服务标识沿用 `lan-terminal` / `LAN_TERMINAL_*`，保证已有 tmux 会话、密码和启动配置继续兼容。

本机仓库目录为 `/mnt/data/Arch/workspace/tools/LanTerm`，旧目录名 `lan-terminal` 保留为兼容软链接，供已经运行的进程和既有命令继续访问。

本机访问 **http://127.0.0.1:8766**，同一内网中的设备访问 **http://服务器内网IP:8766**。`0.0.0.0` 是监听地址；浏览器应填写实际 IP。如果本机防火墙有入站限制，需要允许对应内网访问此 TCP 端口。

第一次启动自动生成访问密码，保存在运行状态目录下的 `access-token`，文件权限为 `0600`。默认状态目录为 `$XDG_RUNTIME_DIR/lan-terminal-8766`（通常是 `/run/user/<UID>/lan-terminal-8766`）；没有该环境变量时使用 `/tmp/lan-terminal-<UID>/lan-terminal-8766`。启动日志会显示实际路径：

```bash
cat "${XDG_RUNTIME_DIR:-/tmp/lan-terminal-$(id -u)}/lan-terminal-8766/access-token"
```

在登录页面输入该密码即可。也可用环境变量 `LAN_TERMINAL_PASSWORD` 设置至少 12 字符的密码；不要把密码写入仓库或启动命令参数。浏览器使用 HttpOnly、SameSite Cookie 登录；密码不会放在 URL 或服务日志中。

平台代理后的浏览器 Origin 与后端地址可以不同；登录、API 和 WebSocket 均通过密码及有效登录 Cookie 验证，不再进行 Origin 来源校验。

## 终端能力

- 创建多个独立会话，选择 Bash / Zsh 和初始工作目录。
- 切换、重命名、关闭会话；双击侧栏会话也能重命名。
- 会话分组、标签、备注、置顶；按名称 / 标签 / 目录搜索，按分组和状态筛选，可按创建时间、最近活动、名称排序。
- 批量移入分组、置顶和关闭；执行前列出所选会话，关闭需要确认。未选中的会话不受批量操作影响。
- 复制会话：用相同 Shell、当前目录、分组和标签创建一个独立 Shell。详情面板显示创建时间、活动时间、当前目录及进程树。
- 真正的 PTY：Tab 补全、方向键、Ctrl+C、Ctrl+Z、Ctrl+D、`jobs` / `fg` / `bg`、管道、重定向、交互提示、ANSI 颜色和全屏 TUI。
- 按窗口大小调整终端行列数，向应用传播尺寸变化；支持鼠标、中文输入和 Unicode。
- 页面刷新、网络断线、浏览器关闭时，命令继续运行。重新连接时由 tmux 恢复当前终端画面，包括尚未退出的 Vim。
- Web 服务重启后，以相同 `--state-dir` 启动即可恢复会话及名称；重启 Web 服务后需要重新登录。
- Shell 执行 `exit` 后，会话标记为“已退出”，保留输出，可点击“重新启动”。点击“关闭”会真正终止该会话。
- 同一会话可以由多个浏览器同时查看和操作。默认最多 32 个会话、每会话 8 个连接；同时操作同一会话会共享输入，最后调整尺寸的浏览器决定会话尺寸。

会话独立指 Shell 进程、当前目录、终端状态和 Shell 环境变量独立。它们使用同一个系统用户的文件、权限、Shell 配置及命令行工具登录状态，登录的内网用户能够看到并操作所有会话。本项目适合可信内网共享，HTTP 本身不加密；它不提供多用户系统权限隔离。

## 资源监控

点击右上角“资源监控”查看 CPU、内存、GPU、磁盘、网络与各 session 的进程资源。查看监控不会断开当前终端。详情面板显示会话进程的 PID、程序名、状态、CPU 和 RSS，不采集命令参数或环境变量。

容器中优先使用 cgroup v1 / v2 的用量和可见父级配额，区分“当前 cgroup”“主机”“文件系统”“网络命名空间”“设备级 GPU”统计范围。未设置或无法读取的指标显示 `—` 或明确说明，不以主机总量冒充容器配额。速率首次采样需要等下一次刷新。

已有会话及其运行程序可以原样保留，新增的分组、标签和置顶信息也由 tmux 持有。集群迁移方式与完整指标口径见 [容器迁移说明](docs/cluster.md)。执行 `uv run python scripts/bundle.py` 可生成带预构建 Web UI 的运行包，方便部署到已有训练容器。

## Codex 状态插件

在终端直接运行 `codex`，侧栏每 0.5 秒查询“Working · 工作中”“等待输入”“等待确认 / 输入”“已中断”“已暂停”或“已退出”。未选中的会话同样更新，状态不变时保留原有元素。插件只读检查本地进程、生命周期事件与 tmux 标题，不修改 Codex 配置；没有可靠信号时显示“状态未知”。审批和提问无法进一步细分时，统一提示打开终端查看。

默认启用 `codex` 插件，用 `--plugins none` 可以完全关闭采集。插件接口、版本兼容性、SSH / remote 模式限制和扩展方法见 [状态插件说明](docs/plugins.md)。

## Web UI 操作

| 操作 | 方式 |
| --- | --- |
| 新建会话 | 左侧“新建会话”或 `Ctrl+Shift+K` |
| 重命名 | 顶部“重命名”或双击侧栏会话 |
| 选择文本 | 按住 `Shift` 拖动鼠标，绕过终端应用的鼠标捕获 |
| 复制 | 选择文本后 `Ctrl+Shift+C`，或浏览器复制菜单 |
| 粘贴 | `Ctrl+Shift+V` / 系统粘贴快捷键，或顶部“粘贴”面板 |
| 查看滚动历史 | 鼠标滚轮；tmux 复制模式下按 `Esc` / `q` 返回交互 |
| 查看、导出完整历史 | 顶部“历史”，保留最近 20,000 行 |
| 搜索当前浏览器缓冲区 | 顶部“搜索”或 `Ctrl+Shift+F` |
| 发送浏览器占用的按键 | 顶部“按键”，可发送 Ctrl+W / Ctrl+T / Ctrl+N / Ctrl+L / Ctrl+/ 等 |
| Ctrl+/ | 按键栏按钮或终端内直接按下，发送终端控制字符 `0x1f`；具体行为由当前程序决定 |
| 调整字号 / 全屏 | 右下角 `−` / `＋`，右上角全屏按钮 |

HTTP 内网页面的剪贴板 API 在部分浏览器中不可用，因此提供了粘贴面板和复制兼容路径。浏览器保留的快捷键不能全部被网页拦截，可通过“按键”工具栏发送。这里提供终端能力，不包括 VS Code 的编辑器、扩展或调试面板。

终端默认字号为 16px，可通过右下角 `−` / `＋` 在 10–28px 间调整；已有的自选字号会保留。界面文字采用较大的字号和清晰的层级。资源监控约每 3 秒更新，数值和进度条在原位置更新；磁盘展示已用比例与可用容量，GPU 利用率、显存占用分别标注。首次速率采样会显示等待提示。

## 后台运行

前台直接执行 `./launch.sh` 即可调试。Linux 桌面上可以用 systemd 用户服务在后台运行；先完成首次构建：

```bash
uv sync --frozen
npm ci
npm run build

systemd-run --user --unit=lan-terminal --collect \
  --property=KillMode=process \
  --property=Restart=on-failure \
  --working-directory="$PWD" \
  "$PWD/.venv/bin/python" "$PWD/launch.py" \
  --host 0.0.0.0 --port 8766 --shell zsh --cwd /path/to/workspace

systemctl --user status lan-terminal
journalctl --user -u lan-terminal -f
systemctl --user stop lan-terminal
```

`KillMode=process` 保证停止 Web 服务时不连带终止由它创建的 tmux 服务。上述命令创建临时用户服务，不配置开机自启。终端会话能跨 Web 服务重启保留；机器重启、用户登出时系统清理所有用户进程、tmux 服务被杀或显式关闭会话后，进程不会保留。

密码和 tmux socket 位于上述运行状态目录，不进入 Git。目录必须支持 Unix `0700` 私有权限；默认放在 Linux 用户运行目录，也适用于代码位于 NTFS / exFAT 数据盘的情况。不要在会话运行时删除或移动此目录。重启机器或清理运行目录后，会生成新的访问密码。需要长期保留密码时，可通过 `--state-dir` 指定原生 Linux 文件系统上的持久目录。不同实例要指定不同的 `--port`；自定义状态目录时也要分别指定。

也可以从本机命令行接入本应用专用的 tmux 服务：

```bash
state_dir="${XDG_RUNTIME_DIR:-/tmp/lan-terminal-$(id -u)}/lan-terminal-8766"
tmux -S "$state_dir/tmux.sock" list-sessions
tmux -S "$state_dir/tmux.sock" attach -t 'lt-替换为实际ID'
```

`attach` 的目标请替换为 `list-sessions` 列出的完整会话名（实际格式为 `lt-<ID>`）。这个 tmux 服务不读取你的 `~/.tmux.conf`，不影响默认 tmux 服务。Shell 仍读取自己的登录 / 交互配置；本应用关闭了 tmux 前缀键，以免吞掉 Shell 的 Ctrl+B。

## 开发与验证

```bash
uv sync --frozen
npm ci
npm run build

uv run ruff format --check .
uv run ruff check .
uv run pytest -q

# 首次运行浏览器测试时安装 Chromium
npx playwright install chromium
npm run test:e2e
```

已有兼容 Chromium 时可使用 `PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome npm run test:e2e`。

Python 集成测试创建实际监听端口和独立 tmux 服务，验证鉴权、代理来源兼容、TTY、Bash / Zsh 任务控制、窗口尺寸、Unicode、会话独立性、重命名、重连、Vim 编辑保存、退出后重启以及输出流控。浏览器测试验证真实 UI 操作、Vim 内刷新、服务进程重启恢复及桌面 / 手机布局。所有测试只清理自己创建的临时服务和目录。

前端代码修改后需要执行 `npm run build`，再刷新浏览器。后端只启动一个 Uvicorn worker；多个 worker 不共享登录状态。依赖锁文件 `uv.lock`、`package-lock.json` 均纳入版本控制。

## 实现结构

```text
浏览器 xterm.js ← 二进制 WebSocket / ACK / resize → Python PTY
                                                    ↓
                                            独立 tmux 服务
                                              ├─ Bash
                                              ├─ Zsh → Vim
                                              └─ Zsh → Codex
```

- `terminal/app.py`：HTTP、登录、会话管理 API、需登录的 WebSocket。
- `terminal/pty.py`：异步 PTY 读写、终端尺寸和输出背压。
- `terminal/sessions.py`：tmux 生命周期；名称和初始目录存储在 tmux 会话选项里，无需数据库。
- `terminal/cgroup.py` / `terminal/monitor.py`：容器资源、GPU、会话进程树和共享采样缓存。
- `terminal/plugins/` / `web/plugins.js`：可选的会话状态插件、Codex 适配器与侧栏 badge。
- `scripts/bundle.py`：将明确列出的运行文件和已构建静态资源打包，不复制凭证。
- `terminal/tmux.conf`：应用专用终端设置、历史和鼠标支持。
- `web/`：原生 HTML / CSS / JavaScript，xterm.js 及插件由 esbuild 打包到 `static/`。使用时不依赖 CDN。

技术参考：[xterm.js](https://github.com/xtermjs/xterm.js)、[WebSocket 流控](https://xtermjs.org/docs/guides/flowcontrol/)、[tmux 手册](https://man.openbsd.org/tmux)、[FastAPI WebSocket](https://fastapi.tiangolo.com/advanced/websockets/)。
