const $ = (id) => document.getElementById(id);
const el = (tag, className, text = '') => {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = text;
  return item;
};
export const bytes = (value) => {
  if (value === null || value === undefined) return '—';
  const unit = Math.min(4, Math.max(0, Math.floor(Math.log2(value || 1) / 10)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
};
const num = (value, digits = 1) => value === null || value === undefined ? '—' : value.toFixed(digits);
const percent = (value) => value === null || value === undefined ? '—' : `${num(value)}%`;
const speed = (value) => value === null || value === undefined ? '—' : `${bytes(value)}/s`;
export const age = (seconds) => seconds < 60 ? `${Math.floor(seconds)} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟` : `${(seconds / 3600).toFixed(1)} 小时`;

function sparkline(history, key) {
  const points = history.filter((item) => item[key] !== null && item.timestamp >= Date.now() / 1000 - 360);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 260 36');
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('aria-label', '最近采样趋势');
  if (points.length < 2) return svg;
  const min = points[0].timestamp;
  const span = points.at(-1).timestamp - min || 1;
  const max = Math.max(...points.map((item) => item[key]), 1);
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  line.setAttribute('points', points.map((item) => `${(item.timestamp - min) / span * 260},${34 - item[key] / max * 30}`).join(' '));
  svg.append(line);
  return svg;
}

function card(title, value, detail, ratio) {
  const node = el('article', 'metric-card');
  node.append(el('span', 'metric-label', title), el('strong', 'metric-value', value), el('p', 'metric-detail', detail));
  if (ratio !== null && Number.isFinite(ratio)) {
    const bar = el('div', 'meter');
    const fill = el('span', ratio > 90 ? 'high' : '');
    fill.style.width = `${Math.min(100, Math.max(0, ratio))}%`;
    bar.append(fill); node.append(bar);
  }
  return node;
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
  }

  async refresh() {
    if (this.busy || !this.allowed()) return;
    this.busy = true;
    try {
      const data = await this.api('/metrics');
      if (!this.allowed()) return;
      this.data = data;
      this.render(data);
      $('monitor-error').textContent = '';
    } catch (error) {
      $('monitor-error').textContent = `统计更新失败：${error.message}。当前显示的是上一次采样。`;
    } finally { this.busy = false; }
  }

  render(data) {
    const { environment: env, cpu, memory, disk, network, io, pids } = data;
    const label = (scope) => ({ cgroup: '当前 cgroup', host: '主机', unavailable: '不可用' })[scope];
    $('monitor-scope').textContent = `${env.hostname} · ${env.container ? '容器环境' : 'Linux 主机'} · ${env.cgroup_version ? `cgroup v${env.cgroup_version}` : '未发现 cgroup'}`;
    $('monitor-scope').title = env.cgroup_path || '未发现可读取的 cgroup';
    $('monitor-updated').textContent = `采样于 ${new Date(data.timestamp * 1000).toLocaleTimeString()} · 每 ${data.interval} 秒刷新`;
    const cpuCard = card(`CPU · ${label(cpu.scope)}`, percent(cpu.percent), `${num(cpu.cores_used, 2)} / ${num(cpu.cores_limit, 2)} 核${cpu.quota_cores === null ? ' · CPU 亲和性上限' : ' · 按配额归一化'}${cpu.shared_limit ? ' · 上级共享配额' : ''}`, cpu.percent);
    cpuCard.append(sparkline(data.history, 'cpu'));
    const memRatio = memory.limit && memory.used !== null ? memory.used / memory.limit * 100 : null;
    const memCard = card(`内存 · ${label(memory.scope)}`, bytes(memory.used), `${memory.limit === null ? '未设置可见内存上限' : `上限 ${bytes(memory.limit)}`}${memory.shared_limit ? ' · 上级共享配额' : ''} · OOM ${memory.oom_kills ?? '—'}`, memRatio);
    memCard.append(sparkline(data.history, 'memory'));
    $('metric-cards').replaceChildren(
      cpuCard, memCard,
      card('工作目录文件系统', disk ? bytes(disk.free) : '—', disk ? `剩余 / 共 ${bytes(disk.total)} · ${disk.path}` : '无法读取目录所在文件系统', disk?.percent ?? null),
      card('网络 · 当前网络命名空间', `↓ ${speed(network.rx_rate)}`, `↑ ${speed(network.tx_rate)} · 不含 loopback`, null),
      card('磁盘 I/O · 当前 cgroup', speed(io.read_rate), `写入 ${speed(io.write_rate)} · 未提供计数器时显示 —`, null),
      card('进程 / 线程 · 当前 cgroup', String(pids.current ?? '—'), `上限 ${pids.limit ?? '未设置'} · CPU 累计限流 ${num(cpu.throttled_seconds, 2)} 秒`, pids.limit && pids.current !== null ? pids.current / pids.limit * 100 : null),
    );
    const gpuCards = data.gpu.devices.map((gpu) => {
      const ratio = gpu.memory_total && gpu.memory_used !== null ? gpu.memory_used / gpu.memory_total * 100 : null;
      const node = card(`GPU ${gpu.index} · ${gpu.name}`, percent(gpu.utilization), `显存 ${bytes(gpu.memory_used)} / ${bytes(gpu.memory_total)} · ${num(gpu.temperature, 0)} °C · ${num(gpu.power)} W`, ratio);
      node.title = gpu.uuid;
      return node;
    });
    if (!gpuCards.length) gpuCards.push(el('p', 'monitor-note', data.gpu.reason || '未发现可见 GPU'));
    if (env.cuda_visible_devices !== null) gpuCards.push(el('p', 'monitor-note', `CUDA_VISIBLE_DEVICES=${env.cuda_visible_devices}；上方为驱动可见设备的总量，未折算为单个会话或 MIG 配额。`));
    $('gpu-cards').replaceChildren(...gpuCards);
    const rows = this.getSessions().map((item) => {
      const value = data.sessions[item.id];
      const row = el('tr', '');
      row.dataset.sid = item.id;
      for (const text of [item.name, item.group || '未分组', item.status === 'exited' ? '已退出' : '运行中', value?.process_count ?? '—', percent(value?.cpu_percent), bytes(value?.rss_bytes)]) row.append(el('td', '', String(text)));
      const cell = el('td', 'row-actions');
      const details = el('button', '', '进程');
      details.addEventListener('click', () => this.showSession(item.id));
      const attach = el('button', '', '连接');
      attach.addEventListener('click', () => this.select(item.id));
      cell.append(details, attach); row.append(cell);
      return row;
    });
    if (!rows.length) { const row = el('tr', ''); const cell = el('td', 'monitor-note', '尚无会话，新建一个终端后即可查看会话资源。'); cell.colSpan = 7; row.append(cell); rows.push(row); }
    $('session-resources').replaceChildren(...rows);
  }

  async showSession(sid) {
    $('details-dialog').dataset.sid = sid;
    $('details-title').textContent = '正在读取会话详情…';
    $('details-summary').replaceChildren(); $('process-table').replaceChildren();
    $('details-note').textContent = ''; $('details-error').textContent = '';
    if (!$('details-dialog').open) $('details-dialog').showModal();
    await this.refreshSession();
  }

  async refreshSession() {
    if (this.detailBusy || !$('details-dialog').open || !this.allowed()) return;
    this.detailBusy = true;
    const sid = $('details-dialog').dataset.sid;
    try {
      const item = await this.api(`/sessions/${sid}`);
      if (!this.allowed() || sid !== $('details-dialog').dataset.sid) return;
      $('details-title').textContent = item.name;
      const entries = [
        ['Shell', item.shell], ['分组', item.group || '未分组'], ['标签', item.tags.join(' · ') || '—'],
        ['创建时间', new Date(item.created * 1000).toLocaleString()],
        ['最近活动', new Date(item.activity * 1000).toLocaleString()], ['已连接浏览器', String(item.clients)],
        ['初始目录', item.cwd], ['当前目录', item.resources?.cwd || '无法读取 / 已退出'],
      ];
      $('details-summary').replaceChildren(...entries.map(([key, value]) => { const node = el('div', ''); node.append(el('span', '', key), el('strong', '', value)); return node; }));
      $('details-note').textContent = item.note;
      $('process-table').replaceChildren(...(item.resources?.processes || []).map((proc) => {
        const row = el('tr', '');
        for (const value of [proc.pid, proc.name, proc.status, percent(proc.cpu_percent), bytes(proc.rss_bytes), age(proc.age_seconds)]) row.append(el('td', '', String(value)));
        return row;
      }));
      $('details-error').textContent = item.status === 'exited' ? 'Shell 已退出，可通过“重新启动”继续使用此会话。' : '';
    } catch (error) { $('details-error').textContent = error.message; }
    finally { this.detailBusy = false; }
  }
}
