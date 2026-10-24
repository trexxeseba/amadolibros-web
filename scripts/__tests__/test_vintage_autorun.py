"""Tests del supervisor Vintage: python -m unittest discover -s scripts/__tests__ -p "test_vintage_autorun.py"."""
import re
import sys
import unittest.mock
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
    runner.wait_seconds = []

    def wait(seconds, reason):
        runner.waits.append(reason)
        runner.wait_seconds.append(seconds)
    runner.wait = wait
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


class RenewLadderTest(unittest.TestCase):
    def test_repeated_renewals_back_off_gradually_and_never_wait_hours(self):
        # 22/10 y 23/10: tres vueltas seguidas de auth_error dejaron al publicador 6 h parado.
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [3474] * 6)
            for _ in range(6):
                runner.cycle()
            self.assertEqual(runner.wait_seconds, [120, 120, 900, 1800, 3600, 3600])
            self.assertEqual(runner.waits[2], "renovación repetida")

    def test_publishing_again_restarts_the_ladder(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [100, 100, 100, 100, 150, 150])
            for _ in range(6):
                runner.cycle()
            self.assertEqual(runner.wait_seconds, [120, 120, 900, 1800, 120, 120])


class UpdateCodeTest(unittest.TestCase):
    def runner(self, directory):
        args = types.SimpleNamespace(directory=directory, excel=None, connection=None, secret_file=None, sbs_file=None, node=None, target=10000, notify_url=None, no_update=False)
        runner = vintage_autorun.Runner(args)
        runner.notices = []
        runner.notify = lambda title, message, key=None, every_s=3600: runner.notices.append((title, message, every_s))
        return runner

    def fake_git(self, pull_code=0, pull_error="", head="abc1234"):
        def run(command, **kwargs):
            if "pull" in command:
                return types.SimpleNamespace(returncode=pull_code, stdout="", stderr=pull_error)
            if "--abbrev-ref" in command:
                return types.SimpleNamespace(returncode=0, stdout="main" + chr(10), stderr="")
            return types.SimpleNamespace(returncode=0, stdout=head + chr(10), stderr="")
        return run

    def update(self, runner, run):
        with unittest.mock.patch.object(vintage_autorun.shutil, "which", return_value="git"), unittest.mock.patch.object(vintage_autorun.subprocess, "run", side_effect=run):
            return runner.update_code()

    def test_a_failed_pull_is_reported_right_away_and_repeats_every_half_hour(self):
        # El pull ocurre una vez por ciclo (que puede durar un día): no se espera a una segunda falla.
        with tempfile.TemporaryDirectory() as directory:
            runner = self.runner(directory)
            error = "error: The following untracked working tree files would be overwritten by merge: package.json"
            self.assertFalse(self.update(runner, self.fake_git(pull_code=1, pull_error=error)))
            self.assertEqual(len(runner.notices), 1)
            title, message, every_s = runner.notices[0]
            self.assertEqual(title, "Vintage: no pude actualizar el código")
            self.assertEqual(every_s, 30 * 60)
            self.assertIn("package.json", message)
            self.assertIn("sigue con el código anterior", message)

    def test_git_unreachable_is_reported_too(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.runner(directory)
            def broken(command, **kwargs):
                raise OSError("sin red")
            self.assertFalse(self.update(runner, broken))
            self.assertEqual([n[0] for n in runner.notices], ["Vintage: no pude consultar el código"])
            self.assertEqual(runner.notices[0][2], 6 * 3600)

    def test_a_successful_pull_stays_silent_and_reports_new_code(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.runner(directory)
            runner.head = "old0000"
            self.assertTrue(self.update(runner, self.fake_git(head="new1111")))
            self.assertEqual(runner.notices, [])

    def test_a_pull_with_nothing_new_returns_false_and_stays_silent(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.runner(directory)
            runner.head = "same222"
            self.assertFalse(self.update(runner, self.fake_git(head="same222")))
            self.assertEqual(runner.notices, [])


class TargetRaisedTest(unittest.TestCase):
    def closed_runner(self, directory, status):
        runner = make_runner(directory, [10000])
        runner.status = lambda: status
        runner.run_engine = lambda: (0, None)
        return runner

    def test_closed_campaign_with_target_still_open_checks_again_soon(self):
        # Seba subió el objetivo con set-target: el run figura 'complete' pero faltan libros.
        with tempfile.TemporaryDirectory() as directory:
            runner = self.closed_runner(directory, {"state": "complete", "published_total": 10000, "run": {"target_remaining": 500}})
            runner.cycle()
            self.assertEqual(runner.waits, ["objetivo subido"])

    def test_closed_campaign_at_its_target_still_waits_for_new_stock(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.closed_runner(directory, {"state": "complete", "published_total": 10000, "run": {"target_remaining": 0}})
            runner.cycle()
            self.assertEqual(runner.waits, ["sin pendientes"])

    def test_without_target_info_the_previous_behavior_is_kept(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.closed_runner(directory, {"state": "complete", "published_total": 10000})
            runner.cycle()
            self.assertEqual(runner.waits, ["sin pendientes"])

    def test_engine_gets_the_ceiling_not_the_launcher_target(self):
        # run.cmd fija --target 10000; el objetivo real lo manda la base (set-target).
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [10000])
            command = runner.engine_command()
            self.assertEqual(command[command.index("--target") + 1], str(vintage_autorun.ENGINE_TARGET_CEILING))

    def test_ceiling_matches_the_engine_constant(self):
        engine = Path(vintage_autorun.ENGINE).read_text("utf-8")
        match = re.search(r"MAX_TARGET_TOTAL\s*=\s*(\d+)", engine)
        self.assertIsNotNone(match)
        self.assertEqual(int(match.group(1)), vintage_autorun.ENGINE_TARGET_CEILING)

    def test_running_campaign_past_the_old_target_is_not_treated_as_finished(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.closed_runner(directory, {"state": "publishing", "published_total": 10040, "run": {"target_remaining": 2960}})
            runner.cycle()
            self.assertNotIn("sin pendientes", runner.waits)


if __name__ == "__main__":
    unittest.main()
