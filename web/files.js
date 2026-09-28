import { $, el } from './dom.js';
import { renderTable, renderMedia } from './fileviews.js';

// Quoting preserves spaces; bare paths stop at prose and Markdown delimiters.
const TOKENS = /`([^`\r\n]+)`|"([^"\r\n]+)"|'([^'\r\n]+)'|[^\s<>"'`()[\]{}|=，。；！？：]+/gu;

function target(raw) {
  let path = raw;
  let line = 0;
  if (path.startsWith('file://')) {
    const url = new URL(path);
    if (url.hostname && url.hostname !== 'localhost') return null;
    path = decodeURIComponent(url.pathname) + url.hash;
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return null;
  const suffix = path.match(/(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)$/);
  if (suffix) {
    line = Number(suffix[1] || suffix[2]);
    path = path.slice(0, -suffix[0].length);
  }
  if (
    !path ||
    path.startsWith('-') ||
    !(
      /^(?:\/|~\/|\.\.?\/)/.test(path) ||
      path.includes('/') ||
      /[\p{L}_-][\p{L}\p{N}_.-]*\.[a-zA-Z\d]{1,12}$/.test(path)
    )
  )
    return null;
  return { path, line };
}

function links(term, number) {
  const buffer = term.buffer.active;
  let start = number - 1;
  let end = start;
  while (start > 0 && number - start < 8 && buffer.getLine(start)?.isWrapped) start--;
  while (end - start < 16 && buffer.getLine(end + 1)?.isWrapped) end++;
  let text = '';
  const points = [];
  for (let y = start; y <= end; y++) {
    const row = buffer.getLine(y);
    if (!row) break;
    for (let x = 0; x < term.cols; x++) {
      const cell = row.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      text += chars;
      for (let i = 0; i < chars.length; i++) points.push({ x: x + 1, y: y + 1 });
    }
  }
  const found = [];
  for (const match of text.matchAll(TOKENS)) {
    const quoted = match[1] ?? match[2] ?? match[3];
    const raw = quoted ?? match[0].replace(/[.,;:!?，。；：！？]+$/u, '');
    let value;
    try {
      value = target(raw);
    } catch (error) {
      if (error instanceof URIError || error instanceof TypeError) continue;
      throw error;
    }
    if (!value) continue;
    const offset = match.index + (quoted === undefined ? 0 : 1);
    const range = { start: points[offset], end: points[offset + raw.length - 1] };
    if (range.start.y <= number && range.end.y >= number) found.push({ text: raw, range });
  }
  return found;
}

export class FilePreview {
  constructor(api, current, report) {
    this.api = api;
    this.current = current;
    this.report = report;
    this.generation = 0;
    this.controller = null;
    this.sid = null;
    this.path = '';
    this.history = [];
    this.sheet = '';
    this.table = null;
    $('preview-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const raw = $('preview-path').value;
      try {
        const value = target(raw);
        this.load(value?.path || raw, value?.line || 0);
      } catch (error) {
        $('preview-error').textContent = '无法解析路径或文件链接。';
      }
    });
    $('preview-parent').addEventListener('click', () =>
      this.load(this.path.slice(0, this.path.lastIndexOf('/')) || '/', 0),
    );
    $('preview-back').addEventListener('click', () => {
      const previous = this.history.pop();
      if (previous) this.fetch(previous.path, previous.line, previous.sheet);
    });
    $('preview-dialog').addEventListener('close', () => {
      this.generation++;
      this.controller?.abort();
      this.clear();
    });
    $('preview-sheet').addEventListener('change', () => {
      this.fetch(this.path, 0, $('preview-sheet').value);
    });
    $('preview-table-search').addEventListener('input', () => {
      if (this.table) renderTable(this.table, $('preview-table-search').value, this.line);
    });
    $('preview-maximize').addEventListener('click', () => {
      const expanded = $('preview-dialog').classList.toggle('maximized');
      $('preview-maximize').setAttribute('aria-pressed', String(expanded));
      $('preview-maximize').textContent = expanded ? '还原窗口' : '最大化';
    });
  }

  clear() {
    for (const player of $('preview-content').querySelectorAll('audio, video')) {
      player.pause();
      player.removeAttribute('src');
      player.load();
    }
    $('preview-content').replaceChildren();
    $('preview-content').removeAttribute('data-kind');
    $('preview-table-tools').hidden = true;
    $('preview-external').hidden = true;
    $('preview-external').removeAttribute('href');
    this.table = null;
  }

  attach(term) {
    term.registerLinkProvider({
      provideLinks: (number, callback) =>
        callback(
          links(term, number).map((link) => ({
            ...link,
            activate: (event) => {
              event.preventDefault();
              // xterm may retain a hover result while the pointer is outside it.
              if (
                !links(term, link.range.start.y).some(
                  (current) =>
                    current.text === link.text && current.range.start.x === link.range.start.x,
                )
              )
                return;
              this.open(link.text, term, link.range.start);
            },
          })),
        ),
    });
    term.options.linkHandler = {
      allowNonHttpProtocols: true,
      activate: (event, uri, range) => {
        event.preventDefault();
        if (/^https?:\/\//i.test(uri)) {
          window.open(uri, '_blank', 'noopener,noreferrer');
          return;
        }
        if (/^(?:file:\/\/|\/|~\/|\.\.?\/)/.test(uri)) this.open(uri, term, range.start);
      },
    };
  }

  open(raw, term, point) {
    const item = this.current();
    if (!item) return;
    let value;
    try {
      value = raw ? target(raw) : null;
    } catch {
      this.report(new Error('无法解析文件链接，请检查路径。'));
      return;
    }
    this.sid = item.id;
    this.path = '';
    this.history = [];
    this.line = 0;
    this.controller?.abort();
    this.generation++;
    $('preview-pane').replaceChildren(
      ...item.panes
        .filter((p) => p.visible)
        .map((p) => new Option(`${p.id} · ${p.command || item.shell}`, p.id)),
    );
    $('preview-pane').hidden = $('preview-pane').options.length < 2;
    let pane = item.active_pane;
    if (point && term) {
      const x = point.x - 1;
      const y = point.y - 1 - term.buffer.active.viewportY;
      pane =
        item.panes.find(
          (p) => p.visible && x >= p.x && x < p.x + p.cols && y >= p.y && y < p.y + p.rows,
        )?.id || pane;
    }
    $('preview-pane').value = pane;
    this.clear();
    $('preview-title').textContent = '文件预览';
    $('preview-kind').textContent = 'FILE';
    $('preview-note').textContent = '读取 LanTerm 主机上的文件；相对路径按所选分屏的当前目录解析。';
    $('preview-error').textContent = '';
    $('preview-path').value = value?.path || raw;
    $('preview-parent').disabled = true;
    $('preview-back').disabled = true;
    if (!$('preview-dialog').open) $('preview-dialog').showModal();
    if (value) this.load(value.path, value.line);
    else $('preview-path').focus();
  }

  load(path, line) {
    if (this.path) this.history.push({ path: this.path, line: this.line, sheet: this.sheet });
    return this.fetch(path, line, '');
  }

  async fetch(path, line, sheet) {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.clear();
    $('preview-error').textContent = '';
    $('preview-note').textContent = '正在读取…';
    $('preview-parent').disabled = true;
    $('preview-back').disabled = !this.history.length;
    try {
      const params = new URLSearchParams({ path, pane: $('preview-pane').value, sheet });
      const data = await this.api(
        `/sessions/${this.sid}/file?${params}`,
        'GET',
        undefined,
        controller.signal,
      );
      if (generation !== this.generation) return;
      this.path = data.path;
      this.line = line;
      this.sheet = data.sheet || '';
      $('preview-title').textContent = data.path.split('/').at(-1) || '/';
      $('preview-title').title = data.path;
      $('preview-kind').textContent = {
        text: 'TEXT',
        image: 'IMAGE',
        directory: 'DIR',
        table: 'TABLE',
        pdf: 'PDF',
        audio: 'AUDIO',
        video: 'VIDEO',
      }[data.kind];
      $('preview-path').value = data.path;
      $('preview-parent').disabled = data.path === '/';
      $('preview-note').textContent =
        data.kind === 'directory'
          ? `LanTerm 主机 · ${data.entries.length} 项${data.truncated ? ' · 仅显示前 500 项' : ''}`
          : `LanTerm 主机 · ${data.size < 1024 ? `${data.size} B` : `${(data.size / 1024).toFixed(1)} KiB`} · 只读${data.truncated && data.kind === 'text' ? ' · 仅预览前 1 MiB' : ''}`;
      const content = $('preview-content');
      content.dataset.kind = data.kind;
      if (data.kind === 'table') {
        this.table = data;
        $('preview-table-tools').hidden = false;
        $('preview-table-search').value = '';
        $('preview-sheet').replaceChildren(...data.sheets.map((name) => new Option(name, name)));
        $('preview-sheet').value = data.sheet;
        $('preview-sheet').hidden = !data.sheets.length;
        if (data.note) $('preview-note').textContent += ` · ${data.note}`;
        if (data.truncated)
          $('preview-note').textContent +=
            ` · 预览已截断（最多 ${data.limits.rows} 行、${data.limits.cols} 列、每格 ${data.limits.cell} 字符）`;
        renderTable(data, '', line);
      } else if (['pdf', 'audio', 'video'].includes(data.kind)) {
        const params = new URLSearchParams({ path: data.path, pane: $('preview-pane').value });
        const url = new URL(`api/sessions/${this.sid}/file/content?${params}`, location.href);
        $('preview-external').href = url.href;
        $('preview-external').hidden = false;
        if (data.kind === 'pdf')
          $('preview-note').textContent += ' · 浏览器 PDF 阅读器；无法内嵌时可在新标签页打开';
        renderMedia(data, url.href, (message) => {
          if (generation === this.generation) $('preview-error').textContent = message;
        });
      } else if (data.kind === 'image') {
        const img = document.createElement('img');
        img.alt = data.path;
        img.src = data.src;
        img.addEventListener('error', () => {
          if (generation === this.generation)
            $('preview-error').textContent = '图片格式无效或浏览器无法显示。';
        });
        content.append(img);
      } else if (data.kind === 'directory') {
        const list = el('div', 'file-entries');
        for (const entry of data.entries) {
          const button = el('button', 'file-entry');
          button.append(
            el('span', 'file-kind', entry.directory ? '目录' : '文件'),
            el('span', '', entry.name),
          );
          button.addEventListener('click', () => this.load(`${data.path}/${entry.name}`, 0));
          list.append(button);
        }
        if (!data.entries.length) list.append(el('p', '', '空目录'));
        content.append(list);
      } else {
        const all = data.content.split('\n');
        const code = el('pre', 'file-code');
        const lines = all.slice(0, 5000);
        for (const [index, text] of lines.entries()) {
          const row = el('span', 'file-line', text || ' ');
          row.dataset.line = index + 1;
          if (index + 1 === line) row.classList.add('highlight');
          code.append(row);
        }
        content.append(code);
        if (all.length > 5000) $('preview-note').textContent += ' · 仅显示前 5000 行';
        if (line > lines.length) $('preview-note').textContent += ` · 第 ${line} 行超出预览范围`;
        code.querySelector('.highlight')?.scrollIntoView({ block: 'center' });
      }
    } catch (error) {
      if (generation !== this.generation || error.name === 'AbortError') return;
      $('preview-note').textContent = '';
      $('preview-error').textContent = error.message;
    }
  }
}
