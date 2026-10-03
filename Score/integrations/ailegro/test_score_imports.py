#!/usr/bin/env python3
"""Tests of the adapter's import jobs with stand-in tools (no Audiveris, MuScriptor, AIlegro or torch needed).

    python3 integrations/ailegro/test_score_imports.py        # or: npm run test:adapter
"""
from __future__ import annotations

import base64
import json
import os
import stat
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import score_compose  # noqa: E402
import score_imports as imports  # noqa: E402

FAKE_AUDIVERIS = textwrap.dedent('''\
    #!{python}
    import sys, time, zipfile
    from pathlib import Path
    args = sys.argv[1:]
    out = Path(args[args.index('-output') + 1])
    source = Path(args[args.index('--') + 1])
    sheets = args[args.index('-sheets') + 1:args.index('--')] if '-sheets' in args else []
    if source.read_bytes().startswith(b'SLOW'):
        time.sleep(30)
    print(f'2026-10-03 11:31:08,278 INFO [x]  Book.java:560  | 2 sheets in {{source}}', flush=True)
    for k in (1, 2):
        print(f'2026-10-03 11:31:09,000 INFO [x#{{k}}]  StepMonitoring.java:98   | HEADS', flush=True)
        print(f'2026-10-03 11:31:10,000 INFO [x#{{k}}]  SheetStub.java:1655 | Sheet#{{k}} disposed', flush=True)
    print("WARN  [x]  could not run OCR: couldn't load any languages", flush=True)
    print('2026-10-03 11:31:48,292 INFO [x]  PartwiseBuilder.java:2707 | Exporting sheet(s): [#1#2]', flush=True)
    with zipfile.ZipFile(out / (source.stem + '.mxl'), 'w') as z:
        z.writestr('score.xml', '<score-partwise version="4.0"/>' + ' '.join(sheets))
''')

FAKE_TRANSCRIBE = textwrap.dedent('''\
    import argparse, json, sys
    p = argparse.ArgumentParser()
    p.add_argument('audio'); p.add_argument('--output'); p.add_argument('--instruments')
    a = p.parse_args()
    if open(a.audio, 'rb').read().startswith(b'FAIL'):
        print('Traceback: no model'); sys.exit(3)
    print('loading model', flush=True); print('loaded in 1 s; transcribing x', flush=True)
    print('  1/2 chunks', flush=True); print('  2/2 chunks', flush=True)
    print('3 notes; tracking beats', flush=True)
    json.dump({'schema': 'ailegro.transcription/1', 'notes': [[0.5, 1.0, 60, 'acoustic_piano']],
               'beats': [0.5, 1.0], 'downbeats': [0.5], 'instruments': a.instruments}, open(a.output, 'w'))
''')

FAKE_SCORE = textwrap.dedent('''\
    import argparse, json
    p = argparse.ArgumentParser()
    p.add_argument('transcription'); p.add_argument('--output'); p.add_argument('--report')
    p.add_argument('--title'); p.add_argument('--piano', action='store_true'); p.add_argument('--metre')
    p.add_argument('--keep-all', action='store_true'); p.add_argument('--analyzer')
    a = p.parse_args()
    doc = json.load(open(a.transcription))
    open(a.output, 'w', encoding='utf-8').write('<score-partwise version="4.0"><work><work-title>'
                                                + a.title + '</work-title></work></score-partwise>')
    json.dump({'notes': 1, 'kept': 1, 'metre': a.metre or '4/4', 'piano': a.piano, 'keepAll': a.keep_all,
               'instruments': doc['instruments']}, open(a.report, 'w'))
''')


def wait(job: imports.Job, seconds: float = 20) -> imports.Job:
    end = time.time() + seconds
    while job.state in ('queued', 'running') and time.time() < end:
        time.sleep(.05)
    return job


