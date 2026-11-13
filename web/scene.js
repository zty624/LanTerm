// The login backdrop: an ASCII landscape — ridgelines, mist, a shaded moon over a lake —
// with pixel sky lanterns rising from the water. Night in the dark theme, ink-wash dawn in
// the light one. Static layers are painted once per resize; only light and water move.
const FONT = '12px "JetBrains Mono", "Cascadia Code", "DejaVu Sans Mono", ui-monospace, monospace';
const ROW = 15;
const SHADE = ' .:-=+*#%@';
const MIST = ['.', '·', '-', '~'];
const STARS = ['.', '·', '+', '*'];
// A paper sky lantern: rounded top, lit paper, the flame under its open base.
const SPRITE = ['.rrrr.', 'rRRRRr', 'rROORr', 'rOyyOr', 'rOyyOr', '.rOOr.', '..yy..'];
const SPRITE_COLORS = { r: '#8f2419', R: '#d23f2c', O: '#ec6a3f', y: '#ffc46b' };
const PALETTES = {
  dark: {
    sky: ['#0d0c0b', '#171411', '#231a14'],
    star: '#f3e6c4',
    orb: [240, 227, 191],
    orbChars: SHADE,
    mist: '#3a342e',
    hills: [
      { fill: '#16141280', ink: '#4d463e', dots: '#2e2b27' },
      { fill: '#1a1816', ink: '#615950', dots: '#36322d' },
      { fill: '#1f1c19', ink: '#7a7063', dots: '#403a34' },
    ],
    water: '#141414',
    ripple: '#36404a',
    glow: [255, 150, 70],
    blend: 'lighter',
    halo: 0.4,
  },
  light: {
    sky: ['#faf8f3', '#f5f0e7', '#efe6d8'],
    star: null,
    orb: [228, 128, 86],
    orbChars: ' ..·:',
    mist: '#ddd5c6',
    hills: [
      { fill: '#efe9df99', ink: '#c2b9a7', dots: '#ded7c9' },
      { fill: '#e9e3d7', ink: '#a69c89', dots: '#d3cab9' },
      { fill: '#e1d9cb', ink: '#857b6a', dots: '#c6bdab' },
    ],
    water: '#ebe4d9',
    ripple: '#b3bbbf',
    glow: [236, 106, 63],
    blend: 'source-over',
    halo: 0.22,
  },
};

function hash(x, y) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise(x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const u = (x - xi) ** 2 * (3 - 2 * (x - xi));
  const v = (y - yi) ** 2 * (3 - 2 * (y - yi));
  const a = hash(xi, yi);
  const b = hash(xi + 1, yi);
  const c = hash(xi, yi + 1);
  const d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y) {
  return noise(x, y) * 0.6 + noise(x * 2.1, y * 2.1) * 0.28 + noise(x * 4.3, y * 4.3) * 0.12;
}

// Ridged noise folds the smooth hills into sharper peaks.
function ridged(x, y) {
  return 1 - Math.abs(2 * noise(x, y) - 1);
}

function layer() {
  const canvas = document.createElement('canvas');
  return { canvas, ctx: canvas.getContext('2d') };
}

function prepare(ctx, dpr) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = FONT;
  ctx.textBaseline = 'top';
}

