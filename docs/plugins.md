# 状态插件

默认启用 Codex 与 Claude Code 插件，在终端直接运行 `codex` 或 `claude` 即可。只启用其中一个或全部关闭：

```bash
./launch.sh --plugins claude
./launch.sh --plugins none
```

| 状态 | 含义 |
| --- | --- |
| Working · 工作中 | 任务进行中，包括思考、工具执行和等待后台命令 |
| 等待输入 | 等待下一条消息或阻塞式提问的回答 |
| 等待确认 / 输入 | Codex 报告 Action Required，打开终端查看具体内容 |
| 等待授权 / 等待回答 / 等待操作 | Claude Code 请求使用工具、需要补充信息或其他确认 |
| 启动中 / 已中断 / 已暂停 | 对应启动、中断事件或挂起进程 |
| 已退出 | 进程结束，提示保留 30 秒 |
| 状态未知 | 检测到进程，但无法读取或识别状态 |

浏览器每 0.5 秒查询，后端缓存 0.25 秒。状态不变时保留原有元素；没有打开页面时停止采样。网络延迟、采样耗时会影响更新速度，短暂状态可能被跳过。

## Codex 识别方式

按 tmux pane 的进程树和终端设备定位本机 Codex，再读取它已打开的根会话日志与终端标题。Codex 0.157.1 会将日志交给直接子进程 `app-server`；插件也会读取该私有子进程的根日志（包括标记为 `vscode` 的会话来源），状态仍归属原 CLI。不会扫描全局 Codex 日志或借用其他进程的状态。子代理日志会被过滤；切换线程时选择最近写入的根日志。

生命周期字段对照 Codex CLI 0.153.4 / 0.157.1，标题模式参考 [Codex 源码](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/status_surfaces.rs)。这些字段可能随版本变化。SSH 内的远端 Codex 无法识别；共享 app-server / remote 模式也可能缺少信号。

日志按 1 MiB 窗口增量读取，API 只返回状态和进程标识，不返回对话或工具参数。插件不修改 Codex 配置，也不代替用户审批或回答。

## Claude Code 识别方式

同样按 pane 的进程树和终端设备定位名为 `claude` 的进程，再读取它自己维护的会话登记文件 `~/.claude/sessions/<PID>.json`；设置了 `CLAUDE_CONFIG_DIR` 时使用该目录。目录取自 Claude 进程自身的环境变量。tmux 中 Claude Code 的终端标题是静态的，不作为状态来源。

| 登记文件 `status` | 显示 |
| --- | --- |
| `busy` | Working · 工作中 |
| `idle` | 等待输入 |
| `waiting` + 权限提示 | 等待授权 |
| `waiting` + 需要输入 | 等待回答 |
| `waiting` + 打开了本地对话框（如 `/config`） | 等待输入 |
| `waiting` + 其他原因 | 等待操作 |

字段对照 Claude Code 2.1.323：`busy`、`idle`、对话框状态和退出时删除文件经实测验证，权限与输入请求的映射依据该版本的实现推断，可能随版本变化。只处理 `kind` 为 `interactive` 的登记；文件中的 PID、进程启动时间与实际进程不符时忽略，避免 PID 复用误报。`claude -p`、MCP 等无登记文件的辅助进程不显示状态。文件写入一半时保留上一次状态。

插件只读取 `status` 与 `waitingFor`，并映射为固定文案；不返回会话名、目录、等待原因原文或对话内容，不读取 transcript，也不修改 Claude Code 配置或 hooks。SSH 内的远端 Claude Code 无法识别。

## 扩展

1. 在 `terminal/plugins/` 实现 `StatusPlugin`，提供 `id`、`name`、`version` 和 `sample(panes)`。识别终端里的 Agent CLI 时可继承 `agent.py` 的 `AgentStatus`，只需实现 `state(proc, used)`，进程定位、暂停与退出保留由基类处理。
2. 在 `registry.py` 的 `PROVIDERS` 注册类，构造参数为 `Sessions`。
3. 用 `--plugins codex,插件名` 启用。

`sample` 接收 `Pane(session, id, pid, dead, tty)`；tmux 3.8 中已退出 pane 的 `pid` 为 `None`，返回 `{session_id: [badge, ...]}`。耗时读取放到 `asyncio.to_thread`，限制读取范围和大小。

Badge 字段为 `plugin`、`name`、`state`、`label`、`detail`、`source`、`pane`、`pid`、`observed_at`。前端通过 `web/plugins.js` 渲染。

`GET /api/plugins/status` 返回各会话状态，`GET /api/config` 列出启用插件，均需登录。更新插件后重启 Web 服务并刷新页面。
