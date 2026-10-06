import {spawn} from 'node:child_process';
import {readFile, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifestPath = path.join(root, 'training/runs/four-pillar-v1-pilot-20260929/manifest.json');
const checkpointPath = path.join(root, 'training/runs/four-pillar-v2-preview-20261001-step19193/state.pt');
const python = path.join(root, '.venv-training/bin/python');
const script = path.join(root, 'training/scripts/sample_four_pillar_v2_web.py');
const groups = ['woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings'];
const cache = new Map();

export class FourPillarInputError extends Error {}
export class FourPillarBusyError extends Error {}

export async function previewPrompts() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  return manifest.selection.validation.map((entry, index) => ({
    id: index, scoreId: entry.scoreId, work: entry.workId.replaceAll('_', ' '),
    oldPrior: false,
  }));
}

export function normalizeFourPillarOptions(value, count = 5) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FourPillarInputError('Invalid request');
  const prompt = value.prompt ?? 2;
  const seed = value.seed ?? 41977;
  const temperature = value.temperature ?? 0.95;
  const tempo = value.tempo ?? 96;
  const useLegacy = value.useLegacy ?? true;
  const selected = value.groups ?? groups;
  if (!Number.isInteger(prompt) || prompt < 0 || prompt >= count) throw new FourPillarInputError('Unknown prompt');
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999999) throw new FourPillarInputError('Invalid seed');
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0.6 || temperature > 1.3) {
    throw new FourPillarInputError('Temperature must be 0.6–1.3');
  }
  if (!Number.isInteger(tempo) || tempo < 60 || tempo > 160) throw new FourPillarInputError('Tempo must be 60–160 BPM');
  if (typeof useLegacy !== 'boolean') throw new FourPillarInputError('Invalid old-prior setting');
  if (!Array.isArray(selected) || selected.length === 0 || selected.length > groups.length ||
      selected.some(name => !groups.includes(name)) || new Set(selected).size !== selected.length) {
    throw new FourPillarInputError('Choose one or more valid instrument groups');
  }
  return {prompt, seed, temperature, tempo, useLegacy, groups: groups.filter(name => selected.includes(name))};
}

function runSampler(scoreId, options) {
  return new Promise((resolve, reject) => {
    const args = [script, '--score-id', scoreId, '--seed', String(options.seed),
      '--temperature', String(options.temperature), '--groups', options.groups.join(',')];
    args.push('--tempo', String(options.tempo));
    const child = spawn(python, args, {cwd: root, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '', timedOut = false, settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 300000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (stdout.length > 2_000_000) child.kill('SIGTERM');
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-5000); });
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0) { finish(new Error(timedOut ? 'Preview timed out' : `Sampler exited ${code}: ${stderr}`)); return; }
      try { finish(null, JSON.parse(stdout)); } catch (error) { finish(error); }
    });
  });
}

let busy = false;
export async function generateFourPillarPreview(raw) {
  const prompts = await previewPrompts();
  const options = normalizeFourPillarOptions({...raw, useLegacy: false}, prompts.length);
  const checkpoint = await stat(checkpointPath);
  const key = JSON.stringify({options: options, size: checkpoint.size, modified: checkpoint.mtimeMs});
  let sample = cache.get(key);
  if (!sample) {
    if (busy) throw new FourPillarBusyError('A preview is already generating; try again shortly');
    busy = true;
    try {
      sample = await runSampler(prompts[options.prompt].scoreId, options);
      if (sample.generatedBars !== 2 || !Array.isArray(sample.notes) ||
          sample.notes.some(note => !Number.isFinite(note.quarter) || !Number.isFinite(note.duration) ||
            !Number.isInteger(note.pitch) || !groups.includes(note.group))) {
        throw new Error('Invalid preview from sampler');
      }
      if (cache.size > 15) cache.delete(cache.keys().next().value);
      cache.set(key, sample);
    } finally { busy = false; }
  }
  return {prompt: prompts[options.prompt], options, checkpoint: 'four-pillar-v2-preview-20261001-step19193/state.pt',
    sample: {...sample, barEvents: sample.barEvents}};
}