class ImportJobs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name) / 'AIlegro'
        scripts = root / 'training' / 'scripts'
        scripts.mkdir(parents=True)
        (scripts / 'audio_transcribe_muscriptor.py').write_text(FAKE_TRANSCRIBE)
        (scripts / 'audio_to_score.py').write_text(FAKE_SCORE)
        audiveris = Path(cls.tmp.name) / 'Audiveris'
        audiveris.write_text(FAKE_AUDIVERIS.format(python=sys.executable))
        audiveris.chmod(audiveris.stat().st_mode | stat.S_IXUSR)
        cls.root = root
        cls.tools = imports.Tools(root, str(audiveris), muscriptor_python=sys.executable)
        cls.jobs = imports.Jobs(cls.tools)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_tools_found(self):
        info = self.tools.describe()
        self.assertTrue(info['pdf'] and info['audio'], info)
        self.assertIn('acoustic_piano', info['instruments'])
        missing = imports.Tools(None, str(Path(self.tmp.name) / 'nope')).describe()
        self.assertFalse(missing['pdf'] or missing['audio'])
        self.assertIn('Audiveris', missing['why']['pdf'])
        default = imports.Tools(self.root)        # MuScriptor's default environment is absent here
        self.assertIn('MuScriptor', default.describe()['why']['audio'])

    def test_pdf_job(self):
        job = wait(self.jobs.submit('pdf', '../My Score.pdf', b'%PDF-1.4', {'sheets': '1 2'}))
        self.assertEqual(job.state, 'done', job.snapshot())
        self.assertEqual(job.name, 'My_Score.pdf')
        self.assertEqual(job.progress, (2, 2))
        result = job.snapshot()['result']
        self.assertEqual([f['name'] for f in result['files']], ['My_Score.mxl'])
        self.assertEqual(result['files'][0]['format'], 'mxl')
        self.assertTrue(base64.b64decode(result['files'][0]['data']).startswith(b'PK'))
        self.assertTrue(any('OCR language' in w for w in result['warnings']))
        self.assertFalse((job.workdir / job.name).exists(), 'the upload is removed after the run')

    def test_audio_job_passes_options(self):
        job = wait(self.jobs.submit('audio', 'take 1.wav', b'RIFF....', {
            'instruments': ['acoustic_piano', 'voice'], 'metre': '6/8', 'piano': True, 'title': 'Take one'}))
        self.assertEqual(job.state, 'done', job.snapshot())
        result = job.snapshot()['result']
        self.assertEqual(result['files'][0]['name'], 'take_1.musicxml')
        xml = base64.b64decode(result['files'][0]['data']).decode('utf-8')
        self.assertIn('<work-title>Take one</work-title>', xml)
        self.assertEqual(result['report']['metre'], '6/8')
        self.assertTrue(result['report']['piano'])
        self.assertEqual(result['report']['instruments'], 'acoustic_piano,voice')

    def test_audio_failure_is_reported(self):
        job = wait(self.jobs.submit('audio', 'bad.wav', b'FAIL', {}))
        self.assertEqual(job.state, 'failed')
        self.assertIn('MuScriptor failed', job.error)
        self.assertIn('no model', job.error)

    def test_refusals(self):
        for kind, name, options, message in (
                ('pdf', 'score.docx', {}, 'not a PDF'), ('audio', 'song.txt', {}, 'not an audio file'),
                ('audio', 'song.wav', {'metre': '7/9'}, 'bad metre'),
                ('audio', 'song.wav', {'instruments': ['Piano!']}, 'instrument group'),
                ('pdf', 'score.pdf', {'sheets': '1; rm -rf /'}, 'sheet list'), ('midi', 'x.mid', {}, 'kind')):
            with self.subTest(name=name), self.assertRaisesRegex(imports.ImportRefused, message):
                self.jobs.submit(kind, name, b'x', options)

    def test_cancel(self):
        job = self.jobs.submit('pdf', 'slow.pdf', b'SLOW', {})
        end = time.time() + 10
        while job.proc is None and time.time() < end:
            time.sleep(.05)
        self.jobs.cancel(job.id)
        self.assertEqual(wait(job).state, 'cancelled')


class Server(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ImportJobs.setUpClass()
        handler = score_compose.make_handler(score_compose.MockModel(), None, set(), ImportJobs.jobs)
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), handler)
        cls.base = f'http://127.0.0.1:{cls.httpd.server_address[1]}'
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        ImportJobs.tearDownClass()

    def call(self, method: str, path: str, body: bytes | None = None, origin: str = 'http://127.0.0.1:5178'):
        req = urllib.request.Request(self.base + path, data=body, method=method, headers={'Origin': origin})
        try:
            with urllib.request.urlopen(req) as res:
                return res.status, json.loads(res.read()), res.headers
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read()), e.headers

    def test_health_lists_imports(self):
        status, body, _ = self.call('GET', '/health')
        self.assertEqual(status, 200)
        self.assertTrue(body['imports']['pdf'] and body['imports']['audio'])
        self.assertEqual(body['job'], imports.JOB_SCHEMA)

    def test_upload_poll_and_cors(self):
        status, job, headers = self.call('POST', '/import/pdf?name=chorale.pdf', b'%PDF')
        self.assertEqual(status, 202, job)
        self.assertEqual(headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:5178')
        for _ in range(200):
            status, job, _ = self.call('GET', f'/jobs/{job["id"]}')
            if job['state'] not in ('queued', 'running'):
                break
            time.sleep(.05)
        self.assertEqual(job['state'], 'done', job)
        self.assertEqual(job['result']['files'][0]['name'], 'chorale.mxl')
        status, body, _ = self.call('POST', '/import/audio?name=a.wav&metre=x', b'RIFF')
        self.assertEqual(status, 422)
        self.assertIn('bad metre', body['error'])
        self.assertEqual(self.call('GET', '/jobs/nope')[0], 404)
        self.assertEqual(self.call('DELETE', '/jobs/nope')[0], 404)
        self.assertEqual(self.call('POST', '/import/pdf?name=x.pdf', b'%PDF', origin='https://evil.example')[0], 403)


if __name__ == '__main__':
    os.environ.pop('AUDIVERIS', None)
    unittest.main(verbosity=2)
