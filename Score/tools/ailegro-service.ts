/**
 * Start the local AIlegro service for the editor: the reference adapter
 * (integrations/ailegro/score_compose.py --serve) run with AIlegro's own Python environment and the
 * newest v3.1 weights. The editor's AIlegro panel then generates, harmonises and analyses with it,
 * and Open reads PDFs / scanned pages (Audiveris) and recordings (MuScriptor + AIlegro).
 *
 *   npm run ailegro:serve                                   # ../AIlegro, newest v3.1 weights, port 8765
 *   npm run ailegro:serve -- --checkpoint training/runs/four-pillar-v31-step101129/weights.pt
 *   npm run ailegro:serve -- --ailegro ~/AIlegro --port 8766 -- --threads 2 --candidates 8
 *   npm run ailegro:serve -- --mock                         # placeholder music, no AIlegro model needed
 *
 * Paths: --ailegro (default $AILEGRO_ROOT, then the sibling folder ../AIlegro); --python (default
 * <AIlegro>/.venv-training/bin/python, or a command on the PATH); --checkpoint (default: the newest
 * <AIlegro>/training/runs/four-pillar-v31*\/weights.pt), relative paths are taken from the AIlegro
 * folder. Arguments after `--` go to score_compose.py unchanged (e.g. --audiveris PATH,
 * --muscriptor-python PATH, --harmonizer none). See docs/try-it.md.
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

const root = resolve(values.ailegro ?? process.env.AILEGRO_ROOT ?? join(REPO, '..', 'AIlegro'));
const fromRoot = (p: string) => (isAbsolute(p) ? p : resolve(root, p));
const hasAilegro = existsSync(join(root, 'training', 'scripts'));
if (!hasAilegro && !values.mock)
  fail(
    `no AIlegro project at ${root} (expected training/scripts). ` +
      'Pass --ailegro <folder> or set AILEGRO_ROOT, or use --mock.',
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
      : fail(`AIlegro's Python environment is missing (${venvPython}); pass --python <path>.`);

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
if (hasAilegro) args.push('--ailegro-root', root);
if (values.mock) args.push('--mock');
else args.push('--checkpoint', checkpoint!);
args.push(...positionals);

console.log('AIlegro service');
console.log(`  AIlegro     ${hasAilegro ? root : '(none: --mock)'}`);
console.log(`  Python      ${python}`);
if (checkpoint) {
  const saved = new Date(statSync(checkpoint).mtimeMs).toLocaleString();
  console.log(`  weights     ${checkpoint} (saved ${saved})`);
}
console.log(
  `  editor      npm run dev → http://127.0.0.1:5178/ (AIlegro panel: http://127.0.0.1:${values.port})`,
);
console.log('  stop        Ctrl+C\n');

const child = spawn(python, args, { cwd: hasAilegro ? root : REPO, stdio: 'inherit' });
child.on('error', (e) => fail(`could not start ${python}: ${e.message}`));
child.on('exit', (code, signal) => process.exit(signal ? 0 : (code ?? 0)));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => child.kill(sig));
