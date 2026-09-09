# LanTerm

<img src="web/lantern.svg" width="48" alt="LanTerm 灯笼" />

基于 tmux 的内网 Web 终端，支持 Bash / Zsh、Vim、Codex。浏览器断开后，会话继续运行。

- 会话重命名、分组、标签、置顶、复制和批量管理。
- CPU、内存、GPU 与会话进程监控。
- Codex 状态插件：工作中、等待输入、暂停等。

## 运行

需要 Linux、Python 3.11+、uv、tmux 3.3+；源码构建需要 Node.js 20+ 和 npm。

```bash
./launch.sh --shell bash --cwd /path/to/workspace
```

默认监听 `0.0.0.0:8766`。本机访问 <http://127.0.0.1:8766>，内网设备使用服务器 IP。

另开终端查看登录密码：

```bash
cat "${XDG_RUNTIME_DIR:-/tmp/lan-terminal-$(id -u)}/lan-terminal-8766/access-token"
```

所有会话共享服务所在机器的系统用户权限，适合可信内网使用。

## 文档

- [参数、操作与后台运行](docs/usage.md)
- [容器部署](docs/cluster.md)
- [状态插件](docs/plugins.md)
- [开发](docs/usage.md#开发)
