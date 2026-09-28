const $ = (id) => document.getElementById(id);
let relay = null;
let timer = null;
let attempts = 0;
let generation = 0;
let sockets = [];
let settings;
let role =
  new URLSearchParams(location.search).get('role') ||
  (location.hostname === '127.0.0.1' ? 'local' : 'remote');

function showRole(value) {
  role = value;
  for (const name of ['local', 'remote']) {
    $(`${name}-panel`).hidden = role !== name;
    $(`role-${name}`).setAttribute('aria-pressed', String(role === name));
  }
  $('error').textContent = '';
}
for (const name of ['local', 'remote'])
  $(`role-${name}`).addEventListener('click', () => showRole(name));
showRole(role === 'local' ? 'local' : 'remote');

async function api(path, method = 'GET', body) {
  const response = await fetch(`api/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 401) {
    $('login').hidden = false;
    $('controls').hidden = true;
    throw new Error('请先登录这个 LanTerm。');
  }
  if (!response.ok) {
    const error = await response.json();
    throw new Error(
      typeof error.detail === 'string'
        ? error.detail
        : `请求失败（${response.status}），请检查服务是否启用了 --ssh。`,
    );
  }
  return response.json();
}

async function refresh() {
  settings = await api('ssh');
  $('settings').textContent = `当前页面：${location.host}${location.pathname}`;
  $('technical').textContent =
    `远端 sshd 端口：${settings.target}；断线后最多保留 ${settings.ttl} 秒。`;
  $('replace-note').hidden = !settings.paired;
  $('revoke').hidden = !settings.paired;
  $('local-status').textContent = settings.connected
    ? `浏览器已接入 · 本机端口 ${settings.port} · ${settings.streams} 条 SSH / TCP 连接`
    : settings.paired
      ? '配对已生成 · 请去远端页面粘贴并连接'
      : '尚未配对 · 请先填写远端地址';
  $('login').hidden = true;
  $('controls').hidden = false;
}

function report(error) {
  $('error').textContent = error.message;
}

function wsURL(path) {
  const url = new URL(path, location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

$('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('login', 'POST', { password: $('password').value });
    $('password').value = '';
    await refresh();
    $('error').textContent = '';
  } catch (error) {
    report(error);
  }
});

$('pair-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    if (location.hostname !== '127.0.0.1')
      throw new Error('请用 http://127.0.0.1:Web端口/ssh 打开本机页面后生成配对。');
    const remote = new URL($('remote-url').value);
    if (
      !['http:', 'https:'].includes(remote.protocol) ||
      remote.username ||
      remote.password ||
      remote.search ||
      remote.hash
    )
      throw new Error('请输入不含凭证、查询参数和片段的完整 HTTP(S) 地址。');
    remote.pathname = remote.pathname.replace(/\/ssh\/?$/, '').replace(/\/$/, '') + '/ssh';
    if (remote.origin === location.origin && remote.pathname === location.pathname)
      throw new Error('这是当前本机页面，请填写要连接的远端 LanTerm 地址。');
    const pair = await api('ssh/pair', 'POST', { origin: remote.href });
    $('pair-code').value = JSON.stringify({
      ...pair,
      local: wsURL('ssh/bridge/local'),
      origin: remote.origin,
      remote: remote.href,
    });
    remote.searchParams.set('role', 'remote');
    $('open-remote').href = remote.href;
    $('pair-output').hidden = false;
    $('pair-code').select();
    $('error').textContent = '';
    await refresh();
  } catch (error) {
    report(error);
  }
});

function dispose(code) {
  generation++;
  clearTimeout(timer);
  for (const ws of sockets) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close(code, code === 4002 ? 'User stopped' : 'Transport reconnect');
  }
  sockets = [];
}

function stop() {
  dispose(4002);
  relay = null;
  $('connect').disabled = false;
  $('rotate').disabled = true;
  $('stop').disabled = true;
  $('status').textContent = '已停止；SSH 连接已关闭';
  $('command-panel').hidden = true;
  $('connect-form').hidden = false;
  $('role-local').disabled = false;
}

function connect() {
  if (!relay) return;
  if (Date.now() - relay.seen > relay.ttl * 1000) {
    stop();
    $('status').textContent = '已超过隧道保留时间，请重新生成配对信息';
    return;
  }
  dispose(4000);
  const current = generation;
  $('status').textContent = '正在建立浏览器转发…';
  const ends = [
    { url: relay.local, hello: { id: relay.id, key: relay.key } },
    { url: wsURL('ssh/bridge/remote'), hello: { id: relay.id } },
  ];
  let failed = false;
  function retry(message, fatal = false) {
    if (failed || current !== generation) return;
    failed = true;
    dispose(fatal ? 4002 : 4000);
    if (fatal) {
      relay = null;
      $('connect').disabled = false;
      $('rotate').disabled = true;
      $('stop').disabled = true;
      $('status').textContent = message;
      $('command-panel').hidden = true;
      $('connect-form').hidden = false;
      $('role-local').disabled = false;
      return;
    }
    const delay = Math.min(1000 * 2 ** attempts++, 10000);
    $('status').textContent = `${message}；${delay / 1000} 秒后自动重连，请保持页面打开。`;
    timer = setTimeout(connect, delay);
  }
  try {
    for (const end of ends) {
      end.ready = false;
      end.queue = [];
      end.bytes = 0;
      end.seen = Date.now();
      end.ws = new WebSocket(end.url);
      sockets.push(end.ws);
    }
  } catch (error) {
    retry(`浏览器拒绝连接：${error.message}。检查本地网络权限或混合内容限制`, true);
    return;
  }
  ends.forEach((end, index) => {
    const other = ends[1 - index];
    end.ws.onopen = () => end.ws.send(JSON.stringify(end.hello));
    end.ws.onmessage = (event) => {
      if (current !== generation || failed) return;
      end.seen = Date.now();
      if (ends.every((item) => item.ready)) relay.seen = end.seen;
      let packet;
      try {
        packet = JSON.parse(event.data);
      } catch {
        retry('收到无效隧道消息', true);
        return;
      }
      if (packet.ready === true) {
        end.ready = true;
        for (const data of end.queue) end.ws.send(data);
        end.queue = [];
        end.bytes = 0;
        if (ends.every((item) => item.ready)) {
          attempts = 0;
          $('status').textContent = '已连接 · 浏览器正在转发 SSH';
          $('command-panel').hidden = false;
          $('error').textContent = '';
        }
        return;
      }
      if (other.ready && other.ws.readyState === WebSocket.OPEN) {
        if (other.ws.bufferedAmount > 2 * 1024 * 1024) {
          retry('传输阻塞，重新连接续传');
          return;
        }
        other.ws.send(event.data);
      } else {
        other.bytes += event.data.length;
        if (other.bytes > 2 * 1024 * 1024) {
          retry('等待连接的数据过多');
          return;
        }
        other.queue.push(event.data);
      }
    };
    end.ws.onclose = (event) =>
      retry(
        [4001, 4400, 4403, 4408].includes(event.code)
          ? '登录或隧道状态已失效，请重新登录并生成配对信息'
          : 'WS 已断开；若持续失败，请检查本机服务、浏览器本地网络权限及平台登录状态',
        [4001, 4400, 4403, 4408].includes(event.code),
      );
    end.ws.onerror = () => {}; // onclose reports connection failures without leaking pairing data.
  });
  function watchdog() {
    if (current !== generation || failed) return;
    if (ends.some((end) => Date.now() - end.seen > 12000)) {
      retry('连接无响应');
      return;
    }
    timer = setTimeout(watchdog, 1000);
  }
  watchdog();
}

$('connect-form').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const pair = JSON.parse($('pair-input').value);
    const local = new URL(pair.local);
    if (
      local.hostname !== '127.0.0.1' ||
      !['ws:', 'wss:'].includes(local.protocol) ||
      local.username ||
      local.password ||
      local.search ||
      local.hash
    )
      throw new Error('配对地址必须是本机回环 WebSocket 地址。');
    if (pair.origin !== location.origin)
      throw new Error('当前页面与生成配对时填写的远端域名不一致。');
    if (pair.remote && new URL(pair.remote).pathname !== location.pathname)
      throw new Error('当前远端路径与配对目标不一致，请从本机页面点击「打开远端页面」。');
    if (
      !/^[A-Za-z0-9_-]{16,64}$/.test(pair.id) ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(pair.key) ||
      !Number.isInteger(pair.port) ||
      pair.port < 1 ||
      pair.port > 65535
    )
      throw new Error('配对信息不完整，请重新生成。');
    if (pair.ttl !== undefined && (!Number.isFinite(pair.ttl) || pair.ttl < 15 || pair.ttl > 600))
      throw new Error('配对信息的有效时间无效，请重新生成。');
    relay = { ...pair, seen: Date.now(), ttl: Math.min(pair.ttl || 120, settings.ttl) };
    attempts = 0;
    $('pair-input').value = '';
    $('connect').disabled = true;
    $('rotate').disabled = false;
    $('stop').disabled = false;
    $('role-local').disabled = true;
    $('connect-form').hidden = true;
    $('error').textContent = '';
    updateCommand();
    connect();
  } catch (error) {
    report(error);
  }
});
$('rotate').addEventListener('click', () => {
  dispose(4000);
  $('status').textContent = '已主动切断 WS，3 秒后恢复；SSH TCP 保持打开…';
  timer = setTimeout(connect, 3000);
});
$('stop').addEventListener('click', stop);
function updateCommand() {
  if (!relay) return;
  const user = $('ssh-user').value.trim();
  $('command').textContent = `ssh -p ${relay.port} ${user || '远端用户名'}@127.0.0.1`;
  $('copy-command').disabled = !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user);
}
$('ssh-user').addEventListener('input', updateCommand);

async function copy(value, field) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(value);
    $('notice').textContent = '已复制';
  } catch {
    if (field) {
      field.focus();
      field.select();
    }
    $('notice').textContent = '浏览器未允许自动复制，请选中文本后按 Ctrl+C（Mac 使用 ⌘C）。';
  }
}
$('copy-pair').addEventListener('click', () => copy($('pair-code').value, $('pair-code')));
$('copy-command').addEventListener('click', () => copy($('command').textContent));
$('revoke').addEventListener('click', async () => {
  try {
    await api('ssh/pair', 'DELETE');
    $('pair-code').value = '';
    $('pair-output').hidden = true;
    await refresh();
  } catch (error) {
    report(error);
  }
});
setInterval(() => {
  if (role === 'local' && !document.hidden && !$('controls').hidden) refresh().catch(report);
}, 3000);
window.addEventListener('online', () => {
  if (relay) connect();
});
refresh().catch(report);
