# 迁移到现有集群容器

本阶段已实现容器内资源监控和可迁移运行包。连接或调度 SII / MOVA-Server 前，必须先由用户确认此次集群工作目录；此文档不会连接集群或提交任务。

## 本地生成运行包

```bash
npm ci
npm run build
uv run python scripts/bundle.py
```

生成 `dist/LanTerm.tar.gz`，内含 Python 服务、锁文件、文档和已构建的 Web UI。打包脚本使用明确的文件列表，不包含运行状态、访问密码、日志、Git、虚拟环境和本机 Shell 配置。源代码的完整开发仓库仍是本地 Git 仓库。

## 容器内启动

将包放入已确认的工作目录，解压后执行：

```bash
tar -xzf LanTerm.tar.gz
cd LanTerm
uv sync --frozen --no-dev
./launch.sh --host 0.0.0.0 --port 8766 --shell bash --cwd /已确认的集群工作目录
```

运行包内已有静态前端，因此集群容器不需要 Node.js、npm、CDN 或 systemd。需要 Python 3.11+、uv、tmux 3.3+ 及所选 Shell；例如 Ubuntu 镜像可由镜像维护者预装 `tmux bash zsh`。Python 软件源按集群内已有的源配置使用。

如果集群只能访问 SII 内部 Python 源，可使用包内从 `uv.lock` 导出的固定版本 `requirements.txt`，绕过锁文件中的公网下载地址：

```bash
uv venv
uv pip sync requirements.txt \
  --index-url http://nexus.sii.shaipower.online/repository/pypi/simple \
  --allow-insecure-host nexus.sii.shaipower.online
.venv/bin/python launch.py --host 0.0.0.0 --port 8766 --shell bash \
  --cwd /已确认的集群工作目录
```

这条安装路径仍使用 uv 和相同依赖版本，启动时直接调用已安装的环境。uv 不依赖 `pip config` 的源设置，需显式传入内部索引。

访问密码路径在启动日志中显示，默认位于用户运行目录或 `/tmp/lan-terminal-<UID>/lan-terminal-8766/access-token`。日志不输出密码内容。需要更换端口时使用 `--port`；状态目录随端口区分。需要固定状态目录时通过 `--state-dir` 指定支持 `0700` 私有权限的目录。

终端中的工具取决于该容器里的安装和配置；本机的 Codex 登录、Shell 配置和程序不会随运行包复制。平台需允许转发此 HTTP 端口及同端口 WebSocket。

如果通过 notebook 平台的路径代理访问，追加完整的公开访问地址：

```bash
./launch.sh --host 0.0.0.0 --port 8766 --shell bash \
  --cwd /已确认的集群工作目录 \
  --public-url 'https://平台域名/notebook/.../proxy/8766/'
```

浏览器访问该完整地址，并保留末尾 `/`。前端静态资源、API 和 WebSocket 均跟随当前路径前缀；后端兼容代理去掉前缀或保留前缀两种行为。`--public-url` 用于路径前缀和登录 Cookie 的 Path / Secure 设置，支持 HTTPS 代理转发到容器内部 HTTP。

登录、API 和 WebSocket 不再检查 Origin 与后端 Host / 协议是否一致，平台代理改写地址不会触发“不允许跨站访问”。访问密码、登录 Cookie、登录有效期和失败次数限制仍然生效；`--public-url` 不再充当来源白名单。

## 资源口径

| 项目 | 数据范围与解释 |
| --- | --- |
| CPU | 当前进程所在 cgroup 及其子组。按可见父级 CPU 配额与 CPU 亲和性的较小值计算可用核数；用量除以可用核数得到占比。未设 CPU quota 时，界面标注亲和性上限。 |
| 内存 | 优先读取 cgroup v2 `memory.current` / `memory.max`，或 v1 对应计数器。包含文件缓存等 cgroup 内存；上级共享限额会明确标识。容器未提供限额时显示“未设置可见内存上限”。 |
| 系统回退 | 本机没有可用 cgroup 计数器时，CPU / 内存可退回主机统计并明确标注“主机”；检测到容器后不会拿主机总内存冒充容器配额。 |
| GPU | `nvidia-smi` 可见设备的利用率、显存、温度和功耗；这些是设备级数据，可能包括同卡其他任务。`CUDA_VISIBLE_DEVICES` 单独展示。MIG 不支持的字段显示 `—`；未将整卡显存当作 MIG 或单会话配额。 |
| 会话 | 从 tmux 提供的 Shell PID 向下遍历进程树，展示 CPU、RSS、进程名、PID、状态和当前目录。CPU 100% 表示 1 核，RSS 合计可能重复计入共享页。进程脱离进程树后不计入会话。 |
| 磁盘容量 | 初始工作目录所在文件系统的总量和剩余空间，可能是共享挂载；不是个人或项目存储 quota。 |
| 磁盘 I/O | cgroup v2 `io.stat` 的读写速率；缺失或旧系统不提供时显示 `—`。 |
| 网络 | 当前网络命名空间中除 loopback 外的接口计数器合计；使用 host network 时是主机网络统计。 |

监控不需要 Docker socket、root 或特权容器。GPU 数据需要容器里有驱动设备和 `nvidia-smi`；缺失时只影响 GPU 卡片。只读取当前可见 cgroup 层级，无法探测被 cgroup 命名空间隐藏的父级限额，也不等同于集群调度器的项目 quota。

资源面板打开时每 3 秒刷新；多浏览器请求共享短时采样缓存，避免反复启动 `nvidia-smi`。CPU / 网络 / I/O 等速率需要两次采样，首次或相隔超过 15 秒时显示 `—`。最近 120 次采样保存在服务内存中，服务重启清空，不写入数据库或持续日志。

## 会话生命周期

分组、标签、置顶和备注存在本应用专用 tmux 服务的会话选项里，旧版本会话可直接继续使用。复制会话会用相同 Shell、当前目录、分组及标签启动一个新 Shell，不复制运行中的进程或临时环境变量。

浏览器断开、Web 服务进程单独重启后，可以恢复已有终端。容器被删除、Pod 重建、节点重启或平台清理所有进程时，tmux 进程也会结束；持久化 socket 文件不能恢复这些进程。训练任务仍应由训练框架负责 checkpoint 和续训。

技术参考：[Linux cgroup v2 文档](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)、[NVIDIA SMI 文档](https://docs.nvidia.com/deploy/nvidia-smi/)、[psutil](https://psutil.io/)。
