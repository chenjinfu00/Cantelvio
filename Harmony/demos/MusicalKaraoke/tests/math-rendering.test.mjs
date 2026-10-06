import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import katex from "katex";

test("all presentation LaTeX parses into accessible mathematics", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const formulas = [...html.matchAll(/data-tex="([^"]+)"/g)].map((match) =>
    match[1].replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'"
    })[entity])
  );
  assert.ok(formulas.length > 0, "the deck must contain LaTeX formulas");
  for (const formula of formulas) {
    const output = katex.renderToString(formula, { throwOnError: true, strict: "error", output: "htmlAndMathml" });
    assert.match(output, /<math/, formula);
    assert.match(output, /katex-html/, formula);
  }
});

test("KaTeX scripts and every referenced font are bundled locally", async () => {
  const base = new URL("../public/vendor/katex/", import.meta.url);
  await access(new URL("katex.min.js", base));
  await access(new URL("LICENSE", base));
  const css = await readFile(new URL("katex.min.css", base), "utf8");
  const fonts = [...new Set([...css.matchAll(/url\((?:["'])?([^)'"\s]+)(?:["'])?\)/g)].map((match) => match[1]))];
  assert.ok(fonts.length > 0);
  for (const font of fonts) await access(new URL(font, base));
});
