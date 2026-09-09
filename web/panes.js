import { $, reconcile, text } from './dom.js';

export class PaneControls {
  constructor(api, changed, report, status) {
    this.api = api;
    this.changed = changed;
    this.report = report;
    this.status = status;
    this.sid = null;
    this.data = null;
    this.busy = false;
    this.generation = 0;
    this.closing = null;
    $('pane-target').addEventListener('change', () => {
      this.closing = null;
      $('pane-confirm').hidden = true;
      $('pane-error').textContent = '';
      this.update();
    });
    for (const button of document.querySelectorAll('[data-split]')) {
      button.addEventListener('click', () => this.run('split', button.dataset.split));
    }
    for (const action of ['select', 'zoom', 'restart']) {
      $(`pane-${action}`).addEventListener('click', () => this.run(action, ''));
    }
    $('pane-close').addEventListener('click', () => {
      this.closing = $('pane-target').value;
      $('pane-close-label').textContent = this.closing;
      $('pane-confirm').hidden = false;
    });
    $('pane-cancel-close').addEventListener('click', () => {
      $('pane-confirm').hidden = true;
      this.closing = null;
    });
    $('pane-confirm-close').addEventListener('click', () => this.run('close', ''));
  }

  update() {
    const pane = this.data?.panes.find((item) => item.id === $('pane-target').value);
    const count = this.data?.panes.length || 0;
    $('pane-target').disabled = this.busy;
    for (const button of document.querySelectorAll('[data-split]'))
      button.disabled = this.busy || !pane || pane.dead || count >= this.data.limit;
    $('pane-select').disabled = this.busy || !pane;
    $('pane-zoom').disabled = this.busy || !pane || count < 2;
    $('pane-zoom').textContent = pane?.zoomed ? '还原布局' : '放大分屏';
    $('pane-restart').hidden = !pane?.dead;
    $('pane-restart').disabled = this.busy;
    $('pane-close').disabled = this.busy || !pane || count < 2;
    $('pane-close').title = count < 2 ? '最后一个分屏请使用顶部“关闭”结束会话' : '';
    $('pane-confirm-close').disabled = this.busy;
    const badges = $('pane-status');
    if (pane) {
      badges.dataset.pluginSession = this.sid;
      badges.dataset.pluginPane = pane.id;
      this.status.fill(badges, this.sid);
    } else {
      delete badges.dataset.pluginSession;
      delete badges.dataset.pluginPane;
      delete badges.dataset.signature;
      badges.replaceChildren();
      badges.hidden = true;
    }
  }

  reset() {
    this.generation += 1;
    this.sid = null;
    this.data = null;
    this.busy = false;
    this.closing = null;
    $('pane-dialog').close();
    this.update();
  }

  apply(data, selected) {
    this.data = data;
    text($('pane-context'), `${data.name} · ${data.panes.length} / ${data.limit} 个分屏`);
    const choices = data.panes.map((pane) => ({
      key: pane.id,
      label: `${pane.id} · ${pane.dead ? '已退出' : pane.command || 'Shell'}${pane.id === data.active ? '（当前输入）' : ''}`,
    }));
    if (!choices.some((item) => item.key === selected)) {
      selected = '';
      choices.unshift({ key: '', label: '请选择分屏' });
      $('pane-error').textContent = '所选分屏已关闭或移到其他窗口，请重新选择';
      $('pane-confirm').hidden = true;
      this.closing = null;
    }
    reconcile(
      $('pane-target'),
      choices,
      () => new Option(),
      (option, item) => {
        option.value = item.key;
        text(option, item.label);
      },
    );
    $('pane-target').value = selected;
    this.update();
  }

  sync(items) {
    if (!$('pane-dialog').open || this.busy || !this.data) return;
    const item = items.find((item) => item.id === this.sid);
    if (!item) {
      this.reset();
      this.report(new Error('会话已关闭'));
      return;
    }
    this.apply(
      {
        name: item.name,
        active: item.active_pane,
        limit: this.data.limit,
        panes: item.panes.filter((pane) => pane.visible),
      },
      $('pane-target').value,
    );
  }

  async open(sid, pane) {
    this.sid = sid;
    this.data = null;
    this.closing = null;
    const generation = ++this.generation;
    this.busy = true;
    $('pane-confirm').hidden = true;
    $('pane-error').textContent = '';
    $('pane-context').textContent = '正在读取分屏…';
    $('pane-target').replaceChildren();
    this.update();
    $('pane-dialog').showModal();
    try {
      const data = await this.api(`/sessions/${sid}/panes`);
      if (generation !== this.generation) return;
      this.apply(data, pane || data.active);
    } catch (error) {
      if (generation === this.generation) $('pane-error').textContent = error.message;
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.update();
      }
    }
  }

  async run(action, direction) {
    if (this.busy || !this.data) return;
    const sid = this.sid;
    const pane = action === 'close' ? this.closing : $('pane-target').value;
    if (!pane) return;
    const generation = this.generation;
    this.busy = true;
    this.update();
    $('pane-error').textContent = '';
    try {
      if (action === 'split') await this.api(`/sessions/${sid}/panes`, 'POST', { pane, direction });
      else if (action === 'close')
        await this.api(`/sessions/${sid}/panes/${encodeURIComponent(pane)}`, 'DELETE');
      else await this.api(`/sessions/${sid}/panes/action`, 'POST', { pane, action });
      if (generation === this.generation) $('pane-dialog').close();
      await this.changed(action === 'close' ? null : sid);
    } catch (error) {
      if (generation === this.generation && $('pane-dialog').open)
        $('pane-error').textContent = error.message;
      else this.report(error);
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.update();
      }
    }
  }
}
