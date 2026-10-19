import * as THREE from 'three';
import type { GameStack } from '../game/stack';
import type { TapResult } from '../game/HideAndSeek';
import type { ActivityId } from '../game/Activities';
import type { Hud } from './Hud';
import type { Voice } from './Voice';
import { TapMarker } from './TapMarker';

/**
 * Glue between the game's events and the HUD/voice, shared by the AR and
 * simulator modes: the activities picker, tap feedback (marker, sounds) and
 * the per-phase HUD state.
 */
export class GameUI {
  private lastTick = -1;
  private petWorld = new THREE.Vector3();
  readonly marker = new TapMarker();
  private lastT = 0;
  private tipShown = false;
  constructor(readonly stack: GameStack, readonly hud: Hud, readonly voice: Voice) {
    const { game, pet } = stack;
    game.events.onMessage = (m) => hud.say(m, 6);
    game.events.onGiggle = (_p, loud) => voice.giggle(loud);
    game.events.onFidget = (a) => {
      const r = Math.random();
      if (a === 'sniff' && r < 0.35) setTimeout(() => voice.sneeze(), 700);
      else if (a === 'idle' && r < 0.2) voice.purr();
      else if (a === 'lookAround' && r < 0.1) voice.yawn();
    };
    game.events.onFound = (info) => {
      if (!info.revealed) {
        voice.surprised();
        voice.fanfare();
      } else voice.greet();
      const tail = info.hintsUsed ? ` Hints used: ${info.hintsUsed}.` : '';
      hud.showCard(info.revealed ? `Hopper was hiding ${info.where}! Round ${info.round}.` : `Found Hopper ${info.where} in ${info.seconds}s!${tail}`);
    };
    game.events.onPhase = (p) => {
      hud.showCover(p === 'countdown', Math.ceil(game.countdownLeft));
      if (p !== 'found') hud.showCard(null);
      if (p !== 'roam') this.marker.hide();
      if (p === 'roam' && game.round === 0) {
        voice.greet();
        // After the hello: how to play with Hopper on a walk.
        if (!this.tipShown) {
          this.tipShown = true;
          setTimeout(() => {
            if (game.phase === 'roam') hud.say('Tip: tap the floor to send me somewhere — or tap me!', 6);
          }, 9000);
        }
      }
    };
    game.events.onTap = (r) => this.onTap(r);
    game.events.onUnlock = (a) => {
      voice.fanfare();
      setTimeout(() => voice.giggle(false), 500);
      // The chip may not exist until the next frame's update.
      requestAnimationFrame(() => hud.celebrateActivity(a.id));
    };
    pet.events.onHop = () => voice.hop();
    pet.events.onJump = () => voice.jump();
    pet.events.onLand = (impact) => voice.land(impact);
    hud.on('hint', () => game.hint());
    hud.on('difficulty', () => (game.opts.difficulty = hud.difficultyValue));
    hud.onActivity = (id) => this.pickActivity(id);
  }

  /** An activity chip was tapped. */
  private pickActivity(id: ActivityId) {
    const { game } = this.stack;
    this.voice.unlock();
    const st = game.activities.status().find((s) => s.id === id);
    if (!st) return;
    if (id === 'walk') {
      if (game.phase === 'roam') this.hud.say('We’re on a walk! I’ll follow you around — tap the floor to send me somewhere.', 5);
      return;
    }
    if (st.ready) {
      // The mode starts the round (it knows how to get a trustworthy view).
      if (id === 'hideSeek') this.hud.trigger('play');
      return;
    }
    this.hud.say(st.unlocked ? 'One moment — I’m getting my bearings…' : `${st.hint} — then we can play ${st.label.toLowerCase()}!`, 4);
  }

  private onTap(r: TapResult) {
    const v = this.voice;
    switch (r.kind) {
      case 'pet':
        if (r.reaction === 'wave') v.greet();
        else if (r.reaction === 'surprised') {
          v.surprised();
          setTimeout(() => v.giggle(false), 600);
        } else v.giggle(false);
        break;
      case 'goto':
        this.showMarker(r.target, true);
        if (Math.random() < 0.35) v.greet();
        break;
      case 'unreachable':
        if (r.at) this.showMarker(r.at, false);
        break;
    }
  }

  private showMarker(p: { x: number; y: number; z: number }, ok: boolean) {
    // The marker lives in the map frame, next to the pet's rig.
    const parent = this.stack.rig.group.parent;
    if (!parent) return;
    if (this.marker.group.parent !== parent) parent.add(this.marker.group);
    this.marker.show(p, ok);
  }

  /** Per-frame HUD state. */
  update(camera: THREE.Camera) {
    const { game, pet } = this.stack;
    const hud = this.hud;
    const now = performance.now() / 1000;
    const dt = this.lastT ? Math.min(0.1, now - this.lastT) : 0;
    this.lastT = now;
    if (this.marker.visible) {
      const g = this.marker.group.position;
      if (!pet.moving && Math.hypot(pet.pos.x - g.x, pet.pos.z - g.z) < 0.25) this.marker.arrived();
      this.marker.update(dt);
    }
    // The camera is in the tracking frame; the pet in its parent's (map) frame.
    const parent = this.stack.rig.group.parent;
    const petPos = parent ? this.petWorld.copy(pet.pos).applyMatrix4(parent.matrixWorld) : pet.pos;
    // Web Audio throws on non-finite values (a broken camera pose during tracking faults).
    if (Number.isFinite(petPos.x) && Number.isFinite(petPos.y) && Number.isFinite(petPos.z) && camera.matrixWorld.elements.every(Number.isFinite)) this.voice.updateSpatial(camera, petPos);
    switch (game.phase) {
      case 'waiting':
        hud.setPrimary(null);
        hud.setSecondary(false);
        hud.setActivities(null);
        hud.setStatus('');
        break;
      case 'roam':
        hud.setPrimary(null);
        hud.setSecondary(false);
        hud.setActivities(game.activities.status());
        hud.setStatus('');
        break;
      case 'countdown': {
        const n = Math.ceil(game.countdownLeft);
        hud.showCover(true, n, n <= 0 ? 'Hopper is still hiding…' : 'Count out loud!');
        if (n !== this.lastTick && n >= 0) {
          this.lastTick = n;
          this.voice.tick(n === 0);
        }
        hud.setPrimary(null);
        hud.setSecondary(false);
        hud.setActivities(null);
        hud.setStatus('');
        break;
      }
      case 'seek':
        hud.showCover(false);
        hud.setPrimary(null);
        hud.setSecondary(true);
        hud.setActivities(null);
        hud.setStatus(`Seeking ${Math.floor(game.seekTime)}s`);
        break;
      case 'found':
        hud.setPrimary(null);
        hud.setSecondary(false);
        hud.setActivities(null);
        hud.setStatus('');
        break;
    }
  }
}
