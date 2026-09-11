const $ = (id) => document.getElementById(id);
let relay = null;
let timer = null;
let attempts = 0;
let generation = 0;
let sockets = [];
let settings;

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
  if (!response.ok)
    throw new Error(`请求失败（${response.status}），请检查服务是否启用了 --experimental-ssh。`);
  return response.json();
}

async function refresh() {
  settings = await api('ssh');
  $('settings').textContent =
    `sshd 目标：127.0.0.1:${settings.target} · SSH 转发入口：127.0.0.1:${settings.port} · 无消息保留：${settings.ttl} 秒`;
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
    const pair = await api('ssh/pair', 'POST', { origin: remote.href });
    $('pair-code').value = JSON.stringify({
      ...pair,
      local: wsURL('ssh/bridge/local'),
      origin: remote.origin,
    });
    $('pair-output').hidden = false;
    $('pair-code').select();
    $('error').textContent = '';
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
      return;
    }
    const delay = Math.min(1000 * 2 ** attempts++, 10000);
    $('status').textContent = `${message}；${delay / 1000} 秒后重连。TCP 在保留时间内继续等待。`;
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
    if (
      !/^[A-Za-z0-9_-]{16,64}$/.test(pair.id) ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(pair.key) ||
      !Number.isInteger(pair.port) ||
      pair.port < 1 ||
      pair.port > 65535
    )
      throw new Error('配对信息不完整，请重新生成。');
    relay = { ...pair, seen: Date.now(), ttl: Math.min(pair.ttl || 120, settings.ttl) };
    attempts = 0;
    $('pair-input').value = '';
    $('connect').disabled = true;
    $('rotate').disabled = false;
    $('stop').disabled = false;
    $('command').textContent = `ssh -p ${pair.port} 容器用户名@127.0.0.1`;
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
window.addEventListener('online', () => {
  if (relay) connect();
});
refresh().catch(report);
