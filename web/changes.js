import { $, el, text } from './dom.js';
import { icon } from './icons.js';

const LABELS = {
  M: '已修改',
  A: '新增',
  D: '已删除',
  R: '重命名',
  C: '复制',
  T: '类型变更',
  U: '冲突',
  '?': '未跟踪',
};
const MAX_LINES = 6000;

function count(value, sign) {
  return value === null || value === undefined ? '' : `${sign}${value}`;
}

// Read-only view of the Git work tree that a pane is in: what an agent changed.
export class Changes {
  constructor(api, current, openFile, report) {
    this.api = api;
    this.current = current;
    this.openFile = openFile;
    this.report = report;
    this.sid = null;
    this.data = null;
    this.selected = null;
    this.generation = 0;
    this.diffGeneration = 0;
    $('changes-refresh').addEventListener('click', () => this.load());
    $('changes-pane').addEventListener('change', () => {
      this.selected = null;
      this.load();
    });
    $('changes-open').addEventListener('click', () => {
      if (!this.data?.repo || !this.selected) return;
      this.openFile(`${this.data.root}/${this.selected.path}`, $('changes-pane').value);
    });
    $('changes-list').addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...$('changes-list').querySelectorAll('.change-item')];
      const index = buttons.indexOf(document.activeElement);
      const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
      next?.focus();
      next?.click();
    });
  }

  open() {
    const item = this.current();
    if (!item) return;
    if (this.sid !== item.id) this.selected = null;
    this.sid = item.id;
    const panes = item.panes.filter((pane) => pane.visible);
    $('changes-pane').replaceChildren(
      ...panes.map((pane) => new Option(`${pane.id} · ${pane.command || item.shell}`, pane.id)),
    );
    $('changes-pane').value = item.active_pane;
    $('changes-pane').hidden = panes.length < 2;
    if (!$('changes-dialog').open) $('changes-dialog').showModal();
    this.load();
  }

  async load() {
    const generation = ++this.generation;
    const pane = $('changes-pane').value;
    $('changes-error').textContent = '';
    $('changes-dialog').classList.add('loading');
    try {
      const data = await this.api(`/sessions/${this.sid}/git?pane=${encodeURIComponent(pane)}`);
      if (generation !== this.generation) return;
      this.data = data;
      this.summary();
      this.list();
      const files = data.repo ? data.files : [];
      const keep = files.find((file) => file.path === this.selected?.path);
      if (keep || files.length) this.show(keep || files[0]);
      else this.empty(data.repo ? '工作区没有未提交的变更。' : '当前目录不在 Git 仓库中。');
    } catch (error) {
      if (generation !== this.generation) return;
      $('changes-error').textContent = error.message;
    } finally {
      if (generation === this.generation) $('changes-dialog').classList.remove('loading');
    }
  }

  summary() {
    const data = this.data;
    const branch = $('changes-branch');
    branch.replaceChildren();
    if (!data.repo) {
      branch.hidden = true;
      text($('changes-summary'), data.cwd);
      return;
    }
    branch.hidden = false;
    branch.append(icon('branch'), el('span', '', data.branch || '(detached)'));
    if (data.ahead || data.behind) {
      const sync = [data.ahead ? `↑${data.ahead}` : '', data.behind ? `↓${data.behind}` : '']
        .filter(Boolean)
        .join(' ');
      branch.append(el('span', 'changes-sync', sync));
    }
    const added = data.files.reduce((sum, file) => sum + (file.added || 0), 0);
    const deleted = data.files.reduce((sum, file) => sum + (file.deleted || 0), 0);
    const parts = [`${data.files.length}${data.truncated ? '+' : ''} 个文件`];
    if (added || deleted) parts.push(`+${added} −${deleted}`);
    text($('changes-summary'), parts.join(' · '));
    $('changes-summary').title = `${data.root}\n${data.head ? `HEAD ${data.head}` : '尚无提交'}`;
  }

  list() {
    const files = this.data.repo ? this.data.files : [];
    const fragment = document.createDocumentFragment();
    for (const file of files) {
      const button = el('button', 'change-item');
      button.type = 'button';
      button.dataset.path = file.path;
      button.setAttribute('role', 'listitem');
      button.title = `${LABELS[file.status] || file.status}${file.staged ? ' · 已暂存' : ''}\n${file.orig ? `${file.orig} → ` : ''}${file.path}`;
      // VS Code style letters: U = untracked, ! = merge conflict.
      const status = el('span', 'change-status', { '?': 'U', U: '!' }[file.status] || file.status);
      status.dataset.status = file.status;
      const slash = file.path.lastIndexOf('/');
      const name = el('span', 'change-name');
      name.append(
        el('strong', '', file.path.slice(slash + 1)),
        el('small', '', slash >= 0 ? file.path.slice(0, slash) : ''),
      );
      const stats = el('span', 'change-stats');
      stats.append(
        el('span', 'added', count(file.added, '+')),
        el('span', 'deleted', count(file.deleted, '−')),
      );
      button.append(status, name, stats);
      button.addEventListener('click', () => this.show(file));
      fragment.append(button);
    }
    $('changes-list').replaceChildren(fragment);
    $('changes-list').hidden = !files.length;
  }

  empty(message) {
    this.selected = null;
    text($('changes-file'), '');
    $('changes-open').hidden = true;
    $('changes-content').replaceChildren(el('p', 'changes-empty', message));
  }

  async show(file) {
    this.selected = file;
    for (const button of $('changes-list').querySelectorAll('.change-item'))
      button.setAttribute('aria-current', String(button.dataset.path === file.path));
    text($('changes-file'), file.orig ? `${file.orig} → ${file.path}` : file.path);
    $('changes-open').hidden = file.status === 'D';
    const generation = ++this.diffGeneration;
    $('changes-content').replaceChildren(el('p', 'changes-empty', '正在读取差异…'));
    try {
      const query = new URLSearchParams({ pane: $('changes-pane').value, path: file.path });
      if (file.orig) query.set('orig', file.orig);
      const result = await this.api(`/sessions/${this.sid}/git/diff?${query}`);
      if (generation !== this.diffGeneration) return;
      this.render(result);
    } catch (error) {
      if (generation !== this.diffGeneration) return;
      $('changes-content').replaceChildren(el('p', 'changes-empty', error.message));
    }
  }

  render(result) {
    const view = $('changes-content');
    if (result.binary) {
      view.replaceChildren(el('p', 'changes-empty', '二进制文件，不显示文本差异。'));
      return;
    }
    if (!result.diff.trim()) {
      view.replaceChildren(el('p', 'changes-empty', '没有文本差异（可能只是权限或换行变化）。'));
      return;
    }
    const lines = result.diff.replace(/\n$/, '').split('\n');
    const pre = el('pre', 'diff-lines');
    let oldLine = 0;
    let newLine = 0;
    let body = false;
    for (const line of lines.slice(0, MAX_LINES)) {
      let kind = 'meta';
      let left = '';
      let right = '';
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        kind = 'hunk';
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        body = true;
      } else if (!body || line.startsWith('diff --git')) {
        body = false;
      } else if (line.startsWith('+')) {
        kind = 'add';
        right = newLine++;
      } else if (line.startsWith('-')) {
        kind = 'del';
        left = oldLine++;
      } else if (line.startsWith('\\')) {
        kind = 'meta';
      } else {
        kind = 'ctx';
        left = oldLine++;
        right = newLine++;
      }
      const row = el('span', 'diff-line');
      row.dataset.kind = kind;
      row.append(
        el('span', 'diff-num', String(left)),
        el('span', 'diff-num', String(right)),
        el('span', 'diff-text', line || ' '),
      );
      pre.append(row);
    }
    const nodes = [pre];
    if (lines.length > MAX_LINES || result.truncated)
      nodes.push(el('p', 'render-note', '差异过长，仅显示开头部分。'));
    view.replaceChildren(...nodes);
    view.scrollTop = 0;
  }
}
