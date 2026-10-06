/** Sound choices and model conditions offered by the console. Instrument ids are
 * the synthesis/sample engines understood by src/audio.js (lists carried over from
 * the earlier frozen accompaniment and melody modules). */
const freeze = entries => Object.freeze(entries.map(e => Object.freeze({ ...e, name: Object.freeze(e.name) })));

export const INSTRUMENTS = freeze([
    { id: 'piano', name: { en: 'Acoustic piano', zh: '原声钢琴' }, engine: 'piano' },
    { id: 'epiano', name: { en: 'Electric piano', zh: '电钢琴' }, engine: 'epiano' },
    { id: 'electric-guitar', name: { en: 'Electric guitar', zh: '电吉他' }, engine: 'electric-guitar' },
    { id: 'organ', name: { en: 'Organ', zh: '风琴' }, engine: 'organ' },
    { id: 'harp', name: { en: 'Harp / pluck', zh: '竖琴／拨弦' }, engine: 'pluck' },
    { id: 'synth-lead', name: { en: 'Warm synth', zh: '温暖合成音' }, engine: 'synth-lead' },
    { id: 'strings', name: { en: 'Strings', zh: '弦乐' }, engine: 'strings' },
    { id: 'bell', name: { en: 'Bell', zh: '钟琴' }, engine: 'bell' },
    { id: 'pad', name: { en: 'Soft pad', zh: '柔和铺底' }, engine: 'pad' }
]);
export const BASS_INSTRUMENTS = freeze([
    { id: 'electric-bass', name: { en: 'Electric bass', zh: '电贝斯' }, engine: 'electric-bass' },
    { id: 'synth-bass', name: { en: 'Warm synth bass', zh: '温暖合成贝斯' }, engine: 'synth-bass' },
    { id: 'piano', name: { en: 'Piano left hand', zh: '钢琴左手' }, engine: 'piano' }
]);
export const MELODY_INSTRUMENTS = freeze([
    { id: 'piano', name: { en: 'Piano', zh: '钢琴' }, engine: 'piano' },
    { id: 'epiano', name: { en: 'Electric piano', zh: '电钢琴' }, engine: 'epiano' },
    { id: 'electric-guitar', name: { en: 'Electric guitar', zh: '电吉他' }, engine: 'electric-guitar' },
    { id: 'synth-lead', name: { en: 'Warm synth lead', zh: '温暖合成主音' }, engine: 'synth-lead' },
    { id: 'reed-lead', name: { en: 'Reed lead', zh: '簧管主音' }, engine: 'reed-lead' },
    { id: 'bell', name: { en: 'Bell', zh: '钟琴' }, engine: 'bell' },
    { id: 'harp', name: { en: 'Harp / pluck', zh: '竖琴／拨弦' }, engine: 'pluck' },
    { id: 'organ', name: { en: 'Organ', zh: '风琴' }, engine: 'organ' }
]);
/** Sustained engines hold broken-chord notes only as long as the rhythm stream says. */
export const SUSTAINED = new Set(['pad', 'strings', 'organ', 'synth-lead', 'reed-lead']);
export const engineOf = (list, id) => list.find(e => e.id === id)?.engine || id;

/** Model condition = (domain, style) inputs of the joint Transformer.
 * Art song is the Lieder domain; the others are the synthetic styles learned in
 * pretraining. The synthetic "exploratory" style is not offered: its training
 * phrases had no melody, so the melody stream was never trained under it. */
export const STYLES = freeze([
    { id: 'lieder', name: { en: 'Art song (Lieder)', zh: '艺术歌曲（Lieder）' }, domain: 1, styleId: 3 },
    { id: 'pop', name: { en: 'Pop', zh: '流行' }, domain: 0, styleId: 0 },
    { id: 'jazz', name: { en: 'Jazz', zh: '爵士' }, domain: 0, styleId: 1 },
    { id: 'blues', name: { en: 'Blues / rock', zh: '布鲁斯／摇滚' }, domain: 0, styleId: 2 },
    { id: 'classical', name: { en: 'Classical (rule phrases)', zh: '古典（规则乐句）' }, domain: 0, styleId: 3 },
    { id: 'ambient', name: { en: 'Ambient', zh: '氛围' }, domain: 0, styleId: 4 }
]);
export const styleOf = id => STYLES.find(s => s.id === id) || STYLES[0];
export const METER_CHOICES = freeze([
    { id: 4, name: { en: '4/4', zh: '4/4' } },
    { id: 3, name: { en: '3/4', zh: '3/4' } },
    { id: 2, name: { en: '2/4', zh: '2/4' } },
    { id: 5, name: { en: '5/4', zh: '5/4' } },
    { id: 6, name: { en: '6/8 · two dotted beats', zh: '6/8 · 两个附点拍' } },
    { id: 9, name: { en: '9/8 · three dotted beats', zh: '9/8 · 三个附点拍' } },
    { id: 12, name: { en: '12/8 · four dotted beats', zh: '12/8 · 四个附点拍' } }
]);
export const GROOVES = freeze([
    { id: 'straight', name: { en: 'Straight', zh: '平均' } },
    { id: 'swing', name: { en: 'Swing eighths', zh: '摇摆八分' } }
]);
