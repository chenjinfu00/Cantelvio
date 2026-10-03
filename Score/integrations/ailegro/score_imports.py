"""Background import jobs of the adapter server: a PDF or scanned page through Audiveris, a recording through
MuScriptor and AIlegro's audio_to_score.py. The editor uploads the file, polls the job and imports the MusicXML
it gets back (see docs/ailegro-integration.md, "本机服务的导入任务", and ADR 0013).

Only the standard library: the tools run as separate processes, so this module works without torch, without
AIlegro (PDF only) and in the adapter's --mock mode.
"""
from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections import OrderedDict, deque
from pathlib import Path

JOB_SCHEMA = 'ailegro-score.import-job/1'
PDF_SUFFIXES = ('.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp')
AUDIO_SUFFIXES = ('.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.aif', '.aiff')
MAX_UPLOAD = 512 * 1024 * 1024
KEEP_SECONDS = 3600          # finished jobs (and their files) are dropped after an hour
LOG_LINES = 40
# Common MuScriptor instrument groups (`muscriptor list-instruments` has the full list); the editor offers these
# as hints for --instruments, the service passes any well-formed group name on.
COMMON_GROUPS = (
    'acoustic_piano', 'voice', 'violin', 'viola', 'cello', 'contrabass', 'string_ensemble', 'flutes', 'oboe',
    'clarinet', 'bassoon', 'french_horn', 'trumpet', 'trombone', 'tuba', 'timpani', 'orchestral_harp', 'organ',
    'acoustic_guitar', 'electric_piano')
GROUP = re.compile(r'^[a-z][a-z_]{1,39}$')
METRE = re.compile(r'^\d{1,2}/(1|2|4|8|16)$')
SHEETS = re.compile(r'^[0-9 ,-]{1,64}$')


class ImportRefused(Exception):
    """A request the import service refuses (bad file type, missing tool): reported to the editor as is."""


# ------------------------------------------------------------------------------------------------- tools

def find_audiveris(explicit: str | None = None) -> Path | None:
    """The Audiveris launcher: --audiveris, $AUDIVERIS, the PATH, then the installers' default places."""
    explicit = explicit or os.environ.get('AUDIVERIS')
    if explicit:
        return Path(explicit) if Path(explicit).is_file() else None
    for name in ('audiveris', 'Audiveris', 'Audiveris.exe'):
        found = shutil.which(name)
        if found:
            return Path(found)
    for p in ('/Applications/Audiveris.app/Contents/MacOS/Audiveris',
              str(Path.home() / 'Applications/Audiveris.app/Contents/MacOS/Audiveris'),
              '/opt/audiveris/bin/Audiveris', r'C:\Program Files\Audiveris\Audiveris.exe'):
        if Path(p).is_file():
            return Path(p)
    return None


class Tools:
    """Where the external programs are, and why a feature is unavailable when one is missing."""

    def __init__(self, ailegro_root: Path | None, audiveris: str | None = None,
                 muscriptor_python: str | None = None, score_python: str | None = None):
        self.audiveris = find_audiveris(audiveris)
        root = ailegro_root
        scripts = root / 'training' / 'scripts' if root else None
        self.transcribe_script = scripts / 'audio_transcribe_muscriptor.py' if scripts else None
        self.score_script = scripts / 'audio_to_score.py' if scripts else None
        default_python = root / 'MuScriptor-large-1.3B' / '.venv-py312' / 'bin' / 'python' if root else None
        self.muscriptor_python = Path(muscriptor_python) if muscriptor_python else default_python
        self.muscriptor_weights = root / 'MuScriptor-large-1.3B' / 'model.safetensors' if root else None
        self.score_python = score_python or sys.executable
        self.pdf_missing = None if self.audiveris else (
            'Audiveris was not found: install it (docs/pdf-import.md) or start the service with --audiveris PATH')
        missing = []
        if root is None:
            missing.append('no AIlegro project (--ailegro-root)')
        else:
            for label, path in (('audio_transcribe_muscriptor.py', self.transcribe_script),
                                ('audio_to_score.py', self.score_script),
                                ("MuScriptor's Python (--muscriptor-python)", self.muscriptor_python)):
                if not path or not path.exists():
                    missing.append(f'{label} not found ({path})')
        self.audio_missing = '; '.join(missing) or None

    def describe(self) -> dict:
        return {'pdf': self.pdf_missing is None, 'audio': self.audio_missing is None,
                'audiveris': str(self.audiveris) if self.audiveris else None,
                'muscriptor': str(self.muscriptor_python) if self.audio_missing is None else None,
                'muscriptorWeights': bool(self.muscriptor_weights and self.muscriptor_weights.is_file()),
                'why': {k: v for k, v in (('pdf', self.pdf_missing), ('audio', self.audio_missing)) if v},
                'pdfSuffixes': list(PDF_SUFFIXES), 'audioSuffixes': list(AUDIO_SUFFIXES),
                'instruments': list(COMMON_GROUPS)}


