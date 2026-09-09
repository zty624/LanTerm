import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ResourceView } from './monitor.js';
import { SessionStatus } from './plugins.js';
import { PaneControls } from './panes.js';
import { $, el, reconcile, text } from './dom.js';
import './style.css';

const encoder = new TextEncoder();
const state = {
  config: null,
  sessions: [],
  active: null,
  term: null,
  ws: null,
  fit: null,
  search: null,
  retry: null,
  retries: 0,
  generation: 0,
  editing: null,
  loggedIn: false,
  refreshing: false,
  view: 'terminal',
  batch: false,
  selected: new Set(),
  batchIds: [],
  batchAction: '',
};
const resources = new ResourceView(
  api,
  () => state.sessions,
  select,
  () => state.loggedIn,
);
const plugins = new SessionStatus(api, () => state.loggedIn);
const panes = new PaneControls(
  api,
  async (sid) => {
    await refresh();
    if (sid && sid !== state.active) select(sid);
    plugins.refresh();
    state.term?.focus();
  },
  report,
  plugins,
);
const sessionView = (items) =>
  items.map(({ activity, panes, pid, active_pane, active_dead, ...item }) => ({
    ...item,
    pane_ids: panes.map((pane) => pane.id),
    activity: $('session-sort').value === 'activity' ? activity : null,
  }));
let toastTimer;
let fontSize = Math.min(28, Math.max(10, Number(localStorage.getItem('lt-font')) || 16));

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(path, method = 'GET', body, signal) {
  const response = await fetch(new URL(`api${path}`, location.href), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const error = await response.json();
    if (response.status === 401 && path !== '/login') showLogin();
    throw new ApiError(
      typeof error.detail === 'string' ? error.detail : '输入格式有误，请检查后重试',
      response.status,
    );
  }
  if (response.status === 204) return null;
  return response.headers.get('Content-Type')?.includes('application/json')
    ? response.json()
    : response.text();
}

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    $('toast').hidden = true;
  }, 4000);
}

function report(error) {
  toast(error.message);
}
function bind(id, action) {
  $(id).addEventListener('click', () => Promise.resolve().then(action).catch(report));
}
function active() {
  return state.sessions.find((item) => item.id === state.active);
}

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
  plugins.reset([]);
  panes.reset();
  disconnect();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('workspace').hidden = true;
  $('login-screen').hidden = false;
  $('password').focus();
  resources.reset();
}

function filteredSessions() {
  const query = $('filter-query').value.trim().toLowerCase();
  const group = $('filter-group').value;
  const status = $('filter-status').value;
  const sort = $('session-sort').value;
  return state.sessions
    .filter((item) => {
      if (
        query &&
        ![item.name, item.group, item.cwd, item.note, ...item.tags]
          .join(' ')
          .toLowerCase()
          .includes(query)
      )
        return false;
      if (group && (group === '@none' ? !!item.group : `group:${item.group}` !== group))
        return false;
      if (status === 'running' && item.status !== 'running') return false;
      if (status === 'exited' && item.status !== 'exited') return false;
      if (status === 'attached' && !item.clients) return false;
      if (status === 'detached' && (item.clients || item.status !== 'running')) return false;
      if (status === 'pinned' && !item.pinned) return false;
      return true;
    })
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (a.pinned ? 0 : a.group.localeCompare(b.group)) ||
        (sort === 'name'
          ? a.name.localeCompare(b.name)
          : sort === 'activity'
            ? b.activity - a.activity
            : b.created - a.created) ||
        a.id.localeCompare(b.id),
    );
}

function groupOptions() {
  const names = [...new Set(state.sessions.map((item) => item.group).filter(Boolean))].sort();
  const key = JSON.stringify(names);
  if ($('filter-group').dataset.options === key) return;
  const selected = $('filter-group').value;
  $('filter-group').replaceChildren(
    new Option('全部分组', ''),
    new Option('未分组', '@none'),
    ...names.map((name) => new Option(name, `group:${name}`)),
  );
  $('filter-group').value = [...$('filter-group').options].some(
    (option) => option.value === selected,
  )
    ? selected
    : '';
  $('filter-group').dataset.options = key;
  $('group-options').replaceChildren(...names.map((name) => new Option(name, name)));
}

