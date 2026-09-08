"""Read the process's visible cgroup hierarchy without requiring Docker or root."""

import logging
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

LOG = logging.getLogger(__name__)


def read(path: Path) -> str | None:
    try:
        return path.read_text().strip()
    except FileNotFoundError:
        return None
    except PermissionError:
        LOG.debug("Cannot read resource counter: %s", path)
        return None


def fields(text: str | None) -> dict[str, int]:
    return {key: int(value) for key, value in (line.split() for line in (text or "").splitlines())}


def limit(text: str | None) -> int | None:
    if text is None or text in ("max", "-1", ""):
        return None
    value = int(text)
    return None if value >= 2**60 else value


def unescape(value: str) -> str:
    return re.sub(r"\\([0-7]{3})", lambda match: chr(int(match[1], 8)), value)


@dataclass(frozen=True)
class Mount:
    path: Path
    root: Path

    def parents(self) -> list[Path]:
        # Stop at the mount boundary; hidden ancestors are not observable.
        return [self.path, *list(self.path.parents)[: len(self.path.relative_to(self.root).parts)]]


class Cgroup:
    def __init__(self, version: int, mounts: dict[str, Mount]):
        self.version = version
        self.mounts = mounts

    @classmethod
    def discover(cls, proc: Path):
        memberships = {}
        for line in (read(proc / "self/cgroup") or "").splitlines():
            _, names, path = line.split(":", 2)
            for name in names.split(","):
                memberships[name] = PurePosixPath(path)
        unified, legacy = {}, {}
        for line in (read(proc / "self/mountinfo") or "").splitlines():
            before, after = line.split(" - ", 1)
            kind, _, options = after.split()[:3]
            if kind not in ("cgroup", "cgroup2"):
                continue
            parts = before.split()
            root = PurePosixPath(unescape(parts[3]))
            point = Path(unescape(parts[4]))
            names = [""] if kind == "cgroup2" else options.split(",")
            for name in names:
                group = memberships.get(name)
                if group is None:
                    continue
                if group.is_relative_to(root):
                    relative = group.relative_to(root)
                elif group == PurePosixPath("/"):
                    relative = PurePosixPath(".")
                else:
                    continue
                path = point / str(relative)
                if not path.is_dir():
                    continue
                if kind == "cgroup2":
                    unified.update(
                        {key: Mount(path, point) for key in ("cpu", "memory", "pids", "io")}
                    )
                else:
                    legacy[name] = Mount(path, point)
        if any(key in legacy for key in ("cpu", "memory", "cpuacct")):
            return cls(1, legacy)
        return cls(2 if unified else 0, unified)

    def file(self, controller: str, name: str) -> str | None:
        mount = self.mounts.get(controller)
        return read(mount.path / name) if mount else None

    def limits(self, controller: str, name: str) -> list[tuple[Path, int]]:
        mount = self.mounts.get(controller)
        if not mount:
            return []
        result = []
        for path in mount.parents():
            value = limit(read(path / name))
            if value is not None:
                result.append((path, value))
        return result

    def sample(self, affinity: int) -> dict:
        cpu = self.mounts.get("cpu")
        quotas = []
        if cpu:
            for path in cpu.parents():
                if self.version == 2:
                    values = (read(path / "cpu.max") or "max 100000").split()
                    quota, period = limit(values[0]), int(values[1])
                else:
                    quota = limit(read(path / "cpu.cfs_quota_us"))
                    period = limit(read(path / "cpu.cfs_period_us"))
                if quota is not None and period:
                    quotas.append((path, quota / period))
        quota = min(quotas, key=lambda item: item[1]) if quotas else None
        name = "memory.max" if self.version == 2 else "memory.limit_in_bytes"
        caps = self.limits("memory", name)
        mem_cap = min(caps, key=lambda item: item[1]) if caps else None
        stat = fields(self.file("cpu", "cpu.stat"))
        seconds = stat.get("usage_usec")
        if self.version == 2:
            seconds = seconds / 1e6 if seconds is not None else None
            mem = limit(self.file("memory", "memory.current"))
            events = fields(self.file("memory", "memory.events"))
            throttle = stat.get("throttled_usec")
            throttle = throttle / 1e6 if throttle is not None else None
        else:
            seconds = limit(self.file("cpuacct", "cpuacct.usage"))
            seconds = seconds / 1e9 if seconds is not None else None
            mem = limit(self.file("memory", "memory.usage_in_bytes"))
            events = {}
            throttle = stat.get("throttled_time")
            throttle = throttle / 1e9 if throttle is not None else None
        io = self.file("io", "io.stat")
        totals = {"rbytes": 0, "wbytes": 0}
        for line in (io or "").splitlines():
            for pair in line.split()[1:]:
                key, value = pair.split("=", 1)
                if key in totals:
                    totals[key] += int(value)
        pid_caps = self.limits("pids", "pids.max")
        return {
            "version": self.version,
            "path": str(cpu.path) if cpu else None,
            "cpu_seconds": seconds,
            "cpu_cores": min(affinity, quota[1]) if quota else float(affinity),
            "cpu_quota": quota[1] if quota else None,
            "cpu_shared_limit": bool(quota and cpu and quota[0] != cpu.path),
            "throttled_seconds": throttle,
            "memory_used": mem,
            "memory_limit": mem_cap[1] if mem_cap else None,
            "memory_shared_limit": bool(mem_cap and mem_cap[0] != self.mounts["memory"].path),
            "oom_kills": events.get("oom_kill"),
            "pids": limit(self.file("pids", "pids.current")),
            "pids_limit": min(value for _, value in pid_caps) if pid_caps else None,
            "read_bytes": totals["rbytes"] if io is not None else None,
            "write_bytes": totals["wbytes"] if io is not None else None,
        }
