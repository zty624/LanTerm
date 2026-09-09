# 开发约定

- 本项目是运行在用户 Linux 主机上的 Web 终端，需要真实 PTY 和 tmux，不部署到静态站点或远程托管平台。
- Python 用 uv 管理依赖、ruff 格式化检查；前端保持原生 HTML / CSS / JavaScript。
- 核心类的方法形参不设置默认值；默认值只放在入口和 API 输入层。
- 避免宽泛捕获异常，用精确异常类型和 logging，尽早暴露非预期问题。
- 终端程序由 tmux 持有。关闭浏览器连接或 Web 服务时，只释放附着客户端；禁止连带终止用户会话。
- 所有 tmux 操作必须使用应用专用 socket，不能操作用户默认 tmux 服务。
- 测试使用真实 shell 和端到端行为，避免无意义的格式断言或哈希断言。
- 不提交 `.runtime/`、凭证、日志、缓存、依赖目录和构建产物。
- 使用本地 `feat/*`、`fix/*` 分支开发，验证后合入 `main`，保持主分支可运行。
- 相关验证：`uv run ruff check .`、`uv run ruff format --check .`、`uv run pytest -q`、`npm run format:check`、`npm run build`、`npm run test:e2e`。
