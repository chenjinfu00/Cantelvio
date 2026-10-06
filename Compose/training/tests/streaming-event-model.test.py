import importlib.util
import pathlib
import unittest
import torch
spec = importlib.util.spec_from_file_location('experiment', pathlib.Path(__file__).resolve().parents[1] / 'experiments/streaming_event_model.py')
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class ArchitectureTests(unittest.TestCase):
    def setUp(self):
        torch.manual_seed(27); torch.set_num_threads(2)
        self.model = m.StreamingEventModel(width=32, heads=4, layers=2, window=8).eval()
        self.events = torch.randn(1, 24, 32)

    def test_incremental_matches_full_across_window_eviction(self):
        with torch.no_grad():
            full, _ = self.model.backbone(self.events)
            cache = None; rows = []
            for index in range(24):
                hidden, cache = self.model.backbone(self.events[:, index:index+1], caches=cache)
                rows.append(hidden)
                self.assertLessEqual(cache[0][0].shape[2], 8)
            torch.testing.assert_close(torch.cat(rows, 1), full, atol=2e-6, rtol=2e-5)
            self.assertEqual(int(cache[0][2][-1]), 23)

    def test_plan_change_does_not_invalidate_backbone(self):
        hidden, caches = self.model.backbone(self.events[:, :8])
        before = [tuple(t.clone() for t in layer) for layer in caches]
        a = self.model.heads(hidden[:, -1:], torch.zeros(1, 1, 32))
        b = self.model.heads(hidden[:, -1:], torch.ones(1, 1, 32))
        self.assertFalse(torch.equal(a['group'], b['group']))
        for old, new in zip(before, caches):
            for left, right in zip(old, new): self.assertTrue(torch.equal(left, right))

    def test_future_cannot_change_past_and_group_conditions_attributes(self):
        other = self.events.clone(); other[:, 12:] += 100
        a, _ = self.model.backbone(self.events); b, _ = self.model.backbone(other)
        torch.testing.assert_close(a[:, :12], b[:, :12])
        plan = torch.zeros(1, 1, 32)
        first = self.model.heads(a[:, -1:], plan, torch.zeros(1, 1, dtype=torch.long))
        second = self.model.heads(a[:, -1:], plan, torch.ones(1, 1, dtype=torch.long))
        self.assertEqual(first['pitch'].shape[-1], 128)
        self.assertEqual(first['drum_identity'].shape[-1], 128)
        self.assertFalse(torch.equal(first['pitch'], second['pitch']))

if __name__ == '__main__': unittest.main()
