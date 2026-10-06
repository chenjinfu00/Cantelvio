let language='zh',state=null;
const text=(zh,en)=>language==='zh'?zh:en;
const score=id=>`http://127.0.0.1:5178/?demo=${id}&service=${encodeURIComponent('http://127.0.0.1:8766')}`;
const cards=[
  ['01','旋律配伴奏','Melody accompaniment','给定旋律保持原样，生成钢琴或其他乐器的伴奏。','Keep the melody and write accompaniment for piano or other instruments.','accompaniment','accompany-melody'],
  ['02','续写音乐','Continue music','从现有曲谱接着写，比较不同走向。','Continue an existing score and compare different directions.','continue','continue'],
  ['03','依和弦作曲','Compose from chords','改一组和弦，让模型写旋律与伴奏。','Edit chord symbols and generate melody and accompaniment.','chords','melody-from-chords'],
  ['04','动机发展','Develop a motif','从短小材料出发，生成后续的重复与变化。','Develop short material into repetitions and variations.','motif','develop-motif'],
  ['05','重新配器','Orchestrate','把已有音乐交给不同乐器组，回到总谱试听和编辑。','Assign existing music to instrument groups, then hear and edit the score.','orchestrate','orchestrate'],
  ['06','编辑、分析与导出','Edit, analyse and export','输入音符、自动标和弦、撤销修改，试听并导出 MIDI、矢量 PDF。','Enter notes, analyse chords, undo edits, listen, and export MIDI or vector PDF.','accompaniment',null],
];
function render() {
  document.documentElement.lang=language==='zh'?'zh-CN':'en';
  document.querySelectorAll('[data-zh]').forEach(el=>el.textContent=el.dataset[language]);
  const ready=state?.scoreReady&&state?.composer?.ok&&!state.composer.mock;
  document.querySelector('#status').textContent=state?text(ready?'编辑器已连接 · 真实 v3.1 模型 · 5 项作曲任务':'部分服务尚未连接，请检查本机启动状态',ready?'Editor connected · Real v3.1 model · Five composition tasks':'Some services are offline; check the local launch status'):text('正在连接本机服务…','Connecting to local services…');
  document.querySelector('#features').innerHTML=cards.map(c=>{
    const available=ready&&(!c[6]||state.composer.tasks?.includes(c[6]));
    return `<article><div class="card-top"><span class="number">${c[0]}</span><span class="badge ${available?'ready':''}">${text(available?'可试用':'等待服务',available?'Ready':'Waiting')}</span></div><h2>${text(c[1],c[2])}</h2><p>${text(c[3],c[4])}</p><a href="${score(c[5])}" target="_blank" rel="noreferrer">${text('打开演示','Open demo')} →</a></article>`;
  }).join('');
  const imports=state?.composer?.imports;
  const rows=[
    [text('连续生成与六组控制','Continuous generation and six-group controls'),text('已实现 · 当前 v2 · 首次准备八小节后开始','Implemented · current v2 · prepares eight bars before playback'),'../?debug'],
    [text('MusicXML 导入 / 乐谱保存 / SoundFont 回放','MusicXML import / score saving / SoundFont playback'),text('已接入编辑器','Available in the editor'),score('accompaniment')],
    [text('录音转乐谱','Recording to score'),text(imports?.audio?'本机工具可用 · 可在编辑器打开录音':'本机工具尚未就绪',imports?.audio?'Local tools ready · open a recording in the editor':'Local tools unavailable'),score('accompaniment')],
    [text('PDF / 图片识谱','PDF / image recognition'),text(imports?.pdf?'本机工具可用':'入口已实现 · 尚需安装 Audiveris',imports?.pdf?'Local tools ready':'Entry implemented · Audiveris installation required'),null],
    ['Anticipatory Music Transformer',text('代码与权重已下载 · 本轮尚未接入生成','Code and weights downloaded · generation integration pending'),null],
    [text('MusicXML 导出 / 大编制 MIDI / 长作品结构','MusicXML export / large-ensemble MIDI / long-form structure'),text('后续开发项','Planned work'),null],
  ];
  document.querySelector('#availability').innerHTML=rows.map(([name,status,url])=>`<div class="availability-row"><strong>${name}</strong><span>${status}</span>${url?`<a href="${url}" target="_blank" rel="noreferrer">${text('打开','Open')} ↗</a>`:''}</div>`).join('');
}
async function connect(){try{const response=await fetch('/api/demo/status');if(!response.ok)throw new Error();state=await response.json()}catch{state={}}render()}
document.querySelector('#lang').onchange=e=>{language=e.target.value;render()};
window.addEventListener('focus',connect);render();connect();
