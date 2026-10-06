# Musical Karaoke publication

Published 2026-09-23 with the user's explicit authorization.

- Entry: https://www.aigimon.com/MusicalKaraoke
- AIgimon's primary domain also serves `/MusicalKaraoke`: https://aigimon.ai/MusicalKaraoke
- Title: Musical Karaoke · AIgimon
- Exactly ten slides, including cover and closing.
- Removed both optional concerto rehearsal entries from page 8.
- The new runtime bundle excludes concerto audio, score guides, the rehearsal module, and its controls. The original `/Kitaev` and public `/tonnetz` are unchanged.
- The current 23 tests passed. The staging audit checked all 86 new runtime files, every local HTML reference, the slide count, and absence of concerto names/files.
- The Site workflow built and packaged successfully. The native deployment returned `succeeded`.

## Deployment record

- Site: `appgprj_6ab0f9d1162481919aab5aee39f0a28b`
- Saved version: 67
- Version ID: `appgprj_6ab0f9d1162481919aab5aee39f0a28b~appgver_ce3ada5c18e08191b5747efaf47e6dfd`
- Source commit: `dbe50f751d72a392262a3c207ea430cb94fe5790`
- Deployment: `appgdep_6ab4173d74148191a839cc41c49224c2`
- Successful native deployment origin: `https://ai-haowan-guide.chenjinfu.chatgpt.site`
- The Sites domain listing confirmed `www.aigimon.com`, `aigimon.com`, `www.aigimon.ai`, and `aigimon.ai` are active on this same Site.

The staging script `scripts/stage-musical-karaoke.mjs` preserves the nested relative URLs and uses an explicit `tonnetz/index.html?embed=1` URL for the sound engine. Its service-worker cleanup is scoped to this new copy.

## Focused chord page update

Version 68 was published successfully on 2026-09-23, source commit `001709f302fb89e8705da2c42b82dd2656f65f6f`, deployment `appgdep_6ab424d4a1b481919098f74ce09af70c`. Page 4 now contains only its title, the enlarged chord diagram, and eight complete-chord buttons. The fixed-note singing prompt and C-to-Am common-tone demonstration were removed. The ten-page count is unchanged. Local visual and Cdim7 playback checks passed, as did all 23 existing tests. Only three Musical Karaoke runtime files changed.

## 2026-09-23：三人四音排练与终止式

已发布版本 69，状态 succeeded（2026-09-23T19:40:57Z）。提交 19aa87b039d57c3babee362b5d627bf4bc30694d；归档 /private/tmp/aigimon-karaoke-three-voices-20260923.tar.gz。

更新限于 public/MusicalKaraoke：四个演示文件、七个合唱音频及其 manifest。首页无字；三人各四音可练习三遍、独唱耳听核对、合唱；进行页紧跟合唱且首条为 C–G–Am–F；最后可播放并跟随 F–G7–C 终止式。共 10 页。既有 /Kitaev、/tonnetz/ 和站点其他内容保留。

线上入口：https://www.aigimon.com/MusicalKaraoke 。Sites 成功返回 origin 为 https://ai-haowan-guide.chenjinfu.chatgpt.site 。验证见 karaoke-v2-validation.md 最新记录。

## 删除 The missing note：版本 70

2026-09-23T19:48:56Z 发布成功。提交 967d9b2e2cb250d914342fc99a7113ca4e16efa6。删除页面、专属脚本和样式，页码及页面描述改为九页。25 项现有测试通过；浏览器确认进行页直达和弦页、末页 9/9，无控制台错误。入口继续为 https://www.aigimon.com/MusicalKaraoke 。

## 删除原第 7、8 页：版本 71

2026-09-23T19:54:08Z 发布成功。提交 1d8062cc64a61b06f5d6ae516d77af12d2dfff6d。移除 You are the choir 与 The hidden lattice，当前七页，键盘页直接连接终止式；第二页三人四音排练保留。25 项测试通过，浏览器确认翻页、终止式播放及停止正常。入口 https://www.aigimon.com/MusicalKaraoke 。

## Guided seven-page update: version 72

Published successfully on 2026-09-24 (Amsterdam), 2026-09-23T22:38:47Z.

- Entry: https://www.aigimon.com/MusicalKaraoke
- Source commit: `ad405d37ad2a48f518f197ec4b1dd51ecc2d09e6`
- Version ID: `appgprj_6ab0f9d1162481919aab5aee39f0a28b~appgver_aea63753108c8191a7277e0aec1d26d5`
- Deployment: `appgdep_6ab454e0b73881918c3f2ebe25acac9c`
- Archive: `/private/tmp/aigimon-guided-seven-20260924.tar.gz`
- Native successful URL: https://ai-haowan-guide.chenjinfu.chatgpt.site