async function selectPane(sid, pane) {
  await api(`/sessions/${sid}/panes/action`, 'POST', { pane, action: 'select' });
  select(sid);
  await refresh();
}

function syncPanes() {
  for (const group of document.querySelectorAll('[data-pane-session]')) {
    const item = state.sessions.find((item) => item.id === group.dataset.paneSession);
    if (!item) continue;
    reconcile(
      group,
      item.panes.map((pane) => ({ ...pane, key: pane.id })),
      (pane) => {
        const row = el('div', 'sidebar-pane');
        const button = el('button', 'pane-switch');
        button.setAttribute('aria-label', `切换到分屏 ${pane.id}`);
        const heading = el('span', 'pane-heading');
        heading.append(
          el('code', 'pane-number', pane.id),
          el('span', 'pane-command'),
          el('span', 'pane-focus', '输入'),
        );
        button.append(heading, plugins.render(item.id, pane.id));
        button.addEventListener('click', () => selectPane(item.id, pane.id).catch(report));
        const menu = el('button', 'pane-menu', '⋯');
        menu.setAttribute('aria-label', `管理分屏 ${pane.id}`);
        menu.addEventListener('click', () => panes.open(item.id, pane.id));
        row.append(button, menu);
        return row;
      },
      (row, pane) => {
        const current = state.active === item.id && pane.visible && pane.active;
        row.classList.toggle('active', current);
        row.querySelector('.pane-switch').setAttribute('aria-current', String(current));
        row.querySelector('.pane-switch').disabled = !pane.visible;
        row.querySelector('.pane-menu').disabled = !pane.visible;
        row.title = pane.visible ? '' : '此分屏位于其他 tmux 窗口，请先切换窗口';
        row.querySelector('.pane-focus').hidden = !current;
        text(
          row.querySelector('.pane-command'),
          `${pane.dead ? '已退出' : pane.command || item.shell}${pane.visible ? '' : ' · 其他窗口'}`,
        );
      },
    );
  }
  const item = active();
  const focused = item?.panes.find((pane) => pane.id === item.active_pane);
  if (state.view === 'terminal' && item)
    text(
      $('active-detail'),
      `${item.pane_count > 1 ? `${focused.id} · ` : ''}${focused.command || item.shell} · ${item.cwd}`,
    );
  $('restart-session').hidden = !item?.active_dead;
  $('restart-session').textContent = item?.pane_count > 1 ? '重启分屏' : '重新启动';
  panes.sync(state.sessions);
}

