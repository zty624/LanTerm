# 使用

## 参数

| 参数 | 默认值 / 用途 |
| --- | --- |
| `--host` / `--port` | `0.0.0.0` / `8766` |
| `--shell` | 从 `$SHELL` 读取，支持 Bash / Zsh |
| `--cwd` | `launch.sh` 默认使用仓库目录 |
| `--state-dir` | 默认位于用户运行目录，存放密码与 tmux socket |
| `--max-sessions` | `32`，每个会话最多 8 个浏览器连接 |
| `--plugins` | 默认 `codex,claude`；`none` 关闭插件 |
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

侧栏默认显示搜索与会话列表；展开「筛选与排序」可筛选分组、状态、排序和批量管理，启用的筛选数量在收起后仍可见。顶部保留分屏、搜索、粘贴和按键；重命名、置顶、复制、详情、历史及关闭会话位于「更多」。窗口较窄时顶部按钮只显示图标，悬停查看说明。手机上点击侧栏外的遮罩或按 Esc 可收起侧栏。

新建会话时可选择「启动程序」：仅 Shell、Claude Code、Codex 或自定义命令。LanTerm 先启动登录 Shell，再自动输入该命令并回车，命令会进入 Shell 历史；程序退出后回到 Shell，会话继续保留。空白页的卡片和命令面板也可直接新建 Claude Code / Codex 会话。自定义命令需为单行。

`Ctrl+Shift+P` 或顶部「命令」打开命令面板：模糊搜索会话名称、分组、标签和目录并切换，也可新建会话、分屏、搜索、预览文件、打开资源监控和切换主题。方向键选择，Enter 执行，Esc 关闭。

侧栏底部的「外观与通知」按钮可选择跟随系统、浅色或深色主题，并可让终端在浅色主题下保持深色配色；设置保存在当前浏览器。

Claude Code / Codex 在后台会话中完成任务（工作中 → 等待输入）或请求授权、回答时，页面右上角弹出提醒，对应会话显示提示点，标签页标题和图标显示未读数量；打开该会话后清除。可在「外观与通知」中开启提示音和桌面通知。桌面通知需通过 HTTPS 或 `localhost` 访问；开启任一项后，页面在后台也会约每 3 秒检查一次状态。

侧边栏底部显示 CPU、内存概览及最近 6 分钟的曲线，约每 3 秒更新；“资源监控”查看完整指标。

| 操作 | 方式 |
| --- | --- |
| 新建 / 编辑会话 | `Ctrl+Shift+K` / 双击侧栏会话 |
| 命令面板 | `Ctrl+Shift+P` |
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

## 代码变更

顶部「变更」或命令面板中的「代码变更（Git）」按所选分屏的**当前目录**查找 Git 仓库，列出未提交的改动：修改（M）、新增（A）、删除（D）、重命名（R）、未跟踪（U）和冲突（!），并显示增删行数、分支、HEAD 与上游的领先 / 落后提交数。点击文件查看相对 HEAD 的逐行 diff（包含已暂存和未暂存的改动），「预览文件」用文件预览打开当前版本。

面板只读：Git 命令不加锁、不运行 hooks、外部 diff 或 textconv，路径按字面解析且限制在仓库内，不会暂存、提交或修改工作区。最多列出 1000 个文件，单个 diff 最多 1 MiB、显示前 6000 行；二进制文件只提示不显示内容。与文件预览相同，只能查看 LanTerm 主机上的仓库。

## 文件预览

点击终端输出中的路径可打开只读文件预览，也可从顶部「更多 → 预览文件」输入路径。预览窗口在桌面仅保留 8px 外边距，右上角可「最大化 / 还原窗口」；手机上默认铺满屏幕。顶部合并路径与导航按钮，单分屏时隐藏分屏选择，给文件内容留出更多空间。

- 支持绝对路径、`~/`、`./`、`../`、含目录的相对路径和带扩展名的文件名。带空格的路径用引号或反引号包围，或使用文件超链接。
- 支持 `path:行号`、`path:行号:列号` 和 `path#L行号`，预览中高亮对应行。Agent 的 `file://` 终端超链接也可打开；需 tmux 支持 OSC 8；不支持时仍可点击普通路径文本。
- 相对路径按点击位置对应分屏的**当前目录**解析；预览弹窗中也可选择分屏。
- 文本和代码最多读取前 1 MiB、显示前 5000 行。支持自动语言识别、手动切换语言、行号、搜索当前视图、自动换行和复制源码；路径带行号时直接打开源码视图定位。Highlight.js 提供 193 种语言规则，覆盖 Python、JavaScript/TypeScript/JSX/TSX、Rust、Go、C/C++/CUDA、Java、Shell、SQL、YAML、TOML、XML、CSS、Diff、Dockerfile、Makefile 等。超过 200,000 字符时省略语法高亮。HTML、SVG、JS 等文件只显示代码，不执行。
- Markdown 默认排版预览，可切换源码；支持标题、表格、任务列表、引用、代码块高亮与复制。文档内相对文件链接按 Markdown 所在目录解析，本地图片复用已登录的预览接口读取，最多加载 20 张；外部图片显示占位，不自动请求。原始 HTML 标签按文本显示。
- Markdown 支持 `$...$` 行内公式、`$$...$$` 独立公式，以及 `mermaid` 代码围栏中的图表。公式使用 KaTeX，图表使用 Mermaid；无效图表会保留源码并提示。最多渲染前 200,000 字符和 12 张图表，单张图表最多 20,000 字符、300 条边。
- JSON、JSONC、JSONL/NDJSON 可切换结构树、格式化和源码。结构树按需展开，保留原始数值精度；JSONC 支持注释和尾逗号，JSONL 每条记录对应数组中的一项。无效 JSON 会提示行列位置并显示源码。树最多显示约 3000 个节点，搜索只覆盖当前已展开的节点；大型文件可切换到源码搜索。
- 渲染组件按需加载，所有 JS、字体和样式均从本机服务提供。
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
