# Sound credits

All sound effects in this folder (`*.mp3`) were generated for this project
(Hopper, the AR hide-and-seek pet) with the ElevenLabs Sound Effects
(text-to-sound-effects) API, then trimmed and loudness-normalised with ffmpeg.

Prompts described a tiny, cute, high-pitched fantasy creature (baby dragon /
cartoon critter) — giggles, greetings, hops, jumps, landings, a surprised
squeak, a celebration, yawn, sneeze and purr.

## Petting and cuter-voice pass

A second batch (66 candidates from 28 prompt variations) asked for a tiny
baby creature / small fluffy pet: soft coos, contented "mmm" hums and
purr-trills while being stroked, sweet rising "ooh!" / "wee!" chirps of
delight, gentle bubbly "hee hee" giggles and warm hello trills — always
"cute, soft, high but not shrill, no words". Candidates were picked by
measurement (duration, integrated loudness, true peak, spectral centroid and
flatness, share of energy above 6 kHz, onset time and clipping) favouring
short, clean-onset clips that are bright but not harsh or hissy:

- `pet-1…4` (new): contented coos / purr-trills when petted, normalised to
  about −17 LUFS (softer than the rest).
- `love-1…3` (new): happy rising "love" chirps (lots of petting), −15 LUFS.
- `giggle-2`, `giggle-loud-2`, `greet-3` (replaced: the old ones were the
  harshest in their banks) and `giggle-4`, `greet-4`, `purr-2` (added).

Processing: mono, leading/trailing silence trimmed at −42 dB, 4 ms fade-in,
60 ms fade-out, gain to the target loudness, peak-limited at −1.5 dBFS,
44.1 kHz 80 kbps MP3.

The synthesised WebAudio sounds in `src/app/Voice.ts` remain as a fallback when
these files are unavailable.
