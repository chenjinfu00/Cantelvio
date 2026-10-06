import { CHORD_VOCAB } from "./lib/harmony-models.js";

const freezeSequence = (id, name, nameZh, romans, chords, description, descriptionZh) => Object.freeze({
  id,
  name: Object.freeze({ en: name, "zh-CN": nameZh }),
  description: Object.freeze({ en: description, "zh-CN": descriptionZh }),
  romans: Object.freeze(romans),
  chords: Object.freeze(chords)
});

// The eight progressions are the complete presentation set from MusicalKaraoke v79.
export const PROGRESSIONS = Object.freeze([
  freezeSequence("pop-loop", "Four-chord loop", "流行四和弦", ["I", "V", "vi", "IV"], ["C", "G", "Am", "F"], "A familiar loop for melodic improvisation.", "适合旋律即兴的常用循环。"),
  freezeSequence("pop-cadence", "Pop cadence", "流行终止进行", ["I", "vi", "IV", "V", "I"], ["C", "Am", "F", "G", "C"], "A longer tonic-to-dominant arc.", "从主和弦走向属和弦，再回到主和弦。"),
  freezeSequence("two-five-one", "ii–V–I", "二五一", ["ii", "V", "I"], ["Dm", "G", "C"], "The compact functional cadence.", "最精炼的功能和声终止。"),
  freezeSequence("jazz-two-five-one", "Jazz ii7–V7–Imaj7", "爵士二五一", ["ii7", "V7", "Imaj7"], ["Dm7", "G7", "Cmaj7"], "Seventh chords with a settled major-seventh tonic.", "以七和弦连接，并落在大七主和弦。"),
  freezeSequence("modal-colour", "Major to parallel minor", "同主大小调色彩", ["I", "i", "♭VI"], ["C", "Cm", "A♭"], "Parallel-minor colour without leaving C as the reference.", "以 C 为中心，借用同主小调色彩。"),
  freezeSequence("classical-cadence", "Classical I–IV–V–I", "古典正格进行", ["I", "IV", "V", "I"], ["C", "F", "G", "C"], "Clear tonic, predominant, dominant and resolution.", "清楚呈现主、下属、属与解决。"),
  freezeSequence("backdoor-rise", "Modal rise", "调式上行", ["IV", "V", "♭VI", "♭VII", "I"], ["F", "G", "A♭", "B♭", "C"], "A bright chromatic climb back to the tonic.", "明亮的半音上行，最后回到主和弦。"),
  freezeSequence("circle-home", "Circle home", "循环回归", ["IV", "V", "iii", "vi", "ii", "V", "I"], ["F", "G", "Em", "Am", "Dm", "G", "C"], "A seven-bar functional route home.", "七小节的功能和声回归路线。")
]);

export const AUTHENTIC_CADENCE = Object.freeze({
  ...freezeSequence("authentic-cadence", "Authentic cadence", "正格终止", ["IV", "V7", "I"], ["F", "G7", "C"], "Voice-led F–G7–C with root-position dominant and tonic.", "经过良好声部连接的 F–G7–C，属七与主和弦均保持根音位置。"),
  // Four voices: A4–B4–C5 above a root-position G7–C resolution.
  voicings: Object.freeze([
    Object.freeze([41, 57, 60, 69]),
    Object.freeze([43, 62, 65, 71]),
    Object.freeze([48, 55, 64, 72])
  ])
});

export const CHORDS_BY_ID = new Map(CHORD_VOCAB.map((chord) => [chord.id, chord]));

export const copyFor = (language, value) => {
  if (!value || typeof value !== "object") return String(value ?? "");
  return value[language] ?? value.en ?? "";
};

export const WORKBENCH_COPY = Object.freeze({
  workbench: { en: "Harmony workbench", "zh-CN": "和声工作台" },
  expand: { en: "Open workbench", "zh-CN": "打开工作台" },
  collapse: { en: "Collapse workbench", "zh-CN": "收起工作台" },
  start: { en: "Start", "zh-CN": "开始" },
  stop: { en: "Stop", "zh-CN": "停止" },
  accompaniment: { en: "Accompaniment", "zh-CN": "伴奏" },
  harmony: { en: "Harmony", "zh-CN": "和声" },
  learn: { en: "Learn", "zh-CN": "学习" },
  style: { en: "Style", "zh-CN": "风格" },
  rhythm: { en: "Rhythm", "zh-CN": "节奏型" },
  pattern: { en: "Pattern", "zh-CN": "音型" },
  tempo: { en: "Tempo", "zh-CN": "速度" },
  instrument: { en: "Instrument", "zh-CN": "乐器" },
  accompanimentVolume: { en: "Accompaniment volume", "zh-CN": "伴奏音量" },
  beatsFour: { en: "4 beats", "zh-CN": "四拍" },
  beatsThree: { en: "3 beats", "zh-CN": "三拍" },
  currentChord: { en: "Current chord", "zh-CN": "当前和弦" },
  barBehaviour: { en: "At each bar", "zh-CN": "每小节" },
  hold: { en: "Hold chord", "zh-CN": "保持和弦" },
  progression: { en: "Progression", "zh-CN": "进行循环" },
  generate: { en: "Generate", "zh-CN": "模型生成" },
  progressions: { en: "Eight progressions", "zh-CN": "八组进行" },
  cadence: { en: "Cadence", "zh-CN": "终止式" },
  chordVocabulary: { en: "Chord library · inversions", "zh-CN": "和弦库 · 含转位" },
  model: { en: "Transformer", "zh-CN": "Transformer" },
  palette: { en: "Palette", "zh-CN": "调色板" },
  temperature: { en: "Temperature", "zh-CN": "温度" },
  nextChord: { en: "Next-chord probability", "zh-CN": "下一和弦概率" },
  next: { en: "Generate next", "zh-CN": "生成下一和弦" },
  history: { en: "History", "zh-CN": "历史" },
  evidence: { en: "Parameters & attention", "zh-CN": "参数与注意力" },
  parameters: { en: "Actual model parameters", "zh-CN": "真实模型参数" },
  attention: { en: "Actual causal attention", "zh-CN": "真实因果注意力" },
  attentionUnavailable: { en: "Attention is available in Transformer mode.", "zh-CN": "注意力仅在 Transformer 模式中显示。" },
  authoredModel: { en: "Trained locally on synthetic harmonic phrases. Every root, quality and inversion stays available.", "zh-CN": "以合成和声进行训练，在本地运行。所有根音、和弦类型及转位均可选。" },
  preparing: { en: "Preparing model…", "zh-CN": "正在准备模型…" },
  soundUnavailable: { en: "Sound is unavailable. Tap the main sound button and try again.", "zh-CN": "声音尚不可用。请先点击主界面的声音按钮再重试。" },
  empty: { en: "No candidates available.", "zh-CN": "暂无候选和弦。" },
  bpm: { en: "BPM", "zh-CN": "BPM" }
});
