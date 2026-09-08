# Session 状态插件

LanTerm 的状态采集通过独立插件完成。默认启用 `codex`，在会话侧栏显示状态；无需改变原来启动 Codex 的方式。在 LanTerm 的 Bash / Zsh 中直接运行 `codex` 即可。

```bash
./launch.sh --plugins codex
# 完全禁用状态采集
./launch.sh --plugins none
```

已有服务更新后需要重启 **Web 服务** 并刷新浏览器。使用原来的 `--state-dir`，tmux 和 Codex 进程会继续保留。不要执行 `tmux kill-server`。状态会在重新登录后自动恢复识别。

## Codex 状态

| 侧栏显示 | 含义 |
| --- | --- |
| Working · 工作中 | Codex 有进行中的任务，包括思考、工具执行、等待后台命令 |
| 等待输入 | 任务结束后等待下一条消息，或正在提出阻塞式用户问题 |
| 等待确认 / 输入 | Codex 标题报告 Action Required；打开终端查看具体审批或提问 |
| 启动中 | Codex 明确报告 Starting |
| 已中断 · 等待输入 | 任务收到中断事件 |
| 已暂停 | Codex 进程被挂起，例如 Ctrl+Z |
| 已退出 | 检测到的 Codex 进程退出，保留提示 30 秒；Shell 继续运行 |
| 状态未知 | 进程存在，但缺少可识别的事件或没有读取权限 |

浏览器每 2 秒拉取一次；服务端共享短期采样缓存。所有会话的所有 pane 都会被检查，切换会话或断开终端 WebSocket 不影响采样。没有打开浏览器时不持续采样；重新打开会从当前进程和事件恢复状态。

### 状态来源与限制

1. 以 LanTerm 专用 tmux socket 中的 pane 为边界，通过进程树和终端设备确认本地 `codex` 进程。不会用目录名匹配会话，不会把两个相同工作目录的 session 混在一起。
2. 仅检查该进程已打开的 `rollout-*.jsonl` 文件，读取根 CLI / exec 会话的生命周期字段。`task_started` 对应工作中，`task_complete` 对应等待输入，`turn_aborted` 对应中断。阻塞式 `request_user_input` 调用与返回分别进入和离开等待状态；异步问题不当作阻塞。过滤 subagent 日志；CLI 切换线程时选择最近写入的根日志。
3. tmux 保存的 Codex OSC 标题补充启动、工作和 Action Required 信号。标题不区分审批与普通提问，因此合并显示“等待确认 / 输入”。插件不会自动审批、提交回答或向 Codex 注入按键。

这是适配器，不是 Codex 的稳定遥测 API。生命周期字段已对照本机 **Codex CLI 0.153.4**；标题模式参考 [Codex 官方实现](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/status_surfaces.rs)。Codex 版本、标题设置或事件格式变化可能降低识别能力。默认关闭标题动画、禁用标题或一次任务产生超过采样上限的连续输出时，部分状态可能暂时显示未知。不会按 CPU 高低、输出速度或长时间静默猜测任务是否结束。

通过 SSH 在另一台机器中运行的 Codex 不会被本机插件识别，LanTerm 只能看到 SSH 进程。不向当前 CLI 进程开放日志的共享 app-server / remote 模式也不能保证完整识别；检测到 CLI 但没有可靠信号时显示未知。初始会话选择界面、登录页面和错误页面也可能显示未知。`已退出` 只表示进程消失，不推断成功或失败。

采样不递归扫描 `$CODEX_HOME/sessions`，也不读取认证配置。日志按文件增量读取，每次最多 1 MiB；支持未写完的 JSON 行、文件截断和替换。API 只返回插件名、状态、pane、PID、采样时间和固定说明，不返回 prompt、回复、工具参数、标题内容或日志路径。不新增数据库或状态文件。

官方提供 [App Server 状态接口](https://learn.chatgpt.com/docs/app-server) 和 [Hooks](https://learn.chatgpt.com/docs/hooks)，但连接一个不同的 app-server 不能代表用户正在操作的 TUI，Hooks 还涉及来源信任配置。因此本插件采用只读的本地适配，不修改用户的 Codex 配置，也不接管 CLI。

## 添加其他插件

后端入口是 `terminal/plugins/registry.py` 的 `PROVIDERS`。新增一个实现 `terminal/plugins/base.py` 中 `StatusPlugin` 接口的类并注册名称；启动时用 `--plugins codex,新插件名` 启用。多个插件的 badge 可以并列显示。

插件需要提供 `id`、`name`、`version`，构造参数为 `Sessions`。异步 `sample(panes)` 接收 `Pane(session, id, pid, dead, tty)` 列表，返回 `{session_id: [badge, ...]}`。耗时的进程或文件读取放入 `asyncio.to_thread`，应有明确的大小和范围限制，不影响 PTY 的输入输出。

每个 badge 使用以下字段；状态名称与中文标签由插件自己提供：

```json
{
  "plugin": "codex",
  "name": "Codex",
  "state": "working",
  "label": "Working · 工作中",
  "detail": "",
  "source": "lifecycle",
  "pane": "%0",
  "pid": 12345,
  "observed_at": 1788880000
}
```

`GET /api/plugins/status` 返回启用插件、各会话的 badge 和采样时间，沿用登录 Cookie 验证。`GET /api/config` 的 `plugins` 字段列出启用插件。插件读取失败与 API 请求失败不会断开终端；前端请求失败时将已有 badge 标为“状态暂不可用”，避免保留过期的 Working 状态。

前端通用渲染器在 `web/plugins.js`，只使用 `textContent` 显示插件文字，不依赖 Codex 的状态解析逻辑。PTY、tmux 会话生命周期和资源监控均不依赖 Codex 插件。

测试使用隔离的真实 tmux / PTY 和可控制的 Codex 生命周期记录，验证切换状态、后台会话、子代理过滤、重启恢复及退出后的 Shell 保留；不会启动付费模型请求。
