#!/usr/bin/env python3
"""Run MuScriptor large on several audio files with one model load."""

from __future__ import annotations

import argparse
import json
import time
from collections import Counter
from pathlib import Path

import mido

from muscriptor import TranscriptionModel
from muscriptor.events import ProgressEvent


MODEL_DIR = Path(__file__).resolve().parent
DEFAULT_MODEL = MODEL_DIR / "model.safetensors"


def midi_summary(midi_bytes: bytes) -> dict:
    temp_path = MODEL_DIR / ".summary-temp.mid"
    temp_path.write_bytes(midi_bytes)
    try:
        midi = mido.MidiFile(temp_path)
        tracks = []
        for track in midi.tracks:
            name = ""
            notes = 0
            programs: set[int] = set()
            channels: set[int] = set()
            for message in track:
                if message.type == "track_name":
                    name = message.name
                elif message.type == "note_on" and message.velocity > 0:
                    notes += 1
                    channels.add(message.channel)
                elif message.type == "program_change":
                    programs.add(message.program)
                    channels.add(message.channel)
            if notes or name:
                tracks.append(
                    {
                        "name": name,
                        "notes": notes,
                        "programs": sorted(programs),
                        "channels": sorted(channels),
                    }
                )
        return {
            "midi_type": midi.type,
            "ticks_per_beat": midi.ticks_per_beat,
            "duration_seconds": midi.length,
            "tracks": tracks,
        }
    finally:
        temp_path.unlink(missing_ok=True)


def transcribe_one(
    model: TranscriptionModel,
    audio_path: Path,
    output_path: Path,
    instruments: list[str] | None,
) -> dict:
    print(f"START {audio_path}", flush=True)
    started = time.perf_counter()
    beat_grid = model.detect_beat_grid_for(audio_path, mode="best-effort")
    event_counts: Counter[str] = Counter()

    def events_with_progress():
        for event in model.transcribe(
            audio_path,
            cfg_coef=2.0,
            batch_size=1,
            prelude_forcing=True,
            instruments=instruments,
        ):
            if isinstance(event, ProgressEvent):
                print(
                    f"PROGRESS {audio_path.name} {event.completed}/{event.total}",
                    flush=True,
                )
            else:
                event_counts[type(event).__name__] += 1
            yield event

    midi_bytes = model.events_to_midi_bytes(events_with_progress(), beat_grid=beat_grid)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(midi_bytes)
    elapsed = time.perf_counter() - started
    report = {
        "audio": str(audio_path),
        "output": str(output_path),
        "model": str(DEFAULT_MODEL),
        "device": "mps",
        "dtype": "float16",
        "cfg_coef": 2.0,
        "batch_size": 1,
        "prelude_forcing": True,
        "instruments": instruments,
        "elapsed_seconds": elapsed,
        "event_counts": dict(event_counts),
        "beat_grid": (
            {
                "bpm": beat_grid.bpm,
                "beats_per_bar": beat_grid.beats_per_bar,
                "first_downbeat": beat_grid.first_downbeat,
                "onset_delay": beat_grid.onset_delay,
            }
            if beat_grid is not None
            else None
        ),
        "midi": midi_summary(midi_bytes),
    }
    report_path = output_path.with_suffix(".json")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"DONE {audio_path.name} {elapsed:.2f}s -> {output_path}", flush=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio", nargs="+", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument(
        "--instruments",
        help="Comma-separated MuScriptor instrument-group names.",
    )
    parser.add_argument(
        "--tag",
        default="muscriptor_large",
        help="Filename tag appended to every output (default: muscriptor_large).",
    )
    args = parser.parse_args()
    instruments = (
        [name.strip() for name in args.instruments.split(",") if name.strip()]
        if args.instruments
        else None
    )

    print(f"LOADING {DEFAULT_MODEL}", flush=True)
    load_started = time.perf_counter()
    model = TranscriptionModel.load_model(DEFAULT_MODEL, device="mps", dtype="float16")
    print(f"LOADED {time.perf_counter() - load_started:.2f}s", flush=True)

    reports = []
    for audio_path in args.audio:
        output_path = args.output_dir / f"{audio_path.stem}_{args.tag}.mid"
        reports.append(transcribe_one(model, audio_path, output_path, instruments))

    aggregate = {
        "model": str(DEFAULT_MODEL),
        "instruments": instruments,
        "reports": reports,
    }
    aggregate_path = args.output_dir / f"batch_report_{args.tag}.json"
    aggregate_path.write_text(
        json.dumps(aggregate, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"BATCH_DONE {aggregate_path}", flush=True)


if __name__ == "__main__":
    main()
