"""Tests del supervisor Vintage: python -m unittest discover -s scripts/__tests__ -p "test_vintage_autorun.py"."""
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import vintage_autorun  # noqa: E402


def make_runner(directory, published_by_run):
    args = types.SimpleNamespace(directory=directory, excel=None, connection=None, secret_file=None, sbs_file=None, node=None, target=10000, notify_url=None)
    runner = vintage_autorun.Runner(args)
    runner.waits = []
    totals = iter(published_by_run)
    current = {"published_total": published_by_run[0]}
    runner.update_code = lambda: False
    runner.connection_expires_at = lambda: time.time() + 86400
    runner.renew = lambda: (0, {"state": "renewed"})
    runner.sync_stock = lambda: None
    runner.heartbeat = lambda published, state: None
    runner.notify = lambda *a, **k: None
    runner.wait = lambda seconds, reason: runner.waits.append(reason)
    runner.status = lambda: dict(current)

    def run_engine():
        current.update(published_total=next(totals), state="auth_error")
        return 0, None
    runner.run_engine = run_engine
    return runner


class RenewLoopTest(unittest.TestCase):
    def test_auth_error_after_publishing_does_not_count_as_repeated_renewal(self):
        # Como el 22/10: auth_error a las 04:32 y a las 16:25 con más de mil altas entre medio.
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [3474, 3673, 4934, 5100])
            for _ in range(3):
                runner.cycle()
            self.assertNotIn("renovación repetida", runner.waits)

    def test_auth_error_without_progress_still_backs_off(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [3474, 3474, 3474, 3474])
            for _ in range(3):
                runner.cycle()
            self.assertIn("renovación repetida", runner.waits)


if __name__ == "__main__":
    unittest.main()
