# 网页演示音源：2026-09-23

## 本轮选择

键盘、和弦及进行改用 **Salamander Grand Piano / Alexander Holm** 的实录钢琴采样。取 Tone.js 托管版本的 C2–C6 共 17 个 MP3（每小三度一个），保持原文件，体积约 1.19 MiB。中间音高以最近样本移调；单层采样，不宣称完整钢琴库的 16 层力度功能。无需新增 Tone.js 框架。

- [Tone.js 分发目录与原始 README](https://github.com/Tonejs/audio/tree/efd8296360f9526e379bfbe5c1698ff54d6a1d34/salamander)：记录 Yamaha C5、Alexander Holm 与 CC BY 3.0。
- [原作者声明](https://rytmenpinne.wordpress.com/sounds-and-such/salamander-grandpiano/)：2022-03-04 起声明公有领域。包内仍完整保留作者、来源、原分发说明与许可链接。
- 本地 `scripts/fetch-karaoke-piano.py` 固定版本抓取；`public/media/karaoke/piano/manifest.json` 记录逐文件 SHA-256、大小与音高。
- 音源完全同源加载，首个用户手势恢复 AudioContext；等待或解码期间不会先出音，播放完成前的取消由演示运行令牌校验。采样失败可重试。
- 17 个 MP3 已用 libsndfile 实际解码，均为 44.1kHz 双声道。单元测试核对哈希、音域、最近采样移调、准备不发声、停止与失败重试。

## 保留的声音

Choir 的唱音仍用项目自制的 AH 共振峰合成示范，便于准确跟唱和精确保留静音回应段；不把钢琴或合成 AH 称为真人录音。Pure fifth / 12-TET 对比继续使用精确频率的音源，不能用已调律的钢琴样本冒充频率比实验。

## 其他候选

- [VSCO 2 Community Edition](https://versilian-studios.com/vsco-community/)：官方提供约 3GB 的 CC0 室内管弦乐素材；对本轮短钢琴/唱音演示范围过大，未加入。
- [MIDI.js Soundfonts](https://github.com/gleitz/midi-js-soundfonts)：原乐器使用的 Musyng Kite 分发为 CC BY-SA 3.0，FluidR3 为 CC BY 3.0。可用于将来更多音色；本轮采样钢琴使用独立的小型本地包，不改原乐器音源。
