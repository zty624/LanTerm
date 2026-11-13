import { $, el } from './dom.js';
import { icon } from './icons.js';

const BUSY = new Set(['working', 'starting']);
const READY = new Set(['waiting_input', 'interrupted']);

function stored(key) {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Storage may be unavailable; the toggle still applies until reload.
  }
}

// Turns agent status transitions into "needs you" / "finished" alerts for sessions
// the user is not currently looking at.
export class Attention {
  constructor(sessions, active, select) {
    this.sessions = sessions;
    this.active = active;
    this.select = select;
    this.states = new Map();
    this.flags = new Map();
    this.primed = false;
    this.base = 'LanTerm';
    this.desktop = stored('lt-notify-desktop') && this.canNotify();
    this.sound = stored('lt-notify-sound');
    this.audio = null;
    this.favicon = document.querySelector('link[rel="icon"]');
    this.plainIcon = this.favicon?.href;
    this.badgeIcon = null;
  }

  canNotify() {
    return window.isSecureContext && 'Notification' in window;
  }

  background() {
    return this.desktop || this.sound;
  }

  async setDesktop(enabled) {
    if (enabled) {
      if (!this.canNotify()) throw new Error('桌面通知需要 HTTPS 或 localhost 访问');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('浏览器未授予通知权限');
    }
    this.desktop = enabled;
    store('lt-notify-desktop', enabled);
  }

  setSound(enabled) {
    this.sound = enabled;
    store('lt-notify-sound', enabled);
    if (enabled) this.chime('done');
  }

  reset() {
    this.states.clear();
    this.flags.clear();
    this.primed = false;
    $('notices').replaceChildren();
    this.sync();
  }

  viewing(sid) {
    return sid === this.active() && document.visibilityState === 'visible' && document.hasFocus();
  }

  update(data) {
    const seen = new Set();
    for (const [sid, badges] of Object.entries(data)) {
      for (const badge of badges) {
        const key = `${sid}|${badge.pane}|${badge.plugin}|${badge.pid}`;
        const previous = this.states.get(key);
        this.states.set(key, badge.state);
        seen.add(key);
        if (!this.primed || previous === badge.state) continue;
        if (badge.state === 'needs_attention') this.raise(sid, 'needs', badge);
        else if (READY.has(badge.state) && BUSY.has(previous)) this.raise(sid, 'done', badge);
      }
    }
    for (const key of this.states.keys()) if (!seen.has(key)) this.states.delete(key);
    for (const [sid, flag] of this.flags) {
      const live = data[sid] || [];
      if (flag === 'needs' && !live.some((badge) => badge.state === 'needs_attention'))
        this.flags.set(sid, 'done');
      if (!this.sessions().some((item) => item.id === sid)) this.flags.delete(sid);
    }
    this.primed = true;
    this.sync();
  }

  raise(sid, kind, badge) {
    if (this.viewing(sid)) return;
    if (kind === 'needs' || this.flags.get(sid) !== 'needs') this.flags.set(sid, kind);
    const item = this.sessions().find((session) => session.id === sid);
    const name = item?.name || '会话';
    const detail = `${badge.name} · ${kind === 'needs' ? badge.label : '已完成，等待输入'}`;
    this.notice(sid, kind, name, detail);
    if (this.sound) this.chime(kind);
    if (this.desktop && document.visibilityState !== 'visible') {
      const notification = new Notification(`${name} — ${detail}`, {
        body: kind === 'needs' ? '打开 LanTerm 查看并处理' : '点击回到这个会话',
        tag: `lanterm-${sid}`,
        icon: 'static/lantern.svg',
      });
      notification.onclick = () => {
        window.focus();
        this.select(sid);
        notification.close();
      };
    }
  }

  notice(sid, kind, name, detail) {
    const stack = $('notices');
    stack.querySelector(`[data-sid="${CSS.escape(sid)}"]`)?.remove();
    const card = el('div', 'notice');
    card.dataset.sid = sid;
    card.dataset.kind = kind;
    card.setAttribute('role', 'status');
    const text = el('div', '');
    text.append(el('strong', '', name), el('span', '', detail));
    const close = el('button', 'icon-button');
    close.setAttribute('aria-label', '关闭提醒');
    close.append(icon('x'));
    close.addEventListener('click', () => card.remove());
    const actions = el('div', 'notice-actions');
    const open = el('button', kind === 'needs' ? 'primary' : '', '查看会话');
    open.addEventListener('click', () => {
      card.remove();
      this.select(sid);
    });
    actions.append(open);
    card.append(icon(kind === 'needs' ? 'bell' : 'check'), text, close, actions);
    stack.prepend(card);
    while (stack.childElementCount > 4) stack.lastElementChild.remove();
    setTimeout(() => card.remove(), kind === 'needs' ? 30000 : 10000);
  }

  chime(kind) {
    try {
      this.audio ||= new AudioContext();
      const context = this.audio;
      const start = context.currentTime + 0.02;
      const notes = kind === 'needs' ? [784, 988] : [659];
      notes.forEach((frequency, index) => {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        const at = start + index * 0.16;
        oscillator.type = 'sine';
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.07, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.32);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.34);
      });
    } catch (error) {
      console.warn('LanTerm chime unavailable', error);
    }
  }

  // The user opened this session, or returned to the page while it was active.
  seen(sid, explicit) {
    if (!sid || (!explicit && !this.viewing(sid))) return;
    $('notices')
      .querySelector(`[data-sid="${CSS.escape(sid)}"]`)
      ?.remove();
    if (this.flags.delete(sid)) this.sync();
  }

  title(base) {
    this.base = base;
    const count = this.flags.size;
    document.title = count ? `(${count}) ${base}` : base;
  }

  sync() {
    for (const item of document.querySelectorAll('.session-item[data-session-id]')) {
      const flag = this.flags.get(item.dataset.sessionId);
      if (flag) item.dataset.attention = flag;
      else delete item.dataset.attention;
    }
    this.title(this.base);
    this.icon(this.flags.size > 0);
  }

  icon(alert) {
    if (!this.favicon || !this.plainIcon) return;
    if (!alert) {
      if (this.favicon.href !== this.plainIcon) this.favicon.href = this.plainIcon;
      return;
    }
    if (this.badgeIcon) {
      this.favicon.href = this.badgeIcon;
      return;
    }
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, 64, 64);
      context.beginPath();
      context.arc(50, 14, 12, 0, Math.PI * 2);
      context.fillStyle = '#c4552d';
      context.fill();
      context.lineWidth = 4;
      context.strokeStyle = '#ffffff';
      context.stroke();
      this.badgeIcon = canvas.toDataURL('image/png');
      if (this.flags.size) this.favicon.href = this.badgeIcon;
    };
    image.src = this.plainIcon;
  }
}
