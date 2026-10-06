import test from "node:test";
import assert from "node:assert/strict";

import {
  EQUAL_FIFTH_RATIO,
  FIFTH_DIFFERENCE_CENTS,
  PURE_FIFTH_MIDI,
  PURE_FIFTH_RATIO,
  frequencyForMidi,
  previewFifth
} from "../public/tonnetz/learn.js";

test("pure and equal-tempered fifth ratios are mathematically correct", () => {
  assert.equal(PURE_FIFTH_RATIO, 1.5);
  assert.ok(Math.abs(EQUAL_FIFTH_RATIO - 1.4983070768766815) < 1e-14);
  assert.ok(Math.abs(FIFTH_DIFFERENCE_CENTS - 1.955000865387433) < 1e-9);
  assert.ok(Math.abs(frequencyForMidi(PURE_FIFTH_MIDI) / frequencyForMidi(60) - 1.5) < 1e-12);
  assert.ok(Math.abs(frequencyForMidi(67) / frequencyForMidi(60) - EQUAL_FIFTH_RATIO) < 1e-12);
});

test("pure-fifth preview uses fractional MIDI and only the learn audio group", async () => {
  const calls = [];
  const audio = {
    ensureReady: async () => true,
    stopGroup: (group) => calls.push(["stop", group]),
    playNote: (midi, options) => calls.push(["play", midi, options])
  };
  assert.equal(await previewFifth(audio, "pure"), true);
  assert.deepEqual(calls[0], ["stop", "learn"]);
  assert.equal(calls.filter(([kind]) => kind === "play").length, 2);
  assert.equal(calls[2][1], PURE_FIFTH_MIDI);
  assert.notEqual(calls[2][1], Math.round(calls[2][1]));
  calls.filter(([kind]) => kind === "play").forEach(([, , options]) => {
    assert.equal(options.group, "learn");
    assert.equal(options.instrument, "sine");
    assert.equal(typeof options.duration, "number");
  });
  assert.equal(calls.some(([kind, group]) => kind === "stop" && group !== "learn"), false);
});

test("equal-tempered preview uses MIDI 67 and respects failed audio unlock", async () => {
  const played = [];
  const audio = {
    ensureReady: async () => true,
    stopGroup() {},
    playNote: (midi) => played.push(midi)
  };
  assert.equal(await previewFifth(audio, "equal"), true);
  assert.deepEqual(played, [60, 67]);

  let touched = false;
  const blocked = {
    ensureReady: async () => false,
    stopGroup: () => { touched = true; },
    playNote: () => { touched = true; }
  };
  assert.equal(await previewFifth(blocked, "pure"), false);
  assert.equal(touched, false);
});

test("a stale preview is cancelled after audio unlock without sounding", async () => {
  let release;
  let played = false;
  const audio = {
    ensureReady: () => new Promise((resolve) => { release = resolve; }),
    stopGroup: () => { played = true; },
    playNote: () => { played = true; }
  };
  const pending = previewFifth(audio, "pure", () => false);
  release(true);
  assert.equal(await pending, false);
  assert.equal(played, false);
});
