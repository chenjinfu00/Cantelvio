# Cantelvio web structure

- `/` opens the software workspaces, with Score as the main action.
- `/demo/` contains the introduction, walkthrough, capability explanation and results links.
- `/results/` retains historical experiments and listening examples.
- `/score/`, `/compose/`, `/harmony/` and `/stage/` remain usable module routes.
- `/concerto/` lists prepared accompaniment repertoire; `/concerto/play.html` reads the user's PDF/MIDI inside the browser, with orchestra SoundFont playback and a separate experimental microphone follower. Only Chopin Op.21 movement I is currently prepared. The user-approved complete Finley MIDI and two-piano PDF for this work are shipped unchanged, with source notices retained. Other private scores, recordings and models are excluded. Custom files and microphone audio are not uploaded; Score edits do not change playback.

Concerto automatically loads the published Chopin preset on first use: opening pickup plus complete orchestral introduction (start 0; start 1 is the first complete printed bar), Pianoforte track 13 muted, tempo 94%, volume 45%, and two-piano PDF page 13. Published assets are fixed allowlisted paths, length-checked and SHA-256 verified. Project-scoped IndexedDB remembers custom files, solo tracks, page and settings. If storage is unavailable or damaged, the public preset still loads; Restore defaults reloads it. Example playback does not replace the saved performance. A verified `.concerto` pack remains an optional import, not part of the public bundle. Sound never starts automatically, and microphone permission remains browser-controlled.

All public pages share appearance settings rooted at the GitHub Pages project URL. The launcher and guide also share the existing `cantelvio-lang` preference. New Python piano models and private score libraries are excluded from the static bundle.

Build only into a fresh directory:

```sh
node site/build.mjs --build --out /tmp/cantelvio-web-preview-fresh
node site/check-links.mjs --out /tmp/cantelvio-web-preview-fresh
```

`--build` rebuilds Score directly inside the new output, leaving module distributions untouched. `--modules-root /absolute/checkout` can reuse a verified module checkout while current site pages/settings come from this checkout. Without this option modules come from the current repository. `version.json` records both source commits and whether site source has local changes.

The default `site-dist` works on a fresh CI checkout. Repeated local builds must select a new `--out`; existing output is never erased. Assembly excludes local-service-only pages before copying, instead of deleting them afterward.

[2026-10-13 verification](reports/web-separation-20261013/README.md).

Concerto score alignment uses 348 complete printed bars plus the 5/16 pickup. `alignment.mjs` maps the unchanged Finley performance clock to score coordinates using `assets/chopin-op21-alignment.json`; it applies only to that exact MIDI SHA-256. The three pickup notes are quarter beats 3.75, 4 and 4.75, followed by bar 1 beat 1. Piano enters at printed bar 71, the solo ends in 337, and the orchestra finishes in 348. The written fermata/cadenza in bar 148 is explicitly marked free time. Unknown MIDI files retain clearly labelled file-grid coordinates. Old saved grid starts are migrated once to the new basis while preserving files, PDF page, tempo and volume (including 100%); the old start 1 becomes pickup start 0.

The map was prepared from the NIFC encoded first edition and checked against the supplied National Edition PDF. Quarter positions are interpolated between aligned attacks; they do not quantize or retime the MIDI. Reproduction and independent acceptance records live in `Concerto/scripts/` and `site/reports/concerto-web-20261018/`.
