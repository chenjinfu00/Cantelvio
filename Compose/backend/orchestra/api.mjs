import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runDir = path.join(root, 'training/orchestra/work/runs');
const sampleDir = path.join(root, 'training/orchestra/work/samples');
const python = path.join(root, '.venv-training/bin/python');
const sampler = path.join(root, 'training/orchestra/sample.py');
const groupNames = ['woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings'];

export const models = Object.freeze([
  {id: 'abl-absolute', validation: 2.42060, transposed: 2.49626, pitch: 'absolute', augmented: false, register: true},
  {id: 'abl-absolute-aug', validation: 2.50308, transposed: 2.56317, pitch: 'absolute', augmented: true, register: true},
  {id: 'abl-rotary', validation: 1.82644, transposed: 1.83039, pitch: 'rotary', augmented: false, register: true},
  {id: 'abl-rotary-aug', validation: 1.80978, transposed: 1.81288, pitch: 'rotary', augmented: true, register: true},
  {id: 'abl-rotary-exact-aug', validation: 1.83727, transposed: 1.83845, pitch: 'rotary', augmented: true, register: false},
]);
const modelIds = new Set(models.map(model => model.id));

export class PreviewInputError extends Error {}
export class PreviewBusyError extends Error {}

export function normalizePreviewOptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PreviewInputError('Invalid request');
  const model = value.model ?? 'abl-rotary-aug';
  const bars = value.bars ?? 8;
  const seed = value.seed ?? 41977;
  const tempo = value.tempo ?? 96;
  const temperature = value.temperature ?? 0.9;
  const topP = value.topP ?? 0.95;
  if (!modelIds.has(model)) throw new PreviewInputError('Unknown model');
  if (![4, 8, 16].includes(bars)) throw new PreviewInputError('Bars must be 4, 8 or 16');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999999) throw new PreviewInputError('Invalid seed');
  if (!Number.isInteger(tempo) || tempo < 60 || tempo > 160) throw new PreviewInputError('Tempo must be 60–160 BPM');
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0.6 || temperature > 1.3) {
    throw new PreviewInputError('Temperature must be 0.6–1.3');
  }
  if (typeof topP !== 'number' || !Number.isFinite(topP) || topP < 0.75 || topP > 1) {
    throw new PreviewInputError('Top-p must be 0.75–1.0');
  }
  const inputGroups = value.groups ?? {};
  if (!inputGroups || typeof inputGroups !== 'object' || Array.isArray(inputGroups) ||
      Object.keys(inputGroups).some(name => !groupNames.includes(name))) throw new PreviewInputError('Invalid groups');
  const groups = Object.fromEntries(groupNames.map(name => {
    const state = inputGroups[name] ?? (name.endsWith('strings') ? 'on' : 'auto');
    if (!['on', 'auto', 'off'].includes(state)) throw new PreviewInputError(`Invalid ${name} state`);
    return [name, state];
  }));
  if (Object.values(groups).every(state => state === 'off')) throw new PreviewInputError('At least one group must be available');
  return {model, bars, seed, tempo, temperature, topP, groups};
}

async function hasFile(file) {
  try { return (await stat(file)).isFile(); } catch { return false; }
}

function runSampler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [sampler, ...args], {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    let stderr = '';
    let timedOut = false;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-3000); });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 120000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(timedOut ? 'Generation timed out' : `Sampler exited ${code}: ${stderr}`));
    });
  });
}

let generationTail = Promise.resolve();
let waiting = 0;

export async function inGenerationQueue(task) {
  if (waiting >= 8) throw new PreviewBusyError('Generation queue is full');
  waiting++;
  const previous = generationTail;
  let release;
  generationTail = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await task(); }
  finally { waiting--; release(); }
}

export async function generatePreview(raw) {
  const options = normalizePreviewOptions(raw);
  const checkpoint = path.join(runDir, options.model, 'best.pt');
  const checkpointInfo = await stat(checkpoint);
  // The original sampler already used top-p=.95; keep its cache key for that default.
  const cacheOptions = options.topP === 0.95 ? (({model, bars, seed, tempo, temperature, groups}) =>
    ({model, bars, seed, tempo, temperature, groups}))(options) : options;
  const hash = createHash('sha256').update(JSON.stringify({options: cacheOptions, size: checkpointInfo.size,
    mtime: checkpointInfo.mtimeMs})).digest('hex').slice(0, 12);
  const base = `${options.model}-${hash}`;
  const midi = path.join(sampleDir, `${base}.mid`);
  const events = path.join(sampleDir, `${base}.json`);
  await mkdir(sampleDir, {recursive: true});
  if (!(await hasFile(midi) && await hasFile(events))) {
    await inGenerationQueue(async () => {
      if (await hasFile(midi) && await hasFile(events)) return;
      const groups = Object.entries(options.groups).map(([name, state]) => `${name}=${state}`).join(',');
      await runSampler([checkpoint, midi, '--events-json', events, '--bars', String(options.bars),
        '--meter', '4/4', '--tempo', String(options.tempo), '--temperature', String(options.temperature),
        '--top-p', String(options.topP), '--seed', String(options.seed), '--groups', groups, '--device', 'cpu']);
    });
  }
  const sample = JSON.parse(await readFile(events, 'utf8'));
  return {model: options.model, options, sample, midiUrl: `/training/orchestra/work/samples/${base}.mid`};
}