function render() {
  groupOptions();
  const ids = new Set(state.sessions.map((item) => item.id));
  state.selected = new Set([...state.selected].filter((id) => ids.has(id)));
  const visible = filteredSessions();
  const fragment = document.createDocumentFragment();
  let lastGroup = null;
  for (const item of visible) {
    const group = item.pinned ? '★ 置顶' : item.group || '未分组';
    if (lastGroup !== group) {
      const heading = el('div', 'group-heading', group);
      fragment.append(heading);
      lastGroup = group;
    }
    const row = el('div', 'session-row');
    row.setAttribute('role', 'listitem');
    if (state.batch) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = state.selected.has(item.id);
      checkbox.setAttribute('aria-label', `选择 ${item.name}`);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selected.add(item.id);
        else state.selected.delete(item.id);
        $('selected-count').textContent = `已选 ${state.selected.size}`;
      });
      row.append(checkbox);
    }
    const button = document.createElement('button');
    button.className = `session-item${state.active === item.id ? ' active' : ''}`;
    button.setAttribute('aria-current', String(state.active === item.id));
    button.dataset.sessionId = item.id;
    button.title = `${item.name}\n${item.group || '未分组'} · 初始目录: ${item.cwd}\n${item.note || '双击编辑名称、分组和标签'}`;
    const icon = el('span', 'session-icon', item.pinned ? '★' : '>_');
    const info = el('span', 'session-info');
    const title = el('strong', '', item.name);
    const detail = document.createElement('small');
    detail.textContent = `${item.shell}${item.panes.length > 1 ? ` · ${item.panes.length} 个分屏` : ''} · ${item.status === 'exited' ? '已退出' : item.clients > 0 ? '已连接' : '后台运行'}`;
    const dot = document.createElement('span');
    dot.className = `dot ${item.status === 'exited' ? 'muted' : ''}`;
    info.append(title, detail);
    if (item.panes.length === 1) info.append(plugins.render(item.id, item.active_pane));
    if (item.tags.length) {
      const tags = el('span', 'session-tags');
      for (const name of item.tags.slice(0, 3)) {
        tags.append(el('span', '', name));
      }
      info.append(tags);
    }
    button.append(icon, info, dot);
    button.addEventListener('click', () => select(item.id));
    button.addEventListener('dblclick', () => sessionDialog(item));
    row.append(button);
    fragment.append(row);
    if (item.panes.length > 1) {
      const group = el('div', 'session-panes');
      group.dataset.paneSession = item.id;
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', `${item.name} 的分屏`);
      fragment.append(group);
    }
  }
  if (!visible.length) {
    const empty = el('p', 'monitor-note', '没有匹配的会话');
    fragment.append(empty);
  }
  $('session-list').replaceChildren(fragment);
  $('session-count').textContent = `${visible.length} / ${state.sessions.length}`;
  $('batch-tools').hidden = !state.batch;
  $('selected-count').textContent = `已选 ${state.selected.size}`;
  $('batch-mode').textContent = state.batch ? '退出批量' : '批量管理';
  const item = active();
  const monitoring = state.view === 'resources';
  $('active-name').textContent = monitoring ? '资源监控' : item?.name || '工作空间';
  $('active-detail').textContent = monitoring
    ? '容器配额 · GPU · Session 进程'
    : item
      ? `${item.shell}  ·  ${item.cwd}`
      : '选择或新建一个终端';
  $('active-detail').title = item ? `初始目录: ${item.cwd}` : '';
  $('session-actions').hidden = !item || monitoring;
  $('pin-session').textContent = item?.pinned ? '取消置顶' : '置顶';
  $('restart-session').hidden = !item?.active_dead;
  $('restart-session').textContent = item?.pane_count > 1 ? '重启分屏' : '重新启动';
  $('empty-state').hidden = !!item || monitoring;
  $('terminal').hidden = !item || monitoring;
  $('monitor-view').hidden = !monitoring;
  resources.setVisible(monitoring);
  $('show-monitor').textContent = monitoring ? '返回终端' : '资源监控';
  document.body.classList.toggle('resources-open', monitoring);
  if (monitoring) $('search-bar').hidden = true;
  document.title = monitoring ? '资源监控 — LanTerm' : item ? `${item.name} — LanTerm` : 'LanTerm';
  syncPanes();
}

async function refresh() {
  if (!state.loggedIn || state.refreshing) return;
  state.refreshing = true;
  try {
    const sessions = await api('/sessions');
    const changed =
      JSON.stringify(sessionView(sessions)) !== JSON.stringify(sessionView(state.sessions));
    state.sessions = sessions;
    if (state.active && !active()) {
      disconnect();
      state.active = null;
    }
    if (!state.active && state.sessions.length) {
      select(state.sessions[0].id);
    } else if (changed) {
      render();
    } else syncPanes();
  } finally {
    state.refreshing = false;
  }
}

