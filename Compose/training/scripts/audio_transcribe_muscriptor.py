#!/usr/bin/env python3
"""Audio -> notes and beats, the input of audio_to_score.py.

Notes come from MuScriptor (Mirelo x Kyutai, CC BY-NC 4.0 with conditions of use: only for recordings you have
the rights to transcribe), beats and downbeats from beat_this (the tracker MuScriptor itself uses). Run it with
the Python environment that has the `muscriptor` package (on the Mac: MuScriptor-large-1.3B/.venv-py312):

    MuScriptor-large-1.3B/.venv-py312/bin/python training/scripts/audio_transcribe_muscriptor.py song.wav \\
        --output song.notes.json [--instruments acoustic_piano,voice]

--instruments (MuScriptor group names, `muscriptor list-instruments`) tells the model which instruments play;
it keeps the instrument labels stable. The output (ailegro.transcription/1) lists every note as
[start seconds, end seconds, MIDI pitch, MuScriptor instrument group] plus the tracked beats and downbeats.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

SCHEMA = 'ailegro.transcription/1'
DEFAULT_MODEL = Path(__file__).resolve().parents[2] / 'MuScriptor-large-1.3B' / 'model.safetensors'


def device_and_dtype(choice: str) -> tuple[str, str]:
    import torch
    if choice != 'auto':
        return choice, 'float16' if choice in ('mps', 'cuda') else 'float32'
    if torch.backends.mps.is_available():
        return 'mps', 'float16'
    if torch.cuda.is_available():
        return 'cuda', 'float16'
    return 'cpu', 'float32'


def track_beats(audio: Path, device: str) -> tuple[list[float], list[float]]:
    """beat_this beats and downbeats in seconds ('final0' checkpoint, no DBN, as MuScriptor does)."""
    import numpy as np
    import soundfile as sf
    from beat_this.inference import Audio2Beats
    signal, sr = sf.read(str(audio), always_2d=True, dtype='float32')
    mono = signal.mean(axis=1)
    beats, downbeats = Audio2Beats(checkpoint_path='final0', device='cpu' if device == 'mps' else device,
                                   dbn=False)(mono, sr)
    return [round(float(b), 4) for b in np.asarray(beats)], [round(float(d), 4) for d in np.asarray(downbeats)]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('audio', type=Path)
    parser.add_argument('--output', type=Path, help='default: <audio>.notes.json next to the audio')
    parser.add_argument('--model', type=Path, default=DEFAULT_MODEL, help='MuScriptor weights (.safetensors)')
    parser.add_argument('--instruments', help='comma-separated MuScriptor instrument groups present in the recording')
    parser.add_argument('--device', default='auto', help='auto (mps, cuda or cpu), mps, cuda or cpu')
    parser.add_argument('--cfg', type=float, default=2.0, help='classifier-free guidance (MuScriptor default 2)')
    args = parser.parse_args()
    try:
        from muscriptor import TranscriptionModel
        from muscriptor.events import NoteEndEvent, ProgressEvent
    except ImportError:
        sys.exit('the muscriptor package is missing: run this with MuScriptor\'s Python environment '
                 '(MuScriptor-large-1.3B/.venv-py312/bin/python)')
    if not args.audio.is_file():
        sys.exit(f'no such audio file: {args.audio}')
    output = args.output or args.audio.with_suffix('.notes.json')
    instruments = [n.strip() for n in args.instruments.split(',') if n.strip()] if args.instruments else None
    device, dtype = device_and_dtype(args.device)

    t0 = time.perf_counter()
    print(f'loading {args.model} on {device} ({dtype})', flush=True)
    model = TranscriptionModel.load_model(args.model if args.model.exists() else 'large', device=device, dtype=dtype)
    print(f'loaded in {time.perf_counter() - t0:.0f} s; transcribing {args.audio.name}', flush=True)
    notes = []
    for event in model.transcribe(args.audio, cfg_coef=args.cfg, batch_size=1, prelude_forcing=True,
                                  instruments=instruments):
        if isinstance(event, ProgressEvent):
            print(f'  {event.completed}/{event.total} chunks', flush=True)
        elif isinstance(event, NoteEndEvent):
            start = event.start_event
            notes.append([round(start.start_time, 4), round(event.end_time, 4), int(start.pitch), start.instrument])
    notes.sort(key=lambda n: (n[0], n[2]))
    print(f'{len(notes)} notes; tracking beats', flush=True)
    beats, downbeats = track_beats(args.audio, device)
    duration = None
    try:
        import soundfile as sf
        duration = round(sf.info(str(args.audio)).duration, 3)
    except Exception:  # noqa: BLE001  (duration is informative only)
        pass
    document = {'schema': SCHEMA, 'audio': args.audio.name, 'duration': duration,
                'model': {'name': 'muscriptor', 'weights': str(args.model), 'cfg': args.cfg, 'device': device,
                          'instruments': instruments},
                'beatTracker': 'beat_this final0', 'notes': notes, 'beats': beats, 'downbeats': downbeats}
    output.write_text(json.dumps(document, ensure_ascii=False))
    print(f'{len(beats)} beats, {len(downbeats)} downbeats -> {output} ({time.perf_counter() - t0:.0f} s)')


if __name__ == '__main__':
    main()
