# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

LanTerm is a LAN web terminal: a FastAPI backend that attaches browsers to tmux sessions over WebSockets, plus a vanilla-JS frontend bundled with esbuild. UI strings, error messages and docs are in Chinese. Keep new user-facing text in Chinese too. Commit messages are English Conventional Commits (`feat: …`, `fix: …`), with a wrapped body explaining why.

## Commands

The full verification list is in AGENTS.md. Extra commands:

```bash
uv sync --frozen && npm ci                       # setup
./launch.sh --shell bash --cwd /path/to/workspace # run (builds static/ only if static/app.js is missing)
npm run format                                   # prettier write for web/, tests/browser and playwright.config.js

uv run pytest tests/test_files.py::test_tables_preserve_cells_sheets_and_formulas -q
npx playwright test tests/browser/terminal.spec.js -g "tmux splits"
```

- The server serves `static/`, which is built output, not `web/`. After any edit in `web/`, run `npm run build` before a manual run or `npm run test:e2e`. Otherwise you will be testing stale assets. `launch.py` refuses to start if `static/app.js` is missing. `LAN_TERMINAL_STATIC_DIR` redirects both the build output and the served assets.
- E2E tests spawn `.venv/bin/python launch.py` on a random port with a temporary state dir. They need `npx playwright install chromium` (or `PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chrome`). Media-preview tests also need `ffmpeg`.
- pytest fixtures (`tests/conftest.py`) start a real uvicorn server with a private tmux socket in a temp dir, and run `kill-server` on that socket afterwards.
- For manual dev instances, always pass a distinct `--port` and `--state-dir`. The default (port 8766, state under `$XDG_RUNTIME_DIR/lan-terminal-8766`) may be the user's live instance with real sessions.

## Architecture

**Startup.** `launch.py` handles argparse and all defaults. It calls `config.prepare()` (validates tmux and the shell, creates the private state dir, loads or generates `access-token`) and then `create_app(config, plugins, ssh)`. All routes and shared objects are wired as closures inside `create_app` in `terminal/app.py`, and the server runs as a single uvicorn worker. State that lives only in memory, such as auth tokens, is lost on restart, so users must log in again.

**tmux is the only datastore.** Each session is a tmux session named `lt-<uuid hex>`, with its metadata (name, shell, cwd, group, tags, pinned, note) stored as base64 JSON in the session option `@lt_meta`. `Sessions.list()` rebuilds everything from `list-sessions` and `list-panes -a`. Every tmux call must go through `Sessions.run` / `Sessions.scan`, which add `-S <state>/tmux.sock -f terminal/tmux.conf` and a sanitized `child_env()`. `scan` treats "no server running" as empty. `Panes` (`terminal/panes.py`) wraps splits and pane actions on top of `Sessions`.

**Terminal WebSocket (`/ws/{sid}`).** Each connection creates a `Terminal` (`terminal/pty.py`). It opens a PTY and spawns `terminal/attach.py`, which calls TIOCSCTTY and then execs `tmux attach-session`. On disconnect only that attach client is reaped, and the shell keeps running inside tmux. Binary frames carry raw terminal bytes in both directions. Text frames are strict JSON control messages, `resize` or `ack`. Output pauses once about 256 KiB is unacknowledged, and the frontend must send `ack` for the bytes it has consumed.

**Auth.** `POST /api/login` checks the password from `LAN_TERMINAL_PASSWORD` or `access-token`, with rate limiting, and sets an in-memory token in an httponly cookie named `lan_terminal_<port>`. Routes under `/api/*` get auth through an `APIRouter` dependency. The WebSocket routes check `auth.valid()` manually, and new WS endpoints must do the same.

**Reverse proxy and CSP.** `--public-url` sets a path prefix, handled by `PrefixMiddleware` (`terminal/proxy.py`), which accepts both stripped and preserved prefixes. The cookie path follows that prefix. The CSP is strict `'self'`: no inline scripts and no CDNs. Every JS file, font and style must be bundled and served locally, and frontend URLs must stay relative so they work under a prefix.

**File preview and Git changes.** `GET /api/sessions/{sid}/file` resolves paths against the target pane's `#{pane_current_path}` and calls `terminal/files.py`, plus `tables.py` for CSV/XLSX. `/file/content` streams media and PDFs with Range support. `/git` and `/git/diff` (`terminal/git.py`) use the same pane directory for a read-only status and diff view: no locks, hooks, external diff or textconv, with literal pathspecs confined to the repo. Size and row limits are enforced on the backend.

**Session creation.** `POST /api/sessions` takes an optional single-line `command` (Claude Code, Codex or custom). It is typed into the new login shell with `send-keys`, so the shell remains when the program exits. `/api/config` lists the known agents.