async function enter() {
  state.config = await api('/config');
  state.sessions = await api('/sessions');
  state.loggedIn = true;
  plugins.reset(state.config.plugins || []);
  plugins.refresh();
  $('password').value = '';
  $('login-screen').hidden = true;
  $('workspace').hidden = false;
  $('host-label').textContent = location.host;
  $('session-shell').replaceChildren(
    ...state.config.shells.map((shell) => new Option(shell, shell)),
  );
  if (matchMedia('(max-width: 700px)').matches) document.body.classList.add('sidebar-hidden');
  const saved = localStorage.getItem('lt-active');
  state.active = null;
  if (state.sessions.length)
    select(state.sessions.find((item) => item.id === saved)?.id || state.sessions[0].id);
  else render();
  resources.resume();
}

function fit() {
  if (!state.fit || !$('terminal').clientHeight) return;
  const size = state.fit.proposeDimensions();
  if (size)
    state.term.resize(
      Math.min(500, Math.max(10, size.cols)),
      Math.min(200, Math.max(2, size.rows)),
    );
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
  for (let offset = 0; offset < data.length; offset += 16384)
    state.ws.send(data.subarray(offset, offset + 16384));
}

function sendInput(text) {
  sendBytes(encoder.encode(text));
}

function select(sid) {
  state.view = 'terminal';
  if (state.active === sid && state.ws) {
    render();
    fit();
    state.term?.focus();
    return;
  }
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
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize,
    fontFamily:
      '"Cascadia Code", "JetBrains Mono", "Noto Sans Mono", "DejaVu Sans Mono", monospace',
    lineHeight: 1.15,
    scrollback: 20000,
    allowProposedApi: true,
    theme: {
      background: '#111318',
      foreground: '#d4dce5',
      cursor: '#8fdfb1',
      selectionBackground: '#455d5777',
      black: '#20252e',
      red: '#ee8a91',
      green: '#99cc99',
      yellow: '#e6c384',
      blue: '#88ade6',
      magenta: '#c3a1df',
      cyan: '#7dc4ca',
      white: '#d7dce3',
      brightBlack: '#758190',
      brightRed: '#ffabb0',
      brightGreen: '#b4e6b4',
      brightYellow: '#f2d8a3',
      brightBlue: '#adc8f0',
      brightMagenta: '#dcbeef',
      brightCyan: '#a6e0e5',
      brightWhite: '#f2f4f7',
    },
  });
  state.term = term;
  const fitAddon = new FitAddon();
  state.fit = fitAddon;
  term.loadAddon(fitAddon);
  state.search = new SearchAddon();
  term.loadAddon(state.search);
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      const url = new URL(uri);
      if (['http:', 'https:'].includes(url.protocol))
        window.open(url.href, '_blank', 'noopener,noreferrer');
    }),
  );
  term.open($('terminal'));
  fit();
  $('font-size').textContent = `${fontSize}px`;
  const url = new URL(`ws/${state.active}`, location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('cols', Math.min(500, Math.max(10, term.cols)));
  url.searchParams.set('rows', Math.min(200, Math.max(2, term.rows)));
  const ws = new WebSocket(url);
  state.ws = ws;
  ws.binaryType = 'arraybuffer';
  connection('正在连接', 'waiting');
  ws.onopen = () => {
    if (state.generation !== generation) return;
    state.retries = 0;
    $('reconnect-banner').hidden = true;
    connection('已连接', '');
    term.options.disableStdin = false;
    fit();
    term.focus();
  };
  ws.onmessage = (event) => {
    if (state.generation !== generation) return;
    const data = new Uint8Array(event.data);
    term.write(data, () => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ type: 'ack', size: data.byteLength }));
    });
  };
  ws.onclose = async (event) => {
    if (state.generation !== generation || !state.loggedIn) return;
    connection('连接断开', 'waiting');
    term.options.disableStdin = true;
    if (event.code === 4001) {
      showLogin();
      return;
    }
    $('reconnect-banner').hidden = false;
    try {
      await refresh();
    } catch (error) {
      if (error.status === 401) return;
    }
    if (state.generation !== generation || !active()) return;
    const delay = Math.min(1000 * 2 ** state.retries++, 10000);
    $('reconnect-text').textContent = `连接已断开，${delay / 1000} 秒后重连…`;
    state.retry = setTimeout(connect, delay);
  };
  term.onData(sendInput);
  term.onBinary((data) => sendBytes(Uint8Array.from(data, (char) => char.charCodeAt(0))));
  term.onResize(({ cols, rows }) => {
    sendControl({
      type: 'resize',
      cols: Math.min(500, Math.max(10, cols)),
      rows: Math.min(200, Math.max(2, rows)),
    });
    $('terminal-size').textContent = `${cols} × ${rows}`;
  });
  term.attachCustomKeyEventHandler((event) => {
    if (
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.code === 'Slash'
    ) {
      if (event.type === 'keydown') {
        event.preventDefault();
        sendInput('\x1f');
      }
      return false;
    }
    if (event.ctrlKey && event.shiftKey && ['KeyC', 'KeyV', 'KeyF', 'KeyK'].includes(event.code)) {
      if (event.type === 'keydown' && event.code === 'KeyC') {
        event.preventDefault();
        copySelection();
      }
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
  const field = document.createElement('textarea');
  field.value = text;
  field.style.position = 'fixed';
  field.style.left = '-10000px';
  document.body.append(field);
  field.select();
  const ok = document.execCommand('copy');
  field.remove();
  state.term?.focus();
  toast(ok ? '已复制' : '请使用浏览器的复制菜单');
}

function sessionDialog(item) {
  state.editing = item?.id || null;
  $('dialog-title').textContent = item ? '重命名会话' : '新建会话';
  $('session-submit').textContent = item ? '保存名称' : '创建会话';
  $('create-options').hidden = !!item;
  $('session-name').value = item?.name || `Terminal ${state.sessions.length + 1}`;
  $('session-group').value = item?.group || '';
  $('session-tags').value = item?.tags.join(', ') || '';
  $('session-note').value = item?.note || '';
  $('session-shell').value = state.config.shell;
  $('session-cwd').value = state.config.cwd;
  $('session-error').textContent = '';
  $('session-dialog').showModal();
  $('session-name').focus();
  $('session-name').select();
}

function showSearch() {
  if (!state.term) return;
  $('search-bar').hidden = false;
  $('search-input').focus();
}

function prepareBatch(action) {
  state.batchIds = [...state.selected];
  if (!state.batchIds.length) {
    toast('请先选择会话');
    return;
  }
  state.batchAction = action;
  const closing = action === 'close';
  $('batch-title').textContent = closing
    ? `关闭 ${state.batchIds.length} 个会话？`
    : action === 'group'
      ? '批量移入分组'
      : '批量置顶';
  $('batch-description').textContent = closing
    ? '下面这些会话中的 Shell 和正在运行的程序将结束。'
    : '操作仅应用于下方列出的会话。';
  $('batch-preview').replaceChildren(
    ...state.sessions
      .filter((item) => state.selected.has(item.id))
      .map((item) => {
        const li = document.createElement('li');
        li.textContent = `${item.name} · ${item.status === 'exited' ? '已退出' : '运行中'}`;
        return li;
      }),
  );
  $('batch-group-field').hidden = action !== 'group';
  $('batch-group-name').value = '';
  $('batch-submit').textContent = closing ? '结束所选会话' : '保存';
  $('batch-submit').className = closing ? 'danger' : 'primary';
  $('batch-error').textContent = '';
  $('batch-dialog').showModal();
}

$('batch-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    const result = await api('/sessions/batch', 'POST', {
      ids: state.batchIds,
      action: state.batchAction,
      group: $('batch-group-name').value.trim(),
    });
    state.selected = new Set(result.failed.map((item) => item.id));
    $('batch-dialog').close();
    await refresh();
    toast(
      `完成 ${result.succeeded.length} 个会话${result.failed.length ? `，${result.failed.length} 个失败，请刷新后重试` : ''}`,
    );
  } catch (error) {
    $('batch-error').textContent = error.message;
  } finally {
    event.submitter.disabled = false;
  }
});

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $('login-error').textContent = '';
  try {
    await api('/login', 'POST', { password: $('password').value });
    await enter();
  } catch (error) {
    $('login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  const body = {
    name: $('session-name').value.trim(),
    group: $('session-group').value.trim(),
    tags: $('session-tags')
      .value.split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean),
    note: $('session-note').value,
  };
  try {
    let item;
    if (state.editing) item = await api(`/sessions/${state.editing}`, 'PATCH', body);
    else
      item = await api('/sessions', 'POST', {
        ...body,
        shell: $('session-shell').value,
        cwd: $('session-cwd').value,
      });
    $('session-dialog').close();
    state.sessions = await api('/sessions');
    select(item.id);
  } catch (error) {
    if ($('session-dialog').open) $('session-error').textContent = error.message;
    else report(error);
  } finally {
    button.disabled = false;
  }
});

