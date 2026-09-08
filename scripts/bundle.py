#!/usr/bin/env python3
"""Package the Python service and built web assets for an existing cluster image."""

import argparse
import io
import logging
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser(description="打包可迁移到现有集群容器的运行文件")
    parser.add_argument("--assets", type=Path, default=ROOT / "static")
    parser.add_argument("--output", type=Path, default=ROOT / "dist/LanTerm.tar.gz")
    args = parser.parse_args()
    assets = args.assets.resolve()
    for name in ("index.html", "app.js", "app.css", "lantern.svg"):
        if not (assets / name).is_file():
            parser.error("前端尚未构建，请先执行 npm ci && npm run build")
    sources = [
        ROOT / name
        for name in (
            "launch.py",
            "launch.sh",
            "pyproject.toml",
            "uv.lock",
            "README.md",
            "AGENTS.md",
            "docs/cluster.md",
            "docs/plugins.md",
            "terminal/tmux.conf",
            "scripts/bundle.py",
            "web/lantern.svg",
        )
    ]
    sources.extend(sorted((ROOT / "terminal").rglob("*.py")))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    requirements = subprocess.run(
        ["uv", "export", "--frozen", "--no-dev", "--no-hashes", "--no-header", "--no-emit-project"],
        cwd=ROOT,
        check=True,
        stdout=subprocess.PIPE,
    ).stdout

    def normalize(info: tarfile.TarInfo) -> tarfile.TarInfo:
        info.uid = info.gid = 0
        info.uname = info.gname = ""
        info.mode = 0o755 if info.name.endswith("launch.sh") else 0o644
        return info

    with tarfile.open(args.output, "w:gz") as archive:
        info = normalize(tarfile.TarInfo("LanTerm/requirements.txt"))
        info.size = len(requirements)
        archive.addfile(info, io.BytesIO(requirements))
        for path in sources:
            archive.add(
                path,
                arcname=str(Path("LanTerm") / path.relative_to(ROOT)),
                filter=normalize,
                recursive=False,
            )
        for name in (
            "index.html",
            "app.js",
            "app.css",
            "lantern.svg",
            "app.js.LEGAL.txt",
            "app.css.LEGAL.txt",
        ):
            path = assets / name
            if path.is_file():
                archive.add(path, arcname=f"LanTerm/static/{name}", filter=normalize)
    logging.info("运行包已生成: %s (%.1f KiB)", args.output, args.output.stat().st_size / 1024)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    main()
