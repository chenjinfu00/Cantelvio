"""Content fingerprint every approved MIDI, without changing membership."""
import argparse
import json
from pathlib import Path

from four_pillar_midi_data import ROOT, sha256, source_path, verify_manifest

MEMBERSHIP=ROOT/'data/four-pillar-midi-all-train-v1.json'
FINGERPRINTS=ROOT/'data/four-pillar-v2-source-hashes.json'


def key(row):return row['source']+':'+row['name']


def prepare():
    if FINGERPRINTS.exists():raise FileExistsError(FINGERPRINTS)
    membership=json.loads(MEMBERSHIP.read_text())
    verify_manifest(membership)
    hashes={}
    for index,row in enumerate(membership['rows'],1):
        hashes[key(row)]=sha256(source_path(row))
        if index%10000==0:print(json.dumps({'fingerprinted':index}),flush=True)
    data={'schema':'four-pillar-v2-midi-content-1',
          'membershipSha256':sha256(MEMBERSHIP),'sha256':hashes}
    with FINGERPRINTS.open('x') as stream:
        json.dump(data,stream,ensure_ascii=False,separators=(',',':'))
    print(json.dumps({'fingerprinted':len(hashes),'path':str(FINGERPRINTS)}),flush=True)


class SourceIntegrity:
    def __init__(self,membership,*,verify_all=True):
        data=json.loads(FINGERPRINTS.read_text())
        if (data['schema']!='four-pillar-v2-midi-content-1'
                or data['membershipSha256']!=sha256(MEMBERSHIP)
                or set(data['sha256'])!={key(row) for row in membership['rows']}):
            raise RuntimeError('frozen MIDI content inventory changed')
        self.hashes=data['sha256']
        if verify_all:
            for row in membership['rows']:self.check(row)

    def check(self,row):
        if sha256(source_path(row))!=self.hashes[key(row)]:
            # Integrity failures must bypass the sampler's data-rejection retry.
            raise RuntimeError('MIDI content changed: '+row['name'])


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prepare',action='store_true')
    if parser.parse_args().prepare:prepare()
    else:
        SourceIntegrity(json.loads(MEMBERSHIP.read_text()))
        print('All approved MIDI contents match their frozen fingerprints.')
