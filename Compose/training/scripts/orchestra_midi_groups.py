"""Reuse the six-group General MIDI mapping without shadowing score-event groups."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'orchestra'))
from groups import GROUPS, group_of as _group_of


def group_of(program: int, pitch: int, is_drum: bool) -> str | None:
    index = _group_of(program, pitch, is_drum)
    return None if index is None else GROUPS[index]
