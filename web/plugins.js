// Generic session badges: providers own their state names and labels on the server.
export class SessionStatus {
  constructor(api, loggedIn) {
    this.api = api;
    this.loggedIn = loggedIn;
    this.data = {};
    this.enabled = false;
    this.busy = false;
    this.generation = 0;
    this.controller = null;
  }

  reset(plugins) {
    this.generation += 1;
    this.controller?.abort();
    this.controller = null;
    this.data = {};
    this.enabled = plugins.length > 0;
    this.busy = false;
    this.update();
  }

  render(sid) {
    const group = document.createElement('span');
    group.className = 'plugin-badges';
    group.dataset.pluginSession = sid;
    this.fill(group, sid);
    return group;
  }

  fill(group, sid) {
    group.replaceChildren();
    for (const item of this.data[sid] || []) {
      const badge = document.createElement('span');
      badge.className = 'plugin-badge';
      badge.dataset.plugin = item.plugin;
      badge.dataset.state = item.state;
      badge.textContent = `${item.name} · ${item.label}`;
      badge.title = item.detail || `${item.name} · ${item.label} (${item.pane})`;
      group.append(badge);
    }
    group.hidden = !group.childElementCount;
  }

  update() {
    for (const group of document.querySelectorAll('[data-plugin-session]')) this.fill(group, group.dataset.pluginSession);
  }

  async refresh() {
    if (!this.enabled || this.busy || !this.loggedIn()) return;
    this.busy = true;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const result = await this.api('/plugins/status', 'GET', undefined, controller.signal);
      if (generation !== this.generation) return;
      this.data = result.sessions;
    } catch (error) {
      if (generation !== this.generation) return;
      if (error.status === 401) this.data = {};
      else {
        this.data = Object.fromEntries(Object.entries(this.data).map(([sid, badges]) => [sid, badges.map((badge) => ({ ...badge, state: 'unknown', label: '状态暂不可用', detail: '状态服务未响应，恢复连接后将自动更新' }))]));
      }
    } finally {
      clearTimeout(timeout);
      if (generation === this.generation) { this.controller = null; this.busy = false; this.update(); }
    }
  }
}
