import { $, el, text, reconcile } from './dom.js';
import { icon } from './icons.js';
import { TrendChart, clock, nice } from './charts.js';

export const bytes = (value) => {
  if (value === null || value === undefined) return '—';
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log2(value || 1) / 10)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
};
const num = (value, digits = 1) =>
  value === null || value === undefined ? '—' : value.toFixed(digits);
const percent = (value) => (value === null || value === undefined ? '—' : `${num(value)}%`);
const whole = (value) => `${Math.round(value)}%`;
const speed = (value) => (value === null || value === undefined ? '—' : `${bytes(value)}/s`);
export const age = (seconds) =>
  seconds < 60
    ? `${Math.floor(seconds)} 秒`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} 分钟`
      : `${(seconds / 3600).toFixed(1)} 小时`;
const SCOPE = { cgroup: '当前 cgroup', host: '主机', unavailable: '不可用' };
const WARN = 85;
const CRITICAL = 95;

// Byte scales round to clean binary units: 1 / 2 / 5 × 1024ⁿ.
function niceBytes(value) {
  if (!(value > 0)) return 1024;
  const unit = 1024 ** Math.floor(Math.log2(value) / 10);
  return nice(value / unit) * unit;
}

function level(ratio) {
  if (!Number.isFinite(ratio)) return '';
  return ratio >= CRITICAL ? 'critical' : ratio >= WARN ? 'warn' : '';
}

function meter() {
  const block = el('div', 'meter-block');
  const heading = el('div', 'meter-heading');
  heading.append(el('span', 'meter-label'), el('strong', ''));
  const bar = el('div', 'meter');
  bar.append(el('span', ''));
  block.append(heading, bar);
  return block;
}

// `label` names the meter for assistive tech; `display` is the shorter visible heading.
function updateMeter(node, label, ratio, caption, display) {
  text(node.querySelector('.meter-label'), display);
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
  if (level(ratio)) bar.dataset.level = level(ratio);
  else delete bar.dataset.level;
}

// Status chips only appear when something needs attention, always with icon and words.
function status(node, state) {
  node.hidden = !state;
  if (!state) return;
  node.dataset.level = state.level;
  if (node.dataset.text === state.text) return;
  node.dataset.text = state.text;
  node.replaceChildren(icon('alert'), document.createTextNode(state.text));
}

function ratioStatus(ratio) {
  const kind = level(ratio);
  return kind ? { level: kind, text: kind === 'critical' ? '接近上限' : '偏高' } : null;
}

function series(history, keys, convert) {
  return history.map((item) => ({
    timestamp: item.timestamp,
    values: Object.fromEntries(keys.map((key) => [key, convert(item, key)])),
  }));
}

const CHARTS = {
  cpu: () =>
    new TrendChart({
      label: 'CPU',
      series: [{ key: 'cpu', label: 'CPU', slot: 1 }],
      format: percent,
      scale: whole,
    }),
  memory: () =>
    new TrendChart({
      label: '内存',
      series: [{ key: 'memory', label: '内存', slot: 1 }],
      format: bytes,
      round: niceBytes,
    }),
  network: () =>
    new TrendChart({
      label: '网络',
      series: [
        { key: 'rx', label: '接收', slot: 1 },
        { key: 'tx', label: '发送', slot: 2 },
      ],
      format: speed,
      scale: (value) => `${bytes(value)}/s`,
      round: niceBytes,
    }),
  io: () =>
    new TrendChart({
      label: '磁盘 I/O',
      series: [
        { key: 'read', label: '读取', slot: 1 },
        { key: 'write', label: '写入', slot: 2 },
      ],
      format: speed,
      scale: (value) => `${bytes(value)}/s`,
      round: niceBytes,
    }),
};

function card(data) {
  const node = el('article', 'metric-card');
  node.dataset.size = data.size;
  const heading = el('div', 'metric-heading');
  heading.append(
    icon(data.icon, 'icon metric-icon'),
    el('span', 'metric-label'),
    el('span', 'metric-status'),
  );
  const primary = el('div', 'metric-primary');
  primary.append(el('strong', 'metric-value'), el('span', 'metric-detail'));
  const legend = el('div', 'metric-legend');
  for (let index = 0; index < 2; index++) {
    const row = el('div', 'legend-row');
    const key = el('span', 'legend-key');
    key.dataset.slot = index + 1;
    row.append(key, el('span', 'legend-label'), el('strong', 'legend-value'));
    legend.append(row);
  }
  const chart = el('div', 'metric-chart');
  if (CHARTS[data.key]) {
    node.chart = CHARTS[data.key]();
    chart.append(node.chart.node);
  }
  node.append(heading, primary, legend, chart, meter());
  return node;
}

function updateCard(node, data) {
  const label = node.querySelector('.metric-label');
  text(label, data.title);
  node.title = data.note;
  status(node.querySelector('.metric-status'), data.status);
  const value = node.querySelector('.metric-value');
  text(value, data.value);
  value.classList.toggle('pending', data.value === '采样中' || data.value === '—');
  text(node.querySelector('.metric-detail'), data.detail || '');
  node.querySelector('.metric-primary').hidden = !!data.pair;
  const legend = node.querySelector('.metric-legend');
  legend.hidden = !data.pair;
  data.pair?.forEach(([name, amount], index) => {
    text(legend.children[index].querySelector('.legend-label'), name);
    text(legend.children[index].querySelector('.legend-value'), amount);
  });
  node.querySelector('.metric-chart').hidden = !data.trend;
  if (data.trend) node.chart.update(...data.trend);
  // Cards with a trend already show the ratio on a 0–limit scale; a meter would repeat it.
  const bar = node.querySelector('.meter-block');
  bar.hidden = !Number.isFinite(data.ratio) || !!data.trend;
  const name = data.meterLabel || `${data.title}使用率`;
  updateMeter(bar, name, data.ratio, percent(data.ratio), name);
}

function gpuCard() {
  const node = el('article', 'gpu-card');
  const heading = el('div', 'gpu-heading');
  heading.append(
    icon('gpu', 'icon metric-icon'),
    el('span', 'gpu-index'),
    el('h4', ''),
    el('span', 'gpu-thermal'),
  );
  const values = el('div', 'gpu-values');
  for (const kind of ['utilization', 'memory']) {
    const block = meter();
    block.dataset.metric = kind;
    if (kind === 'memory') block.append(el('p', 'gpu-memory'));
    values.append(block);
  }
  node.chart = new TrendChart({
    label: 'GPU',
    series: [
      { key: 'utilization', label: '利用率', slot: 1 },
      { key: 'memory', label: '显存', slot: 2 },
    ],
    format: percent,
    scale: whole,
    legend: true,
  });
  const chart = el('div', 'metric-chart');
  chart.append(node.chart.node);
  node.append(heading, values, chart);
  return node;
}

function updateGpu(node, gpu) {
  text(node.querySelector('.gpu-index'), `GPU ${gpu.index}`);
  text(node.querySelector('h4'), gpu.name);
  text(node.querySelector('.gpu-thermal'), `${num(gpu.temperature, 0)} °C · ${num(gpu.power)} W`);
  node.title = `${gpu.uuid}\n设备整体用量，可能包含其他进程`;
  const ratio =
    gpu.memory_total && gpu.memory_used !== null
      ? (gpu.memory_used / gpu.memory_total) * 100
      : null;
  updateMeter(
    node.querySelector('[data-metric="utilization"]'),
    `GPU ${gpu.index} 利用率`,
    gpu.utilization,
    percent(gpu.utilization),
    '利用率',
  );
  updateMeter(
    node.querySelector('[data-metric="memory"]'),
    `GPU ${gpu.index} 显存占用`,
    ratio,
    percent(ratio),
    '显存',
  );
  text(node.querySelector('.gpu-memory'), `${bytes(gpu.memory_used)} / ${bytes(gpu.memory_total)}`);
  node.chart.update(
    series(gpu.history, ['utilization', 'memory'], (item, key) => {
      const sample = item.gpu?.[gpu.uuid];
      if (!sample) return null;
      if (key === 'utilization') return sample.utilization;
      return gpu.memory_total && Number.isFinite(sample.memory)
        ? (sample.memory / gpu.memory_total) * 100
        : null;
    }),
    100,
  );
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
      format: percent,
    },
    {
      key: 'memory',
      scope: memory.scope,
      value: bytes(memory.used),
      detail: memory.limit === null ? '上限未知' : `/ ${bytes(memory.limit)} · ${percent(ratio)}`,
      limit: memory.limit,
      shared: memory.shared_limit,
      format: bytes,
    },
  ];
  for (const item of values) {
    const node = document.querySelector(`.overview-card[data-key="${item.key}"]`);
    text(node.querySelector('.overview-value'), item.value);
    text(node.querySelector('.overview-detail'), item.detail);
    node.title = `${SCOPE[item.scope]}${item.shared ? ' · 上级共享配额' : ''}`;
    const slot = node.querySelector('.overview-trend');
    if (!slot.chart) {
      slot.chart = new TrendChart({
        label: item.key === 'cpu' ? 'CPU' : '内存',
        series: [{ key: item.key, label: '', slot: 1 }],
        format: item.format,
        compact: true,
      });
      slot.replaceChildren(slot.chart.node);
    }
    slot.chart.update(
      series(history, [item.key], (entry, key) => entry[key]),
      item.limit || niceBytes(Math.max(...history.map((entry) => entry.memory || 0))),
    );
  }
  $('resource-overview').classList.remove('stale');
  $('overview-updated').hidden = true;
  text($('overview-updated'), clock(data.timestamp));
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
    this.sort = '';
    for (const button of document.querySelectorAll('[data-sort]'))
      button.addEventListener('click', () => {
        this.sort = this.sort === button.dataset.sort ? '' : button.dataset.sort;
        if (this.data) this.render(this.data);
      });
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
    $('overview-updated').hidden = true;
    text($('overview-updated'), '正在读取…');
    for (const node of document.querySelectorAll('.overview-card')) {
      text(node.querySelector('.overview-value'), '—');
      text(node.querySelector('.overview-detail'), '');
      const slot = node.querySelector('.overview-trend');
      slot.chart = null;
      slot.replaceChildren();
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
      $('monitor-view').classList.remove('stale');
    } catch (error) {
      if (generation !== this.generation) return;
      $('monitor-error').textContent =
        `更新失败：${error.name === 'AbortError' ? '请求超时' : error.message}${this.data ? '，显示上次采样' : ''}`;
      $('monitor-view').classList.toggle('stale', !!this.data);
      $('resource-overview').classList.add('stale');
      $('overview-updated').hidden = false;
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
    const { environment: env, cpu, memory, disk, network, io, pids, history } = data;
    text(
      $('monitor-scope'),
      `${env.hostname} · ${env.container ? '容器' : '主机'} · ${env.cgroup_version ? `cgroup v${env.cgroup_version}` : '无 cgroup'}`,
    );
    $('monitor-scope').title = env.cgroup_path || '未发现可读取的 cgroup';
    text($('monitor-updated'), clock(data.timestamp));
    $('monitor-updated').title = '约每 3 秒采样一次，曲线为最近 6 分钟';
    const memoryRatio =
      memory.limit && memory.used !== null ? (memory.used / memory.limit) * 100 : null;
    const pidRatio = pids.limit && pids.current !== null ? (pids.current / pids.limit) * 100 : null;
    const pending = cpu.percent === null && cpu.scope !== 'unavailable';
    const cards = [
      {
        key: 'cpu',
        icon: 'cpu',
        size: 'wide',
        title: 'CPU',
        note: `${SCOPE[cpu.scope]} · ${cpu.quota_cores === null ? '按 CPU 亲和性计算' : '按 CPU 配额计算'}${cpu.shared_limit ? ' · 上级共享配额' : ''}`,
        value: pending ? '采样中' : percent(cpu.percent),
        detail: `${num(cpu.cores_used, 2)} / ${num(cpu.cores_limit, 2)} 核`,
        ratio: cpu.percent,
        status: ratioStatus(cpu.percent),
        trend: [series(history, ['cpu'], (item) => item.cpu), 100],
      },
      {
        key: 'memory',
        icon: 'memory',
        size: 'wide',
        title: '内存',
        note: `${SCOPE[memory.scope]}${memory.shared_limit ? ' · 上级共享配额' : ''}`,
        value: bytes(memory.used),
        detail: memory.limit === null ? '未设上限' : `/ ${bytes(memory.limit)}`,
        ratio: memoryRatio,
        status: memory.oom_kills
          ? { level: 'critical', text: `OOM ${memory.oom_kills} 次` }
          : ratioStatus(memoryRatio),
        trend: [
          series(history, ['memory'], (item) => item.memory),
          memory.limit || niceBytes(Math.max(...history.map((item) => item.memory || 0))),
        ],
      },
      {
        key: 'disk',
        icon: 'disk',
        size: 'small',
        title: '存储',
        note: disk ? `工作目录所在文件系统\n${disk.path}` : '无法读取文件系统',
        value: percent(disk?.percent),
        detail: disk ? `可用 ${bytes(disk.free)} / ${bytes(disk.total)}` : '',
        ratio: disk?.percent,
        status: ratioStatus(disk?.percent),
        meterLabel: '存储已用比例',
      },
      {
        key: 'network',
        icon: 'network',
        size: 'small',
        title: '网络',
        note: '当前网络空间，不含本地回环接口',
        value: '',
        pair: [
          ['接收', speed(network.rx_rate)],
          ['发送', speed(network.tx_rate)],
        ],
        ratio: null,
        trend: [series(history, ['rx', 'tx'], (item, key) => item[key]), null],
      },
      {
        key: 'io',
        icon: 'layers',
        size: 'small',
        title: '磁盘 I/O',
        note: '当前 cgroup 的读写速率',
        value: '',
        pair: [
          ['读取', speed(io.read_rate)],
          ['写入', speed(io.write_rate)],
        ],
        ratio: null,
        trend: [series(history, ['read', 'write'], (item, key) => item[key]), null],
      },
      {
        key: 'pids',
        icon: 'terminal',
        size: 'small',
        title: '进程',
        note: `当前 cgroup 的进程与线程数 · CPU 累计限流 ${num(cpu.throttled_seconds, 2)} 秒`,
        value: String(pids.current ?? '—'),
        detail: pids.limit ? `/ ${pids.limit}` : '',
        ratio: pidRatio,
        status: cpu.throttled_seconds
          ? { level: 'warn', text: `限流 ${num(cpu.throttled_seconds)} 秒` }
          : ratioStatus(pidRatio),
      },
    ];
    reconcile($('metric-cards'), cards, card, updateCard);
    const devices = data.gpu.devices.map((gpu) => ({ ...gpu, key: gpu.uuid, history }));
    reconcile($('gpu-cards'), devices, gpuCard, updateGpu);
    text($('gpu-note'), devices.length ? '' : data.gpu.reason || '未发现可见 GPU');
    $('gpu-note').hidden = !!devices.length;
    $('gpu-heading').title =
      env.cuda_visible_devices === null
        ? '设备整体用量，可能包含其他进程'
        : `CUDA_VISIBLE_DEVICES=${env.cuda_visible_devices}`;
    this.sessions(data);
  }

  sessions(data) {
    const items = this.getSessions().map((item) => ({
      ...item,
      key: item.id,
      usage: data.sessions[item.id],
    }));
    if (this.sort === 'cpu')
      items.sort((a, b) => (b.usage?.cpu_percent ?? -1) - (a.usage?.cpu_percent ?? -1));
    if (this.sort === 'memory')
      items.sort((a, b) => (b.usage?.rss_bytes ?? -1) - (a.usage?.rss_bytes ?? -1));
    for (const button of document.querySelectorAll('[data-sort]'))
      button
        .closest('th')
        .setAttribute('aria-sort', this.sort === button.dataset.sort ? 'descending' : 'none');
    // Bars compare sessions on one scale per column; CPU never scales below one core.
    const cpuScale = Math.max(100, ...items.map((item) => item.usage?.cpu_percent || 0));
    const memoryScale = Math.max(1, ...items.map((item) => item.usage?.rss_bytes || 0));
    text($('resource-session-count'), items.length);
    reconcile(
      $('session-resources'),
      items,
      (item) => {
        const row = el('tr', '');
        row.dataset.sid = item.id;
        const name = el('td', 'session-cell');
        const dot = el('span', 'dot');
        const label = el('span', '');
        label.append(el('strong', ''), el('small', ''));
        name.append(dot, label);
        row.append(name, el('td', 'numeric'));
        for (const kind of ['cpu', 'memory']) {
          const cell = el('td', 'bar-cell');
          cell.dataset.kind = kind;
          const bar = el('span', 'cell-bar');
          bar.append(el('span', ''));
          cell.append(el('span', 'numeric'), bar);
          row.append(cell);
        }
        const actions = el('td', 'row-actions');
        const details = el('button', '', '进程');
        details.addEventListener('click', () => this.showSession(item.id));
        const attach = el('button', '', '连接');
        attach.addEventListener('click', () => this.select(item.id));
        actions.append(details, attach);
        row.append(actions);
        return row;
      },
      (row, item) => {
        const [name, count, cpuCell, memoryCell] = row.children;
        text(name.querySelector('strong'), item.name);
        text(name.querySelector('small'), item.group || '未分组');
        name.title = item.name;
        name.querySelector('.dot').className = `dot ${item.status === 'exited' ? 'muted' : ''}`;
        name.querySelector('.dot').title = item.status === 'exited' ? '已退出' : '运行中';
        text(count, String(item.usage?.process_count ?? '—'));
        const cpuValue = item.usage?.cpu_percent;
        const rss = item.usage?.rss_bytes;
        text(cpuCell.firstElementChild, percent(cpuValue));
        text(memoryCell.firstElementChild, bytes(rss));
        cpuCell.querySelector('.cell-bar > span').style.width =
          `${Number.isFinite(cpuValue) ? (cpuValue / cpuScale) * 100 : 0}%`;
        memoryCell.querySelector('.cell-bar > span').style.width =
          `${Number.isFinite(rss) ? (rss / memoryScale) * 100 : 0}%`;
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
      text($('details-error'), item.status === 'exited' ? 'Shell 已退出' : '');
    } catch (error) {
      if (generation === this.generation) $('details-error').textContent = error.message;
    } finally {
      if (generation === this.generation) this.detailBusy = false;
    }
  }
}
