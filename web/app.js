import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import './style.css';

const $ = (id) => document.getElementById(id);
const encoder = new TextEncoder();
const state = { config: null, sessions: [], active: null, term: null, ws: null, fit: null, search: null, retry: null, retries: 0, generation: 0, editing: null, loggedIn: false, refreshing: false };
let toastTimer;
let fontSize = Math.min(24, Math.max(10, Number(localStorage.getItem('lt-font')) || 14));

class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function api(path, method = 'GET', body) {
  const response = await fetch(`/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const error = await response.json();
    if (response.status === 401 && path !== '/login') showLogin();
    throw new ApiError(typeof error.detail === 'string' ? error.detail : '输入格式有误，请检查后重试', response.status);
  }
  if (response.status === 204) return null;
  return response.headers.get('Content-Type')?.includes('application/json') ? response.json() : response.text();
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function report(error) { toast(error.message); }
function bind(id, action) { $(id).addEventListener('click', () => Promise.resolve().then(action).catch(report)); }
function active() { return state.sessions.find((item) => item.id === state.active); }

function connection(text, status) {
  $('connection-status').textContent = text;
  $('connection-dot').className = `dot ${status}`;
}

function disconnect() {
  state.generation += 1;
  clearTimeout(state.retry);
  state.retry = null;
  const ws = state.ws;
  state.ws = null;
  if (ws) ws.close();
  state.term?.dispose();
  state.term = null;
  state.fit = null;
  state.search = null;
  $('terminal').replaceChildren();
  $('reconnect-banner').hidden = true;
}

function showLogin() {
  state.loggedIn = false;
  disconnect();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('workspace').hidden = true;
  $('login-screen').hidden = false;
  $('password').focus();
}

function render() {
  const fragment = document.createDocumentFragment();
  for (const item of state.sessions) {
    const button = document.createElement('button');
    button.className = `session-item${state.active === item.id ? ' active' : ''}`;
    button.setAttribute('role', 'listitem');
    button.setAttribute('aria-current', String(state.active === item.id));
    button.dataset.sessionId = item.id;
    button.title = `${item.name}\n初始目录: ${item.cwd}\n双击重命名`;
    const icon = document.createElement('span'); icon.className = 'session-icon'; icon.textContent = '>_';
    const info = document.createElement('span'); info.className = 'session-info';
    const title = document.createElement('strong'); title.textContent = item.name;
    const detail = document.createElement('small'); detail.textContent = `${item.shell} · ${item.status === 'exited' ? '已退出' : item.clients > 0 ? '已连接' : '后台运行'}`;
    const dot = document.createElement('span'); dot.className = `dot ${item.status === 'exited' ? 'muted' : ''}`;
    info.append(title, detail); button.append(icon, info, dot);
    button.addEventListener('click', () => select(item.id));
    button.addEventListener('dblclick', () => sessionDialog(item));
    fragment.append(button);
  }
  $('session-list').replaceChildren(fragment);
  $('session-count').textContent = state.sessions.length;
  const item = active();
  $('active-name').textContent = item?.name || '工作空间';
  $('active-detail').textContent = item ? `${item.shell}  ·  ${item.cwd}` : '选择或新建一个终端';
  $('active-detail').title = item ? `初始目录: ${item.cwd}` : '';
  $('session-actions').hidden = !item;
  $('restart-session').hidden = item?.status !== 'exited';
  $('empty-state').hidden = !!item;
  $('terminal').hidden = !item;
  document.title = item ? `${item.name} — LAN Terminal` : 'LAN Terminal';
}

async function refresh() {
  if (!state.loggedIn || state.refreshing) return;
  state.refreshing = true;
  try {
    state.sessions = await api('/sessions');
    if (state.active && !active()) {
      disconnect(); state.active = null;
    }
    if (!state.active && state.sessions.length) {
      select(state.sessions[0].id);
    } else {
      render();
    }
  } finally { state.refreshing = false; }
}

async function enter() {
  state.config = await api('/config');
  state.sessions = await api('/sessions');
  state.loggedIn = true;
  $('password').value = '';
  $('login-screen').hidden = true;
  $('workspace').hidden = false;
  $('host-label').textContent = location.host;
  $('session-shell').replaceChildren(...state.config.shells.map((shell) => new Option(shell, shell)));
  if (matchMedia('(max-width: 700px)').matches) document.body.classList.add('sidebar-hidden');
  const saved = localStorage.getItem('lt-active');
  state.active = null;
  if (state.sessions.length) select(state.sessions.find((item) => item.id === saved)?.id || state.sessions[0].id);
  else render();
}

function fit() {
  if (!state.fit || !$('terminal').clientHeight) return;
  const size = state.fit.proposeDimensions();
  if (size) state.term.resize(Math.min(500, Math.max(10, size.cols)), Math.min(200, Math.max(2, size.rows)));
  if (state.term) $('terminal-size').textContent = `${state.term.cols} × ${state.term.rows}`;
}

function sendControl(value) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(value));
}

function sendBytes(data) {
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  if (state.ws.bufferedAmount + data.byteLength > 2 * 1024 * 1024) {
    toast('发送缓冲区已满，请等待后再输入或分段粘贴');
    return;
  }
  for (let offset = 0; offset < data.length; offset += 16384) state.ws.send(data.subarray(offset, offset + 16384));
}

function sendInput(text) { sendBytes(encoder.encode(text)); }

function select(sid) {
  if (state.active === sid && state.ws) { state.term?.focus(); return; }
  disconnect();
  state.active = sid;
  state.retries = 0;
  localStorage.setItem('lt-active', sid);
  render();
  if (matchMedia('(max-width: 700px)').matches) document.body.classList.add('sidebar-hidden');
  connect();
}

function connect() {
  if (!state.loggedIn || !active()) return;
  disconnect();
  const generation = state.generation;
  const term = new Terminal({
    cursorBlink: true, cursorStyle: 'bar', fontSize,
    fontFamily: '"Cascadia Code", "JetBrains Mono", "Noto Sans Mono", "DejaVu Sans Mono", monospace',
    lineHeight: 1.15, scrollback: 20000, allowProposedApi: true,
    theme: { background: '#111318', foreground: '#d4dce5', cursor: '#8fdfb1', selectionBackground: '#455d5777', black: '#20252e', red: '#ee8a91', green: '#99cc99', yellow: '#e6c384', blue: '#88ade6', magenta: '#c3a1df', cyan: '#7dc4ca', white: '#d7dce3', brightBlack: '#758190', brightRed: '#ffabb0', brightGreen: '#b4e6b4', brightYellow: '#f2d8a3', brightBlue: '#adc8f0', brightMagenta: '#dcbeef', brightCyan: '#a6e0e5', brightWhite: '#f2f4f7' },
  });
  state.term = term;
  const fitAddon = new FitAddon(); state.fit = fitAddon; term.loadAddon(fitAddon);
  state.search = new SearchAddon(); term.loadAddon(state.search);
  term.loadAddon(new Unicode11Addon()); term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon((event, uri) => {
    event.preventDefault();
    const url = new URL(uri);
    if (['http:', 'https:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer');
  }));
  term.open($('terminal')); fit();
  $('font-size').textContent = `${fontSize}px`;
  const url = new URL(`/ws/${state.active}`, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('cols', Math.min(500, Math.max(10, term.cols)));
  url.searchParams.set('rows', Math.min(200, Math.max(2, term.rows)));
  const ws = new WebSocket(url); state.ws = ws; ws.binaryType = 'arraybuffer';
  connection('正在连接', 'waiting');
  ws.onopen = () => {
    if (state.generation !== generation) return;
    state.retries = 0; $('reconnect-banner').hidden = true;
    connection('已连接', ''); term.options.disableStdin = false;
    fit(); term.focus();
  };
  ws.onmessage = (event) => {
    if (state.generation !== generation) return;
    const data = new Uint8Array(event.data);
    term.write(data, () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', size: data.byteLength }));
    });
  };
  ws.onclose = async (event) => {
    if (state.generation !== generation || !state.loggedIn) return;
    connection('连接断开', 'waiting'); term.options.disableStdin = true;
    if (event.code === 4001) { showLogin(); return; }
    $('reconnect-banner').hidden = false;
    try { await refresh(); } catch (error) { if (error.status === 401) return; }
    if (state.generation !== generation || !active()) return;
    const delay = Math.min(1000 * 2 ** state.retries++, 10000);
    $('reconnect-text').textContent = `连接已断开，${delay / 1000} 秒后重连…`;
    state.retry = setTimeout(connect, delay);
  };
  term.onData(sendInput);
  term.onBinary((data) => sendBytes(Uint8Array.from(data, (char) => char.charCodeAt(0))));
  term.onResize(({ cols, rows }) => {
    sendControl({ type: 'resize', cols: Math.min(500, Math.max(10, cols)), rows: Math.min(200, Math.max(2, rows)) });
    $('terminal-size').textContent = `${cols} × ${rows}`;
  });
  term.attachCustomKeyEventHandler((event) => {
    if (event.ctrlKey && event.shiftKey && ['KeyC', 'KeyV', 'KeyF', 'KeyK'].includes(event.code)) {
      if (event.type === 'keydown' && event.code === 'KeyC') { event.preventDefault(); copySelection(); }
      return false;
    }
    return true;
  });
}

function copySelection() {
  const text = state.term?.getSelection();
  if (!text) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else fallbackCopy(text);
}

function fallbackCopy(text) {
  const field = document.createElement('textarea'); field.value = text;
  field.style.position = 'fixed'; field.style.left = '-10000px';
  document.body.append(field); field.select();
  const ok = document.execCommand('copy'); field.remove(); state.term?.focus();
  toast(ok ? '已复制' : '请使用浏览器的复制菜单');
}

function sessionDialog(item) {
  state.editing = item?.id || null;
  $('dialog-title').textContent = item ? '重命名会话' : '新建会话';
  $('session-submit').textContent = item ? '保存名称' : '创建会话';
  $('create-options').hidden = !!item;
  $('session-name').value = item?.name || `Terminal ${state.sessions.length + 1}`;
  $('session-shell').value = state.config.shell;
  $('session-cwd').value = state.config.cwd;
  $('session-error').textContent = '';
  $('session-dialog').showModal(); $('session-name').focus(); $('session-name').select();
}

function showSearch() {
  if (!state.term) return;
  $('search-bar').hidden = false; $('search-input').focus();
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  $('login-error').textContent = '';
  try { await api('/login', 'POST', { password: $('password').value }); await enter(); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter; button.disabled = true;
  const body = { name: $('session-name').value.trim() };
  try {
    let item;
    if (state.editing) item = await api(`/sessions/${state.editing}`, 'PATCH', body);
    else item = await api('/sessions', 'POST', { ...body, shell: $('session-shell').value, cwd: $('session-cwd').value });
    $('session-dialog').close();
    state.sessions = await api('/sessions');
    select(item.id); render();
  } catch (error) { if ($('session-dialog').open) $('session-error').textContent = error.message; else report(error); }
  finally { button.disabled = false; }
});

$('confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const sid = $('confirm-dialog').dataset.sid;
  event.submitter.disabled = true;
  try {
    await api(`/sessions/${sid}`, 'DELETE');
    $('confirm-dialog').close();
    if (state.active === sid) { disconnect(); state.active = null; }
    await refresh();
    if (!state.active) { connection('准备就绪', 'muted'); $('terminal-size').textContent = ''; }
  } catch (error) { $('close-error').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});

$('paste-form').addEventListener('submit', (event) => {
  event.preventDefault(); state.term?.paste($('paste-text').value);
  $('paste-dialog').close(); state.term?.focus();
});

for (const button of document.querySelectorAll('[data-dismiss]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('close', () => state.term?.focus());
for (const button of document.querySelectorAll('[data-key]')) button.addEventListener('click', () => {
  sendInput({ esc: '\x1b', tab: '\t', interrupt: '\x03', suspend: '\x1a', eof: '\x04', word: '\x17', transpose: '\x14', next: '\x0e', clear: '\x0c', up: '\x1b[A', down: '\x1b[B' }[button.dataset.key]);
  state.term?.focus();
});
bind('new-session', () => sessionDialog(null));
bind('first-session', () => sessionDialog(null));
bind('rename-session', () => sessionDialog(active()));
bind('close-session', () => { if (!active()) return; $('close-name').textContent = active().name; $('confirm-dialog').dataset.sid = state.active; $('close-error').textContent = ''; $('confirm-dialog').showModal(); });
bind('restart-session', async () => { await api(`/sessions/${state.active}/restart`, 'POST'); await refresh(); connect(); });
bind('show-paste', () => { $('paste-text').value = ''; $('paste-dialog').showModal(); $('paste-text').focus(); });
bind('show-keys', () => { document.body.classList.toggle('keys-visible'); fit(); });
bind('show-history', async () => { const text = await api(`/sessions/${state.active}/history`); $('history-content').textContent = text; $('history-dialog').showModal(); $('history-content').scrollTop = $('history-content').scrollHeight; });
bind('download-history', () => { const url = URL.createObjectURL(new Blob([$('history-content').textContent], { type: 'text/plain;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = `terminal-${state.active}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
bind('logout', async () => { await api('/logout', 'POST'); showLogin(); });
bind('toggle-sidebar', () => { document.body.classList.toggle('sidebar-hidden'); fit(); });
bind('fullscreen', async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); fit(); });
bind('reconnect-now', connect);
bind('show-search', showSearch);
bind('search-close', () => { $('search-bar').hidden = true; state.search?.clearDecorations(); state.term?.focus(); });
bind('search-next', () => state.search?.findNext($('search-input').value));
bind('search-prev', () => state.search?.findPrevious($('search-input').value));
$('search-input').addEventListener('input', () => state.search?.findNext($('search-input').value, { incremental: true }));
$('search-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') state.search?.[event.shiftKey ? 'findPrevious' : 'findNext']($('search-input').value); if (event.key === 'Escape') $('search-close').click(); });
function zoom(delta) { fontSize = Math.min(24, Math.max(10, fontSize + delta)); localStorage.setItem('lt-font', fontSize); $('font-size').textContent = `${fontSize}px`; if (state.term) { state.term.options.fontSize = fontSize; fit(); } }
bind('zoom-out', () => zoom(-1)); bind('zoom-in', () => zoom(1));
document.addEventListener('keydown', (event) => {
  if (!state.loggedIn || document.querySelector('dialog[open]')) return;
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyK') { event.preventDefault(); sessionDialog(null); }
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyF') { event.preventDefault(); showSearch(); }
});
new ResizeObserver(() => requestAnimationFrame(fit)).observe($('terminal'));
matchMedia('(max-width: 700px)').addEventListener('change', (event) => { document.body.classList.toggle('sidebar-hidden', event.matches); fit(); });
window.addEventListener('online', () => { if (state.loggedIn && state.ws?.readyState !== WebSocket.OPEN) connect(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.loggedIn) refresh().catch(report); });
setInterval(() => { if (state.loggedIn && !document.hidden) refresh().catch((error) => { if (error.status !== 401) connection('服务暂不可达', 'waiting'); }); }, 5000);
enter().catch((error) => { showLogin(); if (error.status !== 401) $('login-error').textContent = '暂时无法连接服务，请刷新页面重试'; });
