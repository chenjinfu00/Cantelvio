import test from 'node:test';
import assert from 'node:assert/strict';
import { configurePlaybackSession, resumePlaybackContext } from '../public/karaoke/audio-session.js';

test('recorded and realtime music request playback routing when available', () => {
  const nav = { audioSession: { type: 'auto' } };
  configurePlaybackSession(nav);
  assert.equal(nav.audioSession.type, 'playback');
  assert.doesNotThrow(() => configurePlaybackSession({}));
  assert.doesNotThrow(() => configurePlaybackSession({ get audioSession() { throw Error('not supported'); } }));
});

test('interrupted contexts are resumed and a failed resume never looks ready', async () => {
  let resumes = 0;
  const context = { state: 'interrupted', async resume() { resumes++; this.state = 'running'; } };
  assert.equal(await resumePlaybackContext(context), context);
  assert.equal(resumes, 1);
  await resumePlaybackContext(context);
  assert.equal(resumes, 1);
  await assert.rejects(resumePlaybackContext({ state: 'interrupted', async resume() {} }), /paused/);
  await assert.rejects(resumePlaybackContext({ state: 'closed' }), /closed/);
});
