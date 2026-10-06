"""Stream the official PDMX metadata into a deduplicated, license-filtered manifest."""
import argparse
import csv
import json
from pathlib import Path


def is_true(value):
    return str(value).strip().lower() in {"true", "1"}


def eligible(row):
    return (is_true(row.get("subset:no_license_conflict"))
            and str(row.get("license_conflict", "")).strip().lower() in {"false", "0"}
            and is_true(row.get("subset:all_valid"))
            and is_true(row.get("is_best_unique_arrangement")))


def select(source, output):
    total = kept = 0
    with Path(source).open(newline="", encoding="utf-8-sig") as incoming, Path(output).open("w", encoding="utf-8") as outgoing:
        reader = csv.DictReader(incoming)
        required = {"subset:no_license_conflict", "license_conflict", "subset:all_valid", "is_best_unique_arrangement", "mxl", "license_url"}
        if not required.issubset(reader.fieldnames or []):
            raise ValueError(f"Missing PDMX v9 fields: {required - set(reader.fieldnames or [])}")
        for row in reader:
            total += 1
            if not eligible(row):
                continue
            kept += 1
            outgoing.write(json.dumps({k: row.get(k) for k in ["path", "mxl", "mid", "license", "license_url", "title", "composer_name", "n_tracks", "tracks", "genres"]}, ensure_ascii=False) + "\n")
    return {"sourceRows": total, "selectedRows": kept, "policy": "no_license_conflict AND all_valid AND best_unique_arrangement", "downloadedScores": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("metadata", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result = select(args.metadata, args.output)
    args.output.with_suffix(".summary.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result))
