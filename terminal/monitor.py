import asyncio
import csv
import logging
import os
import shutil
import socket
import subprocess
import time
from collections import defaultdict, deque
from pathlib import Path

import psutil

from terminal.cgroup import Cgroup, read

LOG = logging.getLogger(__name__)


def rate(value: float | None, previous: float | None, elapsed: float) -> float | None:
    if value is None or previous is None or elapsed <= 0 or elapsed > 15 or value < previous:
        return None
    return (value - previous) / elapsed


def gpu_number(value: str) -> float | None:
    if value.strip() in (
        "N/A",
        "[N/A]",
        "[Not Supported]",
        "Not Supported",
        "[Insufficient Permissions]",
    ):
        return None
    return float(value)


def parse_gpus(text: str) -> list[dict]:
    result = []
    for row in csv.reader(text.splitlines(), skipinitialspace=True):
        index, uid, name, usage, used, total, temp, power = row
        values = [gpu_number(value) for value in (usage, used, total, temp, power)]
        result.append(
            dict(
                index=index,
                uuid=uid,
                name=name,
                utilization=values[0],
                memory_used=None if values[1] is None else int(values[1] * 2**20),
                memory_total=None if values[2] is None else int(values[2] * 2**20),
                temperature=values[3],
                power=values[4],
            )
        )
    return result


def gpus() -> dict:
    if not shutil.which("nvidia-smi"):
        return {"status": "unavailable", "reason": "未安装 nvidia-smi", "devices": []}
    try:
        proc = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"status": "unavailable", "reason": "GPU 查询超时", "devices": []}
    except (FileNotFoundError, PermissionError):
        return {"status": "unavailable", "reason": "无法执行 nvidia-smi", "devices": []}
    if proc.returncode:
        return {"status": "unavailable", "reason": "NVIDIA 驱动不可用或设备未挂载", "devices": []}
    try:
        devices = parse_gpus(proc.stdout)
    except ValueError:
        LOG.warning("Unexpected nvidia-smi response format")
        return {"status": "unavailable", "reason": "GPU 驱动返回了无法解析的数据", "devices": []}
    return {"status": "ok", "reason": "", "devices": devices}


def process_data(items: list[dict], previous: dict, elapsed: float) -> tuple[dict, dict]:
    parents = defaultdict(list)
    for proc in psutil.process_iter(["pid", "ppid"]):
        parents[proc.info["ppid"]].append(proc.pid)
    current, result = {}, {}
    for item in items:
        pending = [pane["pid"] for pane in item["panes"] if not pane["dead"]]
        seen, rows = set(), []
        cwd = None
        while pending:
            pid = pending.pop()
            if pid in seen:
                continue
            seen.add(pid)
            pending.extend(parents[pid])
            try:
                proc = psutil.Process(pid)
                with proc.oneshot():
                    started = proc.create_time()
                    if started < item["created"] - 2:
                        continue
                    times = proc.cpu_times()
                    seconds = times.user + times.system
                    key = (pid, started)
                    current[key] = seconds
                    cores = rate(seconds, previous.get(key), elapsed)
                    rows.append(
                        dict(
                            pid=pid,
                            name=proc.name(),
                            status=proc.status(),
                            cpu_percent=None if cores is None else cores * 100,
                            rss_bytes=proc.memory_info().rss,
                            age_seconds=max(0, time.time() - started),
                        )
                    )
                    if pid == item["pid"]:
                        cwd = proc.cwd()
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
        measured = [row["cpu_percent"] for row in rows if row["cpu_percent"] is not None]
        result[item["id"]] = {
            "cwd": cwd,
            "process_count": len(rows),
            "cpu_percent": sum(measured) if measured else (0 if not rows else None),
            "rss_bytes": sum(row["rss_bytes"] for row in rows),
            "processes": sorted(rows, key=lambda row: -(row["cpu_percent"] or 0)),
        }
    return current, result


