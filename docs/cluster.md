# 容器部署

## 生成运行包

```bash
npm ci
npm run build
uv run python scripts/bundle.py
```

生成 `dist/LanTerm.tar.gz`，包含后端、依赖锁文件、文档和已构建前端。容器需要 Python 3.11+、uv、tmux 3.3+ 和 Bash / Zsh。

## 启动

将运行包放入工作目录：

```bash
tar -xzf LanTerm.tar.gz
cd LanTerm
uv sync --frozen --no-dev
./launch.sh --shell bash --cwd /path/to/workspace
```

容器无需 Node.js 或 systemd。平台需转发 HTTP 和同端口的 WebSocket。容器内的 Codex、Shell 配置和登录状态需自行准备。参数与密码配置见 [使用说明](usage.md)。

SII 内部 Python 源可使用包内导出的固定版本依赖：

```bash
uv venv
uv pip sync requirements.txt \
  --index-url http://nexus.sii.shaipower.online/repository/pypi/simple \
  --allow-insecure-host nexus.sii.shaipower.online
.venv/bin/python launch.py --shell bash --cwd /path/to/workspace
```

## 路径代理

```bash
./launch.sh --shell bash --cwd /path/to/workspace \
  --public-url 'https://平台域名/notebook/.../proxy/8766/'
```

浏览器访问完整地址，保留末尾 `/`。代理需支持 WebSocket；后端兼容保留或移除路径前缀。`--public-url` 同时设置登录 Cookie 的 Path / Secure。接口通过密码和 Cookie 认证，不校验 Origin。

## 资源统计

| 指标 | 范围 |
| --- | --- |
| CPU | 当前 cgroup 及子组，用量按可见父级配额与 CPU 亲和性的较小值归一化 |
| 内存 | cgroup 用量，包含文件缓存；显示可见上限及共享父级限额 |
| 主机回退 | 非容器环境缺少 cgroup 计数器时，CPU / 内存改用主机统计并标注 |
| GPU | 驱动可见设备的整体用量，可能包含其他任务；无法读取的字段显示 `—` |
| 会话 | Shell 进程树的 CPU 和 RSS；CPU 100% 为一核，共享页可能重复计入 RSS |
| 存储 | 工作目录所在文件系统的容量和用量 |
| 磁盘 I/O | cgroup v2 `io.stat` 读写速率 |
| 网络 | 当前网络命名空间中除 loopback 外的接口合计 |

资源面板约每 3 秒更新，保留最近 120 次采样。速率需要两次采样，间隔超过 15 秒后重新计算。GPU 统计需要驱动和 `nvidia-smi`。

这些统计无法确定被命名空间隐藏的父级限额、调度器项目 quota 或 MIG 配额。会话进程脱离 Shell 进程树后不再计入。容器重建、节点重启会结束 tmux 进程，训练任务应通过 checkpoint 续训。
