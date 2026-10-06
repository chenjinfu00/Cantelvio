import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = process.argv[2];
if (!site) throw new Error('Pass the AIgimon Site checkout path.');
const root = resolve(site);
const manifest = JSON.parse(await readFile(join(root, '.openai/hosting.json'), 'utf8'));
if (manifest.project_id !== 'appgprj_6ab0f9d1162481919aab5aee39f0a28b') throw new Error('Not the selected AIgimon Site.');
const destination = join(root, 'public/Kitaev');
try { await access(destination); throw new Error('Kitaev already exists; review it before replacing.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

await cp(fileURLToPath(new URL('../public/', import.meta.url)), destination, {
  recursive: true,
  filter: source => !source.endsWith('/sw.js'),
});
let deck = await readFile(join(destination, 'index.html'), 'utf8');
deck = deck.replace('<head>', '<head>\n  <base href="/Kitaev/">');
deck = deck.replaceAll('./tonnetz/?', './tonnetz/index.html?');
await writeFile(join(destination, 'index.html'), deck);
let instrument = await readFile(join(destination, 'tonnetz/index.html'), 'utf8');
instrument = instrument.replace('href="../#demo"', 'href="../index.html#demo"');
await writeFile(join(destination, 'tonnetz/index.html'), instrument);
let app = await readFile(join(destination, 'tonnetz/app.js'), 'utf8');
// The hosted presentation must never unregister the public Tonnetz app's worker.
app = app.replace('registration.scope.includes("/tonnetz/")', 'registration.scope === new URL("./", location.href).href');
await writeFile(join(destination, 'tonnetz/app.js'), app);

await mkdir(join(root, 'app/Kitaev'), { recursive: true });
await writeFile(join(root, 'app/Kitaev/page.tsx'), `export default function KitaevPage() {
  return (
    <iframe
      src="/Kitaev/index.html"
      title="The Kitaev Honeycomb Model · Interactive Tonnetz presentation"
      allow="autoplay; fullscreen"
      allowFullScreen
      className="fixed inset-0 block h-dvh w-screen border-0 bg-[#0d0e18]"
    />
  );
}
`);
await writeFile(join(root, 'app/Kitaev/layout.tsx'), `import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "The Kitaev Honeycomb Model · Tonnetz",
  description: "An interactive presentation from the Kitaev honeycomb model to playable Tonnetz chords and concerto excerpts.",
  alternates: { canonical: "/Kitaev" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d0e18",
};

export default function KitaevLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
`);
console.log('Staged /Kitaev assets and route in the selected AIgimon checkout.');
