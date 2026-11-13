// Pixel art drawn as crisp SVG rects. Rows are static strings; nothing here takes user data.
const NS = 'http://www.w3.org/2000/svg';

// A paper lantern lit from inside: gold caps, curved ribs, a warm core, a knotted tassel.
const LANTERN = [
  '........kkkk........',
  '........kkkk........',
  '......dGGGGGGd......',
  '.....dGggggggGd.....',
  '....rrrrRRRRrrrr....',
  '...rRRrRROORRrRRr...',
  '..rRLrRROOOORRrRRr..',
  '.rRLRrROOyyOORrRRRr.',
  '.rRLRrROyyyyORrRRRr.',
  'rRLRRrROyyyyORrRRRRr',
  'rRLRRrROyyyyORrRRRRr',
  'rRRRRrROyyyyORrRRRRr',
  'rRRRRrROOyyOORrRRRRr',
  '.rRRRrRROOOORRrRRRr.',
  '.rRRRrRRROORRRrRRRr.',
  '..rRRrRRRRRRRRrRRr..',
  '...rRrRRRRRRRRrRr...',
  '....rrrrRRRRrrrr....',
  '.....dGggggggGd.....',
  '......dGGGGGGd......',
  '.........kk.........',
  '........dGGd........',
  '........tTTt........',
  '.......tttttt.......',
  '.......t.tt.t.......',
  '.......t.tt.t.......',
  '......t..tt..t......',
];
const LANTERN_COLORS = {
  k: '#6b4423',
  d: '#a8701f',
  G: '#e0a83a',
  g: '#f6cf6a',
  r: '#8f2419',
  R: '#d23f2c',
  O: '#ec6a3f',
  y: '#ffc46b',
  L: '#f58a6c',
  t: '#c8372a',
  T: '#8f2419',
};
// Core pixels flicker like a flame behind paper.
const LIT = { y: 'core', O: 'glow' };

function svg(width, height, className) {
  const node = document.createElementNS(NS, 'svg');
  node.setAttribute('viewBox', `0 0 ${width} ${height}`);
  node.setAttribute('class', className);
  node.setAttribute('shape-rendering', 'crispEdges');
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  return node;
}

function rect(x, y, size, inset) {
  const node = document.createElementNS(NS, 'rect');
  node.setAttribute('x', String(x + inset));
  node.setAttribute('y', String(y + inset));
  node.setAttribute('width', String(size - inset * 2));
  node.setAttribute('height', String(size - inset * 2));
  return node;
}

export function lantern() {
  const node = svg(LANTERN[0].length, LANTERN.length, 'pixel-lantern');
  LANTERN.forEach((row, y) =>
    [...row].forEach((code, x) => {
      if (code === '.') return;
      const pixel = rect(x, y, 1, 0);
      pixel.setAttribute('fill', LANTERN_COLORS[code]);
      if (LIT[code]) pixel.setAttribute('class', LIT[code]);
      node.append(pixel);
    }),
  );
  return node;
}

// Replace <span data-pixel="lantern"> placeholders written in index.html.
export function hydratePixels(root) {
  for (const slot of root.querySelectorAll('[data-pixel="lantern"]')) {
    const art = lantern();
    for (const name of slot.classList) art.classList.add(name);
    slot.replaceWith(art);
  }
}
