import { el } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
const W = 1000;
const H = 100;
const PAD = 6;

export const clock = (seconds) =>
  new Date(seconds * 1000).toLocaleTimeString([], { hour12: false });

// Round a scale maximum up to 1 / 2 / 5 × 10ⁿ so axis labels stay clean.
export function nice(value) {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].find((step) => step * power >= value) * power;
}

// Area (one series) or lines (two series) over a fixed time window, with a crosshair
// readout on hover and keyboard focus. Series colours come from CSS slots.
export class TrendChart {
  constructor({ label, series, format, scale, round, compact, legend }) {
    this.label = label;
    this.series = series;
    this.format = format;
    // Axis labels are rounded; readouts keep full precision.
    this.scaleFormat = scale || format;
    this.round = round || nice;
    this.compact = compact;
    this.window = 360;
    this.points = [];
    this.max = 1;
    this.index = -1;
    this.node = el('div', `trend${compact ? ' compact' : ''}`);
    this.node.setAttribute('role', 'img');
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'sparkline');
    svg.setAttribute('aria-hidden', 'true');
    const line = (y) => {
      const rule = document.createElementNS(NS, 'line');
      rule.setAttribute('x1', '0');
      rule.setAttribute('x2', String(W));
      rule.setAttribute('y1', String(y));
      rule.setAttribute('y2', String(y));
      rule.setAttribute('class', 'trend-rule');
      return rule;
    };
    if (!compact) svg.append(line(PAD), line(H / 2));
    svg.append(line(H - 0.5));
    this.marks = series.map((item) => {
      const area = document.createElementNS(NS, 'path');
      area.setAttribute('class', 'trend-area');
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('class', 'trend-line');
      for (const node of [area, path]) node.dataset.slot = item.slot;
      // Two series overlap; a wash under each would muddy both, so only one series gets it.
      if (series.length === 1) svg.append(area);
      svg.append(path);
      const dot = el('span', 'trend-dot');
      dot.dataset.slot = item.slot;
      return { area, path, dot };
    });
    this.cursor = el('span', 'trend-cursor');
    this.tip = el('div', 'trend-tip');
    this.scale = el('span', 'trend-scale');
    this.cursor.hidden = this.tip.hidden = true;
    this.node.append(svg, ...this.marks.map((mark) => mark.dot), this.cursor, this.tip);
    if (compact) return;
    this.node.append(this.scale);
    if (legend) {
      // Charts without value rows beside them carry their own legend.
      const keys = el('div', 'trend-legend');
      for (const item of series) {
        const key = el('span', 'legend-key');
        key.dataset.slot = item.slot;
        const entry = el('span', '');
        entry.append(key, document.createTextNode(item.label));
        keys.append(entry);
      }
      this.node.append(keys);
    }
    this.node.tabIndex = 0;
    this.node.addEventListener('pointermove', (event) => this.show(this.locate(event.clientX)));
    this.node.addEventListener('pointerleave', () => {
      if (document.activeElement !== this.node) this.hide();
    });
    this.node.addEventListener('focus', () => this.show(this.points.length - 1));
    this.node.addEventListener('blur', () => this.hide());
    this.node.addEventListener('keydown', (event) => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
      if (event.key === 'Home') this.show(0);
      else if (event.key === 'End') this.show(this.points.length - 1);
      else if (step) this.show(Math.max(0, Math.min(this.points.length - 1, this.index + step)));
      else return;
      event.preventDefault();
    });
  }

  x(point) {
    return W - ((this.end - point.timestamp) / this.window) * W;
  }

  y(value) {
    return H - PAD / 2 - Math.min(1, Math.max(0, value / this.max)) * (H - PAD * 1.5);
  }

  update(points, max) {
    this.end = points.at(-1)?.timestamp ?? 0;
    this.points = points.filter((point) => point.timestamp >= this.end - this.window);
    const peak = Math.max(
      0,
      ...this.points.flatMap((point) =>
        this.series.map((item) => point.values[item.key]).filter(Number.isFinite),
      ),
    );
    this.max = max || this.round(peak * 1.1);
    this.marks.forEach((mark, index) => {
      const key = this.series[index].key;
      // Missing samples (warm-up, failed reads) break the line instead of bridging it.
      const segments = [];
      let run = [];
      for (const point of this.points) {
        if (Number.isFinite(point.values[key])) run.push(point);
        else if (run.length) {
          segments.push(run);
          run = [];
        }
      }
      if (run.length) segments.push(run);
      const coords = (part) =>
        part.map((p) => `${this.x(p).toFixed(1)},${this.y(p.values[key]).toFixed(1)}`);
      mark.path.setAttribute('d', segments.map((part) => `M${coords(part).join('L')}`).join(''));
      mark.area.setAttribute(
        'd',
        segments
          .map(
            (part) =>
              `M${this.x(part[0]).toFixed(1)},${H}L${coords(part).join('L')}L${this.x(part.at(-1)).toFixed(1)},${H}Z`,
          )
          .join(''),
      );
      const last = segments.at(-1)?.at(-1);
      mark.dot.hidden = !last;
      if (last) {
        mark.dot.style.left = `${(this.x(last) / W) * 100}%`;
        mark.dot.style.top = `${(this.y(last.values[key]) / H) * 100}%`;
      }
    });
    this.scale.textContent = peak > 0 || max ? this.scaleFormat(this.max) : '';
    const latest = this.points.at(-1);
    this.node.setAttribute(
      'aria-label',
      `${this.label}，最近 6 分钟${latest ? `，当前 ${this.series.map((item) => `${item.label} ${this.format(latest.values[item.key])}`).join('，')}` : '，暂无数据'}`,
    );
    if (this.index >= 0) this.show(Math.min(this.index, this.points.length - 1));
  }

  locate(clientX) {
    const box = this.node.getBoundingClientRect();
    const time = this.end - (1 - (clientX - box.left) / box.width) * this.window;
    let best = -1;
    let distance = Infinity;
    this.points.forEach((point, index) => {
      const gap = Math.abs(point.timestamp - time);
      if (gap < distance) [best, distance] = [index, gap];
    });
    return best;
  }

  show(index) {
    const point = this.points[index];
    if (!point) return this.hide();
    this.index = index;
    const left = (this.x(point) / W) * 100;
    this.cursor.style.left = `${left}%`;
    this.cursor.hidden = false;
    const rows = this.series.map((item) => {
      const row = el('div', 'trend-row');
      const key = el('span', 'legend-key');
      key.dataset.slot = item.slot;
      row.append(key, el('strong', '', this.format(point.values[item.key])));
      if (this.series.length > 1) row.append(el('span', '', item.label));
      return row;
    });
    this.tip.replaceChildren(el('span', 'trend-time', clock(point.timestamp)), ...rows);
    this.tip.style.left = `${left}%`;
    this.tip.classList.toggle('flip', left > 55);
    this.tip.hidden = false;
  }

  hide() {
    this.index = -1;
    this.cursor.hidden = this.tip.hidden = true;
  }
}
