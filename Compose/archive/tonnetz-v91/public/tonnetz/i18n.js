(function () {
  "use strict";

  const STORAGE_KEY = "guangge-language";
  const DEFAULT_LANGUAGE = "en";
  const SUPPORTED_LANGUAGES = new Set(["en", "zh-CN"]);

  const messages = {
    en: {
      "meta.description": "Tonnetz: a multi-touch isomorphic keyboard instrument designed for iPad",
      "app.title": "Tonnetz · Isomorphic keyboard",
      "aria.playSurface": "Isomorphic keyboard performance surface",
      "aria.keyboardInitial": "Eight-column isomorphic hexagonal keyboard",
      "aria.performanceControls": "Performance shortcuts",
      "aria.selectLayout": "Choose keyboard layout",
      "aria.sustainOn": "Turn sustain on",
      "aria.sustainOff": "Turn sustain off",
      "aria.glissandoOn": "Turn glissando on",
      "aria.glissandoOff": "Turn glissando off",
      "aria.openSettings": "Swipe up to open settings",
      "aria.instrumentSettings": "Instrument settings",
      "aria.closeSettingsSwipe": "Swipe down to close settings",
      "aria.instrumentControls": "Instrument controls",
      "aria.columns": "Horizontal key columns",
      "aria.columnsMin": "Use the fewest horizontal columns",
      "aria.columnsDown": "Decrease horizontal columns",
      "aria.columnsUp": "Increase horizontal columns",
      "aria.columnsMax": "Use the most horizontal columns",
      "aria.rows": "Vertical key count",
      "aria.rowsDown": "Decrease vertical keys",
      "aria.rowsUp": "Increase vertical keys",
      "aria.keySize": "Key size",
      "aria.keySizeDown": "Make keys smaller",
      "aria.keySizeUp": "Make keys larger",
      "aria.navigatorHeight": "Navigator height",
      "aria.navigatorHeightDown": "Decrease navigator height",
      "aria.navigatorHeightUp": "Increase navigator height",
      "aria.navigatorWidth": "Navigator width",
      "aria.navigatorWidthDown": "Make navigator narrower",
      "aria.navigatorWidthUp": "Make navigator wider",
      "aria.selectSkin": "Choose key skin",
      "aria.selectVoice": "Choose voice",
      "aria.selectLanguage": "Choose language",
      "aria.transpose": "Transpose",
      "aria.octaveDown": "Lower one octave",
      "aria.octaveUp": "Raise one octave",
      "aria.volume": "Volume",
      "aria.keyboardGrid": "{layout}, {columns} columns with up to {rows} keys per column, isomorphic hexagonal keyboard",
      "label.keyboardLayout": "Keyboard layout",
      "label.sustain": "Sustain",
      "label.glissando": "Glissando",
      "label.columns": "Columns",
      "label.rows": "Rows",
      "label.keySize": "Key size",
      "label.navigatorHeight": "Navigator height",
      "label.navigatorWidth": "Navigator width",
      "label.keySkin": "Key skin",
      "label.voice": "Voice",
      "label.language": "Language",
      "label.octave": "Octave",
      "label.volume": "Volume",
      "action.done": "Done",
      "action.hideLabels": "Hide note names",
      "action.showLabels": "Show note names",
      "action.stopAll": "Stop all sounds",
      "layout.classic": "Classic",
      "layout.melodic": "Melodic",
      "layout.harmonic": "Harmonic",
      "layout.classicHint": "Horizontal whole tones · vertical semitones",
      "layout.melodicHint": "Vertical fifths · diagonal whole tones / fourths",
      "layout.harmonicHint": "Vertical fifths · diagonal major / minor thirds",
      "skin.tonnetz": "Tonnetz · Deep sea",
      "skin.piano": "Piano · Black & white",
      "skin.wood": "Acoustic · Walnut",
      "voiceGroup.builtIn": "Built in · Instant",
      "voiceGroup.sampled": "Sampled · Orchestra",
      "voice.concert": "Concert piano",
      "voice.epiano": "Vintage electric piano",
      "voice.bell": "Glass bell",
      "voice.organ": "Warm organ",
      "voice.pad": "Nebula pad",
      "voice.sample-piano": "Sampled grand piano",
      "voice.strings": "Strings · Four-part range mapping",
      "voice.winds": "Winds · Smart mapping",
      "voice.violin": "Violin",
      "voice.viola": "Viola",
      "voice.cello": "Cello",
      "voice.contrabass": "Double bass",
      "voice.harp": "Harp",
      "voice.piccolo": "Piccolo",
      "voice.flute": "Flute",
      "voice.oboe": "Oboe",
      "voice.clarinet": "Clarinet",
      "voice.bassoon": "Bassoon",
      "voice.horn": "French horn",
      "voice.trumpet": "Trumpet",
      "voice.trombone": "Trombone",
      "voice.tuba": "Tuba",
      "voice.timpani": "Timpani",
      "ensemble.strings": "Four-part strings",
      "ensemble.winds": "Wind section",
      "ensemble.detail": "Mapped to real ranges; duplicate keys in overlapping ranges use different instruments",
      "readout.touch": "Touch a key to begin",
      "readout.multi": "Multi-touch and glissando supported",
      "readout.polyphony": "{count}-note polyphony",
      "readout.continue": "Ready to play",
      "status.soundStopped": "Sound stopped",
      "status.keyboardResized": "Keyboard size updated",
      "status.layoutChanged": "Keyboard layout changed",
      "status.octave": "Octave {octave}",
      "status.voiceSelected": "Voice: {voice}",
      "tip.glissando": "Glissando on: every finger can slide",
      "tip.navigator": "Move the keyboard only from the navigator above",
      "tip.samples": "Sampled voices from",
      "start.enable": "Tap to enable sound",
      "start.detail": "Low-latency voices and spatial reverb · Headphones recommended",
      "rotate.title": "Rotate your iPad",
      "rotate.detail": "Landscape fits the complete keyboard"
    },
    "zh-CN": {
      "meta.description": "Tonnetz 调性网络：为 iPad 设计的多点触控等距键盘乐器",
      "app.title": "Tonnetz · 调性网络",
      "aria.playSurface": "等距键盘演奏区",
      "aria.keyboardInitial": "八键列等距六边形键盘",
      "aria.performanceControls": "演奏快捷控制",
      "aria.selectLayout": "选择键盘模式",
      "aria.sustainOn": "开启延音",
      "aria.sustainOff": "关闭延音",
      "aria.glissandoOn": "开启滑奏",
      "aria.glissandoOff": "关闭滑奏",
      "aria.openSettings": "上滑打开设置",
      "aria.instrumentSettings": "乐器设置",
      "aria.closeSettingsSwipe": "下滑关闭设置",
      "aria.instrumentControls": "乐器控制",
      "aria.columns": "横向按键列数",
      "aria.columnsMin": "最少横向列数",
      "aria.columnsDown": "减少横向列数",
      "aria.columnsUp": "增加横向列数",
      "aria.columnsMax": "最多横向列数",
      "aria.rows": "纵向按键数",
      "aria.rowsDown": "减少纵向键数",
      "aria.rowsUp": "增加纵向键数",
      "aria.keySize": "琴键大小",
      "aria.keySizeDown": "缩小琴键",
      "aria.keySizeUp": "放大琴键",
      "aria.navigatorHeight": "导航条高度",
      "aria.navigatorHeightDown": "降低导航条高度",
      "aria.navigatorHeightUp": "增加导航条高度",
      "aria.navigatorWidth": "导航条宽度",
      "aria.navigatorWidthDown": "缩窄导航条",
      "aria.navigatorWidthUp": "加宽导航条",
      "aria.selectSkin": "选择琴键皮肤",
      "aria.selectVoice": "选择音色",
      "aria.selectLanguage": "选择语言",
      "aria.transpose": "移调",
      "aria.octaveDown": "降低一个八度",
      "aria.octaveUp": "升高一个八度",
      "aria.volume": "音量",
      "aria.keyboardGrid": "{layout}，{columns} 列、每列最多 {rows} 键的等距六边形键盘",
      "label.keyboardLayout": "键盘模式",
      "label.sustain": "延音",
      "label.glissando": "滑奏",
      "label.columns": "横向列数",
      "label.rows": "纵向键数",
      "label.keySize": "琴键大小",
      "label.navigatorHeight": "导航高度",
      "label.navigatorWidth": "导航宽度",
      "label.keySkin": "琴键皮肤",
      "label.voice": "音色",
      "label.language": "语言",
      "label.octave": "八度",
      "label.volume": "音量",
      "action.done": "完成",
      "action.hideLabels": "隐藏音名",
      "action.showLabels": "显示音名",
      "action.stopAll": "停止全部声音",
      "layout.classic": "经典",
      "layout.melodic": "旋律",
      "layout.harmonic": "和声",
      "layout.classicHint": "横向全音 · 纵向半音",
      "layout.melodicHint": "纵向五度 · 两斜轴全音/四度",
      "layout.harmonicHint": "纵向五度 · 两斜轴大三度/小三度",
      "skin.tonnetz": "调性网络 · 深海",
      "skin.piano": "钢琴 · 黑白",
      "skin.wood": "原声 · 胡桃木",
      "voiceGroup.builtIn": "内置 · 即时",
      "voiceGroup.sampled": "采样 · 管弦乐团",
      "voice.concert": "演奏钢琴",
      "voice.epiano": "复古电钢",
      "voice.bell": "玻璃钟",
      "voice.organ": "暖风琴",
      "voice.pad": "星云 Pad",
      "voice.sample-piano": "采样三角钢琴",
      "voice.strings": "弦乐组 · 四声部音域分配",
      "voice.winds": "管乐组 · 智能分配",
      "voice.violin": "小提琴",
      "voice.viola": "中提琴",
      "voice.cello": "大提琴",
      "voice.contrabass": "低音提琴",
      "voice.harp": "竖琴",
      "voice.piccolo": "短笛",
      "voice.flute": "长笛",
      "voice.oboe": "双簧管",
      "voice.clarinet": "单簧管",
      "voice.bassoon": "巴松",
      "voice.horn": "圆号",
      "voice.trumpet": "小号",
      "voice.trombone": "长号",
      "voice.tuba": "大号",
      "voice.timpani": "定音鼓",
      "ensemble.strings": "四声部弦乐",
      "ensemble.winds": "管乐组",
      "ensemble.detail": "按真实音域分配；重叠音区的重复琴键使用不同乐器",
      "readout.touch": "触碰琴键开始",
      "readout.multi": "支持多指和滑奏",
      "readout.polyphony": "{count} 音复音",
      "readout.continue": "随时继续演奏",
      "status.soundStopped": "声音已停止",
      "status.keyboardResized": "键盘尺寸已调整",
      "status.layoutChanged": "键盘模式已切换",
      "status.octave": "八度 {octave}",
      "status.voiceSelected": "音色：{voice}",
      "tip.glissando": "滑奏开启：多指均可滑奏",
      "tip.navigator": "琴面位置仅从上方导航窗口拖动",
      "tip.samples": "采样音色来自",
      "start.enable": "轻触启用声音",
      "start.detail": "低延迟音色与空间混响 · 建议佩戴耳机",
      "rotate.title": "请将 iPad 横过来",
      "rotate.detail": "横屏能容纳完整琴键"
    }
  };

  function normalize(language) {
    if (SUPPORTED_LANGUAGES.has(language)) return language;
    return DEFAULT_LANGUAGE;
  }

  function loadLanguage() {
    try { return normalize(window.localStorage.getItem(STORAGE_KEY)); }
    catch (_) { return DEFAULT_LANGUAGE; }
  }

  let language = loadLanguage();

  function translate(key, values = {}) {
    const template = messages[language]?.[key] ?? messages[DEFAULT_LANGUAGE]?.[key] ?? key;
    return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_, name) => values[name] ?? `{${name}}`);
  }

  function applyDOM(root = document) {
    document.documentElement.lang = language;
    root.querySelectorAll("[data-i18n]").forEach((element) => { element.textContent = translate(element.dataset.i18n); });
    root.querySelectorAll("[data-i18n-aria-label]").forEach((element) => { element.setAttribute("aria-label", translate(element.dataset.i18nAriaLabel)); });
    root.querySelectorAll("[data-i18n-title]").forEach((element) => { element.title = translate(element.dataset.i18nTitle); });
    root.querySelectorAll("[data-i18n-content]").forEach((element) => { element.setAttribute("content", translate(element.dataset.i18nContent)); });
    root.querySelectorAll("[data-i18n-label]").forEach((element) => { element.setAttribute("label", translate(element.dataset.i18nLabel)); });
    document.title = translate("app.title");
    document.documentElement.removeAttribute("data-i18n-pending");
  }

  function setLanguage(nextLanguage) {
    const normalized = normalize(nextLanguage);
    if (normalized === language) { applyDOM(); return language; }
    language = normalized;
    try { window.localStorage.setItem(STORAGE_KEY, language); } catch (_) { /* Storage may be unavailable. */ }
    applyDOM();
    window.dispatchEvent(new CustomEvent("tonnetzlanguagechange", { detail: { language } }));
    return language;
  }

  window.TonnetzI18n = Object.freeze({
    DEFAULT_LANGUAGE,
    getLanguage: () => language,
    setLanguage,
    t: translate,
    applyDOM
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => applyDOM(), { once: true });
  else applyDOM();
})();
