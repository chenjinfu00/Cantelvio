import { access, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const site = process.argv[2];
if (!site) throw new Error("Pass the existing AIgimon Site checkout path.");
const root = resolve(site);
const manifest = JSON.parse(await readFile(join(root, ".openai/hosting.json"), "utf8"));
if (manifest.project_id !== "appgprj_6ab0f9d1162481919aab5aee39f0a28b") throw new Error("Not the selected AIgimon Site.");
const destination = join(root, "public/MusicalKaraoke");
const route = join(root, "app/MusicalKaraoke");
for (const path of [destination, route]) {
  try { await access(path); throw new Error(`${path} already exists; review before replacing.`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
}
const source = fileURLToPath(new URL("../public/", import.meta.url));
await mkdir(destination, { recursive: true });
// Explicit runtime allowlist excludes the original deck and all concerto media.
for (const entry of ["karaoke", "shared", "vendor/katex", "media/karaoke", "math.js", "deck-audio.js"]) {
  await cp(join(source, entry), join(destination, entry), { recursive: true });
}
await mkdir(join(destination, "tonnetz"), { recursive: true });
for (const entry of ["app.js", "app.css", "icon.svg"]) {
  await cp(join(source, "tonnetz", entry), join(destination, "tonnetz", entry));
}
let engine = await readFile(join(source, "tonnetz/index.html"), "utf8");
engine = engine.replace(/\s*<aside id="rehearsalPanel"[\s\S]*?<\/aside>/, "")
  .replace(/\s*<script type="module" src="\.\/rehearsal\.js[^\"]*"><\/script>/, "")
  .replace(/\s*<link rel="manifest"[^>]*>/, "");
if (/rehearsalPanel|rehearsal\.js/.test(engine)) throw new Error("Rehearsal UI remained in the new engine.");
await writeFile(join(destination, "tonnetz/index.html"), engine);
let app = await readFile(join(destination, "tonnetz/app.js"), "utf8");
// Restrict cleanup to this new copy's own scope, preserving the public instrument.
app = app.replace('registration.scope.includes("/tonnetz/")', 'registration.scope === new URL("./", location.href).href');
await writeFile(join(destination, "tonnetz/app.js"), app);
let deck = await readFile(join(destination, "karaoke/index.html"), "utf8");
deck = deck.replace('src="../tonnetz/?embed=1"', 'src="../tonnetz/index.html?embed=1"');
if (/demo=(melody|harmony)|Tchaikovsky|Mendelssohn/.test(deck)) throw new Error("Concerto entry remained in the new deck.");
await writeFile(join(destination, "karaoke/index.html"), deck);
await mkdir(route, { recursive: true });
await writeFile(join(route, "page.tsx"), `export default function MusicalKaraokePage() {
  return (
    <iframe
      src="/MusicalKaraoke/karaoke/index.html"
      title="Musical Karaoke · AIgimon"
      allow="autoplay; fullscreen"
      allowFullScreen
      className="fixed inset-0 block h-dvh w-screen border-0 bg-[#090d1f]"
    />
  );
}
`);
await writeFile(join(route, "layout.tsx"), `import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "Musical Karaoke · AIgimon",
  description: "A seven-page interactive musical rehearsal. Sing, play chords, and discover the shapes behind the sound.",
  alternates: { canonical: "/MusicalKaraoke" },
  icons: { icon: "/MusicalKaraoke/tonnetz/icon.svg" },
};
export const viewport: Viewport = {
  width: "device-width", initialScale: 1, viewportFit: "cover", themeColor: "#090d1f",
};
export default function MusicalKaraokeLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
`);
console.log("Staged Musical Karaoke with seven pages and no concerto rehearsals or audio.");