$('confirm-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const sid = $('confirm-dialog').dataset.sid;
  event.submitter.disabled = true;
  try {
    await api(`/sessions/${sid}`, 'DELETE');
    $('confirm-dialog').close();
    if (state.active === sid) {
      disconnect();
      state.active = null;
    }
    await refresh();
    if (!state.active) {
      connection('准备就绪', 'muted');
      $('terminal-size').textContent = '';
    }
  } catch (error) {
    $('close-error').textContent = error.message;
  } finally {
    event.submitter.disabled = false;
  }
});

$('paste-form').addEventListener('submit', (event) => {
  event.preventDefault();
  state.term?.paste($('paste-text').value);
  $('paste-dialog').close();
  state.term?.focus();
});

for (const button of document.querySelectorAll('[data-dismiss]'))
  button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog'))
  dialog.addEventListener('close', () => state.term?.focus());
for (const button of document.querySelectorAll('[data-key]'))
  button.addEventListener('click', () => {
    sendInput(
      {
        esc: '\x1b',
        tab: '\t',
        interrupt: '\x03',
        suspend: '\x1a',
        eof: '\x04',
        word: '\x17',
        transpose: '\x14',
        next: '\x0e',
        clear: '\x0c',
        slash: '\x1f',
        up: '\x1b[A',
        down: '\x1b[B',
      }[button.dataset.key],
    );
    state.term?.focus();
  });
