import { $ } from './dom.js';
import {
  describe,
  languages,
  codeView,
  jsonDocument,
  jsonView,
  markdownView,
  localLink,
  copyText,
} from './text-renderers.js';

export class DeveloperPreview {
  constructor(navigate, read) {
    this.navigate = navigate;
    this.read = read;
    this.generation = 0;
    this.controller = null;
    this.data = null;
    this.matches = [];
    this.index = -1;
    $('preview-language').replaceChildren(
      new Option('自动识别', 'auto'),
      ...languages.map((item) => new Option(item.name, item.value)),
    );
    $('preview-mode').addEventListener('change', () => this.render());
    $('preview-language').addEventListener('change', () => this.render());
    $('preview-text-search').addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.search(), 120);
    });
    $('preview-text-search').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.step(event.shiftKey ? -1 : 1);
      }
    });
    $('preview-match-prev').addEventListener('click', () => this.step(-1));
    $('preview-match-next').addEventListener('click', () => this.step(1));
    $('preview-wrap').addEventListener('click', () => {
      const wrap = $('preview-wrap').getAttribute('aria-pressed') !== 'true';
      $('preview-wrap').setAttribute('aria-pressed', String(wrap));
      $('preview-content').classList.toggle('code-wrap', wrap);
    });
    $('preview-copy').addEventListener('click', async () => {
      if (!this.data) return;
      const current = this.generation;
      const copied = await copyText(this.data.content);
      if (current === this.generation)
        $('preview-copy').textContent = copied ? '已复制' : '请手动复制';
    });
    $('preview-expand-json').addEventListener('click', () => {
      for (const branch of [...$('preview-content').querySelectorAll('.json-branch')].filter(
        (node) => !node.open && node.getClientRects().length,
      ))
        branch.open = true;
    });
    $('preview-collapse-json').addEventListener('click', () => {
      for (const branch of $('preview-content').querySelectorAll('.json-branch'))
        branch.open = false;
    });
    $('preview-content').addEventListener(
      'toggle',
      (event) => {
        if (event.target.classList.contains('json-branch') && $('preview-text-search').value)
          queueMicrotask(() => {
            if (this.data) this.search();
          });
      },
      true,
    );
  }

  clear() {
    this.generation++;
    this.controller?.abort();
    clearTimeout(this.timer);
    this.data = null;
    this.matches = [];
    $('preview-text-tools').hidden = true;
    $('preview-render-note').hidden = true;
    $('preview-content').classList.remove('code-wrap');
  }

  show(data, line) {
    this.data = data;
    this.line = line;
    this.type = describe(data.path);
    this.json = null;
    this.problem = '';
    if (this.type.json && !data.truncated) {
      try {
        this.json = jsonDocument(data.content, this.type);
      } catch (error) {
        if (error instanceof RangeError) this.json = { error: 'JSON 嵌套过深，已切换到源码视图。' };
        else throw error;
      }
      if (this.json.error) this.problem = this.json.error;
    }
    const modes = [new Option('源码', 'source')];
    if (this.type.markdown) modes.unshift(new Option('Markdown 预览', 'markdown'));
    if (this.json && !this.json.error)
      modes.unshift(new Option('JSON 结构', 'tree'), new Option('格式化', 'pretty'));
    $('preview-mode').replaceChildren(...modes);
    $('preview-mode').value = line ? 'source' : modes[0].value;
    $('preview-language').value = 'auto';
    $('preview-text-search').value = '';
    $('preview-copy').textContent = '复制源码';
    $('preview-text-tools').hidden = false;
    $('preview-content').classList.toggle(
      'code-wrap',
      $('preview-wrap').getAttribute('aria-pressed') === 'true',
    );
    if (this.type.json)
      $('preview-kind').textContent = this.type.comments
        ? 'JSONC'
        : this.type.records
          ? 'JSONL'
          : 'JSON';
    else if (this.type.markdown) $('preview-kind').textContent = 'MD';
    else if (this.type.language !== 'plaintext')
      $('preview-kind').textContent = this.type.language.toUpperCase();
    this.render();
  }

  render() {
    if (!this.data) return;
    this.controller?.abort();
    this.controller = new AbortController();
    const generation = ++this.generation;
    const alive = () => generation === this.generation;
    const mode = $('preview-mode').value;
    const content = $('preview-content');
    content.replaceChildren();
    const code = mode === 'source' || mode === 'pretty';
    $('preview-language').hidden = !code;
    $('preview-wrap').hidden = !code;
    $('preview-expand-json').hidden = mode !== 'tree';
    $('preview-collapse-json').hidden = mode !== 'tree';
    let note = this.problem;
    if (mode === 'markdown') {
      const source = this.data.content.slice(0, 200000);
      const { article, images } = markdownView(source, this.data.path, this.navigate);
      content.append(article);
      if (source.length < this.data.content.length)
        note = 'Markdown 较大，仅渲染前 200,000 字符；源码视图可查看已读取的完整内容。';
      this.images(article, images, this.data.path, this.controller.signal, alive);
      if (article.querySelector('code.language-mermaid')) {
        import('./diagrams.js')
          .then((module) => {
            if (alive()) return module.renderDiagrams(article, alive);
          })
          .catch(() => {
            if (alive()) {
              $('preview-render-note').textContent = '图表组件加载失败，请切换源码查看。';
              $('preview-render-note').hidden = false;
            }
          });
      }
    } else if (mode === 'tree') {
      content.append(jsonView(this.json.root, this.data.content));
    } else {
      const source = mode === 'pretty' ? this.json.pretty : this.data.content;
      const language =
        $('preview-language').value === 'auto' ? this.type.language : $('preview-language').value;
      const view = codeView(source, language, mode === 'source' ? this.line : 0);
      content.append(view.node);
      if (view.clipped) note += `${note ? ' · ' : ''}仅显示前 5000 行`;
      if (view.plain) note += `${note ? ' · ' : ''}内容较大，已省略语法高亮`;
      if (mode === 'source' && this.line > view.lines)
        note += `${note ? ' · ' : ''}第 ${this.line} 行超出预览范围`;
      view.node.querySelector('.highlight')?.scrollIntoView({ block: 'center' });
    }
    $('preview-render-note').textContent = note;
    $('preview-render-note').hidden = !note;
    this.search();
  }

  async images(article, images, path, signal, alive) {
    for (const holder of [...article.querySelectorAll('[data-image]')].slice(0, 20)) {
      if (!alive()) return;
      const image = images[Number(holder.dataset.image)];
      if (!image) continue;
      const target = localLink(image.href, path);
      if (!target) {
        holder.textContent = `${image.alt || '图片'}（外部图片未加载）`;
        continue;
      }
      try {
        const data = await this.read(target.path, signal);
        if (!alive()) return;
        if (data.kind !== 'image') {
          holder.textContent = `${image.alt || '图片'}（格式不支持）`;
          continue;
        }
        const img = document.createElement('img');
        img.alt = image.alt;
        img.src = data.src;
        img.loading = 'lazy';
        holder.replaceWith(img);
      } catch (error) {
        if (!alive() || error.name === 'AbortError') return;
        holder.textContent = `${image.alt || '图片'}（无法读取）`;
      }
    }
  }

  search() {
    const content = $('preview-content');
    for (const node of content.querySelectorAll('.search-match, .search-current'))
      node.classList.remove('search-match', 'search-current');
    const query = $('preview-text-search').value.trim().toLocaleLowerCase();
    this.matches = query
      ? [
          ...content.querySelectorAll(
            '.file-line, .json-leaf, .json-branch > summary, .markdown-view h1, .markdown-view h2, .markdown-view h3, .markdown-view p, .markdown-view li, .markdown-view pre, .markdown-view tr',
          ),
        ].filter(
          (node) =>
            node.getClientRects().length && node.textContent.toLocaleLowerCase().includes(query),
        )
      : [];
    for (const node of this.matches) node.classList.add('search-match');
    this.index = -1;
    $('preview-match-count').textContent = query ? `0 / ${this.matches.length}` : '';
    $('preview-match-prev').disabled = !this.matches.length;
    $('preview-match-next').disabled = !this.matches.length;
    if (this.matches.length) this.step(1);
  }

  step(delta) {
    if (!this.matches.length) return;
    this.matches[this.index]?.classList.remove('search-current');
    this.index = (this.index + delta + this.matches.length) % this.matches.length;
    const match = this.matches[this.index];
    match.classList.add('search-current');
    match.scrollIntoView({ block: 'center' });
    $('preview-match-count').textContent = `${this.index + 1} / ${this.matches.length}`;
  }
}
