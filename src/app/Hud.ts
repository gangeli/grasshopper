import type { ActivityId, ActivityStatus } from '../game/Activities';

/**
 * DOM HUD. In AR it is the WebXR dom-overlay root, so the same buttons work
 * on a phone in AR and in the simulator. Pure DOM, no framework.
 */
export type HudAction = 'play' | 'hint' | 'again' | 'exit' | 'debug' | 'difficulty' | 'move' | 'rescan';

export class Hud {
  readonly root: HTMLElement;
  private bubble: HTMLElement;
  private status: HTMLElement;
  private alertEl: HTMLElement;
  private tools: HTMLElement;
  private moveBtn: HTMLButtonElement;
  private primary: HTMLButtonElement;
  private secondary: HTMLButtonElement;
  private cover: HTMLElement;
  private coverNum: HTMLElement;
  private coverSub: HTMLElement;
  private card: HTMLElement;
  private cardText: HTMLElement;
  private reticleHint: HTMLElement;
  private acts: HTMLElement;
  private actButtons = new Map<ActivityId, { btn: HTMLButtonElement; sub: HTMLElement; bar: HTMLElement; key: string }>();
  /** Called when an activity chip is tapped. */
  onActivity: ((id: ActivityId) => void) | null = null;
  private bubbleTimer = 0;
  private handlers = new Map<HudAction, () => void>();
  private diffBtn: HTMLButtonElement;
  readonly difficulties = ['easy', 'normal', 'hard'] as const;
  difficulty: (typeof this.difficulties)[number] = 'normal';

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    parent.appendChild(this.root);
    const top = el('div', 'hud-top');
    this.bubble = el('div', 'bubble');
    this.status = el('div', 'status');
    // Persistent warning (tracking lost, paused, repeated errors): unlike the
    // bubble it stays until the condition clears.
    this.alertEl = el('div', 'alert');
    this.alertEl.setAttribute('role', 'status');
    top.append(this.alertEl, this.bubble, this.status);
    const corner = el('div', 'hud-corner');
    const exit = button('✕', 'icon', () => this.fire('exit'));
    exit.title = 'Exit';
    this.diffBtn = button('normal', 'chip', () => {
      const i = (this.difficulties.indexOf(this.difficulty) + 1) % this.difficulties.length;
      this.difficulty = this.difficulties[i];
      this.diffBtn.textContent = this.difficulty;
      this.fire('difficulty');
    });
    this.diffBtn.title = 'Difficulty';
    const dbg = button('map', 'chip', () => this.fire('debug'));
    dbg.title = 'Show what Hopper has mapped';
    corner.append(this.diffBtn, dbg, exit);
    // AR escape hatches: re-place Hopper (fixes a mis-tapped floor) and
    // forget the map when it has visibly gone wrong.
    this.tools = el('div', 'hud-tools');
    this.moveBtn = button('move', 'chip', () => this.fire('move'));
    this.moveBtn.title = 'Move Hopper: tap the floor to place again';
    const rescan = button('↻ rescan', 'chip', () => this.fire('rescan'));
    rescan.title = 'Forget the map and scan the room again';
    this.tools.append(this.moveBtn, rescan);
    const bottom = el('div', 'hud-bottom');
    this.primary = button('Play hide & seek', 'primary', () => this.fire(this.primary.dataset.action as HudAction));
    this.primary.dataset.action = 'play';
    this.secondary = button('Hint 🔔', 'secondary', () => this.fire('hint'));
    bottom.append(this.secondary, this.primary);
    this.cover = el('div', 'cover');
    this.coverNum = el('div', 'cover-num');
    this.coverSub = el('div', 'cover-sub');
    this.cover.append(el('div', 'cover-title', 'Cover your eyes!'), this.coverNum, this.coverSub);
    this.card = el('div', 'card');
    this.cardText = el('div', 'card-text');
    this.card.append(this.cardText, button('Play again', 'primary', () => this.fire('again')));
    this.reticleHint = el('div', 'place-hint', 'Point at the floor and tap to place Hopper');
    // The activities picker (walk, hide and seek, ...), see setActivities.
    this.acts = el('div', 'acts');
    this.acts.setAttribute('role', 'group');
    this.acts.setAttribute('aria-label', 'Activities');
    this.root.append(top, corner, this.tools, bottom, this.acts, this.cover, this.card, this.reticleHint);
    this.setActivities(null);
    this.showTools(false);
    this.setAlert(null);
    this.showCover(false);
    this.showCard(null);
    this.showPlaceHint(false);
  }

  on(action: HudAction, fn: () => void) {
    this.handlers.set(action, fn);
  }
  private fire(a: HudAction) {
    this.handlers.get(a)?.();
  }
  /** Run the handler of an action as if its button was pressed. */
  trigger(a: HudAction) {
    this.fire(a);
  }

  /**
   * Show the activities picker (null hides it). Chips are built once and
   * updated in place; this is cheap to call every frame.
   */
  setActivities(list: readonly ActivityStatus[] | null) {
    this.acts.style.display = list ? '' : 'none';
    if (!list) return;
    for (const a of list) {
      let c = this.actButtons.get(a.id);
      if (!c) {
        const btn = button('', 'act', () => this.onActivity?.(a.id));
        btn.dataset.activity = a.id;
        const icon = el('span', 'act-icon', a.icon);
        icon.setAttribute('aria-hidden', 'true');
        const text = el('span', 'act-text');
        const sub = el('span', 'act-sub');
        const bar = el('i', '');
        const track = el('span', 'act-bar');
        track.append(bar);
        text.append(el('span', 'act-label', a.label), sub, track);
        btn.append(icon, text);
        this.acts.append(btn);
        c = { btn, sub, bar, key: '' };
        this.actButtons.set(a.id, c);
      }
      const state = a.active ? 'active' : a.ready ? 'ready' : a.unlocked ? 'waiting' : 'locked';
      const pct = Math.round(a.progress * 100);
      const key = `${state}|${pct}|${a.hint}`;
      if (key === c.key) continue;
      c.key = key;
      const b = c.btn;
      for (const s of ['active', 'ready', 'waiting', 'locked']) b.classList.toggle(s, s === state);
      const sub =
        state === 'active' ? (a.id === 'walk' ? 'Hopper follows you' : 'Playing now') : state === 'ready' ? 'Tap to play!' : state === 'waiting' ? 'One moment…' : a.hint;
      c.sub.textContent = sub;
      c.bar.parentElement!.style.display = state === 'locked' ? '' : 'none';
      c.bar.style.width = `${Math.max(4, pct)}%`;
      b.setAttribute(
        'aria-label',
        state === 'ready' ? `Play ${a.label.toLowerCase()}` : state === 'locked' ? `${a.label} (locked, ${pct}%): ${a.hint}` : `${a.label}: ${sub}`,
      );
      b.setAttribute('aria-pressed', String(a.active));
    }
  }

  /** A little pop and sparkle on an activity chip (it just unlocked). */
  celebrateActivity(id: ActivityId) {
    const b = this.actButtons.get(id)?.btn;
    if (!b) return;
    b.classList.remove('pop');
    void b.offsetWidth; // restart the animation
    b.classList.add('pop');
    for (let i = 0; i < 8; i++) {
      const s = el('i', 'spark');
      const a = (i / 8) * Math.PI * 2;
      s.style.setProperty('--dx', `${Math.cos(a) * 70}px`);
      s.style.setProperty('--dy', `${Math.sin(a) * 34 - 10}px`);
      b.append(s);
      setTimeout(() => s.remove(), 1000);
    }
  }

  say(msg: string, seconds = 5) {
    this.bubble.textContent = msg;
    this.bubble.classList.add('show');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.bubble.classList.remove('show'), seconds * 1000);
  }

  /** Show (or clear, with null) the persistent warning line. */
  setAlert(text: string | null) {
    const t = text ?? '';
    if (this.alertEl.textContent !== t) this.alertEl.textContent = t;
    this.alertEl.style.display = text ? '' : 'none';
  }

  get alertText(): string {
    return this.alertEl.style.display === 'none' ? '' : this.alertEl.textContent ?? '';
  }

  showTools(on: boolean, moveLabel = 'move') {
    this.tools.style.display = on ? '' : 'none';
    if (this.moveBtn.textContent !== moveLabel) this.moveBtn.textContent = moveLabel;
  }

  setStatus(text: string) {
    if (this.status.textContent !== text) this.status.textContent = text;
  }

  setPrimary(label: string | null, action: HudAction = 'play', enabled = true) {
    this.primary.style.display = label ? '' : 'none';
    if (label) {
      this.primary.textContent = label;
      this.primary.dataset.action = action;
      this.primary.disabled = !enabled;
    }
  }

  setSecondary(visible: boolean) {
    this.secondary.style.display = visible ? '' : 'none';
  }

  showCover(on: boolean, n = 0, sub = '') {
    this.cover.style.display = on ? 'flex' : 'none';
    if (on) {
      this.coverNum.textContent = n > 0 ? String(n) : '…';
      this.coverSub.textContent = sub;
    }
  }

  showCard(text: string | null) {
    this.card.style.display = text ? 'flex' : 'none';
    if (text) this.cardText.textContent = text;
  }

  showPlaceHint(on: boolean, text?: string) {
    this.reticleHint.style.display = on ? '' : 'none';
    if (text) this.reticleHint.textContent = text;
  }

  get difficultyValue(): number {
    return { easy: 0.15, normal: 0.5, hard: 0.85 }[this.difficulty];
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = text;
  // beforexrselect stops taps on HUD buttons from also firing an XR 'select'.
  b.addEventListener('beforexrselect', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}