# -------------------------------------------------------------------------------------------------- jobs

class Cancelled(Exception):
    pass


class Job:
    def __init__(self, kind: str, name: str, options: dict):
        self.id = uuid.uuid4().hex[:12]
        self.kind = kind
        self.name = name
        self.options = options
        self.state = 'queued'
        self.stage = 'queued'
        self.progress: tuple[int, int] | None = None
        self.log: deque[str] = deque(maxlen=LOG_LINES)
        self.created = time.time()
        self.started: float | None = None
        self.finished: float | None = None
        self.result: dict | None = None
        self.error: str | None = None
        self.cancelled = False
        self.proc: subprocess.Popen | None = None
        self.workdir = Path(tempfile.mkdtemp(prefix=f'ailegro-{kind}-'))

    def snapshot(self, with_result: bool = True) -> dict:
        now = time.time()
        out = {'schema': JOB_SCHEMA, 'id': self.id, 'kind': self.kind, 'name': self.name, 'state': self.state,
               'stage': self.stage, 'progress': list(self.progress) if self.progress else None,
               'elapsed': round((self.finished or now) - (self.started or now), 1), 'log': list(self.log)[-12:]}
        if self.error:
            out['error'] = self.error
        if with_result and self.result is not None:
            out['result'] = self.result
        return out

    def run(self, cmd: list[str], cwd: Path | None, on_line) -> int:
        """Run a tool, feeding each output line to `on_line`; stops the process when the job is cancelled."""
        if self.cancelled:
            raise Cancelled()
        env = dict(os.environ, PYTHONUNBUFFERED='1')
        self.proc = subprocess.Popen(cmd, cwd=str(cwd) if cwd else None, stdin=subprocess.DEVNULL,
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                                     encoding='utf-8', errors='replace', env=env)
        try:
            for line in self.proc.stdout:
                line = line.rstrip()
                if line:
                    self.log.append(line[-300:])
                    on_line(line)
            return self.proc.wait()
        finally:
            if self.proc and self.proc.stdout:
                self.proc.stdout.close()
            self.proc = None
            if self.cancelled:
                raise Cancelled()


