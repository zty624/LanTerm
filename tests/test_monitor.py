from pathlib import Path

import pytest

from terminal.cgroup import Cgroup, Mount
from terminal.monitor import parse_gpus, rate


def files(path: Path, values: dict[str, str]) -> None:
    path.mkdir(parents=True, exist_ok=True)
    for name, value in values.items():
        (path / name).write_text(value)


def test_v2_hierarchical_quotas_and_counters(tmp_path):
    parent = tmp_path / "pod"
    child = parent / "worker"
    files(parent, {"cpu.max": "50000 100000", "memory.max": str(64 * 2**20), "pids.max": "128"})
    files(
        child,
        {
            "cpu.max": "max 100000",
            "cpu.stat": "usage_usec 2000000\nthrottled_usec 125000",
            "memory.max": "max",
            "memory.current": str(40 * 2**20),
            "memory.events": "oom 1\noom_kill 1",
            "pids.current": "12",
            "pids.max": "max",
            "io.stat": (
                "8:0 rbytes=100 wbytes=200 rios=1 wios=1\n8:1 rbytes=20 wbytes=50 rios=1 wios=1"
            ),
        },
    )
    group = Cgroup(2, {key: Mount(child, tmp_path) for key in ("cpu", "memory", "pids", "io")})
    snapshot = group.sample(8)
    assert snapshot["cpu_cores"] == 0.5
    assert snapshot["memory_limit"] == 64 * 2**20
    assert snapshot["cpu_shared_limit"] and snapshot["memory_shared_limit"]
    assert snapshot["cpu_seconds"] == 2 and snapshot["throttled_seconds"] == 0.125
    assert snapshot["memory_used"] == 40 * 2**20 and snapshot["oom_kills"] == 1
    assert snapshot["read_bytes"] == 120 and snapshot["write_bytes"] == 250
    assert snapshot["pids"] == 12 and snapshot["pids_limit"] == 128
    # Quota changes are observed without recreating the sampler.
    (parent / "cpu.max").write_text("200000 100000")
    assert group.sample(1)["cpu_cores"] == 1


def test_v1_cpuacct_and_unlimited_memory(tmp_path):
    files(
        tmp_path,
        {
            "cpu.cfs_quota_us": "150000",
            "cpu.cfs_period_us": "100000",
            "cpuacct.usage": "2500000000",
            "cpu.stat": "throttled_time 500000000",
            "memory.limit_in_bytes": "9223372036854771712",
            "memory.usage_in_bytes": "65536",
        },
    )
    group = Cgroup(1, {key: Mount(tmp_path, tmp_path) for key in ("cpu", "cpuacct", "memory")})
    sample = group.sample(8)
    assert sample["cpu_cores"] == 1.5 and sample["cpu_seconds"] == 2.5
    assert sample["memory_limit"] is None and sample["memory_used"] == 65536
    assert sample["read_bytes"] is None


@pytest.mark.parametrize(
    "membership,root,suffix",
    [("/pod/worker", "/pod", "worker"), ("/", "/pod", ""), ("/pod/worker", "/", "pod/worker")],
)
def test_namespace_mount_roots_are_resolved(tmp_path, membership, root, suffix):
    proc = tmp_path / "proc"
    mount = tmp_path / "cgroup with spaces"
    files(mount / suffix, {"cpu.max": "100000 100000"})
    escaped = str(mount).replace(" ", "\\040")
    files(
        proc / "self",
        {
            "cgroup": f"0::{membership}",
            "mountinfo": f"42 1 0:1 {root} {escaped} rw - cgroup2 cgroup rw",
        },
    )
    group = Cgroup.discover(proc)
    assert group.mounts["cpu"].path == mount / suffix
    assert group.sample(8)["cpu_cores"] == 1


def test_gpu_unsupported_fields_and_comma_in_device_name():
    parsed = parse_gpus('0, GPU-example, "NVIDIA, example", [N/A], 128, 40960, 38, 50.5')
    assert parsed[0]["utilization"] is None
    assert parsed[0]["name"] == "NVIDIA, example"
    assert parsed[0]["memory_used"] == 128 * 2**20
    assert parsed[0]["power"] == 50.5


def test_rate_warmup_reset_and_long_sample_gaps():
    assert rate(2, 1, 2) == 0.5
    assert rate(2, None, 2) is None
    assert rate(1, 2, 2) is None
    assert rate(100, 1, 60) is None
