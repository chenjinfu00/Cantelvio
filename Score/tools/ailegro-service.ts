/**
 * Start the local Cantelvio service for the editor: the reference adapter
 * (integrations/ailegro/score_compose.py --serve) run with Cantelvio's own Python environment and the
 * newest v3.1 weights. The editor's Cantelvio panel then generates, harmonises and analyses with it,
 * and Open reads PDFs / scanned pages (Audiveris) and recordings (MuScriptor + Cantelvio).
 *
 *   npm run cantelvio:serve                                   # ../Compose, newest v3.1 weights, port 8765
 *   npm run cantelvio:serve -- --checkpoint training/runs/four-pillar-v31-step101129/weights.pt
 *   npm run cantelvio:serve -- --cantelvio ~/Cantelvio/Compose --port 8766 -- --threads 2 --candidates 8
 *   npm run cantelvio:serve -- --mock                         # placeholder music, no Cantelvio model needed
 *
 * Paths: --cantelvio (default $CANTELVIO_ROOT, then the sibling folder ../Compose); --python (default
 * <Cantelvio/Compose>/.venv-training/bin/python, or a command on the PATH); --checkpoint (default: the newest
 * <Cantelvio/Compose>/training/runs/four-pillar-v31*\/weights.pt), relative paths are taken from the Compose
 * folder. Arguments after `--` go to score_compose.py unchanged (e.g. --audiveris PATH,
 * --muscriptor-python PATH, --harmonizer none). See docs/try-it.md.
 * The legacy --ailegro option and AILEGRO_ROOT variable remain accepted.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADAPTER = join(REPO, 'integrations', 'ailegro', 'score_compose.py');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cantelvio: { type: 'string' },
    ailegro: { type: 'string' },
    python: { type: 'string' },
    checkpoint: { type: 'string' },
    port: { type: 'string', default: '8765' },
    mock: { type: 'boolean', default: false },
  },
});

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

const root = resolve(
  values.cantelvio ??
    values.ailegro ??
    process.env.CANTELVIO_ROOT ??
    process.env.AILEGRO_ROOT ??
    join(REPO, '..', 'Compose'),
);
const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
const hasAilegro = existsSync(join(root, 'training', 'scripts'));
if (!hasAilegro && !values.mock)
  fail(
    `no Cantelvio project at ${root} (expected training/scripts). ` +
      'Pass --cantelvio <Compose folder> or set CANTELVIO_ROOT, or use --mock.',
  );

const venvPython =
  process.platform === 'win32'
    ? join(root, '.venv-training', 'Scripts', 'python.exe')
    : join(root, '.venv-training', 'bin', 'python');
const python = values.python
  ? /[\\/]/.test(values.python)
    ? fromRoot(values.python)
    : values.python // a command on the PATH
  : existsSync(venvPython)
    ? venvPython
    : values.mock
      ? 'python3'
      : fail(`Cantelvio's Python environment is missing (${venvPython}); pass --python <path>.`);

/** The newest weights of a v3.1 run (a run still training rewrites its weights.pt regularly). */
function newestWeights(): string | null {
  const runs = join(root, 'training', 'runs');
  if (!existsSync(runs)) return null;
  let best: { path: string; time: number } | null = null;
  for (const name of readdirSync(runs)) {
    if (!name.startsWith('four-pillar-v31')) continue;
    const path = join(runs, name, 'weights.pt');
    if (!existsSync(path)) continue;
    const time = statSync(path).mtimeMs;
    if (!best || time > best.time) best = { path, time };
  }
  return best?.path ?? null;
}

const checkpoint = values.checkpoint
  ? fromRoot(values.checkpoint)
  : values.mock
    ? null
    : newestWeights();
if (!values.mock && (!checkpoint || !existsSync(checkpoint)))
  fail(
    checkpoint
      ? `no such weights file: ${checkpoint}`
      : `no v3.1 weights under ${join(root, 'training', 'runs')}; pass --checkpoint <weights.pt>.`,
  );

const args = [ADAPTER, '--serve', '--port', values.port];
if (hasAilegro) args.push('--cantelvio-root', root);
if (values.mock) args.push('--mock');
else args.push('--checkpoint', checkpoint!);
args.push(...positionals);

console.log('Cantelvio service');
console.log(`  Cantelvio     ${hasAilegro ? root : '(none: --mock)'}`);
console.log(`  Python      ${python}`);
if (checkpoint) {
  const saved = new Date(statSync(checkpoint).mtimeMs).toLocaleString();
  console.log(`  weights     ${checkpoint} (saved ${saved})`);
}
console.log(
  `  editor      npm run dev → http://127.0.0.1:5178/ (Cantelvio panel: http://127.0.0.1:${values.port})`,
);
console.log('  stop        Ctrl+C\n');

const child = spawn(python, args, { cwd: hasAilegro ? root : REPO, stdio: 'inherit' });
child.on('error', (e) => fail(`could not start ${python}: ${e.message}`));
child.on('exit', (code, signal) => process.exit(signal ? 0 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