The seven-page guided flow adds delayed choir revelation, sequential progressions and chord shapes, chromatic-to-fifths-to-Tonnetz mapping, translated cells, Harmonic then Classic keyboards, a playable authentic cadence, and bundled Salamander piano samples. Only MusicalKaraoke runtime assets were changed. Build and archive validation passed; 36 tests passed. Detailed independent checks are in [guided-seven-slide-validation.md](guided-seven-slide-validation.md).

## 24 September 2026 — version 73

Published successfully at 2026-09-24T20:53:34Z.

- Musical Karaoke: https://www.aigimon.com/MusicalKaraoke
- English-first bilingual instrument: https://aigimon.ai/tonnetz/
- Typing compatibility: /tonentz redirects to /tonnetz/.
- Seven presentation pages preserved.
- Source: d3b08c4fd149adf97e8b448b4c300c2c4c80403f
- Version: appgprj_6ab0f9d1162481919aab5aee39f0a28b~appgver_8a2fae9f896c819187d0596fd5bab05a
- Deployment: appgdep_6ab58db6a5d88191887052130c52c58d
- Archive: /private/tmp/aigimon-karaoke-v73-20260924.tar.gz
- Deployment status: succeeded; https://ai-haowan-guide.chenjinfu.chatgpt.site

Validation: 43 presentation/audio/geometry/register tests and 6 translation tests passed. Browser review at 1280×720 covered the complete three-voice practice and collective reveal, sung-note replay, fixed chromatic fifths traversal, map to one cell, repeat plane, interval introduction, fixed labeled chord grid, concrete G3/B3/D4 keyboard voicing and closing layout. English/Chinese switching, persistence through reload, and dynamic octave status were exercised. Viewport override did not change this browser's effective dimensions; responsive fitting also has unit coverage, but no new narrow-screen screenshot is claimed.

GPT-5.6 sol implemented geometry and translation modules and performed a final code review. Old requests for individual checking and a closing page without thanks were superseded by the latest user message. Review identified future interval buttons that could play early; they are now disabled and guarded until their turn.

The Sites plugin helper disappeared during this session. Existing source was already opened and verified against v72. The repository's own build completed; an ephemeral credential was passed only through hidden stdin and process memory for a normal fast-forward source push. The build archive was saved using the native Sites version tool and deployed with unchanged public access.

## 24 September 2026 — version 74

Published successfully at 2026-09-24T21:14:38Z.

- Entry: https://www.aigimon.com/MusicalKaraoke
- The user explicitly expanded the deck to eight pages. Page 7 is the independent Tonnetz graphical summary; page 8 remains Authentic cadence.
- Sing together starts with one count-in and a silent audience-only response; the old combined answer example is removed.
- Source: ea95266978716873751c74d2bf3304cdff98325e
- Version: appgprj_6ab0f9d1162481919aab5aee39f0a28b~appgver_4b54ec5bf20481918e6347936a4a4aa6
- Deployment: appgdep_6ab592a785ec8191abd8ba0a9c0ce072
- Archive: /private/tmp/aigimon-karaoke-v74-20260924.tar.gz
- Status: succeeded; https://ai-haowan-guide.chenjinfu.chatgpt.site

48 tests passed. Local visual and interaction review covered Choir count-in/reveal, page 6 → 7 → 8, graph nodes and random transitions, interrupted/completed path, and final cadence. Summary geometry has no measured overflow at 1280 × 720 and no KaTeX errors. The archive contains eight pages and the new silent asset, with no old together recording or QA fixture. The existing Site build and secure ephemeral source push were used as in v73; public access is unchanged. Implementation and scientific rationale: musical-karaoke-v74.md.

## 24 September 2026 — version 75

Published successfully at 2026-09-24T21:27:39Z. The revealed Choir button is now “▶ The answer” and plays a separate 6.4-second synthesized three-voice C → G → Am → F answer, with synchronized note/chord highlights. Pre-reveal audience-only singing and all eight pages are preserved. 49 tests passed; browser confirmed playing, natural completion, Stop and cleared highlights.

- Entry: https://www.aigimon.com/MusicalKaraoke
- Source: 8861e1850893a0573df70d886e96f5fa1b9b2106
- Version: appgprj_6ab0f9d1162481919aab5aee39f0a28b~appgver_8f91c82b280c8191a230b30de58a266b
- Deployment: appgdep_6ab595b482cc8191bae4067f549e90d9
- Archive: /private/tmp/aigimon-karaoke-v75-20260924.tar.gz
- Status: succeeded; https://ai-haowan-guide.chenjinfu.chatgpt.site