class Monitor:
    def __init__(self, cwd: Path, proc: Path, interval: float):
        self.cwd = cwd
        self.proc = proc
        self.interval = interval
        self.lock = asyncio.Lock()
        self.group = Cgroup.discover(proc)
        membership = read(proc / "1/cgroup") or ""
        self.container = (
            Path("/.dockerenv").exists()
            or Path("/run/.containerenv").exists()
            or bool(os.getenv("container"))
            or any(name in membership for name in ("kubepods", "docker", "containerd", "lxc"))
        )
        self.previous = {}
        self.processes = {}
        self.history = deque(maxlen=120)
        self.last = 0.0
        self.key = ()
        self.cached = None

    async def get(self, items: list[dict]) -> dict:
        key = tuple(
            (item["id"], item["pid"], tuple((pane["pid"], pane["dead"]) for pane in item["panes"]))
            for item in items
        )
        async with self.lock:
            if (
                self.cached is not None
                and self.key == key
                and time.monotonic() - self.last < self.interval
            ):
                return self.cached
            result = await asyncio.to_thread(self.sample, items)
            self.cached = result
            self.key = key
            return result

    def sample(self, items: list[dict]) -> dict:
        now = time.monotonic()
        elapsed = now - self.last if self.last else 0
        group = self.group.sample(len(os.sched_getaffinity(0)))
        memory = psutil.virtual_memory()
        cpu_scope = "cgroup" if group["cpu_seconds"] is not None else "unavailable"
        mem_scope = "cgroup" if group["memory_used"] is not None else "unavailable"
        if not self.container and cpu_scope == "unavailable":
            times = psutil.cpu_times()._asdict()
            group["cpu_seconds"] = sum(
                v for k, v in times.items() if k not in ("idle", "iowait", "guest", "guest_nice")
            )
            group["cpu_cores"] = float(os.cpu_count() or 1)
            cpu_scope = "host"
        if not self.container and mem_scope == "unavailable":
            group["memory_used"] = memory.total - memory.available
            group["memory_limit"] = memory.total
            mem_scope = "host"
        cores = rate(group["cpu_seconds"], self.previous.get("cpu_seconds"), elapsed)
        io_read = rate(group["read_bytes"], self.previous.get("read_bytes"), elapsed)
        io_write = rate(group["write_bytes"], self.previous.get("write_bytes"), elapsed)
        interfaces = psutil.net_io_counters(pernic=True)
        net = {
            "rx": sum(value.bytes_recv for name, value in interfaces.items() if name != "lo"),
            "tx": sum(value.bytes_sent for name, value in interfaces.items() if name != "lo"),
        }
        disk = None
        try:
            usage = psutil.disk_usage(str(self.cwd))
            disk = dict(
                path=str(self.cwd),
                total=usage.total,
                used=usage.used,
                free=usage.free,
                percent=usage.percent,
            )
        except (FileNotFoundError, PermissionError):
            LOG.debug("Working directory storage is unavailable: %s", self.cwd)
        current, sessions = process_data(items, self.processes, elapsed)
        gpu = gpus()
        result = {
            "timestamp": time.time(),
            "interval": self.interval,
            "environment": {
                "hostname": socket.gethostname(),
                "container": self.container,
                "cgroup_version": group["version"],
                "cgroup_path": group["path"],
                "cuda_visible_devices": os.getenv("CUDA_VISIBLE_DEVICES"),
            },
            "cpu": {
                "scope": cpu_scope,
                "cores_used": cores,
                "cores_limit": group["cpu_cores"],
                "quota_cores": group["cpu_quota"],
                "shared_limit": group["cpu_shared_limit"],
                "percent": None if cores is None else cores / group["cpu_cores"] * 100,
                "throttled_seconds": group["throttled_seconds"],
            },
            "memory": {
                "scope": mem_scope,
                "used": group["memory_used"],
                "limit": group["memory_limit"],
                "shared_limit": group["memory_shared_limit"],
                "oom_kills": group["oom_kills"],
            },
            "pids": {"current": group["pids"], "limit": group["pids_limit"]},
            "disk": disk,
            "io": {"read_rate": io_read, "write_rate": io_write},
            "network": {
                "rx_rate": rate(net["rx"], self.previous.get("rx"), elapsed),
                "tx_rate": rate(net["tx"], self.previous.get("tx"), elapsed),
            },
            "gpu": gpu,
            "sessions": sessions,
        }
        self.history.append(
            dict(
                timestamp=result["timestamp"],
                cpu=result["cpu"]["percent"],
                memory=group["memory_used"],
            )
        )
        result["history"] = list(self.history)
        self.previous = {**group, **net}
        self.processes = current
        self.last = now
        return result