class Jobs:
    """Import jobs; one tool runs at a time (they are heavy), the others wait in the queue."""

    def __init__(self, tools: Tools):
        self.tools = tools
        self.jobs: OrderedDict[str, Job] = OrderedDict()
        self.lock = threading.Lock()
        self.heavy = threading.Lock()

    def submit(self, kind: str, name: str, data: bytes, options: dict) -> Job:
        name = safe_name(name)
        suffix = Path(name).suffix.lower()
        if kind == 'pdf':
            if self.tools.pdf_missing:
                raise ImportRefused(self.tools.pdf_missing)
            if suffix not in PDF_SUFFIXES:
                raise ImportRefused(f'not a PDF or image Audiveris reads: {name}')
            sheets = options.get('sheets')
            if sheets and not SHEETS.match(sheets):
                raise ImportRefused(f'bad sheet list: {sheets!r}')
        elif kind == 'audio':
            if self.tools.audio_missing:
                raise ImportRefused(self.tools.audio_missing)
            if suffix not in AUDIO_SUFFIXES:
                raise ImportRefused(f'not an audio file: {name}')
            bad = [g for g in options.get('instruments') or [] if not GROUP.match(g)]
            if bad:
                raise ImportRefused(f'bad MuScriptor instrument group name(s): {", ".join(bad)}')
            metre = options.get('metre')
            if metre and not METRE.match(metre):
                raise ImportRefused(f'bad metre: {metre!r} (e.g. 3/4 or 6/8)')
        else:
            raise ImportRefused(f'unknown import kind: {kind}')
        if not data:
            raise ImportRefused('empty file')
        self.prune()
        job = Job(kind, name, options)
        (job.workdir / name).write_bytes(data)
        with self.lock:
            self.jobs[job.id] = job
        threading.Thread(target=self._work, args=(job,), daemon=True, name=f'import-{job.id}').start()
        return job

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        job = self.get(job_id)
        if job and job.state in ('queued', 'running'):
            job.cancelled = True
            proc = job.proc
            if proc and proc.poll() is None:
                proc.terminate()
                threading.Timer(5, lambda: proc.poll() is None and proc.kill()).start()
        return job

    def prune(self) -> None:
        now = time.time()
        with self.lock:
            for job_id, job in list(self.jobs.items()):
                if job.finished and now - job.finished > KEEP_SECONDS:
                    shutil.rmtree(job.workdir, ignore_errors=True)
                    del self.jobs[job_id]

    def _work(self, job: Job) -> None:
        try:
            with self.heavy:
                if job.cancelled:
                    raise Cancelled()
                job.state, job.started = 'running', time.time()
                job.result = (run_pdf if job.kind == 'pdf' else run_audio)(job, self.tools)
                job.state, job.stage = 'done', 'done'
        except Cancelled:
            job.state, job.stage, job.error = 'cancelled', 'cancelled', 'cancelled'
        except ImportRefused as e:
            job.state, job.error = 'failed', str(e)
        except Exception as e:  # noqa: BLE001  report tool failures to the editor
            job.state, job.error = 'failed', f'{type(e).__name__}: {e}'
        finally:
            job.finished = time.time()
            job.started = job.started or job.finished
            for path in job.workdir.iterdir() if job.workdir.exists() else ():
                if path.is_file() and path.suffix.lower() in PDF_SUFFIXES + AUDIO_SUFFIXES:
                    path.unlink(missing_ok=True)   # keep the uploads only while the tool runs


def safe_name(name: str) -> str:
    base = Path(str(name).replace('\\', '/')).name.strip() or 'upload'
    base = re.sub(r'[^\w.\- ]+', '_', base)[-120:].strip(' .') or 'upload'
    return base.replace(' ', '_')


def encoded(path: Path, fmt: str) -> dict:
    return {'name': path.name, 'format': fmt, 'data': base64.b64encode(path.read_bytes()).decode('ascii')}


# ------------------------------------------------------------------------------------------------ runners

SHEETS_IN = re.compile(r'\|\s*(\d+) sheets? in ')
SHEET_STEP = re.compile(r'\[[^\]]*#(\d+)\]\s+StepMonitoring\.java:\d+\s*\|\s*([A-Z_]+)')
SHEET_DONE = re.compile(r'Sheet#(\d+) disposed')
CHUNKS = re.compile(r'(\d+)\s*/\s*(\d+)\s+chunks')


def movement_order(path: Path) -> tuple[int, str]:
    """Audiveris writes <stem>.mxl, or <stem>.mvt<N>.mxl when it finds several movements."""
    m = re.search(r'\.mvt(\d+)\.mxl$', path.name, re.I)
    return (int(m.group(1)) if m else 0, path.name)


