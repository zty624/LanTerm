import DOMPurify from 'dompurify';
import hljs from 'highlight.js';
import { Marked } from 'marked';
import markedKatex from 'marked-katex-extension';
import { parseTree, format, applyEdits, printParseErrorCode } from 'jsonc-parser';
import { el } from './dom.js';

const EXT = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyi: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  ps1: 'powershell',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cu: 'cpp',
  cs: 'csharp',
  rs: 'rust',
  rb: 'ruby',
  jl: 'julia',
  kt: 'kotlin',
  kts: 'kotlin',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  env: 'ini',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  md: 'markdown',
  mdown: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  jsonc: 'json',
  jsonl: 'json',
  ndjson: 'json',
  ipynb: 'json',
  tex: 'latex',
  patch: 'diff',
  dockerfile: 'dockerfile',
  gql: 'graphql',
};
export const languages = hljs
  .listLanguages()
  .map((value) => ({ value, name: hljs.getLanguage(value).name || value }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function describe(path) {
  const name = path.split('/').at(-1).toLowerCase();
  const ext = name.split('.').at(-1);
  let language = EXT[ext] || (hljs.getLanguage(ext) ? ext : 'plaintext');
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) language = 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') language = 'makefile';
  if (name === 'cmakelists.txt') language = 'cmake';
  if (name === '.env' || name.startsWith('.env.')) language = 'ini';
  return {
    language,
    markdown: ['md', 'markdown', 'mdown'].includes(ext),
    json: ['json', 'jsonc', 'jsonl', 'ndjson', 'ipynb'].includes(ext),
    comments: ext === 'jsonc',
    records: ['jsonl', 'ndjson'].includes(ext),
  };
}

export async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      /* HTTP LAN pages and browser permissions may require the selection fallback. */
    }
  }
  const field = document.createElement('textarea');
  field.value = value;
  field.className = 'copy-field';
  const parent = document.querySelector('dialog[open]') || document.body;
  parent.append(field);
  const focused = document.activeElement;
  field.select();
  const copied = document.execCommand('copy');
  field.remove();
  focused?.focus();
  return copied;
}

function colored(text, language) {
  if (!hljs.getLanguage(language) || language === 'plaintext' || text.length > 200000) return null;
  return DOMPurify.sanitize(hljs.highlight(text, { language, ignoreIllegals: true }).value, {
    ALLOWED_TAGS: ['span'],
    ALLOWED_ATTR: ['class'],
  });
}

export function codeView(source, language, line) {
  const all = source.split('\n');
  const text = all.slice(0, 5000).join('\n');
  const pre = el('pre', 'file-code');
  pre.dataset.language = language;
  let row;
  let index = 0;
  function next() {
    row = el('span', 'file-line');
    row.dataset.line = ++index;
    if (line === index) row.classList.add('highlight');
    pre.append(row);
  }
  next();
  const html = colored(text, language);
  if (html === null) {
    for (const [i, value] of text.split('\n').entries()) {
      if (i) next();
      row.textContent = value || ' ';
    }
  } else {
    const template = document.createElement('template');
    template.innerHTML = html;
    function walk(node, classes) {
      if (node.nodeType === Node.TEXT_NODE) {
        for (const [i, value] of node.textContent.split('\n').entries()) {
          if (i) next();
          if (value)
            row.append(
              classes.length
                ? el('span', classes.join(' '), value)
                : document.createTextNode(value),
            );
        }
        return;
      }
      const nested =
        node.nodeType === Node.ELEMENT_NODE ? [...classes, ...node.classList] : classes;
      for (const child of node.childNodes) walk(child, nested);
    }
    walk(template.content, []);
    for (const empty of pre.children) if (!empty.textContent) empty.textContent = ' ';
  }
  return { node: pre, clipped: all.length > 5000, plain: text.length > 200000, lines: index };
}

export function jsonDocument(source, options) {
  const errors = [];
  const config = { allowTrailingComma: options.comments, disallowComments: !options.comments };
  let root;
  let pretty;
  if (options.records) {
    root = { type: 'array', children: [], offset: 0, length: source.length };
    let offset = 0;
    const formatted = [];
    for (const line of source.split('\n')) {
      if (line.trim()) {
        const issues = [];
        const node = parseTree(line, issues, config);
        errors.push(...issues.map((error) => ({ ...error, offset: error.offset + offset })));
        if (node) {
          const stack = [node];
          while (stack.length) {
            const current = stack.pop();
            current.offset += offset;
            if (current.children) stack.push(...current.children);
          }
          root.children.push(node);
        }
        formatted.push(
          applyEdits(line, format(line, undefined, { insertSpaces: true, tabSize: 2, eol: '\n' })),
        );
      }
      offset += line.length + 1;
    }
    pretty = formatted.join('\n\n');
  } else {
    root = parseTree(source, errors, config);
    pretty = errors.length
      ? source
      : applyEdits(
          source,
          format(source, undefined, { insertSpaces: true, tabSize: 2, eol: '\n' }),
        );
  }
  if (errors.length || !root) {
    const error = errors[0] || { offset: 0, error: 4 };
    const prefix = source.slice(0, error.offset);
    const row = prefix.split('\n').length;
    const col = error.offset - prefix.lastIndexOf('\n');
    return { error: `JSON 第 ${row} 行，第 ${col} 列：${printParseErrorCode(error.error)}` };
  }
  return { root, pretty };
}

