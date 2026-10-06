/** Chord-chart helpers. Bars come straight from the generated timeline
 * (Session.chartView); there is no separate forecast walk to keep in sync. */

/** Readable length of a chord segment: whole bars, or beats (halves when needed). */
export function durationLabel(beats, meter, language = 'en', signature = '') {
    if (beats >= meter && beats % meter === 0) { const n = beats / meter; return language === 'en' ? `${n} ${n === 1 ? 'bar' : 'bars'}` : `${n} 小节`; }
    const pulse = ['6/8','9/8','12/8'].includes(signature) ? beats / 1.5 : beats;
    const text = Number.isInteger(pulse) ? String(pulse) : pulse.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    return language === 'en' ? `${text} ${pulse === 1 ? 'beat' : 'beats'}` : `${text} 拍`;
}

export function segmentStyle(segment, meter) {
    return `left:${(100 * segment.startBeat / meter).toFixed(4)}%;width:${(100 * segment.lengthBeats / meter).toFixed(4)}%`;
}

/** Played/advertised comparison key for one bar: [start step, chord label, start beat, length]. */
export const barSignature = row => row.segments.map(s => [s.step, s.label, s.startBeat, s.lengthBeats]);
