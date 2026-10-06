// PDF.js 6 releases documents through their loading task, not PDFDocumentProxy.
export async function loadPDFDocument(getDocument,options,previous,onProgress){
  const task=getDocument(options);
  task.onProgress=onProgress;
  try{
    const pdf=await task.promise;
    if(!pdf.numPages)throw new Error('这个文件没有可显示的 PDF 页面。');
    await previous?.loadingTask.destroy();
    return pdf;
  }catch(error){
    await task.destroy().catch(()=>{});
    throw error;
  }
}
