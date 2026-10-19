import type { HideAndSeek } from './HideAndSeek';

/** Walkable area (m²) Hopper needs to know before hide and seek is any fun. */
export const HIDE_SEEK_MIN_AREA = 2;

/**
 * The activities menu: things to do with Hopper. "Walk" (Hopper keeps the
 * player company and follows them around, which gets the room mapped) is
 * always available and is the default; other activities unlock when their
 * availability predicate says so (hide and seek needs enough of the room
 * mapped). Pure logic: the HUD renders `status()`.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type ActivityId = 'walk' | 'hideSeek' | (string & {});

export interface ActivityDef {
  id: ActivityId;
  label: string;
  icon: string;
  /** Progress towards unlocking, 0..1 (1 = unlocked). */
  progress(game: HideAndSeek): number;
  /** Shown on the locked chip and said when it's tapped while locked. */
  lockedHint(game: HideAndSeek): string;
  /** Can it start right now? (Unlocked, and the game is ready for it.) */
  ready(game: HideAndSeek): boolean;
  /** Said when the activity first unlocks. */
  unlockLine?: string;
}

export interface ActivityStatus {
  id: ActivityId;
  label: string;
  icon: string;
  /** This is what Hopper is doing now. */
  active: boolean;
  /** Progress requirement met (latched once reached). */
  unlocked: boolean;
  /** Can be started right now. */
  ready: boolean;
  progress: number;
  hint: string;
}

export const ACTIVITIES: readonly ActivityDef[] = [
  {
    id: 'walk',
    label: 'Walk',
    icon: '🐾',
    progress: () => 1,
    lockedHint: () => '',
    ready: (g) => g.phase === 'roam',
  },
  {
    id: 'hideSeek',
    label: 'Hide & seek',
    icon: '🙈',
    progress: (g) => Math.max(0, Math.min(1, g.mappedArea() / HIDE_SEEK_MIN_AREA)),
    lockedHint: (g) => (g.mappedArea() < HIDE_SEEK_MIN_AREA * 0.5 ? 'Show me around your room' : 'Map a bit more of your room'),
    ready: (g) => g.canStart(),
    unlockLine: 'Ooh, I know your room now — want to play hide and seek?',
  },
];

export class Activities {
  private unlocked = new Set<ActivityId>();
  /** Called once per activity, the first time it unlocks. */
  onUnlock: ((def: ActivityDef) => void) | null = null;

  constructor(readonly game: HideAndSeek, readonly defs: readonly ActivityDef[] = ACTIVITIES) {
    for (const d of defs) if (d.progress(game) >= 1) this.unlocked.add(d.id);
  }

  /** What Hopper is doing: a round in progress is hide and seek; otherwise a walk. */
  get current(): ActivityId {
    const p = this.game.phase;
    return p === 'countdown' || p === 'seek' || p === 'found' ? 'hideSeek' : 'walk';
  }

  isUnlocked(id: ActivityId): boolean {
    return this.unlocked.has(id);
  }

  /** Check for newly unlocked activities (call every frame or so). */
  update(): void {
    // Unlocks only count once Hopper is out and about.
    if (this.game.phase === 'waiting') return;
    for (const d of this.defs) {
      if (this.unlocked.has(d.id) || d.progress(this.game) < 1) continue;
      this.unlocked.add(d.id);
      this.onUnlock?.(d);
    }
  }

  status(): ActivityStatus[] {
    const cur = this.current;
    return this.defs.map((d) => {
      const progress = d.progress(this.game);
      const unlocked = this.unlocked.has(d.id) && progress >= 1;
      return {
        id: d.id,
        label: d.label,
        icon: d.icon,
        active: d.id === cur,
        unlocked,
        ready: unlocked && d.ready(this.game),
        progress,
        hint: unlocked ? '' : d.lockedHint(this.game),
      };
    });
  }

  get(id: ActivityId): ActivityDef | undefined {
    return this.defs.find((d) => d.id === id);
  }
}
