import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inGenerationQueue, normalizePreviewOptions, PreviewInputError} from './api.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const work = path.join(root, 'training/orchestra/work');
const python = path.join(root, '.venv-training/bin/python');
const script = path.join(root, 'training/orchestra/stream.py');
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script, ...args], {cwd: root, stdio: ['ignore', 'ignore', 'pipe']});
    let errorText = '';
    let timedOut = false;
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-3000); });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(timedOut ? 'Continuous generation timed out' : `Continuation failed (${code}): ${errorText}`));
    });
  });
}

export async function continuePreview(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PreviewInputError('Invalid request');
  const options = normalizePreviewOptions({...raw, bars: 4});
  const index = raw.index ?? 0;
  if (!Number.isSafeInteger(index) || index < 0 || index > 1000000) throw new PreviewInputError('Invalid segment index');
  const id = raw.session ?? randomUUID();
  if (!idPattern.test(id)) throw new PreviewInputError('Invalid session');
  if (!raw.session && index !== 0) throw new PreviewInputError('A new session must start at segment zero');
  const state = path.join(work, 'sessions', `${id}.json`);
  const base = `${id}-${index}`;
  const midi = path.join(work, 'samples', `${base}.mid`);
  const events = path.join(work, 'samples', `${base}.json`);
  await mkdir(path.dirname(state), {recursive: true});
  await mkdir(path.dirname(midi), {recursive: true});
  return inGenerationQueue(async () => {
    let previous = null;
    try { previous = JSON.parse(await readFile(state, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (raw.session && !previous) throw new PreviewInputError('Session not found');
    if (previous && (previous.checkpoint !== options.model || previous.seed !== options.seed)) {
      throw new PreviewInputError('Model or seed changed; start a new continuous session');
    }
    const readyIndex = previous ? previous.nextBar / 4 : 0;
    if (index > readyIndex) throw new PreviewInputError('Segment requested out of order');
    if (index === readyIndex) {
      const groups = Object.entries(options.groups).map(([name, value]) => `${name}=${value}`).join(',');
      await run([path.join(work, 'runs', options.model, 'best.pt'), state, midi, events,
        '--seed', String(options.seed), '--bars', '4', '--tempo', String(options.tempo),
        '--temperature', String(options.temperature), '--top-p', String(options.topP), '--groups', groups]);
    }
    const sample = JSON.parse(await readFile(events, 'utf8'));
    return {session: id, index, model: options.model, options, sample,
      midiUrl: `/training/orchestra/work/samples/${base}.mid`};
  });
}
