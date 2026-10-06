# Karaoke v2 validation

Date: 2026-09-23. Entry point: `http://127.0.0.1:4173/karaoke/`.

Follow-up layout review: the 919 × 804 embedded browser exposed clipping that the original larger-viewport checks missed. GPT-5.6 sol fixed the shared stage scaling and page-specific spacing. All ten pages were rechecked in the actual viewport and six additional desktop sizes, with narrow-window scrolling checked separately. The current suite passes **23/23**. See [the layout review](karaoke-layout-review.md) for reproduced failures and actual verification.

Publication update: version 67 publishes **Musical Karaoke** at `/MusicalKaraoke`. Both optional concerto links were removed; the new bundle excludes their audio, guides, rehearsal module, and controls. The original deck retains its rehearsals. The updated suite still passes 23/23. See [publication details](musical-karaoke-publication.md).

## Implemented contract

- Exactly ten pages, including the cover and coda, with `1 / 10` through `10 / 10` navigation.
- The first eight pages use listening, imitation, playable chords, six progressions, tuning comparison, two real keyboard mappings, and the timed choir. The Tonnetz/Kitaev relationship first appears on page 9.
- Eight C-root chord choices use the shared coordinate data. All six shared progressions play complete chords and update their concrete diagrams in sync.
- The missing-note call and twelve pure fifths use exact `3:2` frequencies. The equal-tempered path uses `2^(7/12)`. The pure endpoint is labelled `C + 23.46¢`; the equal-tempered endpoint closes on C.
- Classic and Harmonic keyboard panels are exported from the shared instrument geometry. Individual keys and the C/D major chord controls are playable.
- Voice samples load through `media/karaoke/manifest.json`. Choir highlighting follows the media element's `currentTime`; it includes the manifest's visible countdown and final silent response interval.
- Changing page, pressing Stop, hiding or blurring the page, and leaving the page cancel media, oscillators, timers, cue highlighting, and progression state.
- The existing root presentation and Tonnetz application files are unchanged. Rehearsal links are optional and do not autoplay.

## Automated checks

Final result: **21/21 passed**. Run `npm test`. The karaoke-specific checks cover the ten-page contract and delayed reveal, coordinate/pitch-class agreement, all six progression shapes, pure/equal tuning endpoints, KaTeX parsing, media-clock cues and cancellation hooks, and required links. Existing geometry, presentation, rehearsal, KaTeX bundle, and concerto asset checks remain in the same command.

JavaScript modules are also checked with:

```sh
node --check public/karaoke/karaoke.js
node --check public/karaoke/karaoke-audio.js
node --check public/karaoke/karaoke-data.js
```

## Completed browser checks

The main agent checked all ten pages at 1366×768 and 1440×900 using the local browser on 2026-09-23. After changes, affected pages were reloaded and checked again.

- The cover, voice order, fifth call, diminished seventh chord, ii7–V7–Imaj7 progression, pure/equal fifth paths, and the keyboard chord controls entered real playback states. Voice order completed at `Your turn`.
- The 24-second choir reached its natural end with its meter at 100%, `Your turn`, zero remaining cue highlights, and `Sound: ready`. The exact final four seconds of its WAV were independently verified to contain silence.
- Harmonic D major highlighted exactly D/F♯/A. The embedded instrument reported **three active voices** and a running AudioContext; pressing Stop reduced voices to **zero**.
- C→Am changed the main diagram to A/C/E and retained C/E as marked common tones. Cdim7 showed C/E♭/G♭/A.
- On page 3 the missing note is a question mark and `3:2` is hidden before Reveal. The page-9 diagram and optional formula panel fit at both sizes, with no overlap with their buttons. A DOM bounds check found no labelled note crossing the diagram frame.
- Blank right click moved backward, blank left click moved forward, Home returned to the cover, and PageDown advanced. Music button clicks did not navigate; page changes stopped pending playback.
- The optional rehearsal links open in a new tab. Both AIgimon links and source URLs are retained. All referenced local HTML assets and vocal files exist.
- A fresh final browser tab loaded with **no warning or error console entries**. A source-less MutationObserver error appeared once during earlier automation setup and did not recur in the final tab.
- Viewport overrides were reset after testing. The new presentation is left at its cover for local review.

Independent lifecycle tests additionally simulate Stop arriving while AudioContext.resume or media.play is pending. Both frequency paths and the voice-order player cancel without creating a later voice or a permanently pending sequence.

The original `public/index.html`, `public/deck.js`, `public/deck.css`, `public/tonnetz/app.js`, and `public/tonnetz/rehearsal.js` SHA-256 values remained unchanged throughout this work.

## Known limits

The voice clips are clearly labelled synthetic formant demonstrations. No claim of human listening validation, microphone analysis, deployment, or a quantum sound mechanism is made. The optional rehearsals are outside the ten-minute default path.

## 2026-09-23：三人四音合唱与终止式修订验收

- 共 25 项测试通过。逐声部三轮音高与三声部各列和弦集合交叉校验；练习、独唱核对、合唱素材的时长、cue 边界、PCM 峰值和无伴奏全零段通过。
- 页面顺序为 cover / voices / progressions / fifth / shapes / tuning / keyboard / choir / reveal / closing，共 10 页。初始进行为 C–G–Am–F；旧版数据、乐器映射及原版五个核心文件 SHA256 保持不变。
- 本地浏览器在 1280×720、1366×768、919×804 检查新首页、声部表、进行及终止式；919×804 对十页的标题、按钮、段落、链接和主要新容器做边界检查，均位于各自幻灯片内。640×800 声部页可纵向滚动，无横向溢出。
- 实际启动并观察 Solo check、三轮练习和终止式自然结束；合唱的无伴奏阶段同步高亮正确。Stop 清除所有播放/发声/cue 样式（计数 0）；播放期间翻页返回 Sound: stopped。浏览器未捕获错误。
- 修正末页黄色播放按钮的文字对比度，以及声部 2/3 的高亮背景优先级。首页点击插画可正常翻页。
- 音色为原创合成 AH 示范；检查由参与者和主持人耳听完成，没有录音或自动评分。

## 删除 The missing note

按用户指示移除该页、页面专属事件和样式，当前 9 页。25 项现有测试通过；浏览器确认 Moving shapes（3/9）下一页为 Shape of chord（4/9），End 到达 A final cadence（9/9），未捕获控制台错误。

## 删除原第 7–8 页

移除 You are the choir 与 The hidden lattice，并清理专属事件和样式以及导航中的旧合唱清理调用。当前 7 页，第二页三人四音排练保留。25 项现有测试通过；浏览器确认第 6 页键盘下一页为终止式 7/7，Play cadence 与 Stop 正常，未捕获控制台错误。
