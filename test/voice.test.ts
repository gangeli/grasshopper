import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SAMPLE_BANKS, Voice } from '../src/app/Voice';

describe('Voice', () => {
  it('works without WebAudio (node): logs sounds, no throw', () => {
    const v = new Voice();
    v.unlock();
    v.giggle();
    v.giggle(true);
    v.greet();
    v.hop();
    v.jump();
    v.land(0.5);
    v.surprised();
    v.fanfare();
    v.tick();
    v.yawn();
    v.sneeze();
    v.purr();
    v.pet(0.5);
    v.love();
    expect(v.played).toEqual(['giggle', 'giggle', 'greet', 'hop', 'jump', 'land', 'surprised', 'fanfare', 'tick', 'yawn', 'sneeze', 'purr', 'pet', 'love']);
    expect(v.sampleBanksLoaded).toBe(0);
  });

  it('has the petting banks', () => {
    expect(SAMPLE_BANKS.pet.length).toBeGreaterThanOrEqual(3);
    expect(SAMPLE_BANKS.love.length).toBeGreaterThanOrEqual(2);
  });

  it('every sample file referenced exists in public/sfx', () => {
    for (const files of Object.values(SAMPLE_BANKS))
      for (const f of files) expect(existsSync(resolve(__dirname, '../public/sfx', f)), f).toBe(true);
  });
});
