#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v tmux >/dev/null || { echo '请先安装 tmux（Arch: sudo pacman -S tmux）' >&2; exit 1; }
command -v uv >/dev/null || { echo '请先安装 uv' >&2; exit 1; }
if [[ ! -f static/app.js ]]; then
    npm ci --no-audit --no-fund
    npm run build
fi
exec uv run --frozen --no-dev python launch.py "$@"
