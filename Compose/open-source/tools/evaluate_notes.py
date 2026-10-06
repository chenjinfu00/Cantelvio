"""Evaluate performance-time note CSVs with mir_eval (not score beat positions)."""
import argparse
import csv
import hashlib
import json
from pathlib import Path
import importlib.metadata
import numpy as np
import mir_eval


def load_notes(path):
    # CSV columns: onset_seconds, offset_seconds, midi. Instrument labels are optional.
    intervals, pitches = [], []
    with Path(path).open(newline="", encoding="utf-8-sig") as stream:
        for row in csv.DictReader(stream):
            onset, offset = float(row["onset_seconds"]), float(row["offset_seconds"])
            pitch = float(row["midi"])
            if not np.isfinite([onset, offset, pitch]).all() or not 0 <= onset < offset or not 0 <= pitch <= 127:
                raise ValueError(f"Invalid note: {row}")
            intervals.append((onset, offset))
            pitches.append(440 * 2 ** ((pitch - 69) / 12))
    return np.array(intervals, dtype=float).reshape(-1, 2), np.array(pitches, dtype=float)


def evaluate(reference, estimate, onset_tolerance=0.05):
    ri, rp = load_notes(reference)
    ei, ep = load_notes(estimate)
    if not len(ri) or not len(ei):
        raise ValueError("Both files must contain notes; an empty transcription is not a valid completed evaluation.")
    onset = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=onset_tolerance, offset_ratio=None)
    offsets = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, onset_tolerance=onset_tolerance, offset_ratio=0.2, offset_min_tolerance=0.05)
    return {"schema": "ailegro.note-evaluation/1", "mir_eval": importlib.metadata.version("mir_eval"),
            "referenceNotes": len(ri), "estimatedNotes": len(ei),
            "onsetToleranceSeconds": onset_tolerance, "pitchToleranceCents": 50,
            "onset": dict(zip(["precision", "recall", "f1", "averageOverlap"], map(float, onset))),
            "onsetAndOffset": dict(zip(["precision", "recall", "f1", "averageOverlap"], map(float, offsets))),
            "inputs": [{"path": str(Path(p).resolve()), "sha256": hashlib.sha256(Path(p).read_bytes()).hexdigest()} for p in [reference, estimate]]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("estimate", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--onset-tolerance", type=float, default=0.05)
    args = parser.parse_args()
    if not 0 < args.onset_tolerance <= 1:
        parser.error("onset tolerance must be in (0, 1] seconds")
    result = evaluate(args.reference, args.estimate, args.onset_tolerance)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
