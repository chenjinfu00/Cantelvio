import { cp, mkdir } from "node:fs/promises";
const root = new URL("../", import.meta.url);
const target = new URL("public/vendor/katex/", root);
await mkdir(target, { recursive: true });
for (const file of ["katex.min.js", "katex.min.css", "fonts"]) {
  await cp(new URL(`node_modules/katex/dist/${file}`, root), new URL(file, target), { recursive: true });
}
await cp(new URL("node_modules/katex/LICENSE", root), new URL("LICENSE", target));
