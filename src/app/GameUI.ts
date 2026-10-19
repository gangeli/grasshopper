import * as THREE from 'three';
import type { GameStack } from '../game/stack';
import type { Hud } from './Hud';
import type { Voice } from './Voice';

/**
 * Glue between the game's events and the HUD/voice, shared by the AR and
 * simulator modes.
 */
export class GameUI {
  private lastTick = -1;
  private petWorld = new THREE.Vector3();
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
      if (p === 'roam' && game.round === 0) voice.greet();
    };
    pet.events.onHop = () => voice.hop();
    pet.events.onJump = () => voice.jump();
    pet.events.onLand = (impact) => voice.land(impact);
    hud.on('hint', () => game.hint());
    hud.on('difficulty', () => (game.opts.difficulty = hud.difficultyValue));
  }

  /** Per-frame HUD state. */
  update(camera: THREE.Camera) {
    const { game, pet } = this.stack;
    const hud = this.hud;
    // The camera is in the tracking frame; the pet in its parent's (map) frame.
    const parent = this.stack.rig.group.parent;
    const petPos = parent ? this.petWorld.copy(pet.pos).applyMatrix4(parent.matrixWorld) : pet.pos;
    if (Number.isFinite(petPos.x) && Number.isFinite(petPos.y) && Number.isFinite(petPos.z)) this.voice.updateSpatial(camera, petPos);
    switch (game.phase) {
      case 'waiting':
        hud.setPrimary(null);
        hud.setSecondary(false);
        hud.setStatus('');
        break;
      case 'roam': {
        const area = game.mappedArea();
        const ready = game.canStart();
        hud.setPrimary(ready ? 'Play hide & seek' : 'Look around to map…', 'play', ready);
        hud.setSecondary(false);
        hud.setStatus(ready ? `Mapped ${area.toFixed(1)} m²` : `Mapping… ${area.toFixed(1)} / 2 m² — walk around, look under tables`);
        break;
      }
      case 'countdown': {
        const n = Math.ceil(game.countdownLeft);
        hud.showCover(true, n, n <= 0 ? 'Hopper is still hiding…' : 'Count out loud!');
        if (n !== this.lastTick && n >= 0) {
          this.lastTick = n;
          this.voice.tick(n === 0);
        }
        hud.setPrimary(null);
        hud.setSecondary(false);
        hud.setStatus('');
        break;
      }
      case 'seek':
        hud.showCover(false);
        hud.setPrimary(null);
        hud.setSecondary(true);
        hud.setStatus(`Seeking ${Math.floor(game.seekTime)}s`);
        break;
      case 'found':
        hud.setPrimary(null);
        hud.setSecondary(false);
        hud.setStatus('');
        break;
    }
  }
}
