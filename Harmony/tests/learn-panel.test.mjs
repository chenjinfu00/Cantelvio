import test from "node:test";
import assert from "node:assert/strict";

import { createLearnPanel } from "../public/tonnetz/learn.js";

function fakeContainer() {
  const listeners = new Map();
  return {
    innerHTML: "",
    listeners,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    querySelectorAll() { return []; }
  };
}

test("Learn panel renders in both supplied languages and exposes lifecycle methods", () => {
  const container = fakeContainer();
  const stopped = [];
  let language = "en";
  const panel = createLearnPanel({
    container,
    audio: { stopGroup: (group) => stopped.push(group) },
    getLanguage: () => language
  });

  assert.equal(typeof panel.render, "function");
  assert.equal(typeof panel.cancel, "function");
  assert.equal(typeof panel.destroy, "function");
  assert.match(container.innerHTML, /How a circle becomes a harmony map/);
  assert.match(container.innerHTML, /data-tex="\\frac/);
  assert.equal(container.listeners.has("click"), true);
  assert.equal(container.listeners.has("keydown"), true);

  language = "zh-CN";
  panel.render();
  assert.match(container.innerHTML, /一个音圈如何变成和声地图/);

  panel.destroy();
  assert.equal(container.innerHTML, "");
  assert.deepEqual(stopped, ["learn"]);
  assert.equal(container.listeners.size, 0);
});
