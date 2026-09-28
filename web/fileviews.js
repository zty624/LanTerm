import { $, el } from './dom.js';

export function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export function renderTable(data, query, line) {
  const needle = query.trim().toLocaleLowerCase();
  const rows = data.rows
    .map((cells, index) => ({ cells, index }))
    .filter(
      (row) => !needle || row.cells.some((cell) => cell.toLocaleLowerCase().includes(needle)),
    );
  const width = Math.max(0, ...data.rows.map((row) => row.length));
  const table = el('table', 'file-table');
  table.setAttribute('aria-label', data.sheet || '表格预览');
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  heading.append(el('th', 'file-row-number', '#'));
  for (let i = 0; i < width; i++) {
    const cell = el('th', '', columnName(i));
    cell.scope = 'col';
    heading.append(cell);
  }
  head.append(heading);
  const body = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.row = row.index + 1;
    if (line === row.index + 1) tr.classList.add('highlight');
    const number = el('th', 'file-row-number', row.index + 1);
    number.scope = 'row';
    tr.append(number);
    for (let i = 0; i < width; i++) {
      const cell = el('td', '', row.cells[i] || '');
      tr.append(cell);
    }
    body.append(tr);
  }
  table.append(head, body);
  $('preview-content').replaceChildren(table);
  if (!rows.length)
    $('preview-content').append(el('p', 'file-empty', needle ? '没有匹配的内容' : '空表格'));
  $('preview-table-count').textContent = `${rows.length} / ${data.rows.length} 行 · ${width} 列`;
  if (!needle) table.querySelector('.highlight')?.scrollIntoView({ block: 'center' });
}

export function renderMedia(data, url, failed) {
  const content = $('preview-content');
  if (data.kind === 'pdf') {
    const frame = document.createElement('iframe');
    frame.className = 'file-pdf';
    frame.title = 'PDF 文档预览';
    frame.src = url;
    content.append(frame);
    return;
  }
  const stage = el('div', `media-stage ${data.kind}`);
  const player = document.createElement(data.kind);
  player.controls = true;
  player.preload = 'metadata';
  player.setAttribute('aria-label', data.kind === 'audio' ? '音频播放器' : '视频播放器');
  player.setAttribute('playsinline', '');
  player.src = url;
  player.addEventListener('error', () =>
    failed('浏览器无法播放此文件：编码不受支持或文件已损坏。'),
  );
  if (data.kind === 'audio') {
    const wave = el('div', 'audio-wave');
    wave.setAttribute('aria-hidden', 'true');
    for (const height of [24, 40, 64, 44, 88, 56, 104, 72, 48, 80, 40, 64, 24]) {
      const bar = el('span', '');
      bar.style.height = `${height}px`;
      wave.append(bar);
    }
    stage.append(
      wave,
      el('h3', 'media-name', data.path.split('/').at(-1)),
      el('p', 'media-hint', '音频预览 · 点击播放'),
    );
  }
  stage.append(player);
  content.append(stage);
}