export function jsonView(root, source) {
  const tree = el('div', 'json-tree');
  let count = 0;
  function value(node, key, depth) {
    if (++count > 3000)
      return el('div', 'render-note', '节点较多，请切换到源码或格式化视图继续查看。');
    const title = key === null ? '' : `${key}: `;
    if (node.type !== 'object' && node.type !== 'array') {
      const row = el('div', 'json-leaf');
      row.append(
        el('span', 'json-key', title),
        el(
          'span',
          `json-value json-${node.type}`,
          source.slice(node.offset, node.offset + node.length),
        ),
      );
      return row;
    }
    const details = el('details', 'json-branch');
    const summary = el('summary', '');
    const children = node.children || [];
    summary.append(
      el('span', 'json-key', title),
      el(
        'span',
        'json-count',
        node.type === 'array' ? `[${children.length} 项]` : `{${children.length} 项}`,
      ),
    );
    const list = el('div', 'json-children');
    details.append(summary, list);
    let offset = 0;
    function batch() {
      list.querySelector('.json-more')?.remove();
      const end = Math.min(offset + 100, children.length);
      for (; offset < end && count <= 3000; offset++) {
        const child = children[offset];
        const item = child.type === 'property' ? child.children[1] : child;
        const label =
          child.type === 'property' ? JSON.stringify(child.children[0].value) : String(offset);
        list.append(value(item, label, depth + 1));
      }
      if (offset < children.length && count <= 3000) {
        const more = el('button', 'json-more', `继续显示（剩余 ${children.length - offset} 项）`);
        more.addEventListener('click', batch);
        list.append(more);
      }
    }
    details.addEventListener('toggle', () => {
      if (details.open && !list.childElementCount) batch();
    });
    if (depth === 0) {
      batch();
      details.open = true;
    }
    return details;
  }
  tree.append(value(root, null, 0));
  return tree;
}

function escape(value) {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

export function localLink(raw, path) {
  let value = raw;
  let line = 0;
  const suffix = value.match(/(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?)$/);
  if (suffix) {
    line = Number(suffix[1] || suffix[2]);
    value = value.slice(0, -suffix[0].length);
  }
  if (value.startsWith('~/')) return { path: value, line };
  try {
    const base = new URL('file:///');
    base.pathname = path;
    const url = new URL(value, base);
    if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return null;
    return { path: decodeURIComponent(url.pathname), line };
  } catch (error) {
    if (error instanceof TypeError || error instanceof URIError) return null;
    throw error;
  }
}

export function markdownView(source, path, navigate) {
  const images = [];
  const parser = new Marked({ gfm: true, breaks: false });
  parser.use(markedKatex({ throwOnError: false, trust: false, maxExpand: 200, maxSize: 20 }));
  parser.use({
    renderer: {
      html(token) {
        return escape(token.text);
      },
      image(token) {
        const index = images.push({ href: token.href, alt: token.text }) - 1;
        return `<span class="markdown-image" data-image="${index}">${escape(token.text || '图片')}</span>`;
      },
    },
  });
  const article = el('article', 'markdown-view');
  article.innerHTML = DOMPurify.sanitize(parser.parse(source), {
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'img', 'video', 'audio'],
    FORBID_ATTR: ['src', 'srcset', 'formaction', 'action'],
    SANITIZE_NAMED_PROPS: true,
  });
  const names = new Map();
  for (const heading of article.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const slug =
      heading.textContent
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s+/g, '-') || 'heading';
    const count = names.get(slug) || 0;
    names.set(slug, count + 1);
    heading.id = `doc-${slug}${count ? `-${count}` : ''}`;
  }
  for (const input of article.querySelectorAll('input')) {
    input.type = 'checkbox';
    input.disabled = true;
  }
  for (const link of article.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    link.removeAttribute('target');
    if (/^https?:\/\//i.test(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else {
      link.removeAttribute('href');
      link.tabIndex = 0;
      const activate = () => {
        if (href.startsWith('#') && !/^#L\d/.test(href)) {
          let id;
          try {
            id = `doc-${decodeURIComponent(href.slice(1))}`;
          } catch (error) {
            if (error instanceof URIError) return;
            throw error;
          }
          article.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView({ block: 'start' });
          return;
        }
        const target = localLink(href, path);
        if (target) navigate(target.path, target.line);
      };
      link.addEventListener('click', activate);
      link.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') activate();
      });
    }
  }
  for (const code of article.querySelectorAll('pre > code')) {
    const language = [...code.classList].find((value) => value.startsWith('language-'))?.slice(9);
    const text = code.textContent;
    if (language !== 'mermaid') {
      const html = colored(text, language || 'plaintext');
      if (html !== null) code.innerHTML = html;
    }
    const copy = el('button', 'copy-code', '复制代码');
    copy.addEventListener('click', async () => {
      copy.textContent = (await copyText(text)) ? '已复制' : '请手动选择复制';
    });
    code.parentElement.append(copy);
  }
  return { article, images };
}