def run_pdf(job: Job, tools: Tools) -> dict:
    """Audiveris -batch -export → one .mxl per movement, returned as is (the editor imports them)."""
    source = job.workdir / job.name
    out = job.workdir / 'out'
    out.mkdir()
    cmd = [str(tools.audiveris), '-batch', '-export', '-output', str(out)]
    if job.options.get('sheets'):
        cmd += ['-sheets', *[s for s in re.split(r'[\s,]+', job.options['sheets']) if s]]
    cmd += ['--', str(source)]
    job.stage = 'recognising'
    state = {'total': 1, 'done': 0}

    def on_line(line: str) -> None:
        if m := SHEETS_IN.search(line):
            state['total'] = int(m.group(1))
        elif m := SHEET_DONE.search(line):
            state['done'] = max(state['done'], int(m.group(1)))
        elif m := SHEET_STEP.search(line):
            job.stage = f'recognising:{m.group(2).lower()}'
        elif 'Exporting sheet' in line:
            job.stage = 'exporting'
        job.progress = (state['done'], state['total'])

    code = job.run(cmd, job.workdir, on_line)
    log = '\n'.join(job.log)
    files = sorted(out.rglob('*.mxl'), key=movement_order)
    if not files:
        raise ImportRefused(f'Audiveris produced no MusicXML (exit code {code}): ' +
                           ' | '.join(list(job.log)[-4:]))
    warnings = []
    if re.search(r"couldn't load any languages|Missing support for", log, re.I):
        warnings.append('Audiveris has no OCR language installed: titles, part names and lyrics were not read '
                        '(Audiveris: Tools › Install languages)')
    return {'files': [encoded(p, 'mxl') for p in files], 'warnings': warnings,
            'report': {'sheets': state['total'], 'movements': len(files), 'tool': 'Audiveris'}}


def run_audio(job: Job, tools: Tools) -> dict:
    """MuScriptor (its own Python environment) → notes and beats; AIlegro's audio_to_score.py → MusicXML."""
    source = job.workdir / job.name
    notes = job.workdir / 'transcription.notes.json'
    root = tools.transcribe_script.parents[2]
    cmd = [str(tools.muscriptor_python), str(tools.transcribe_script), str(source), '--output', str(notes)]
    if job.options.get('instruments'):
        cmd += ['--instruments', ','.join(job.options['instruments'])]
    job.stage = 'loading'

    def on_transcribe(line: str) -> None:
        if m := CHUNKS.search(line):
            job.stage = 'transcribing'
            job.progress = (int(m.group(1)), int(m.group(2)))
        elif line.startswith('loaded') or 'transcribing' in line:
            job.stage = 'transcribing'
        elif 'tracking beats' in line:
            job.stage, job.progress = 'beats', None

    code = job.run(cmd, root, on_transcribe)
    if code != 0 or not notes.is_file():
        raise ImportRefused(f'MuScriptor failed (exit code {code}): ' + ' | '.join(list(job.log)[-4:]))
    stem = Path(job.name).stem
    xml = job.workdir / f'{stem}.musicxml'
    report = job.workdir / 'report.json'
    cmd = [tools.score_python, str(tools.score_script), str(notes), '--output', str(xml), '--report', str(report),
           '--title', job.options.get('title') or stem.replace('_', ' ')]
    if job.options.get('piano'):
        cmd.append('--piano')
    if job.options.get('metre'):
        cmd += ['--metre', job.options['metre']]
    if job.options.get('keepAll'):
        cmd.append('--keep-all')
    job.stage, job.progress = 'score', None
    code = job.run(cmd, root, lambda line: None)
    if code != 0 or not xml.is_file():
        raise ImportRefused(f'audio_to_score.py failed (exit code {code}): ' + ' | '.join(list(job.log)[-4:]))
    details = json.loads(report.read_text()) if report.is_file() else {}
    return {'files': [encoded(xml, 'musicxml')], 'warnings': [], 'report': details}
