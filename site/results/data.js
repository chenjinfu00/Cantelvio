/* Cantelvio results — every number here is copied from the project's own reports/notes (see `src`).
   Status as of 2026-10-07. Edit this file to update the page; app.js renders everything from it. */
window.RESULTS = {
  asOf: '2026-10-07',
  repo: 'https://github.com/chenjinfu00/Cantelvio',
  tiles: [
    {v: '71.2%', zh: '和声分析 v2：读全部音符时，逐拍和弦完全一致（对 AugmentedNet，80 首测试作品）', en: 'Harmony analysis v2: exact per-beat chord match reading all notes (vs AugmentedNet, 80 test pieces)'},
    {v: '89.1%', zh: '艺术歌曲「模拟转写 → 乐谱」逐音 F1（模拟数据，非真实录音）', en: 'Art-song audio-to-score note F1 (simulated transcription, not real recordings)'},
    {v: '2.7%', zh: '配伴奏半音冲突：选 32 份 + 冲突惩罚 4（3 首简单旋律，训练集窗口）', en: 'Accompaniment semitone clashes: best-of-32 + clash penalty 4 (3 simple melodies, training-set windows)'},
    {v: '654 / 654', zh: 'music21 语料库 MusicXML 文件全部导入编辑器，0 个结构错误', en: 'music21-corpus MusicXML files imported by the editor with 0 structural errors'}
  ],
  models: [
    {n: 'Harmony v2 / Melody v5', p: '204,391 / 349,325', zh: '最早的和声与旋律 Transformer（合成数据 + 少量 Lieder）；已被联合模型取代', en: 'First harmony and melody Transformers (synthetic data + a little Lieder); replaced by the joint model', s: 'hist'},
    {n: 'Joint 4-track v1', p: '1,581,309', zh: '和声、低音、旋律、节奏合一；2026-09-27 起在网页演示中使用', en: 'Harmony, bass, melody and rhythm in one model; used by the web demo since 2026-09-27', s: 'web'},
    {n: 'Orchestra (ablation)', p: '≈4.4M', zh: '管弦乐通用 Transformer + 12 平均律对称性对照实验', en: 'General orchestral Transformer; 12-tone symmetry ablation', s: 'res'},
    {n: 'Four-pillar v2', p: '6,965,881', zh: '四大件 v2（含冻结旧分支）；本机连续演奏使用', en: 'Four-pillar v2 (with frozen legacy branch); used by local continuous performance', s: 'local'},
    {n: 'Four-pillar v3.1', p: '5,014,967', zh: '调内相对音高 + 规划器 + 参考小节；续训到第 101,129 步；Score 的五项作曲任务使用', en: 'Key-relative pitch + planner + reference bars; trained to step 101,129; powers Score’s five composition tasks', s: 'local'},
    {n: 'Harmonizer v1', p: '865,248', zh: '旋律 → 和弦（双向编码器）', en: 'Melody → chords (bidirectional encoder)', s: 'local'},
    {n: 'Harmony analysis v2', p: '870,368', zh: '读全部音符的和声分析（自动标和弦）', en: 'Harmony analysis from all notes (automatic chord labelling)', s: 'local'},
    {n: 'Note filler v1', p: '582,841', zh: '扒谱后补漏掉的音', en: 'Fills missed notes after audio transcription', s: 'local'}
  ],
  statusLabel: {
    hist: {zh: '历史', en: 'Historical'}, web: {zh: '网页可用', en: 'In the web demo'},
    res: {zh: '研究', en: 'Research'}, local: {zh: '需本机服务', en: 'Needs the local service'}
  },
  /* lower is better unless noted */
  jointMelody: [
    {k: 'v5', zh: 'Melody v5（旧）', en: 'Melody v5 (old)', v: 2.219, c: 'ref'},
    {k: 's', zh: '联合·结构化（158 万）', en: 'Joint · structured (1.58M)', v: 1.900, c: 'a'},
    {k: 'g1', zh: '联合·通用同参数量（161 万）', en: 'Joint · generic, same params (1.61M)', v: 1.929, c: 'a'},
    {k: 'g2', zh: '联合·通用同计算量（52 万）', en: 'Joint · generic, same compute (0.52M)', v: 2.061, c: 'a'},
    {k: 'g3', zh: '消融：无位置输入（52 万）', en: 'Ablation: no position input (0.52M)', v: 2.192, c: 'a'}
  ],
  jointChord: [
    {k: 'v2', zh: 'Harmony v2（旧）', en: 'Harmony v2 (old)', v: 4.105, c: 'ref'},
    {k: 's', zh: '联合·结构化（158 万）', en: 'Joint · structured (1.58M)', v: 2.412, c: 'a'},
    {k: 'g1', zh: '联合·通用同参数量（161 万）', en: 'Joint · generic, same params (1.61M)', v: 2.421, c: 'a'},
    {k: 'g2', zh: '联合·通用同计算量（52 万）', en: 'Joint · generic, same compute (0.52M)', v: 2.545, c: 'a'},
    {k: 'g3', zh: '消融：无位置输入（52 万）', en: 'Ablation: no position input (0.52M)', v: 2.587, c: 'a'}
  ],
  ablation: [
    {zh: '绝对音高', en: 'Absolute pitch', v: 2.421, t5: 2.496, t4: 2.497},
    {zh: '绝对音高 + 移调增强', en: 'Absolute + transposition augmentation', v: 2.503, t5: 2.563, t4: 2.535},
    {zh: '音高旋转 + 音区', en: 'Pitch rotation + register', v: 1.826, t5: 1.830, t4: 1.830},
    {zh: '音高旋转 + 音区 + 移调增强', en: 'Pitch rotation + register + augmentation', v: 1.810, t5: 1.813, t4: 1.811, best: true},
    {zh: '严格等变（无音区）+ 移调增强', en: 'Strictly equivariant (no register) + augmentation', v: 1.837, t5: 1.838, t4: 1.838}
  ],
  penaltyX: ['0', '1', '2', '4', '8'],
  penalty: {
    clash: [
      {zh: '选 8 份', en: 'best of 8', y: [17.2, 13.4, 9.8, 7.6, 7.3]},
      {zh: '选 32 份', en: 'best of 32', y: [9.9, 6.4, 5.5, 2.7, 1.2]}
    ],
    tone: [
      {zh: '选 8 份', en: 'best of 8', y: [74.0, 77.8, 78.3, 78.3, 77.9]},
      {zh: '选 32 份', en: 'best of 32', y: [86.3, 84.7, 84.8, 83.7, 86.9]}
    ]
  },
  amtSimple: [
    {zh: 'v3.1 只锁旋律', en: 'v3.1, melody locked', v: 21.9, c: 'v'},
    {zh: 'v3.1 选 8 份', en: 'v3.1, best of 8', v: 17.2, c: 'v'},
    {zh: 'v3.1 选 8 份 + 惩罚 4', en: 'v3.1, best of 8 + penalty 4', v: 7.6, c: 'v'},
    {zh: 'v3.1 选 32 份 + 惩罚 4', en: 'v3.1, best of 32 + penalty 4', v: 2.7, c: 'v'},
    {zh: 'AMT 无开头（12 段中 8 段有伴奏）', en: 'AMT, no intro (8 of 12 clips had accompaniment)', v: 8.1, c: 'amt'},
    {zh: 'AMT 旋律前放一小节主和弦', en: 'AMT, 1-bar tonic intro before the melody', v: 4.5, c: 'amt'}
  ],
  amtLieder: [
    {zh: '真实钢琴（参照）', en: 'Real piano (reference)', v: 7.9, tone: 93.1, c: 'ref'},
    {zh: 'AMT（开头一小节主和弦）', en: 'AMT (1-bar tonic intro)', v: 14.1, tone: 59.5, c: 'amt'},
    {zh: 'v3.1 只锁旋律', en: 'v3.1, melody locked', v: 26.3, tone: 49.4, c: 'v'},
    {zh: 'v3.1 选 8 份 + 惩罚 4', en: 'v3.1, best of 8 + penalty 4', v: 11.3, tone: 51.3, c: 'v'}
  ],
  harmBars: [
    {zh: '只读旋律：配和声 v1', en: 'Melody only: harmonizer v1', v: 36.9, c: 'a'},
    {zh: '只读旋律：分析模型 v2', en: 'Melody only: analysis v2', v: 35.0, c: 'a'},
    {zh: '只读旋律：只依据调号的规则', en: 'Melody only: key-signature rule', v: 27.7, c: 'ref'},
    {zh: '读全部音符：分析模型 v2', en: 'All notes: analysis v2', v: 71.2, c: 'a'},
    {zh: '读全部音符：规则和弦跟踪器', en: 'All notes: rule-based chord tracker', v: 67.0, c: 'ref'}
  ],
  harmEffect: [
    {zh: '3 首旋律（选 8 份）', en: '3 melodies (best of 8)', a: '11.8% → 6.1%', b: '72% → 99%', note: {zh: '人写和弦：9.2% / 88%', en: 'human chords: 9.2% / 88%'}},
    {zh: '60 首真实艺术歌曲', en: '60 real art songs', a: '19.5% → 14.3%', b: '69% → 84%', note: {zh: '代价：和声节奏偏密', en: 'cost: harmonic rhythm gets busy'}}
  ],
  audioX: {zh: ['原始转写', '整理 v1', '+ 跑动处理', '+ 补音规则', '+ 补音模型'], en: ['Raw transcription', 'Cleanup v1', '+ Run handling', '+ Filler rules', '+ Filler model']},
  audio: [
    {zh: '艺术歌曲', en: 'Art songs', y: [84.2, 86.3, 88.3, 88.8, 89.1]},
    {zh: '弦乐四重奏', en: 'String quartets', y: [86.2, 88.2, 89.9, 89.6, 89.7]}
  ],
  augnet: [
    {zh: '与 AugmentedNet 一致：根音 + 性质', en: 'Agreement with AugmentedNet: root + quality', a: '51.1%', b: ''},
    {zh: '与 AugmentedNet 一致：根音', en: 'Agreement with AugmentedNet: root', a: '60.1%', b: ''},
    {zh: '和弦音覆盖率（响着的音中是和弦音的比例）', en: 'Chord-tone coverage', a: '75.6%', b: '89.8%'},
    {zh: '低音是根音', en: 'Bass is the chord root', a: '40.8%', b: '50.9%'},
    {zh: '每小节和弦数', en: 'Chords per bar', a: '1.82', b: '1.36'}
  ],
  v31Steps: [
    {zh: '音符交叉熵', en: 'Note cross-entropy', a: '1.834', b: '1.792', better: true},
    {zh: '和弦根音损失（训练时的标签）', en: 'Chord-root loss (training labels)', a: '0.686', b: '0.515', better: true},
    {zh: '和弦性质损失', en: 'Chord-quality loss', a: '0.402', b: '0.287', better: true},
    {zh: '配伴奏·只锁旋律：半音冲突', en: 'Accompaniment, melody locked: clashes', a: '24.6%', b: '22.5%', better: true},
    {zh: '配伴奏·选 8 份：半音冲突', en: 'Accompaniment, best of 8: clashes', a: '13.7%', b: '16.0%', better: false},
    {zh: '配伴奏·选 32 份：半音冲突', en: 'Accompaniment, best of 32: clashes', a: '8.1%', b: '9.9%', better: false},
    {zh: '依和弦写旋律：强拍和弦音', en: 'Melody from chords: strong-beat chord tones', a: '93.0%', b: '95.2%', better: true},
    {zh: '配器：给定音分到原曲用过的组', en: 'Orchestration: notes given to the original’s groups', a: '70.8%', b: '66.4%', better: false},
    {zh: '动机变形 Jaccard', en: 'Motif transformation Jaccard', a: '0.512', b: '0.528', better: true}
  ],
  trainX: {zh: ['前 2,000 步', 'v2 第一轮末（20,134 步）', 'v2 续训末（累计 39,327 步）'], en: ['First 2,000 steps', 'End of v2 run 1 (20,134)', 'End of continued run (39,327 total)']},
  train: [{zh: '事件损失（训练集，无验证集）', en: 'Event loss (training set; no validation set)', y: [2.32, 1.17, 1.00]}],
  software: [
    {zh: 'MusicXML 导入：music21 语料库', en: 'MusicXML import: music21 corpus', v: {zh: '654 个文件全部导入，0 个结构错误；181 个文件与 music21 逐音比较 99.0% 一致（差异在 music21 一侧）', en: 'all 654 files imported with 0 structural errors; 181 files compared note-by-note with music21: 99.0% identical (differences are on music21’s side)'}},
    {zh: 'PDF 识谱（Audiveris，300 dpi 自家排版的乐谱）', en: 'PDF import (Audiveris, 300 dpi scores engraved by the editor)', v: {zh: '众赞歌 100%、《菩提树》90%、韦伯单簧管小协奏曲 80%（指定乐器后 95%）', en: 'chorale 100%, “Der Lindenbaum” 90%, Weber clarinet concertino 80% (95% with the instrument given)'}},
    {zh: 'Stage 全景/无缝视图', en: 'Stage seamless / panorama views', v: {zh: '809 小节的整部四重奏 0.6 秒排好，滚动约 60 帧/秒（原整条内联 SVG 约 16 帧/秒）', en: 'an 809-bar quartet lays out in 0.6 s and scrolls at ≈60 fps (≈16 fps with one inline SVG)'}},
    {zh: '联合模型浏览器推理', en: 'Joint model in-browser inference', v: {zh: '与 PyTorch 逐 logit 对照最大差 2.4×10⁻⁵；48 小节预告与播放 0 差异', en: 'max logit difference vs PyTorch 2.4×10⁻⁵; 0 differences between 48-bar preview and playback'}},
    {zh: '网页发布验证（2026-10-08）', en: 'Web release checks (2026-10-08)', v: {zh: 'Compose 70/70 · Score 195/195 · Harmony 88/88 · Stage 166/166；全部通过，无跳过；静态站点 7 页、0 断链', en: 'Compose 70/70 · Score 195/195 · Harmony 88/88 · Stage 166/166; all passed, none skipped; 7 static pages, 0 broken links'}}
  ],
  audioClips: [
    {id: 'twinkle', zh: '《小星星》', en: 'Twinkle Twinkle'},
    {id: 'ode-to-joy', zh: '《欢乐颂》', en: 'Ode to Joy'},
    {id: 'lightly-row', zh: '《小蜜蜂》', en: 'Lightly Row'}
  ],
  audioKinds: [
    {id: 'v31-k1', zh: 'v3.1 只锁旋律', en: 'v3.1, melody locked'},
    {id: 'v31-k8-pen4', zh: 'v3.1 选 8 份 + 惩罚 4', en: 'v3.1, best of 8 + penalty 4'},
    {id: 'amt-intro', zh: 'AMT（开头一小节主和弦）', en: 'AMT (1-bar tonic intro)'}
  ],
  limits: [
    {zh: '没有独立的留出集：四大件 v3.1 的评估用训练集窗口，只能比较“做法”，不能证明泛化；音乐质量要靠试听。', en: 'No independent held-out set: v3.1 is evaluated on training-set windows, so the numbers compare methods and do not show generalisation. Musical quality needs listening.'},
    {zh: '配伴奏的对照只有 3 首简单旋律 × 4 个种子；在 24 首真实艺术歌曲上，AMT 并不明显更好。v3.1 见过这些总谱、AMT 没见过，所以差距大小不可信。', en: 'The accompaniment comparison uses only 3 simple melodies × 4 seeds; on 24 real art songs AMT is not clearly better. v3.1 saw those scores in training and AMT did not, so the size of any gap is unreliable.'},
    {zh: '“音频 → 乐谱”的数字来自模拟（真实乐谱 + 模拟演奏与转写错误），还没有在真实录音上量过；补音模型可能补出没演奏的音。', en: 'Audio-to-score numbers come from simulation (real scores + simulated performance and transcription errors), not real recordings; the note filler may add notes that were not played.'},
    {zh: '和弦标签是估计值（艺术歌曲用 AugmentedNet，其余用规则跟踪器），两套约定会互相影响评估；AugmentedNet 与规则跟踪器在四重奏上只有约 60% 根音一致。', en: 'Chord labels are estimates (AugmentedNet for art songs, a rule tracker elsewhere); the two conventions affect evaluation, and on quartets they agree on the root only ≈60% of the time.'},
    {zh: '管弦乐对称性对照只跑了一个种子、6,000 步；配器在没有管弦乐上下文时几乎全给弦乐；人声不在模型能预测的六个组里。', en: 'The orchestral symmetry ablation ran one seed for 6,000 steps; orchestration gives almost everything to strings without orchestral context; voice is not one of the six predicted groups.'},
    {zh: '9 小时的学习率衰减 + EMA 收尾训练还没有运行；v3.2（“给定材料”通道）尚未开始。', en: 'The 9-hour LR-decay + EMA finishing run has not started; v3.2 (the “given material” channel) has not begun.'},
    {zh: '许可：MuScriptor 权重与部分评估数据集仅限非商用；SymphonyNet / Lakh 等训练数据版权不明，管弦乐模型不宜公开发布。公开仓库的许可证尚未确定。', en: 'Licences: MuScriptor weights and some evaluation datasets are non-commercial only; SymphonyNet / Lakh training data have unclear copyright, so the orchestral model should not be released. The repository licence is not decided yet.'}
  ],
  sources: [
    {zh: '配伴奏冲突惩罚', en: 'Clash penalty', p: 'Compose/training/reports/accompany-clash-penalty-20261005.json'},
    {zh: 'AMT 对照（3 首旋律）', en: 'AMT comparison (3 melodies)', p: 'Compose/training/reports/amt-compare-20261005/'},
    {zh: 'AMT 对照（24 首艺术歌曲）', en: 'AMT on 24 art songs', p: 'Compose/training/reports/amt-lieder-20261006.json'},
    {zh: '配和声 / 和声分析', en: 'Harmonizer / analysis', p: 'Compose/training/reports/harmonizer-v1-20261003.json、harmonizer-v2-20261003.json'},
    {zh: '音频 → 乐谱', en: 'Audio to score', p: 'Compose/training/reports/audio-to-score-v3-20261004.json'},
    {zh: 'v3.1 续训评估', en: 'v3.1 continuation', p: 'Compose/training/reports/four-pillar-v31-tasks-step101129-20261003.json、four-pillar-v31-parts-labelled-20261004.json'},
    {zh: '联合模型 / 管弦乐对照', en: 'Joint / orchestral ablation', p: 'Compose/training/runs/joint-v1/REPORT.md、Compose/training/orchestra/ABLATION.md'}
  ]
};
