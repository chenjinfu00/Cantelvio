// Keep public names separate from the legacy storage/backup identifiers.
export function brandReaderPage(html,{name='Cantelvio Score',eyebrow='CANTELVIO SCORE'}={}){
  return html.replaceAll('Volta',name).replaceAll('VOLTA',eyebrow)
    .replace(/>volta(?=<)/g,'>'+name)
    .replace('<span class="brand-mark">V</span>','<span class="brand-mark">C</span>')
    .replaceAll('https://github.com/chenjinfu00/volta#readme','https://github.com/chenjinfu00/Cantelvio/tree/main/Stage#readme');
}

// Score's PDF library shares Stage's reader without treating PDF pixels as editable notes.
export function scoreLibraryPage(html,{connected=false}={}){
  const editorLink=html.includes('score-editor-link')?'':'<a class="secondary full score-editor-link" href="../">乐谱编辑器 ↗</a>';
  return brandReaderPage(html).replace('<title>Cantelvio Score · 听谱翻页</title>','<title>Cantelvio Score · 曲谱库</title>')
    .replace('</head>',`${connected?'<script type="text/plain" id="score-library-connection">./library/connection.json</script>':''}<link rel="stylesheet" href="./score-library.css"></head>`)
    .replace('<div class="shelf-actions">',editorLink+'<div class="shelf-actions">');
}
