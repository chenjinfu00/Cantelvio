// Score's PDF library shares Stage's reader without treating PDF pixels as editable notes.
export function scoreLibraryPage(html,{connected=false}={}){
  return html.replace('<title>Volta · 听谱翻页</title>','<title>Cantelvio Score · 曲谱库</title>')
    .replace('</head>',`${connected?'<script type="text/plain" id="score-library-connection">./library/connection.json</script>':''}<link rel="stylesheet" href="./score-library.css"></head>`)
    .replace('<span class="brand-mark">V</span><span>volta','<span class="brand-mark">C</span><span>Cantelvio Score')
    .replace('VOLTA / MUSIC LIBRARY','CANTELVIO SCORE / MUSIC LIBRARY')
    .replace('<h2>曲目概览</h2>','<h2>我的曲谱库</h2><p class="score-library-tip">选择 iPad 本地或 iCloud 中的曲谱文件夹，然后搜索和阅读。曲谱保留在设备上。</p>')
    .replace('<section class="local-folder"','<a class="secondary full score-editor-link" href="../">乐谱编辑器 ↗</a><section class="local-folder"');
}
