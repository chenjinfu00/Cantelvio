"""Download official model snapshots with pinned revisions and SHA-256 verification.
Uses curl for public HTTPS transfer; never executes upstream repository code.
Rerun safely: completed files are verified and skipped, partial files are resumed.
"""
import hashlib,json,subprocess,time
from pathlib import Path
from urllib.parse import quote
ROOT=Path(__file__).resolve().parent
MODELS=ROOT/'models'
LIST=ROOT/'official-models.json'
REPORT=ROOT/'DOWNLOAD_MANIFEST.json'

def transfer(url,path):
    path.parent.mkdir(parents=True,exist_ok=True)
    subprocess.run(['curl','-L','--fail','--silent','--show-error','--retry','5','--retry-delay','3','--connect-timeout','30','--max-time','3600',url,'-o',str(path)],check=True)

def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(8*1024*1024),b''):h.update(chunk)
    return h.hexdigest()

def main():
    if not LIST.exists():transfer('https://huggingface.co/api/models?author=stanford-crfm&search=music-',LIST)
    inventory=[]
    for model in json.loads(LIST.read_text()):
        repo=model['id']
        if not repo.startswith('stanford-crfm/music-'):continue
        metadata=ROOT/'metadata'/ (repo.split('/')[-1]+'.json')
        if not metadata.exists():transfer('https://huggingface.co/api/models/'+repo+'?blobs=true',metadata)
        data=json.loads(metadata.read_text())
        inventory.append({'repo':repo,'revision':data['sha'],'metadata':str(metadata.relative_to(ROOT)),
                          'files':[{'path':f['rfilename'],'size':f.get('size'), 'lfsSha256':f.get('lfs',{}).get('sha256')} for f in data['siblings']]})
    report={'sourceRepository':'https://github.com/jthickstun/anticipation','models':inventory,'complete':False}
    REPORT.write_text(json.dumps(report,indent=2))
    total=sum(f['size'] or 0 for m in inventory for f in m['files'])
    print(json.dumps({'phase':'inventory','models':len(inventory),'totalBytes':total}),flush=True)
    if __import__('sys').argv[-1]=='--inventory-only':return
    import concurrent.futures
    def download(task):
        model,item=task
        target=MODELS/model['repo'].split('/')[-1]
        relative=Path(item['path'])
        if relative.is_absolute() or '..' in relative.parts:raise ValueError('unsafe upstream path')
        path=target/relative;expected=item['lfsSha256']
        started=time.monotonic()
        if path.exists() and (item['size'] is None or path.stat().st_size==item['size']) and (not expected or sha(path)==expected):
            digest=sha(path)
        else:
            part=path.with_name(path.name+'.partial');part.parent.mkdir(parents=True,exist_ok=True)
            url='https://huggingface.co/'+model['repo']+'/resolve/'+model['revision']+'/'+quote(item['path'],safe='/')
            print(json.dumps({'phase':'download','repo':model['repo'],'file':item['path'],'bytes':item['size']}),flush=True)
            subprocess.run(['curl','-L','--fail','--silent','--show-error','--retry','5','--retry-delay','3','--connect-timeout','30','--max-time','7200','-C','-',url,'-o',str(part)],check=True)
            if item['size'] is not None and part.stat().st_size!=item['size']:raise ValueError('size mismatch: '+str(path))
            digest=sha(part)
            if expected and digest!=expected:raise ValueError('SHA256 mismatch: '+str(path))
            part.replace(path)
        return model,item,digest,time.monotonic()-started
    tasks=iter((model,item) for model in inventory for item in model['files'])
    failures=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        active={}
        def admit():
            task=next(tasks,None)
            if task is not None:active[executor.submit(download,task)]=task
        for _ in range(4):admit()
        while active:
            done,_=concurrent.futures.wait(active,return_when=concurrent.futures.FIRST_COMPLETED)
            for future in done:
                model,item=active.pop(future)
                try:
                    _,_,digest,seconds=future.result()
                    item.update(sha256=digest,verified=True,seconds=seconds)
                    print(json.dumps({'phase':'file-verified','repo':model['repo'],'file':item['path'],'seconds':round(seconds,1)}),flush=True)
                except Exception as error:
                    failures.append({'repo':model['repo'],'file':item['path'],'error':str(error)})
                    print(json.dumps({'phase':'file-failed',**failures[-1]}),flush=True)
                # The coordinator is the only manifest writer; each completion
                # immediately frees a slot for another independent file.
                report['failures']=failures
                temporary=REPORT.with_suffix('.tmp')
                temporary.write_text(json.dumps(report,indent=2));temporary.replace(REPORT)
                admit()
    if failures:raise RuntimeError('Some files failed; completed files retained. Rerun to resume.')
    report['complete']=True;report['downloadedBytes']=sum((MODELS/m['repo'].split('/')[-1]/f['path']).stat().st_size for m in inventory for f in m['files'])
    REPORT.write_text(json.dumps(report,indent=2));print(json.dumps({'phase':'complete','bytes':report['downloadedBytes']}),flush=True)
if __name__=='__main__':main()
