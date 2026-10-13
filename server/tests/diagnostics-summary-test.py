#!/usr/bin/env python3
"""Regression tests for the bounded owner diagnostics summary CLI."""

import datetime as dt
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "server/tools/diagnostics-summary.py"


class DiagnosticsSummaryTests(unittest.TestCase):
    def write_records(self, directory, records):
        name = f"diagnostics-{int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)}-0123456789abcdef.jsonl"
        path = directory / name
        path.write_text("".join(json.dumps(row, separators=(",", ":")) + "\n" for row in records), encoding="utf-8")
        return path

    def run_summary(self, directory):
        return subprocess.run(
            [sys.executable, str(CLI), str(directory), "--last", "100", "--hours", "24"],
            check=False, capture_output=True, text=True, timeout=5,
        )

    def test_deduplicates_sequences_and_uses_latest_cumulative_sample_per_session(self):
        now = dt.datetime.now(dt.timezone.utc)
        a = "a" * 32
        b = "b" * 32

        def row(session, seq, received, callbacks, *, category="audio", kind="periodic", empty=0, dropped=0):
            return {
                "receivedAt": (now - dt.timedelta(seconds=received)).isoformat().replace("+00:00", "Z"),
                "sessionId": session,
                "report": {
                    "category": category, "kind": kind, "seq": seq,
                    "sample": {"audio": {
                        "state": "running", "callbacks": callbacks, "lateCallbacks": callbacks,
                        "sampledFrames": callbacks, "clippedSamples": callbacks, "boundaryJumps": callbacks,
                        "emptyDelta": empty, "droppedDelta": dropped,
                    }},
                    # These are historical repeats, not additional current sample observations.
                    "history": [{"audio": {"emptyDelta": 999, "droppedDelta": 999}}] * 6,
                },
            }

        records = [
            row(a, 1, 6, 10, empty=2, dropped=3),
            row(a, 2, 5, 20, empty=4, dropped=5),
            row(a, 2, 4, 20, category="runtime", kind="issue", empty=4, dropped=5),
            # This old seq=1 retry arrives after seq=2 and cannot replace it.
            row(a, 1, 3, 10, empty=2, dropped=3),
            row(b, 1, 5, 8, empty=1, dropped=2),
            row(b, 2, 4, 100_000_000, empty=6, dropped=7),
            # Sequence zero is not a valid snapshot and must not affect totals.
            row(a, 0, 1, 100_000_000, empty=100, dropped=100),
        ]
        with tempfile.TemporaryDirectory(prefix="diagnostics-summary-test-") as temp:
            self.write_records(Path(temp), records)
            result = self.run_summary(temp)

        self.assertEqual(result.returncode, 0, result.stderr)
        output = result.stdout
        self.assertIn("4 unique recent report(s)", output)
        self.assertIn("duplicate report retries skipped: 2", output)
        self.assertIn("Categories (unique reports): audio=3, runtime=1", output)
        self.assertIn("Kinds (unique reports): issue=1, periodic=3", output)
        for key in ("callbacks", "lateCallbacks", "sampledFrames", "clippedSamples", "boundaryJumps"):
            self.assertIn(f"{key} latest observed cumulative (sum across sessions): 100000020", output)
        self.assertIn("emptyDelta observed sample sum: 13", output)
        self.assertIn("droppedDelta observed sample sum: 17", output)
        self.assertIn("malformed lines skipped: 1", output)
        self.assertIn("cumulative counters may predate the query window", output)
        self.assertIn("not a window event total", output)
        self.assertIn("not complete session totals", output)


if __name__ == "__main__":
    unittest.main()
