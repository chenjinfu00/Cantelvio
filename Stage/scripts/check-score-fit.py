"""Read every local PDF page; persist conservative display bounds, never edit PDFs."""
import json
from pathlib import Path
import fitz
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
LIBRARY = ROOT / '.local-library'
VERSION = 1

def page_bounds(page):
    # Count every non-white mark, not only recognised staves. Dust or scan edges
    # reduce enlargement but cannot cause a real note to be discarded as noise.
    pix = page.get_pixmap(matrix=fitz.Matrix(1, 1), colorspace=fitz.csGRAY, alpha=False)
    image = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width)
    ys, xs = np.nonzero(image < 250)
    if not len(xs):
        return [0, 0, 1, 1]
    pad = 12  # generous 12-point margin around all detected ink
    box = [max(0, (xs.min()-pad)/pix.width), max(0, (ys.min()-pad)/pix.height), min(1, (xs.max()+pad+1)/pix.width), min(1, (ys.max()+pad+1)/pix.height)]
    if box[2]-box[0] < .1 or box[3]-box[1] < .1:
        return [0, 0, 1, 1]
    return [round(float(value), 6) for value in box]

def main():
    files = json.loads((LIBRARY/'manifest.json').read_text())['files']
    out = LIBRARY/'fit'
    out.mkdir(exist_ok=True)
    summary = {'version': VERSION, 'pdfs': 0, 'pages': 0, 'failed': []}
    for index, (identity, relative) in enumerate(files.items(), 1):
        target = out/(identity+'.json')
        try:
            if target.exists() and json.loads(target.read_text()).get('version') == VERSION:
                result = json.loads(target.read_text())
            else:
                with fitz.open(LIBRARY/relative) as document:
                    pages = []
                    for page in document:
                        pages.append({'width': page.rect.width, 'height': page.rect.height, 'bounds': page_bounds(page)})
                    result = {'version': VERSION, 'id': identity, 'method': 'all-marks-72dpi-12pt-safety', 'pages': pages}
                temporary = target.with_suffix('.tmp')
                temporary.write_text(json.dumps(result, ensure_ascii=False))
                temporary.replace(target)
            summary['pdfs'] += 1
            summary['pages'] += len(result['pages'])
        except Exception as error:
            summary['failed'].append({'id': identity, 'error': str(error)[:150]})
        if index % 10 == 0 or index == len(files):
            print(f"Checked {index}/{len(files)} PDFs; {summary['pages']} pages; {len(summary['failed'])} failures", flush=True)
    (LIBRARY/'fit-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps({key:value for key,value in summary.items() if key != 'failed'}), flush=True)

if __name__ == '__main__':
    main()
