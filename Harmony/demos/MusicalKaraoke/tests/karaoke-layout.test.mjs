import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DESIGN_HEIGHT,
  DESIGN_WIDTH,
  FLOW_BREAKPOINT,
  computeStageFit
} from "../public/karaoke/karaoke-layout.js";

const cssUrl = new URL("../public/karaoke/karaoke.css", import.meta.url);
const controllerUrl = new URL("../public/karaoke/karaoke.js", import.meta.url);

test("the logical 16:9 canvas fits every supported presentation viewport", () => {
  const viewports = [
    [900, 650],
    [901, 650],
    [919, 804],
    [1000, 650],
    [1100, 650],
    [1280, 720],
    [1366, 768],
    [1440, 900]
  ];

  for (const [width, viewportHeight] of viewports) {
    const shellHeight = viewportHeight - 64;
    const fit = computeStageFit(width, shellHeight);
    assert.ok(width > FLOW_BREAKPOINT, `${width}px should use the fitted canvas`);
    assert.ok(fit.width <= width - 10 + 1e-9, `${width}×${viewportHeight} canvas exceeds shell width`);
    assert.ok(fit.height <= shellHeight - 10 + 1e-9, `${width}×${viewportHeight} canvas exceeds shell height`);
    assert.ok(Math.abs(fit.width / fit.height - DESIGN_WIDTH / DESIGN_HEIGHT) < 1e-12);
  }

  const at900 = computeStageFit(900, 650 - 64);
  const at901 = computeStageFit(901, 650 - 64);
  assert.ok(Math.abs(at901.scale - at900.scale) < 0.002, "900/901 must not cross a layout mode boundary");
});

test("responsive CSS scales one desktop canvas and keeps only a narrow flow breakpoint", async () => {
  const [css, controller] = await Promise.all([
    readFile(cssUrl, "utf8"),
    readFile(controllerUrl, "utf8")
  ]);

  assert.match(css, /\.stage\{[^}]*width:1440px;height:810px[^}]*scale\(var\(--stage-scale\)\)/);
  assert.doesNotMatch(css, /@media\(max-height:/);
  assert.doesNotMatch(css, /@media\(max-width:900px\)/);
  assert.match(css, new RegExp(`@media\\(max-width:${FLOW_BREAKPOINT}px\\)`));
  assert.match(controller, /installStageFitter\(stage, stageShell\)/);
  assert.match(controller, /document\.documentElement\.scrollTop = 0/);
  assert.match(controller, /document\.body\.scrollTop = 0/);
  assert.match(controller, /window\.scrollTo\?\.\(0, 0\)/);
});
