# 状态插件

默认启用 Codex 插件，在终端直接运行 `codex` 即可。关闭插件：

```bash
./launch.sh --plugins none
```

| 状态 | 含义 |
| --- | --- |
| Working · 工作中 | 任务进行中，包括思考、工具执行和等待后台命令 |
| 等待输入 | 等待下一条消息或阻塞式提问的回答 |
| 等待确认 / 输入 | Codex 报告 Action Required，打开终端查看具体内容 |
| 启动中 / 已中断 / 已暂停 | 对应启动、中断事件或挂起进程 |
| 已退出 | 进程结束，提示保留 30 秒 |
| 状态未知 | 检测到进程，但无法读取或识别状态 |

浏览器每 0.5 秒查询，后端缓存 0.25 秒。状态不变时保留原有元素；没有打开页面时停止采样。网络延迟、采样耗时会影响更新速度，短暂状态可能被跳过。

## 识别方式

按 tmux pane 的进程树和终端设备定位本机 Codex，再读取它已打开的根会话日志与终端标题。子代理日志会被过滤；切换线程时选择最近写入的根日志。

生命周期字段对照 Codex CLI 0.153.4，标题模式参考 [Codex 源码](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/status_surfaces.rs)。这些字段可能随版本变化。SSH 内的远端 Codex 无法识别；共享 app-server / remote 模式也可能缺少信号。

日志按 1 MiB 窗口增量读取，API 只返回状态和进程标识，不返回对话或工具参数。插件不修改 Codex 配置，也不代替用户审批或回答。

## 扩展

1. 在 `terminal/plugins/` 实现 `StatusPlugin`，提供 `id`、`name`、`version` 和 `sample(panes)`。
2. 在 `registry.py` 的 `PROVIDERS` 注册类，构造参数为 `Sessions`。
3. 用 `--plugins codex,插件名` 启用。

`sample` 接收 `Pane(session, id, pid, dead, tty)`，返回 `{session_id: [badge, ...]}`。耗时读取放到 `asyncio.to_thread`，限制读取范围和大小。

Badge 字段为 `plugin`、`name`、`state`、`label`、`detail`、`source`、`pane`、`pid`、`observed_at`。前端通过 `web/plugins.js` 渲染。

`GET /api/plugins/status` 返回各会话状态，`GET /api/config` 列出启用插件，均需登录。更新插件后重启 Web 服务并刷新页面。
