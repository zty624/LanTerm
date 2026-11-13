import { $, el } from './dom.js';
import { icon } from './icons.js';

// Subsequence match: consecutive runs and word starts score higher. Returns matched indices.
export function match(query, text) {
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  const indices = [];
  let score = 0;
  let from = 0;
  for (const char of needle) {
    if (char === ' ') continue;
    const index = haystack.indexOf(char, from);
    if (index < 0) return null;
    const previous = indices.at(-1);
    score += 1;
    if (previous === index - 1) score += 4;
    if (index === 0 || /[\s·/_\-.:]/.test(haystack[index - 1])) score += 3;
    indices.push(index);
    from = index + 1;
  }
  // Earlier matches rank slightly higher among equal scores.
  return { score: score - (indices[0] || 0) * 0.05, indices };
}

function highlighted(text, indices) {
  const node = document.createDocumentFragment();
  const marks = new Set(indices);
  let run = '';
  let marked = false;
  const flush = () => {
    if (!run) return;
    node.append(marked ? el('mark', '', run) : document.createTextNode(run));
    run = '';
  };
  [...text].forEach((char, index) => {
    const isMark = marks.has(index);
    if (isMark !== marked) {
      flush();
      marked = isMark;
    }
    run += char;
  });
  flush();
  return node;
}

export class Palette {
  constructor(provider, report) {
    this.provider = provider;
    this.report = report;
    this.items = [];
    this.results = [];
    this.index = 0;
    $('palette-input').addEventListener('input', () => {
      this.index = 0;
      this.render();
    });
    $('palette-input').addEventListener('keydown', (event) => this.key(event));
    $('palette').addEventListener('click', (event) => {
      if (event.target === $('palette')) $('palette').close();
    });
    // Drop live badge copies so they neither update nor match status selectors while closed.
    $('palette').addEventListener('close', () => $('palette-list').replaceChildren());
  }

  open(query = '') {
    this.items = this.provider();
    $('palette-input').value = query;
    this.index = 0;
    this.render();
    if (!$('palette').open) $('palette').showModal();
    $('palette-input').focus();
  }

  key(event) {
    if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
      event.preventDefault();
      this.move(1);
    } else if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
      event.preventDefault();
      this.move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      this.run(this.results[this.index]);
    }
  }

  move(delta) {
    if (!this.results.length) return;
    this.index = (this.index + delta + this.results.length) % this.results.length;
    this.mark();
  }

  mark() {
    const options = $('palette-list').querySelectorAll('[role="option"]');
    options.forEach((option, index) => {
      const selected = index === this.index;
      option.setAttribute('aria-selected', String(selected));
      if (selected) {
        option.scrollIntoView({ block: 'nearest' });
        $('palette-input').setAttribute('aria-activedescendant', option.id);
      }
    });
  }

  run(item) {
    if (!item) return;
    $('palette').close();
    Promise.resolve().then(item.run).catch(this.report);
  }

  render() {
    const query = $('palette-input').value.trim();
    if (query) {
      this.results = this.items
        .map((item) => {
          const title = match(query, item.title);
          const extra = title ? null : match(query, `${item.keywords || ''} ${item.detail || ''}`);
          const found = title || extra;
          if (!found) return null;
          return { ...item, score: found.score + (title ? 10 : 0), marks: title?.indices || [] };
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .slice(0, 60);
    } else this.results = this.items.map((item) => ({ ...item, marks: [] }));
    const list = $('palette-list');
    const fragment = document.createDocumentFragment();
    let section = null;
    this.results.forEach((item, index) => {
      if (!query && item.section !== section) {
        section = item.section;
        fragment.append(el('div', 'palette-section', section));
      }
      const option = el('button', 'palette-item');
      option.type = 'button';
      option.id = `palette-option-${index}`;
      option.setAttribute('role', 'option');
      option.tabIndex = -1;
      option.append(icon(item.icon || 'command'));
      const text = el('span', 'palette-text');
      const title = el('strong', '');
      title.append(highlighted(item.title, item.marks));
      text.append(title);
      if (item.detail) text.append(el('small', '', item.detail));
      option.append(text);
      if (item.badges) option.append(item.badges);
      if (item.shortcut) option.append(el('kbd', '', item.shortcut));
      option.addEventListener('mousemove', () => {
        if (this.index === index) return;
        this.index = index;
        this.mark();
      });
      option.addEventListener('click', () => this.run(item));
      fragment.append(option);
    });
    if (!this.results.length) fragment.append(el('p', 'palette-empty', '没有匹配的会话或命令'));
    list.replaceChildren(fragment);
    this.mark();
  }
}
