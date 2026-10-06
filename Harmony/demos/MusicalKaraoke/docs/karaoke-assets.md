# Karaoke v2 assets

These assets belong to the separate local, ten-slide Karaoke v2 presentation.

## Singing demonstrations

Seven original, locally synthesized WAV clips live in `public/media/karaoke/`. They use harmonic formant synthesis, soft envelopes, light detuning, and vowel-specific spectra. They are **synthetic voices, not human recordings**. No recording, performer imitation, speech service, or microphone is involved.

Rebuild with:

```sh
/opt/anaconda3/envs/chopin-op21-accompanist/bin/python scripts/build-karaoke-voices.py
```

`manifest.json` records source files, exact duration and visible cues. The vowel solos use C3, E3, G3 to provide a comfortable model; participants may sing in any comfortable octave. The pure fifth and tuning examples are generated at exact frequencies in the browser, separately from these 12-TET vowel samples.

| Clip | Seconds | Purpose |
|---|---:|---|
| hum | 2.8 | Cover, hummed C3 |
| ah | 2.2 | AH, C3 |
| oo | 2.2 | OO, E3 |
| doo | 1.6 | DOO, G3 |
| mm | 2.2 | MM, G3 |
| call | 5.2 | C–D–E, followed by a silent response gap |
| choir | 24 | Three-second visual count-in, individual voice entries, C-major chord, four-second silent response |

Samples are mono 44.1 kHz, signed 16-bit PCM. The generator bounds peaks below 0.71 full scale. The choir's final four seconds contain no reference sound. A brief fixed room reflection stays before that response gap.

## Cover illustration

File: `public/media/karaoke/choir-cover.png`, 1536 × 1024. Created with the built-in imagegen tool on 2026-09-23. This is an illustration, not a photo of a real performance. The precise prompt was:

> Use case: illustration-story. Asset type: a single cover illustration for a playful music improvisation slide deck titled The rehearsal (do NOT put this or any text in the image). Create a stylish surreal editorial collage of three floating singing mouths, one wide AH mouth in coral red, one rounded OO mouth in teal, one relaxed humming lips in warm ochre, above a few scattered piano-key-like cream tiles. The image should suggest an absurd tiny choir and invite the audience to make sounds. No faces, no human identities, no text, no letters, no musical notation, no physics symbols, no honeycomb or quantum imagery. Elegant papercut and softly tactile painted paper texture, contemporary arts-festival poster quality, rich ink navy #17182B background. Landscape 3:2 composition, main mouths clustered in middle and right, spacious and restrained, not childish clipart. Distinct mouth openings with believable stylized teeth and lip shapes. Entire composition fits generously inside the edges.

The live keyboards and lattice diagrams remain editable SVG from the existing application; the illustration never replaces a playable diagram.

## 三人四音排练素材（2026-09-23）

新增 part-1/2/3-practice.wav（各 26.4 s，三轮），part-1/2/3-check.wav（各 17.6 s，起音→静音独唱→参考音），parts-together.wav（17.6 s，三声部示范→静音合唱）。所有人声均为合成 AH。每音 1.6 s，发声音长 1.4 s；无伴奏阶段的 PCM 必须全零。三条声部的音高、完整三和弦与页面第一条进行由自动测试交叉校验。
