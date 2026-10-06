import sys,unittest
from pathlib import Path
import torch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from four_pillar_v2_inference_cache import CausalDecoderCache,StaticCache
from torch import nn

class CacheTest(unittest.TestCase):
    def test_prefix_clock_memory_and_eviction_parity(self):
        torch.set_num_threads(1);torch.manual_seed(42)
        core=nn.TransformerDecoder(nn.TransformerDecoderLayer(24,3,48,dropout=0.,batch_first=True,norm_first=True),2).eval()
        cached=CausalDecoderCache(core).eval()
        data=torch.randn(1,12,24);memory=torch.randn(1,7,24);pad=torch.tensor([[False]*5+[True]*2])
        with torch.inference_mode():
            cases=[data[:,:3],data[:,:5],data[:,:8],data[:,:8].clone(),data[:,:10],data[:,4:]]
            cases[3][:,-1]+=0.2
            for x in cases:
                expected=core(x,memory,tgt_mask=torch.triu(torch.ones(x.shape[1],x.shape[1],dtype=torch.bool),1),memory_key_padding_mask=pad)
                actual=cached(x,memory,memory_key_padding_mask=pad)
                torch.testing.assert_close(actual,expected,atol=2e-6,rtol=2e-5)
            memory+=.1
            torch.testing.assert_close(cached(data,memory,memory_key_padding_mask=pad),core(data,memory,tgt_mask=torch.triu(torch.ones(12,12,dtype=torch.bool),1),memory_key_padding_mask=pad),atol=2e-6,rtol=2e-5)
            pad[:,4]=True
            torch.testing.assert_close(cached(data,memory,memory_key_padding_mask=pad),core(data,memory,tgt_mask=torch.triu(torch.ones(12,12,dtype=torch.bool),1),memory_key_padding_mask=pad),atol=2e-6,rtol=2e-5)

if __name__=='__main__':unittest.main()
