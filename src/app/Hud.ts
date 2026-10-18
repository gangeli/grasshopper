/**
 * DOM HUD. In AR it is the WebXR dom-overlay root, so the same buttons work
 * on a phone in AR and in the simulator. Pure DOM, no framework.
 */
export type HudAction = 'play' | 'hint' | 'again' | 'exit' | 'debug' | 'difficulty';

export class Hud {
  readonly root: HTMLElement;
  private bubble: HTMLElement;
  private status: HTMLElement;
  private primary: HTMLButtonElement;
  private secondary: HTMLButtonElement;
  private cover: HTMLElement;
  private coverNum: HTMLElement;
  private coverSub: HTMLElement;
  private card: HTMLElement;
  private cardText: HTMLElement;
  private reticleHint: HTMLElement;
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
    top.append(this.bubble, this.status);
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
    this.root.append(top, corner, bottom, this.cover, this.card, this.reticleHint);
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

  say(msg: string, seconds = 5) {
    this.bubble.textContent = msg;
    this.bubble.classList.add('show');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = window.setTimeout(() => this.bubble.classList.remove('show'), seconds * 1000);
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
