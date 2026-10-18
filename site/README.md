# Cantelvio web structure

- `/` opens the software workspaces, with Score as the main action.
- `/demo/` contains the introduction, walkthrough, capability explanation and results links.
- `/results/` retains historical experiments and listening examples.
- `/score/`, `/compose/`, `/harmony/` and `/stage/` remain usable module routes.
- `/concerto/` lists prepared accompaniment repertoire; `/concerto/play.html` reads the user's PDF/MIDI inside the browser, with orchestra SoundFont playback and a separate experimental microphone follower. Only Chopin Op.21 movement I is currently prepared. No private score, MIDI or microphone recording is shipped or uploaded; Score edits do not change playback.

All public pages share appearance settings rooted at the GitHub Pages project URL. The launcher and guide also share the existing `cantelvio-lang` preference. New Python piano models and private score libraries are excluded from the static bundle.

Build only into a fresh directory:

```sh
node site/build.mjs --build --out /tmp/cantelvio-web-preview-fresh
node site/check-links.mjs --out /tmp/cantelvio-web-preview-fresh
```

`--build` rebuilds Score directly inside the new output, leaving module distributions untouched. `--modules-root /absolute/checkout` can reuse a verified module checkout while current site pages/settings come from this checkout. Without this option modules come from the current repository. `version.json` records both source commits and whether site source has local changes.

The default `site-dist` works on a fresh CI checkout. Repeated local builds must select a new `--out`; existing output is never erased. Assembly excludes local-service-only pages before copying, instead of deleting them afterward.

[2026-10-13 verification](reports/web-separation-20261013/README.md).