bind('new-session', () => sessionDialog(null));
bind('first-session', () => sessionDialog(null));
bind('rename-session', () => sessionDialog(active()));
bind('pin-session', async () => {
  const item = active();
  if (!item) return;
  await api(`/sessions/${item.id}`, 'PATCH', { pinned: !item.pinned });
  await refresh();
});
bind('duplicate-session', async () => {
  const item = await api(`/sessions/${state.active}/duplicate`, 'POST');
  state.sessions = await api('/sessions');
  select(item.id);
  toast('已按原会话的当前目录和 Shell 创建新会话');
});
bind('session-details', () => resources.showSession(state.active));
bind('show-panes', () => panes.open(state.active, null));
bind('batch-mode', () => {
  state.batch = !state.batch;
  if (!state.batch) state.selected.clear();
  render();
});
bind('select-visible', () => {
  for (const item of filteredSessions()) state.selected.add(item.id);
  render();
});
bind('clear-selected', () => {
  state.selected.clear();
  render();
});
bind('batch-group', () => prepareBatch('group'));
bind('batch-pin', () => prepareBatch('pin'));
bind('batch-close', () => prepareBatch('close'));
bind('show-monitor', () => {
  state.view = state.view === 'resources' ? 'terminal' : 'resources';
  render();
  if (state.view === 'terminal') {
    fit();
    state.term?.focus();
  }
});
bind('monitor-refresh', () => resources.refresh());
for (const id of ['filter-query', 'filter-group', 'filter-status', 'session-sort'])
  $(id).addEventListener(id === 'filter-query' ? 'input' : 'change', render);