**Status plugins.** `terminal/plugins/`: a `StatusPlugin` protocol (`base.py`) whose `sample(panes)` returns `{session_id: [badge]}`. Plugins are registered in `PROVIDERS` in `registry.py`, and `Plugins` caches results for 0.25s. Both default plugins subclass `AgentStatus` (`agent.py`), which finds the CLI by process name and controlling TTY in each pane's process tree, detects pause, and keeps an "exited" badge for 30s. In tmux 3.8 a dead pane has `pid` `None`. The Codex plugin reads rollout logs (`rollout.py`) and OSC titles. The Claude plugin reads Claude Code's own `<CLAUDE_CONFIG_DIR or ~/.claude>/sessions/<pid>.json` (`status` busy/idle/waiting plus `waitingFor`) and validates `procStart` against `/proc/<pid>/stat`. Badges carry only fixed labels: never forward names, paths, `waitingFor` text or conversation content. Tests drive fake CLIs in real tmux panes (`tests/fixtures/*_process.py`). See `docs/plugins.md`.

**Monitor.** `terminal/monitor.py` samples CPU, memory, disk usage, disk I/O, network, GPU (via `nvidia-smi`) and per-session process trees from `/proc`. CPU and memory come from the process cgroup (`cgroup.py`, v1 and v2, including limits, OOM kills and throttling), with a fallback to host figures outside containers. Results are cached for 3s. The last 120 samples (about 6 minutes of CPU, memory, rx/tx, read/write and per-GPU use) are returned as `history` for the trend charts.

**SSH tunnel (optional, `--ssh`).** `terminal/ssh.py` (routes and the `/ssh` page) and `terminal/tunnel.py` (a multiplexed TCP-over-WebSocket bridge) are installed only when the flag is set. Origin checks depend on `--public-url`. See `docs/ssh.md`.

**Frontend.** `web/build.mjs` has three esbuild entries:
- `web/app.js` uses ESM with code splitting. Heavy renderers (`developer.js`, `text-renderers.js`, `diagrams.js` for highlight.js, marked, KaTeX and Mermaid) are loaded through dynamic `import()` and should stay lazy.
- `web/ticker.js` is a classic worker that keeps agent alerts timely in hidden tabs.
- `web/ssh.js` / `ssh.css` form a separate page.

`index.html`, `ssh.html` and `lantern.svg` are copied as-is. Other parts of the frontend:
- **Theme.** All colors are CSS custom properties in `web/tokens.css`, shared by `style.css` and `ssh.css`. Light is the default; dark applies via `prefers-color-scheme` or `<html data-theme>`. Use tokens, never hard-coded colors. `theme.js` stores the preference, sets `data-resolved-theme` / `data-terminal-theme`, and supplies the xterm palette. Mermaid and highlight.js colors follow the tokens too. Known literal-colour exceptions: the xterm palettes in `theme.js`, the favicon badge in `attention.js`, the palettes in `scene.js` (one per theme) and `pixel.js`, and in `style.css` the lantern glow, the dark-terminal history text and the PDF and video stage backgrounds.
- **Login scene.** `scene.js` (`LoginScene`) draws the login backdrop on `#login-scene`: ASCII ridgelines, a shaded moon (a vermilion sun in light theme), mist and a lake, with pixel sky lanterns rising from the water. Sky and hills are repainted only on resize or theme change, mist and water about every 120ms, and lanterns at about 30fps. `app.js` starts it when the login screen shows, stops it after login and calls `setTheme` on theme changes. It skips frames in hidden tabs and draws one still frame under `prefers-reduced-motion`. `pixel.js` replaces `data-pixel="lantern"` placeholders (the empty-workspace lantern) with crisp SVG rects from static rows.
- **Icons.** `<span data-icon="name">` placeholders in HTML are replaced by SVGs from `icons.js` at startup. Icon-only buttons need an `aria-label`. JS that changes a button's text must target its `.label` / `.tool-label` child.
- **Charts.** `monitor.js` renders the resource panel. `charts.js` (`TrendChart`) draws its 6-minute trends for CPU, memory, network, disk I/O and each GPU, with a crosshair readout on hover and keyboard focus. Series colors are `--series-1/2` and meter fills turn `--status-warn/critical` at 85/95%; these follow the dataviz reference palette, validated for both themes.
- **Copy.** The toolbar is icon-only, and dialogs, panels and the login carry no explanatory paragraphs. Put scope notes and units in `title` tooltips instead.
- **Other modules.** `palette.js` (Ctrl+Shift+P command palette), `attention.js` (turns plugin state transitions into notices, title/favicon counts, desktop notifications and a chime) and `changes.js` (Git panel).
- **DOM helpers.** These live in `web/dom.js`, where `reconcile` handles keyed list updates.
- **E2E contract.** The browser tests rely on element IDs, accessible names, the badge text format (`Codex · 等待输入`) and `★` for pinned sessions. Keep them stable.

**Packaging.** `scripts/bundle.py` builds `dist/LanTerm.tar.gz` for containers (`docs/cluster.md`). It packs the whole `static/` build (including `chunks/` and `assets/`) and refuses to run until the frontend is built. Backend `.py` files are found automatically, but new docs and top-level files must be added to its `sources` list.
