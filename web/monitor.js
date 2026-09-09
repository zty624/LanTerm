import { $, el, text, reconcile } from './dom.js';

export const bytes = (value) => {
  if (value === null || value === undefined) return '—';
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log2(value || 1) / 10)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
};
const num = (value, digits = 1) =>
  value === null || value === undefined ? '—' : value.toFixed(digits);
const percent = (value) => (value === null || value === undefined ? '—' : `${num(value)}%`);
const speed = (value) => (value === null || value === undefined ? '—' : `${bytes(value)}/s`);
export const age = (seconds) =>
  seconds < 60
    ? `${Math.floor(seconds)} 秒`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟`
      : `${(seconds / 3600).toFixed(1)} 小时`;

function meter() {
  const block = el('div', 'meter-block');
  const heading = el('div', 'meter-heading');
  heading.append(el('span', ''), el('strong', ''));
  const bar = el('div', 'meter');
  bar.append(el('span', ''));
  block.append(heading, bar);
  return block;
}

function updateMeter(node, label, ratio, caption) {
  text(node.querySelector('.meter-heading span'), label);
  text(node.querySelector('.meter-heading strong'), caption);
  const bar = node.querySelector('.meter');
  const valid = Number.isFinite(ratio);
  bar.hidden = !valid;
  if (!valid) return;
  const value = Math.min(100, Math.max(0, ratio));
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', label);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(value));
  bar.setAttribute('aria-valuetext', percent(ratio));
  bar.firstElementChild.style.width = `${value}%`;
  bar.firstElementChild.classList.toggle('high', ratio > 90);
}

function updateTrend(node, history, key, limit) {
  const points = history.filter(
    (item) => Number.isFinite(item[key]) && item.timestamp >= Date.now() / 1000 - 360,
  );
  if (!node.firstElementChild) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 260 36');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'sparkline');
    svg.setAttribute('role', 'img');
    svg.append(document.createElementNS(svg.namespaceURI, 'polyline'));
    node.append(svg);
  }
  const svg = node.firstElementChild;
  const max = limit || Math.max(...points.map((item) => item[key]), 1);
  svg.setAttribute(
    'aria-label',
    `${key === 'cpu' ? 'CPU' : '内存'} 最近 6 分钟，刻度 0–${key === 'cpu' ? `${max}%` : bytes(max)}`,
  );
  node.title = svg.getAttribute('aria-label');
  const end = points.at(-1)?.timestamp || 0;
  svg.firstElementChild.setAttribute(
    'points',
    points
      .map(
        (item) =>
          `${260 - ((end - item.timestamp) / 360) * 260},${34 - Math.min(1, item[key] / max) * 30}`,
      )
      .join(' '),
  );
}

function card() {
  const node = el('article', 'metric-card');
  const heading = el('div', 'metric-heading');
  heading.append(el('span', 'metric-label'), el('span', 'metric-scope'));
  const primary = el('div', 'metric-primary');
  primary.append(el('strong', 'metric-value'), el('div', 'metric-trend'));
  const pair = el('div', 'metric-pair');
  for (let i = 0; i < 2; i++) {
    const column = el('div', '');
    column.append(el('span', ''), el('strong', ''));
    pair.append(column);
  }
  node.append(heading, primary, pair, el('p', 'metric-detail'), meter(), el('p', 'metric-foot'));
  return node;
}

function updateCard(node, data) {
  node.classList.toggle('compact', !!data.pair || data.key === 'pids');
  text(node.querySelector('.metric-label'), data.title);
  text(node.querySelector('.metric-scope'), data.scope);
  const value = node.querySelector('.metric-value');
  text(value, data.value);
  node.querySelector('.metric-primary').hidden = !!data.pair;
  value.classList.toggle('pending', data.value === '采样中' || data.value === '—');
  const pair = node.querySelector('.metric-pair');
  pair.hidden = !data.pair;
  data.pair?.forEach(([label, amount], index) => {
    text(pair.children[index].firstElementChild, label);
    text(pair.children[index].lastElementChild, amount);
  });
  text(node.querySelector('.metric-detail'), data.detail);
  text(node.querySelector('.metric-foot'), data.foot || '');
  node.querySelector('.metric-foot').title = data.foot || '';
  const bar = node.querySelector('.meter-block');
  bar.hidden = !Number.isFinite(data.ratio);
  updateMeter(bar, data.meterLabel || `${data.title}使用率`, data.ratio, percent(data.ratio));
  node.querySelector('.metric-trend').hidden = !data.trend;
  if (data.trend) updateTrend(node.querySelector('.metric-trend'), ...data.trend);
}

function gpuCard() {
  const node = el('article', 'gpu-card');
  const heading = el('div', 'gpu-heading');
  heading.append(el('span', 'gpu-index'), el('h4', ''), el('p', 'gpu-thermal'));
  const values = el('div', 'gpu-values');
  for (const kind of ['utilization', 'memory']) {
    const block = meter();
    block.dataset.metric = kind;
    values.append(block);
  }
  node.append(heading, values, el('p', 'gpu-memory'));
  return node;
}

function updateGpu(node, gpu) {
  text(node.querySelector('.gpu-index'), `GPU ${gpu.index}`);
  text(node.querySelector('h4'), gpu.name);
  text(node.querySelector('.gpu-thermal'), `${num(gpu.temperature, 0)} °C  ·  ${num(gpu.power)} W`);
  const ratio =
    gpu.memory_total && gpu.memory_used !== null
      ? (gpu.memory_used / gpu.memory_total) * 100
      : null;
  updateMeter(
    node.querySelector('[data-metric="utilization"]'),
    `GPU ${gpu.index} 利用率`,
    gpu.utilization,
    percent(gpu.utilization),
  );
  updateMeter(
    node.querySelector('[data-metric="memory"]'),
    `GPU ${gpu.index} 显存占用`,
    ratio,
    percent(ratio),
  );
  text(
    node.querySelector('.gpu-memory'),
    `显存已用 ${bytes(gpu.memory_used)} / ${bytes(gpu.memory_total)}`,
  );
  node.title = gpu.uuid;
}

function overview(data) {
  const { cpu, memory, history } = data;
  const ratio = memory.limit && memory.used !== null ? (memory.used / memory.limit) * 100 : null;
  const values = [
    {
      key: 'cpu',
      scope: cpu.scope,
      value: cpu.percent === null && cpu.scope !== 'unavailable' ? '采样中' : percent(cpu.percent),
      detail: `${num(cpu.cores_used, 2)} / ${num(cpu.cores_limit, 2)} 核`,
      limit: 100,
      shared: cpu.shared_limit,
    },
    {
      key: 'memory',
      scope: memory.scope,
      value: bytes(memory.used),
      detail: memory.limit === null ? '上限未知' : `/ ${bytes(memory.limit)} · ${percent(ratio)}`,
      limit: memory.limit,
      shared: memory.shared_limit,
    },
  ];
  for (const item of values) {
    const node = document.querySelector(`.overview-card[data-key="${item.key}"]`);
    const scope = { cgroup: '当前 cgroup', host: '主机', unavailable: '不可用' }[item.scope];
    text(node.querySelector('.overview-value'), item.value);
    text(node.querySelector('.overview-detail'), item.detail);
    node.title = `${scope}${item.shared ? ' · 上级共享配额' : ''}`;
    updateTrend(node.querySelector('.overview-trend'), history, item.key, item.limit);
  }
  $('resource-overview').classList.remove('stale');
  text(
    $('overview-updated'),
    new Date(data.timestamp * 1000).toLocaleTimeString([], { hour12: false }),
  );
  $('overview-updated').title = '约每 3 秒更新 · 曲线为最近 6 分钟';
}

export class ResourceView {
  constructor(api, getSessions, select, allowed) {
    this.api = api;
    this.getSessions = getSessions;
    this.select = select;
    this.allowed = allowed;
    this.busy = false;
    this.detailBusy = false;
    this.data = null;
    this.visible = false;
    this.timer = null;
    this.controller = null;
    this.generation = 0;
  }

  reset() {
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = null;
    this.visible = false;
    this.controller?.abort();
    this.controller = null;
    this.busy = false;
    this.detailBusy = false;
    this.data = null;
    $('resource-overview').classList.remove('stale');
    text($('overview-updated'), '正在读取…');
    $('overview-updated').title = '';
    for (const node of document.querySelectorAll('.overview-card')) {
      text(node.querySelector('.overview-value'), '—');
      text(node.querySelector('.overview-detail'), '正在读取…');
      node.querySelector('.overview-trend').replaceChildren();
      node.title = '';
    }
  }

  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (visible && this.data) this.render(this.data);
  }

  resume() {
    this.refresh();
  }

  async refresh() {
    if (this.busy || !this.allowed() || document.hidden) return;
    clearTimeout(this.timer);
    this.busy = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    $('monitor-refresh').disabled = true;
    try {
      const data = await this.api('/metrics', 'GET', undefined, controller.signal);
      if (!this.allowed() || generation !== this.generation) return;
      this.data = data;
      overview(data);
      if (this.visible) this.render(data);
      $('monitor-error').textContent = '';
    } catch (error) {
      if (generation !== this.generation) return;
      $('monitor-error').textContent =
        `统计更新失败：${error.name === 'AbortError' ? '请求超时' : error.message}${this.data ? '。保留上次采样，稍后自动重试。' : '。稍后自动重试。'}`;
      $('resource-overview').classList.add('stale');
      text($('overview-updated'), this.data ? '更新失败 · 保留上次采样' : '暂时无法读取');
      $('overview-updated').title = $('monitor-error').textContent;
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) {
        this.busy = false;
        this.controller = null;
        $('monitor-refresh').disabled = false;
        if (this.allowed() && !document.hidden) this.timer = setTimeout(() => this.refresh(), 3000);
      }
    }
  }

  render(data) {
    const { environment: env, cpu, memory, disk, network, io, pids } = data;
    const scope = (value) =>
      ({ cgroup: '当前 cgroup', host: '主机', unavailable: '不可用' })[value];
    text(
      $('monitor-scope'),
      `${env.hostname} · ${env.container ? '容器环境' : 'Linux 主机'} · ${env.cgroup_version ? `cgroup v${env.cgroup_version}` : '未发现 cgroup'}`,
    );
    $('monitor-scope').title = env.cgroup_path || '未发现可读取的 cgroup';
    text(
      $('monitor-updated'),
      `${new Date(data.timestamp * 1000).toLocaleTimeString([], { hour12: false })} 更新 · 约 3 秒 / 次`,
    );
    $('monitor-warmup').hidden =
      !(cpu.percent === null && cpu.scope !== 'unavailable') && network.rx_rate !== null;
    const memoryRatio =
      memory.limit && memory.used !== null ? (memory.used / memory.limit) * 100 : null;
    const cards = [
      {
        key: 'cpu',
        title: 'CPU',
        scope: scope(cpu.scope),
        value:
          cpu.percent === null && cpu.scope !== 'unavailable' ? '采样中' : percent(cpu.percent),
        detail: `已用 ${num(cpu.cores_used, 2)} / 可用 ${num(cpu.cores_limit, 2)} 核`,
        foot: `${cpu.quota_cores === null ? '按 CPU 亲和性上限计算' : '按 CPU 配额计算'}${cpu.shared_limit ? ' · 上级共享配额' : ''}`,
        ratio: cpu.percent,
        trend: [data.history, 'cpu', 100],
      },
      {
        key: 'memory',
        title: '内存',
        scope: scope(memory.scope),
        value: bytes(memory.used),
        detail:
          memory.limit === null
            ? '未设置可见内存上限'
            : `上限 ${bytes(memory.limit)}${memory.shared_limit ? ' · 上级共享配额' : ''}`,
        foot: `内存不足终止 ${memory.oom_kills ?? '—'} 次`,
        ratio: memoryRatio,
        trend: [data.history, 'memory', memory.limit],
      },
      {
        key: 'disk',
        title: '存储空间',
        scope: '工作目录文件系统',
        value: percent(disk?.percent),
        detail: disk ? `已用 ${bytes(disk.used)} / ${bytes(disk.total)}` : '无法读取文件系统',
        foot: disk ? `可用 ${bytes(disk.free)} · ${disk.path}` : '',
        ratio: disk?.percent,
        meterLabel: '存储已用比例',
      },
      {
        key: 'network',
        title: '网络速率',
        scope: '当前网络空间',
        value: '',
        pair: [
          ['↓ 接收', speed(network.rx_rate)],
          ['↑ 发送', speed(network.tx_rate)],
        ],
        detail: '不含本地回环接口',
        ratio: null,
      },
      {
        key: 'io',
        title: '磁盘 I/O',
        scope: '当前 cgroup',
        value: '',
        pair: [
          ['读取', speed(io.read_rate)],
          ['写入', speed(io.write_rate)],
        ],
        detail:
          io.read_rate === null && io.write_rate === null
            ? '等待采样或计数器不可用'
            : '当前资源组的读写速率',
        ratio: null,
      },
      {
        key: 'pids',
        title: '进程 / 线程',
        scope: '当前 cgroup',
        value: String(pids.current ?? '—'),
        detail: `上限 ${pids.limit ?? '未设置'} · CPU 累计限流 ${num(cpu.throttled_seconds, 2)} 秒`,
        ratio: pids.limit && pids.current !== null ? (pids.current / pids.limit) * 100 : null,
      },
    ];
    reconcile($('metric-cards'), cards, card, updateCard);
    const devices = data.gpu.devices.map((gpu) => ({ ...gpu, key: gpu.uuid }));
    reconcile($('gpu-cards'), devices, gpuCard, updateGpu);
    text($('gpu-note'), devices.length ? '' : data.gpu.reason || '未发现可见 GPU');
    $('gpu-note').hidden = !!devices.length;
    text(
      $('gpu-scope'),
      env.cuda_visible_devices === null
        ? ''
        : `CUDA_VISIBLE_DEVICES=${env.cuda_visible_devices} · 显示驱动可见设备整体用量`,
    );
    $('gpu-scope').hidden = env.cuda_visible_devices === null;
    const items = this.getSessions().map((item) => ({ ...item, key: item.id }));
    text($('resource-session-count'), items.length);
    reconcile(
      $('session-resources'),
      items,
      (item) => {
        const row = el('tr', '');
        row.dataset.sid = item.id;
        for (let i = 0; i < 6; i++) row.append(el('td', ''));
        const cell = el('td', 'row-actions');
        const details = el('button', '', '进程');
        details.addEventListener('click', () => this.showSession(item.id));
        const attach = el('button', '', '连接');
        attach.addEventListener('click', () => this.select(item.id));
        cell.append(details, attach);
        row.append(cell);
        return row;
      },
      (row, item) => {
        const value = data.sessions[item.id];
        [
          item.name,
          item.group || '未分组',
          item.status === 'exited' ? '已退出' : '运行中',
          value?.process_count ?? '—',
          percent(value?.cpu_percent),
          bytes(value?.rss_bytes),
        ].forEach((value, index) => text(row.children[index], String(value)));
        row.children[0].title = item.name;
        row.children[2].dataset.state = item.status;
      },
    );
    $('session-resources-empty').hidden = items.length > 0;
  }

  async showSession(sid) {
    $('details-dialog').dataset.sid = sid;
    $('details-title').textContent = '正在读取会话详情…';
    $('details-summary').replaceChildren();
    $('process-table').replaceChildren();
    $('details-note').textContent = '';
    $('details-error').textContent = '';
    if (!$('details-dialog').open) $('details-dialog').showModal();
    await this.refreshSession();
  }

  async refreshSession() {
    if (this.detailBusy || !$('details-dialog').open || !this.allowed()) return;
    this.detailBusy = true;
    const generation = this.generation;
    const sid = $('details-dialog').dataset.sid;
    try {
      const item = await this.api(`/sessions/${sid}`);
      if (
        !this.allowed() ||
        generation !== this.generation ||
        sid !== $('details-dialog').dataset.sid
      )
        return;
      text($('details-title'), item.name);
      const entries = [
        ['Shell', item.shell],
        ['分组', item.group || '未分组'],
        ['标签', item.tags.join(' · ') || '—'],
        ['创建时间', new Date(item.created * 1000).toLocaleString()],
        ['最近活动', new Date(item.activity * 1000).toLocaleString()],
        ['已连接浏览器', String(item.clients)],
        ['初始目录', item.cwd],
        ['当前目录', item.resources?.cwd || '无法读取 / 已退出'],
      ].map(([key, value]) => ({ key, value }));
      reconcile(
        $('details-summary'),
        entries,
        () => {
          const node = el('div', '');
          node.append(el('span', ''), el('strong', ''));
          return node;
        },
        (node, entry) => {
          text(node.firstElementChild, entry.key);
          text(node.lastElementChild, entry.value);
        },
      );
      text($('details-note'), item.note);
      reconcile(
        $('process-table'),
        (item.resources?.processes || []).map((proc) => ({ ...proc, key: proc.pid })),
        () => {
          const row = el('tr', '');
          for (let i = 0; i < 6; i++) row.append(el('td', ''));
          return row;
        },
        (row, proc) => {
          [
            proc.pid,
            proc.name,
            proc.status,
            percent(proc.cpu_percent),
            bytes(proc.rss_bytes),
            age(proc.age_seconds),
          ].forEach((value, index) => text(row.children[index], String(value)));
        },
      );
      text(
        $('details-error'),
        item.status === 'exited' ? 'Shell 已退出，可通过“重新启动”继续使用此会话。' : '',
      );
    } catch (error) {
      if (generation === this.generation) $('details-error').textContent = error.message;
    } finally {
      if (generation === this.generation) this.detailBusy = false;
    }
  }
}