bind('close-session', () => {
  if (!active()) return;
  $('close-name').textContent = active().name;
  $('confirm-dialog').dataset.sid = state.active;
  $('close-error').textContent = '';
  $('confirm-dialog').showModal();
});
bind('restart-session', async () => {
  const item = active();
  await api(`/sessions/${item.id}/panes/action`, 'POST', {
    pane: item.active_pane,
    action: 'restart',
  });
  await refresh();
  state.term?.focus();
});
bind('show-paste', () => {
  $('paste-text').value = '';
  $('paste-dialog').showModal();
  $('paste-text').focus();
});
bind('show-keys', () => {
  document.body.classList.toggle('keys-visible');
  fit();
});
bind('show-history', async () => {
  const text = await api(`/sessions/${state.active}/history`);
  $('history-content').textContent = text;
  $('history-dialog').showModal();
  $('history-content').scrollTop = $('history-content').scrollHeight;
});
bind('download-history', () => {
  const url = URL.createObjectURL(
    new Blob([$('history-content').textContent], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = `terminal-${state.active}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
bind('logout', async () => {
  await api('/logout', 'POST');
  showLogin();
});
bind('toggle-sidebar', () => {
  document.body.classList.toggle('sidebar-hidden');
  fit();
});
bind('fullscreen', async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
  fit();
});
bind('reconnect-now', connect);
bind('show-search', showSearch);
bind('search-close', () => {
  $('search-bar').hidden = true;
  state.search?.clearDecorations();
  state.term?.focus();
});
bind('search-next', () => state.search?.findNext($('search-input').value));
bind('search-prev', () => state.search?.findPrevious($('search-input').value));
$('search-input').addEventListener('input', () =>
  state.search?.findNext($('search-input').value, { incremental: true }),
);
$('search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter')
    state.search?.[event.shiftKey ? 'findPrevious' : 'findNext']($('search-input').value);
  if (event.key === 'Escape') $('search-close').click();
});
function zoom(delta) {
  fontSize = Math.min(28, Math.max(10, fontSize + delta));
  localStorage.setItem('lt-font', fontSize);
  $('font-size').textContent = `${fontSize}px`;
  if (state.term) {
    state.term.options.fontSize = fontSize;
    fit();
  }
}
bind('zoom-out', () => zoom(-1));
bind('zoom-in', () => zoom(1));
$('terminal').addEventListener('contextmenu', (event) => {
  if (!event.shiftKey) event.preventDefault();
});
document.addEventListener('keydown', (event) => {
  if (!state.loggedIn || document.querySelector('dialog[open]')) return;
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyK') {
    event.preventDefault();
    sessionDialog(null);
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyF') {
    event.preventDefault();
    showSearch();
  }
});
new ResizeObserver(() => requestAnimationFrame(fit)).observe($('terminal'));
matchMedia('(max-width: 700px)').addEventListener('change', (event) => {
  document.body.classList.toggle('sidebar-hidden', event.matches);
  fit();
});
window.addEventListener('online', () => {
  if (state.loggedIn && state.ws?.readyState !== WebSocket.OPEN) connect();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.loggedIn) {
    refresh().catch(report);
    plugins.refresh();
    resources.resume();
  }
});
setInterval(() => {
  if (!document.hidden) plugins.refresh();
}, 500);
setInterval(() => {
  if (state.loggedIn && !document.hidden)
    refresh().catch((error) => {
      if (error.status !== 401) connection('服务暂不可达', 'waiting');
    });
}, 1000);
setInterval(() => {
  if (!state.loggedIn || document.hidden) return;
  if ($('details-dialog').open) resources.refreshSession();
}, 3000);
enter().catch((error) => {
  showLogin();
  if (error.status !== 401) $('login-error').textContent = '暂时无法连接服务，请刷新页面重试';
});
