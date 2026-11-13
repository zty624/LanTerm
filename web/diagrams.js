import mermaid from 'mermaid';
import DOMPurify from 'dompurify';
import { el } from './dom.js';

const settings = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  htmlLabels: false,
  maxTextSize: 20000,
  maxEdges: 300,
  fontFamily: 'system-ui, sans-serif',
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'maxTextSize',
    'maxEdges',
    'htmlLabels',
    'themeCSS',
  ],
};
let applied = null;
let sequence = 0;

// Follow the page theme at render time; diagrams are re-rendered per preview.
function configure() {
  const theme = document.documentElement.dataset.resolvedTheme === 'dark' ? 'dark' : 'neutral';
  if (applied === theme) return;
  mermaid.initialize({ ...settings, theme });
  applied = theme;
}

export async function renderDiagrams(article, alive) {
  configure();
  const blocks = [...article.querySelectorAll('code.language-mermaid')];
  if (blocks.length > 12)
    article.append(el('p', 'render-note', '仅渲染前 12 张图表，其余保留源码。'));
  for (const code of blocks.slice(0, 12)) {
    if (!alive()) return;
    const pre = code.parentElement;
    const source = code.textContent;
    const figure = el('figure', 'mermaid-figure');
    const status = el('p', 'render-note', '正在绘制图表…');
    const details = document.createElement('details');
    details.append(el('summary', '', '查看 Mermaid 源码'));
    pre.replaceWith(figure);
    figure.append(status, details);
    details.append(pre);
    if (source.length > 20000) {
      status.textContent = '图表过大，请查看源码。';
      details.open = true;
      continue;
    }
    try {
      const { svg } = await mermaid.render(`lt-diagram-${++sequence}`, source);
      if (!alive()) return;
      const view = el('div', 'mermaid-diagram');
      view.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['foreignObject', 'script'],
        FORBID_ATTR: ['href', 'xlink:href'],
      });
      status.replaceWith(view);
    } catch {
      if (!alive()) return;
      status.textContent = '图表语法无法解析，已保留源码。';
      details.open = true;
    }
  }
}
