# Performance-label candidates v1

This is a small, source-traceable candidate layer for a future version of the
current four-track Transformer. It has **not** trained or changed the live page.
See `../../PERFORMANCE-TEMPO-V2.md` for the proposed model and Tempo Fixed/Walk
behavior.

- `score-events.jsonl.gz` and `audit.json`: explicit MusicXML numeric QPM and
  `sound dynamics` values for the accepted Lieder and classical score files.
  Records retain source, score ID, original archive member, part IDs, measure
  index, fractional quarter-note offset, and the original Lieder split. A missing
  mark stays missing. Printed dynamics and wedges remain in their existing
  score/expression datasets.
- `lieder-joint-tempo.npz` and `.json`: QPM aligned by piece and sixteenth step to
  `../joint/lieder-joint.npz`. `known=false` means no defensible numeric target;
  `qpm` is then NaN. The arrays and original corpus use identical `offsets`.
- `midi-tempo-evidence.jsonl.gz` and `midi-tempo-audit.json`: explicit MIDI
  tempo meta-events for the 43,036 SymphonyNet pieces already in the prepared
  corpus and the reviewed 117 local MIDI files. A file having an explicit tempo
  event does not prove that its speed was artistically chosen rather than inserted
  by export software. Original MIDI velocity is already in the prepared corpus;
  it is not the same unit as MusicXML sound dynamics.

The added classical scores have no approved split and must not enter training
before composition-level overlap checks. Preserve each label's source and mask;
never fill missing labels with a training target of 120 BPM or an invented
velocity. The data are for private research, subject to their source licences.
