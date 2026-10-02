import { add, cmp, isPositive, le, lt } from '../time/rational';
import { allStaves, measureInfos, scoreLength } from './query';
import { SCORE_FORMAT, VOICES_PER_STAFF, type ScoreDoc } from './types';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Check structural invariants of a document. An empty result means the document is valid.
 * Commands keep these invariants; run this on imported or AI-generated documents.
 */
export function validateScore(doc: ScoreDoc): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const issue = (path: string, message: string) => issues.push({ path, message });
  if (doc.format !== SCORE_FORMAT) issue('format', 'wrong format tag');
  if (doc.measures.length === 0) issue('measures', 'score has no measures');
  if (doc.parts.length === 0) issue('parts', 'score has no parts');
  const first = doc.measures[0];
  if (first && !first.timeSig) issue('measures.0', 'first measure needs a time signature');
  if (first && !first.keySig) issue('measures.0', 'first measure needs a key signature');

  const ids = new Set<string>();
  const unique = (id: string, path: string) => {
    if (ids.has(id)) issue(path, `duplicate id ${id}`);
    ids.add(id);
  };
  unique(doc.id, 'id');
  doc.parts.forEach((p, i) => {
    unique(p.id, `parts.${i}`);
    if (p.staves.length === 0) issue(`parts.${i}`, 'part has no staves');
    p.staves.forEach((s, j) => unique(s.id, `parts.${i}.staves.${j}`));
  });
  doc.measures.forEach((m, i) => {
    unique(m.id, `measures.${i}`);
    m.tempo?.forEach((t, k) => unique(t.id, `measures.${i}.tempo.${k}`));
  });
  doc.groups.forEach((g, i) => unique(g.id, `groups.${i}`));

  const staffIds = allStaves(doc).map((s) => s.staff.id);
  const staffIndex = new Map(staffIds.map((id, i) => [id, i]));
  doc.groups.forEach((g, i) => {
    const a = staffIndex.get(g.firstStaff);
    const b = staffIndex.get(g.lastStaff);
    if (a === undefined || b === undefined)
      issue(`groups.${i}`, 'group references an unknown staff');
    else if (a > b) issue(`groups.${i}`, 'group staves out of order');
  });

  const infos = measureInfos(doc);
  const byId = new Map(infos.map((m) => [m.measure.id, m]));
  const end = scoreLength(doc);
  for (const [staffId, measures] of Object.entries(doc.content)) {
    if (!staffIndex.has(staffId)) issue(`content.${staffId}`, 'content for unknown staff');
    const voiceEnds: (ReturnType<typeof add> | null)[] = Array.from(
      { length: VOICES_PER_STAFF },
      () => null,
    );
    for (const info of infos) {
      const sm = measures[info.measure.id];
      if (!sm) continue;
      if (sm.voices.length > VOICES_PER_STAFF)
        issue(`content.${staffId}.${info.measure.id}`, 'too many voices');
      sm.voices.forEach((events, v) => {
        let prevOffset: ReturnType<typeof add> | null = null;
        events.forEach((e, k) => {
          const path = `content.${staffId}.${info.measure.id}.voices.${v}.${k}`;
          unique(e.id, path);
          e.notes.forEach((n) => unique(n.id, `${path}.notes`));
          if (e.notes.length === 0) issue(path, 'event without notes');
          if (!isPositive(e.duration)) issue(path, 'non-positive duration');
          if (lt(e.offset, { n: 0, d: 1 }) || !lt(e.offset, info.length))
            issue(path, 'offset outside measure');
          if (prevOffset && cmp(e.offset, prevOffset) < 0) issue(path, 'events not sorted');
          prevOffset = e.offset;
          const start = add(info.start, e.offset);
          const prevEnd = voiceEnds[v];
          if (prevEnd && lt(start, prevEnd))
            issue(path, 'overlaps the previous event of this voice');
          const stop = add(start, e.duration);
          voiceEnds[v] = stop;
          if (cmp(stop, end) > 0) issue(path, 'extends past the end of the score');
        });
      });
      for (const c of sm.clefChanges ?? [])
        unique(c.id, `content.${staffId}.${info.measure.id}.clefChanges`);
      for (const d of sm.dynamics ?? [])
        unique(d.id, `content.${staffId}.${info.measure.id}.dynamics`);
      for (const t of sm.tuplets ?? []) {
        unique(t.id, `content.${staffId}.${info.measure.id}.tuplets`);
        if (cmp(add(t.offset, t.length), info.length) > 0)
          issue(`content.${staffId}.${info.measure.id}`, 'tuplet crosses barline');
      }
    }
    for (const id of Object.keys(measures)) {
      if (!byId.has(id)) issue(`content.${staffId}.${id}`, 'content for unknown measure');
    }
  }
  doc.harmony.forEach((c, i) => {
    unique(c.id, `harmony.${i}`);
    const m = byId.get(c.measureId);
    if (!m) issue(`harmony.${i}`, 'unknown measure');
    else if (!le({ n: 0, d: 1 }, c.offset) || !lt(c.offset, m.length))
      issue(`harmony.${i}`, 'offset outside measure');
  });
  return issues;
}
