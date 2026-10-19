# Sound credits

All sound effects in this folder (`*.mp3`) were generated for this project
(Hopper, the AR hide-and-seek pet) with the ElevenLabs Sound Effects
(text-to-sound-effects) API, then trimmed and loudness-normalised with ffmpeg.

Prompts described a tiny, cute, high-pitched fantasy creature (baby dragon /
cartoon critter) — giggles, greetings, hops, jumps, landings, a surprised
squeak, a celebration, yawn, sneeze and purr.

The synthesised WebAudio sounds in `src/app/Voice.ts` remain as a fallback when
these files are unavailable.