export class LoginScene {
  constructor(canvas, resolvedTheme) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.theme = resolvedTheme;
    this.still = matchMedia('(prefers-reduced-motion: reduce)');
    this.sky = layer();
    this.hills = layer();
    this.mist = layer();
    this.water = layer();
    this.lanterns = [];
    this.running = false;
    this.last = 0;
    this.slow = -1;
    this.raf = 0;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.still.addEventListener('change', () => {
      if (this.running) this.start();
    });
  }

  palette() {
    return PALETTES[this.theme] || PALETTES.dark;
  }

  setTheme(resolvedTheme) {
    this.theme = resolvedTheme;
    this.paint();
  }

  start() {
    this.running = true;
    cancelAnimationFrame(this.raf);
    if (!this.cols) this.resize();
    if (this.still.matches) this.draw(performance.now());
    else this.raf = requestAnimationFrame((time) => this.tick(time));
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  resize() {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (!width || !height) return;
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.width = width;
    this.height = height;
    for (const target of [
      this.canvas,
      this.sky.canvas,
      this.hills.canvas,
      this.mist.canvas,
      this.water.canvas,
    ]) {
      target.width = Math.round(width * this.dpr);
      target.height = Math.round(height * this.dpr);
    }
    this.ctx.font = FONT;
    this.cell = Math.ceil(this.ctx.measureText('M').width) || 8;
    this.cols = Math.ceil(width / this.cell) + 1;
    this.rows = Math.ceil(height / ROW) + 1;
    this.waterRow = Math.round(this.rows * 0.8);
    this.orb = {
      x: width * (width > 760 ? 0.76 : 0.7),
      y: height * 0.2,
      r: Math.max(46, Math.min(128, Math.min(width, height) * 0.13)),
    };
    // Three ridgelines, far to near: each column's crest row.
    const shape = [
      { base: 0.54, lift: 0.26, freq: 0.028 },
      { base: 0.64, lift: 0.19, freq: 0.05 },
      { base: 0.74, lift: 0.12, freq: 0.085 },
    ];
    this.ridges = shape.map(({ base, lift, freq }, depth) =>
      Array.from({ length: this.cols }, (_, col) => {
        const x = col * freq + depth * 23.7;
        const elevation = 0.55 * fbm(x, depth * 3.1) + 0.45 * ridged(x * 1.7, depth * 5.3);
        return Math.round(this.rows * (base - lift * elevation));
      }),
    );
    this.stars = [];
    for (let row = 0; row < this.waterRow; row++)
      for (let col = 0; col < this.cols; col++)
        if (row < this.ridges[0][col] - 1 && hash(col * 7 + 3, row * 13 + 5) < 0.02)
          this.stars.push({
            col,
            row,
            char: STARS[Math.floor(hash(col, row) * 4)],
            phase: hash(row, col) * 6.28,
          });
    const count = Math.max(7, Math.min(18, Math.round((width * height) / 70000)));
    while (this.lanterns.length < count) this.lanterns.push(this.spawn(true));
    this.lanterns.length = count;
    this.paint();
  }

  spawn(anywhere) {
    const depth = 0.2 + Math.random() * 0.8;
    const waterline = (this.waterRow || 40) * ROW;
    return {
      depth,
      x: Math.random() * (this.width || 1200),
      y: anywhere ? Math.random() * waterline : waterline - 6 + Math.random() * 8,
      speed: 4 + depth * 15,
      sway: Math.random() * 6.28,
      flicker: Math.random() * 6.28,
    };
  }

  // Static layers: sky with the moon (or dawn sun), and the ridgelines.
  paint() {
    if (!this.cols) return;
    const palette = this.palette();
    const { ctx: sky } = this.sky;
    prepare(sky, this.dpr);
    const gradient = sky.createLinearGradient(0, 0, 0, this.height);
    palette.sky.forEach((color, index) => gradient.addColorStop(index / 2, color));
    sky.fillStyle = gradient;
    sky.fillRect(0, 0, this.width, this.height);
    this.paintOrb(sky, palette);
    const { ctx } = this.hills;
    prepare(ctx, this.dpr);
    ctx.clearRect(0, 0, this.width, this.height);
    // Crest strokes per ridge, joining steep steps with stacked slashes.
    const strokes = this.ridges.map((crest) => {
      const marks = new Map();
      crest.forEach((top, col) => {
        const left = crest[col - 1] ?? top;
        const right = crest[col + 1] ?? top;
        const peak = left > top && right > top;
        marks.set(`${col}:${top}`, peak ? '^' : right < left ? '/' : right > left ? '\\' : '_');
        for (let row = top + 1; row < left; row++) marks.set(`${col}:${row}`, '/');
        for (let row = top + 1; row < right; row++) marks.set(`${col}:${row}`, '\\');
      });
      return marks;
    });
    for (let col = 0; col < this.cols; col++) {
      const x = col * this.cell;
      for (let row = 0; row < this.waterRow; row++) {
        // The nearest ridge whose crest is above this cell owns it.
        let depth = -1;
        for (let index = 2; index >= 0; index--)
          if (row >= this.ridges[index][col]) {
            depth = index;
            break;
          }
        if (depth < 0) continue;
        const style = palette.hills[depth];
        ctx.fillStyle = style.fill;
        ctx.fillRect(x, row * ROW, this.cell, ROW);
        const stroke = strokes[depth].get(`${col}:${row}`);
        if (stroke) {
          ctx.fillStyle = style.ink;
          ctx.fillText(stroke, x, row * ROW);
        } else if (hash(col * 3 + depth, row * 5) < 0.14 + depth * 0.08) {
          ctx.fillStyle = style.dots;
          ctx.fillText(row - this.ridges[depth][col] < 3 ? ':' : '.', x, row * ROW);
        }
      }
    }
    this.slow = -1;
    if (!this.running || this.still.matches) this.draw(performance.now());
  }

  // A sphere shaded in ASCII: lit from the upper left, so the night moon is a crescent.
  paintOrb(ctx, palette) {
    const { x, y, r } = this.orb;
    const [red, green, blue] = palette.orb;
    const halo = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 3.2);
    halo.addColorStop(0, `rgb(${red} ${green} ${blue} / ${this.theme === 'dark' ? 0.09 : 0.14})`);
    halo.addColorStop(1, `rgb(${red} ${green} ${blue} / 0)`);
    ctx.fillStyle = halo;
    ctx.fillRect(x - r * 3.2, y - r * 3.2, r * 6.4, r * 6.4);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${red} ${green} ${blue} / ${this.theme === 'dark' ? 0.05 : 0.2})`;
    ctx.fill();
    const light = this.theme === 'dark' ? [-0.78, -0.32, 0.53] : [0, 0, 1];
    const chars = palette.orbChars;
    for (let row = Math.floor((y - r) / ROW); row <= Math.ceil((y + r) / ROW); row++)
      for (
        let col = Math.floor((x - r) / this.cell);
        col <= Math.ceil((x + r) / this.cell);
        col++
      ) {
        const dx = (col * this.cell + this.cell / 2 - x) / r;
        const dy = (row * ROW + ROW / 2 - y) / r;
        const inside = 1 - dx * dx - dy * dy;
        if (inside <= 0) continue;
        const dz = Math.sqrt(inside);
        let lit = Math.max(0, dx * light[0] + dy * light[1] + dz * light[2]);
        lit *= 0.78 + 0.22 * noise(dx * 3 + 11, dy * 3 + 7);
        const char = chars[Math.min(chars.length - 1, Math.floor(lit * chars.length))];
        // The dawn sun is ink wash: a mottled texture, not a halftone grid.
        if (char === ' ' || (this.theme !== 'dark' && hash(col * 5, row * 11) > 0.42)) continue;
        ctx.fillStyle = `rgb(${red} ${green} ${blue} / ${this.theme === 'dark' ? 0.4 + 0.6 * lit : 0.25 + 0.3 * lit})`;
        ctx.fillText(char, col * this.cell, row * ROW);
      }
  }

  // Mist and water change slowly; redraw them a few times a second.
  paintSlow(time) {
    const palette = this.palette();
    const t = time / 1000;
    const { ctx: mist } = this.mist;
    prepare(mist, this.dpr);
    mist.clearRect(0, 0, this.width, this.height);
    mist.fillStyle = palette.mist;
    for (let row = Math.round(this.rows * 0.32); row < this.waterRow; row++) {
      const band = Math.max(0, 1 - Math.abs(row / this.rows - 0.6) * 3);
      for (let col = 0; col < this.cols; col++) {
        const value = fbm(col * 0.045 + t * 0.05, row * 0.16 - t * 0.01) * band;
        if (value > 0.42)
          mist.fillText(
            MIST[Math.min(3, Math.floor((value - 0.42) * 18))],
            col * this.cell,
            row * ROW,
          );
      }
    }
    const { ctx: water } = this.water;
    prepare(water, this.dpr);
    water.clearRect(0, 0, this.width, this.height);
    water.fillStyle = palette.water;
    water.fillRect(0, this.waterRow * ROW, this.width, this.height);
    const [red, green, blue] = palette.orb;
    const center = this.orb.x / this.cell;
    const depth = this.rows - this.waterRow + 2;
    for (let row = this.waterRow; row < this.rows; row++) {
      const below = row - this.waterRow;
      const fade = 1 - below / depth;
      const spread = 2 + below * 0.9;
      for (let col = 0; col < this.cols; col++) {
        const wave = noise(col * 0.18 + t * 0.7 * (row % 2 ? 1 : -1), row * 0.9 + t * 0.2);
        const path = Math.max(0, 1 - Math.abs(col - center) / spread);
        // The moon's path: a shimmering column of light on the lake.
        if (path > 0 && wave > 0.38) {
          water.fillStyle = `rgb(${red} ${green} ${blue} / ${0.7 * path * (0.4 + 0.6 * fade)})`;
          water.fillText(wave > 0.6 ? '~' : '-', col * this.cell, row * ROW);
        } else if (wave > 0.7) {
          water.fillStyle = palette.ripple;
          water.globalAlpha = 0.3 + 0.6 * fade;
          water.fillText(wave > 0.76 ? '~' : '-', col * this.cell, row * ROW);
          water.globalAlpha = 1;
        }
      }
    }
  }

  tick(time) {
    if (!this.running) return;
    this.raf = requestAnimationFrame((next) => this.tick(next));
    if (document.hidden || time - this.last < 33) return;
    const elapsed = this.last ? Math.min(0.1, (time - this.last) / 1000) : 0;
    this.last = time;
    for (const lantern of this.lanterns) {
      lantern.y -= lantern.speed * elapsed;
      lantern.x += Math.sin(time / 1700 + lantern.sway) * 0.14 * lantern.depth;
      if (lantern.y < -48) Object.assign(lantern, this.spawn(false));
    }
    this.draw(time);
  }

  draw(time) {
    if (!this.cols) return;
    const palette = this.palette();
    if (this.slow < 0 || time - this.slow > 120) {
      this.paintSlow(time);
      this.slow = time;
    }
    const ctx = this.ctx;
    const t = time / 1000;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.sky.canvas, 0, 0);
    if (palette.star) {
      prepare(ctx, this.dpr);
      ctx.fillStyle = palette.star;
      for (const star of this.stars) {
        ctx.globalAlpha = 0.12 + 0.6 * Math.abs(Math.sin(t * 0.7 + star.phase));
        ctx.fillText(star.char, star.col * this.cell, star.row * ROW);
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.drawImage(this.mist.canvas, 0, 0);
    ctx.drawImage(this.hills.canvas, 0, 0);
    ctx.drawImage(this.water.canvas, 0, 0);
    prepare(ctx, this.dpr);
    const waterline = this.waterRow * ROW;
    const [r, g, b] = palette.glow;
    // Far lanterns first so nearer ones overlap them.
    for (const lantern of [...this.lanterns].sort((one, two) => one.depth - two.depth)) {
      const size = Math.round(2 + lantern.depth * 3);
      const span = size * 6;
      const x = Math.round(lantern.x - span / 2);
      const y = Math.round(lantern.y);
      const flicker =
        0.82 + 0.18 * Math.sin(t * 7 + lantern.flicker) * Math.sin(t * 3.1 + lantern.flicker);
      const cx = x + span / 2;
      const cy = y + span * 0.6;
      const radius = span * 2;
      ctx.globalCompositeOperation = palette.blend;
      const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      halo.addColorStop(
        0,
        `rgb(${r} ${g} ${b} / ${palette.halo * (0.4 + 0.6 * lantern.depth) * flicker})`,
      );
      halo.addColorStop(1, `rgb(${r} ${g} ${b} / 0)`);
      ctx.fillStyle = halo;
      ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
      // Its reflection: a wavering streak on the lake, brighter as it nears the water.
      if (y < waterline) {
        const strength = Math.max(0, 1 - (waterline - y) / (this.height * 0.75)) * lantern.depth;
        const reach = 3 + lantern.depth * 6;
        for (let row = this.waterRow; row < this.rows && row < this.waterRow + reach; row++) {
          const fade = 1 - (row - this.waterRow) / reach;
          ctx.fillStyle = `rgb(${r} ${g} ${b} / ${0.6 * strength * fade * flicker})`;
          const wobble = Math.round(Math.sin(t * 2 + row + lantern.flicker) * 0.6);
          ctx.fillText(
            row % 2 ? '¦' : '|',
            Math.floor(cx / this.cell + wobble) * this.cell,
            row * ROW,
          );
        }
      }
      ctx.globalCompositeOperation = 'source-over';
      SPRITE.forEach((line, py) =>
        [...line].forEach((code, px) => {
          if (code === '.') return;
          ctx.globalAlpha = code === 'y' || code === 'O' ? flicker : 1;
          ctx.fillStyle = SPRITE_COLORS[code];
          ctx.fillRect(x + px * size, y + py * size, size, size);
        }),
      );
      ctx.globalAlpha = 1;
    }
  }
}
