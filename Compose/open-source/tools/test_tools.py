import csv
import tempfile
import unittest
from pathlib import Path
from evaluate_notes import evaluate
from select_pdmx import eligible


class ToolsTest(unittest.TestCase):
    def test_license_filter_fails_closed(self):
        row = {"subset:no_license_conflict": "True", "license_conflict": "False", "subset:all_valid": "True", "is_best_unique_arrangement": "True"}
        self.assertTrue(eligible(row))
        self.assertFalse(eligible({**row, "license_conflict": "True"}))
        self.assertFalse(eligible({**row, "license_conflict": ""}))
        self.assertFalse(eligible({**row, "subset:all_valid": "False"}))
        self.assertFalse(eligible({**row, "is_best_unique_arrangement": "False"}))

    def test_wrong_pitch_and_offset_are_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ref, est = Path(tmp)/"ref.csv", Path(tmp)/"est.csv"
            def write(path, rows):
                with path.open("w", newline="") as f:
                    w=csv.writer(f);w.writerow(["onset_seconds", "offset_seconds", "midi"]);w.writerows(rows)
            write(ref, [(0,1,60), (1,2,64)])
            write(est, [(0,1,60), (1,2,64)])
            self.assertEqual(evaluate(ref, est)["onset"]["f1"], 1)
            write(est, [(0,.2,60), (1,2,65)])
            result=evaluate(ref, est)
            self.assertEqual(result["onset"]["f1"], .5)
            self.assertEqual(result["onsetAndOffset"]["f1"], 0)


if __name__ == "__main__":
    unittest.main()
