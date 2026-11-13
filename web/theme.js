// Appearance preferences live in this browser only. "system" follows prefers-color-scheme.
const query = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

const PALETTES = {
  dark: {
    background: '#1b1a18',
    foreground: '#e6e1d7',
    cursor: '#e8875a',
    cursorAccent: '#1b1a18',
    selectionBackground: '#8a6a5266',
    black: '#2b2926',
    red: '#e4766d',
    green: '#9cc48a',
    yellow: '#e2b866',
    blue: '#7ea8dd',
    magenta: '#c69bd8',
    cyan: '#74c2bd',
    white: '#d6d0c4',
    brightBlack: '#7d776c',
    brightRed: '#f0958c',
    brightGreen: '#b5d9a4',
    brightYellow: '#efcd8a',
    brightBlue: '#9fc0ec',
    brightMagenta: '#dab6e8',
    brightCyan: '#98d6d1',
    brightWhite: '#f5f1e8',
  },
  light: {
    background: '#fbfaf6',
    foreground: '#2b2824',
    cursor: '#c4552d',
    cursorAccent: '#fbfaf6',
    selectionBackground: '#e3b9a466',
    black: '#2b2824',
    red: '#b8382f',
    green: '#3f7a3a',
    yellow: '#9a6a00',
    blue: '#2f62a6',
    magenta: '#8a4fa3',
    cyan: '#1f7a78',
    white: '#6f6a61',
    brightBlack: '#77716a',
    brightRed: '#d24a3f',
    brightGreen: '#4f9446',
    brightYellow: '#b07d0a',
    brightBlue: '#3b76c4',
    brightMagenta: '#a061bd',
    brightCyan: '#2a918e',
    brightWhite: '#8c867b',
  },
};

function read(key, allowed) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : allowed[0];
  } catch {
    return allowed[0];
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the choice still applies to this page.
  }
}

export const theme = {
  mode: read('lt-theme', ['system', 'light', 'dark']),
  terminal: read('lt-terminal-theme', ['auto', 'dark']),

  resolved() {
    if (this.mode === 'system') return query.matches ? 'dark' : 'light';
    return this.mode;
  },

  terminalPalette() {
    return PALETTES[this.terminal === 'dark' ? 'dark' : this.resolved()];
  },

  apply() {
    const root = document.documentElement;
    if (this.mode === 'system') delete root.dataset.theme;
    else root.dataset.theme = this.mode;
    const resolved = this.resolved();
    root.dataset.resolvedTheme = resolved;
    root.dataset.terminalTheme = this.terminal === 'dark' ? 'dark' : resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', resolved === 'dark' ? '#1b1a18' : '#f7f5f0');
    for (const listener of listeners) listener(resolved);
  },

  set(mode) {
    this.mode = mode;
    write('lt-theme', mode);
    this.apply();
  },

  setTerminal(value) {
    this.terminal = value;
    write('lt-terminal-theme', value);
    this.apply();
  },

  subscribe(listener) {
    listeners.add(listener);
  },
};

query.addEventListener('change', () => {
  if (theme.mode === 'system') theme.apply();
});
theme.apply();
