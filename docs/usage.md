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

侧栏默认显示搜索与会话列表；展开「筛选与排序」可筛选分组、状态、排序和批量管理，启用的筛选数量在收起后仍可见。顶部保留分屏、搜索、粘贴和按键；重命名、置顶、复制、详情、历史及关闭会话位于「更多」。手机上点击侧栏外的遮罩或按 Esc 可收起侧栏。

侧边栏底部显示 CPU、内存概览及最近 6 分钟的曲线，约每 3 秒更新；“资源监控”查看完整指标。

| 操作 | 方式 |
| --- | --- |
| 新建 / 编辑会话 | `Ctrl+Shift+K` / 双击侧栏会话 |
| 选择 / 复制文本 | `Shift` + 鼠标拖选 / `Ctrl+Shift+C` |
| 粘贴 | 系统粘贴快捷键或顶部“粘贴” |
| 搜索 | `Ctrl+Shift+F` |
| 控制键 | 顶部“按键”，包括 Ctrl+W、Ctrl+T、Ctrl+N、Ctrl+/ |
| 分屏 | 顶部“分屏”，支持左右 / 上下分屏、切换、放大、重启和关闭 |
| 右键菜单 | 终端内使用 tmux 菜单；`Shift` + 右键打开浏览器菜单 |
| 历史 | 顶部“更多 → 终端历史”，最近 20,000 行；tmux 复制模式按 `Esc` / `q` 返回 |
| 字号 | 右下角 `−` / `＋`，默认 16px，可调 10–28px |

“关闭”会结束会话及其进程。Shell 执行 `exit` 后保留输出，可重新启动。复制会话会新开 Shell，沿用当前目录、分组和标签。

分屏由 tmux 保存，一个窗口最多 8 个。新分屏沿用所选分屏的当前目录，启动同类型的新 Shell。点击终端切换焦点，拖动分隔线调整大小；关闭一个分屏会结束其中的程序，其余分屏继续运行。多个浏览器共享布局和焦点，历史面板显示当前分屏的输出。命令参考 [tmux 手册](https://man.openbsd.org/tmux#split-window)。

有分屏的会话可点击右侧箭头折叠或展开分屏列表；每个会话的折叠状态保存在当前浏览器中，刷新后仍保留。折叠只影响侧栏显示，不改变终端布局或运行进程。

左侧按分屏显示运行程序和 Codex 状态，点击切换输入位置，`⋯` 管理对应分屏。分屏列表每秒更新，Codex 状态每 500ms 更新；没有可识别信号时显示“状态未知”。

命令行接入已有会话：

```bash
state_dir="${XDG_RUNTIME_DIR:-/tmp/lan-terminal-$(id -u)}/lan-terminal-8766"
tmux -S "$state_dir/tmux.sock" list-sessions
tmux -S "$state_dir/tmux.sock" attach -t lt-实际ID
```

LanTerm 使用独立 tmux socket 和配置。同一会话的多个浏览器共享输入，最后一次窗口调整决定终端尺寸。

## 文件预览

点击终端输出中的路径可打开只读文件预览，也可从顶部「更多 → 预览文件」输入路径。预览窗口在桌面仅保留 8px 外边距，右上角可「最大化 / 还原窗口」；手机上默认铺满屏幕。顶部合并路径与导航按钮，单分屏时隐藏分屏选择，给文件内容留出更多空间。

- 支持绝对路径、`~/`、`./`、`../`、含目录的相对路径和带扩展名的文件名。带空格的路径用引号或反引号包围，或使用文件超链接。
- 支持 `path:行号`、`path:行号:列号` 和 `path#L行号`，预览中高亮对应行。Agent 的 `file://` 终端超链接也可打开；需 tmux 支持 OSC 8；不支持时仍可点击普通路径文本。
- 相对路径按点击位置对应分屏的**当前目录**解析；预览弹窗中也可选择分屏。
- 文本、代码和 Markdown 按源码显示，最多读取前 1 MiB、显示前 5000 行。HTML、SVG 也以源码显示，不执行脚本。
- PNG、JPEG、GIF、WebP 图片最多 8 MiB。目录最多列出 500 项，可进入文件、返回和转到上级目录。
- CSV、TSV、XLSX 显示为表格，带行号、列标和内容搜索；XLSX 可切换工作表。预览最多 500 行、50 列，每格 2000 字符，截断时会提示。搜索仅覆盖已预览的行。CSV/TSV 读取前 1 MiB；XLSX 文件最大 16 MiB、解压内容最大 64 MiB。Excel 公式显示原式，不重新计算；不还原图表、合并单元格和复杂格式。不支持旧版 XLS。
- PDF 使用浏览器自带阅读器，支持该阅读器提供的翻页、缩放等操作；浏览器不能内嵌时可点击「新标签页打开」。
- 音频支持 WAV、MP3、FLAC、OGG、Opus、M4A、AAC；视频支持 MP4、WebM、OGV、MOV、MKV。使用浏览器播放器，实际能否播放取决于文件编码及浏览器支持，不会自动转码。关闭预览或切换文件会停止播放。
- PDF、音视频走已登录的同源文件接口，按需读取并支持 Range 请求，无需把大文件全部加载进预览 JSON。
- 预览复用 LanTerm 登录权限，只读取 **LanTerm 服务所在主机**上当前系统用户可读的文件。Shell 内通过 SSH 连接另一台主机时，远端路径不能直接由本机预览。路径使用点击时的当前目录；旧输出对应的目录改变后，可改用绝对路径。

关闭弹窗后回到终端，预览不会修改文件。无需另开 `python -m http.server` 或额外端口。

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

媒体预览浏览器测试需要本机安装 `ffmpeg`，用于生成临时 WebM；运行 LanTerm 本身不依赖 ffmpeg。

前端用 `npm run format` 格式化，修改后重新构建。后端使用单个 Uvicorn worker。测试会创建独立端口和 tmux socket；可用 `PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome` 指定已有浏览器。
