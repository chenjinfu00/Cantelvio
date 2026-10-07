/** Local SoundFont synthesizer. Destroying the worklet cancels scheduled notes on Stop. */
import type { PlaybackNote } from '@cantelvio-score/core';
import type { WorkletSynthesizer } from 'spessasynth_lib';
import processorUrl from 'spessasynth_lib/dist/spessasynth_processor.min.js?url';

let synth: WorkletSynthesizer | null = null;
let loading: Promise<WorkletSynthesizer | null> | null = null;
let bank: Promise<ArrayBuffer> | null = null;
const modules = new WeakMap<AudioContext, Promise<void>>();
let generation = 0;
const channels = new Map<string, number>();

export async function prepareSoundfont(
  ac: AudioContext,
  output: AudioNode,
): Promise<WorkletSynthesizer | null> {
  if (synth) return synth;
  if (loading) return loading;
  const id = generation;
  loading = (async () => {
    let created: WorkletSynthesizer | null = null;
    try {
      bank ??= (async () => {
        const response = await fetch(
          new URL('audio/soundfonts/MuseScore_General.sf3', document.baseURI),
        );
        if (!response.ok) throw new Error(`SoundFont: HTTP ${response.status}`);
        return response.arrayBuffer();
      })().catch((e) => {
        bank = null;
        throw e;
      });
      let moduleReady = modules.get(ac);
      if (!moduleReady) {
        moduleReady = ac.audioWorklet.addModule(processorUrl).catch((e) => {
          modules.delete(ac);
          throw e;
        });
        modules.set(ac, moduleReady);
      }
      const [{ WorkletSynthesizer }, data] = await Promise.all([
        import('spessasynth_lib'),
        bank,
        moduleReady,
      ]);
      if (id !== generation) return null;
      created = new WorkletSynthesizer(ac);
      created.setLogLevel(false, true, false);
      await created.soundBankManager.addSoundBank(data.slice(0), 'MuseScore_General');
      await created.isReady;
      if (id !== generation) {
        created.destroy();
        return null;
      }
      created.connect(output);
      synth = created;
      return created;
    } catch (e) {
      created?.destroy();
      console.warn('[playback] SoundFont unavailable, using synthesis', e);
      return null;
    } finally {
      if (id === generation) loading = null;
    }
  })();
  return loading;
}

export function playSoundfont(n: PlaybackNote, when: number): boolean {
  if (!synth) return false;
  const key = `${n.partId}:${n.program}:${n.drum}`;
  let channel = channels.get(key);
  if (channel === undefined) {
    channel = channels.size;
    while (synth.channelCount <= channel) synth.addNewChannel();
    synth.midiChannels[channel]!.setDrums(n.drum);
    synth.programChange(channel, n.program);
    channels.set(key, channel);
  }
  synth.noteOn(channel, n.midi, n.velocity, { time: when });
  synth.noteOff(channel, n.midi, { time: when + n.duration });
  return true;
}

export function stopSoundfont(): void {
  generation++;
  synth?.disconnect();
  synth?.destroy();
  synth = null;
  loading = null;
  channels.clear();
}
