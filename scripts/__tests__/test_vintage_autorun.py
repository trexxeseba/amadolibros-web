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
    runner.apply_repo_target = lambda: None
    runner.connection_expires_at = lambda: time.time() + 86400
    runner.renew = lambda: (0, {"state": "renewed"})
    runner.sync_stock = lambda: None
    runner.corrections = []
    runner.correct_prices = lambda: runner.corrections.append(True)
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


class RepoTargetTest(unittest.TestCase):
    def runner(self, directory, campaign):
        args = types.SimpleNamespace(directory=directory, excel=None, connection=None, secret_file=None, sbs_file=None, node="node", target=10000, notify_url=None)
        runner = vintage_autorun.Runner(args)
        runner.node = "node"
        runner.notices = []
        runner.notify = lambda title, message, **k: runner.notices.append(title)
        path = Path(directory) / "campaign.json"
        path.write_text(campaign, "utf-8")
        return runner, path

    def test_the_repo_target_is_applied_once_with_set_target(self):
        with tempfile.TemporaryDirectory() as directory:
            runner, path = self.runner(directory, '{"target_total": 80000}')
            calls = []
            done = types.SimpleNamespace(returncode=0, stdout="Objetivo: 10000 -> 80000", stderr="")
            with unittest.mock.patch.object(vintage_autorun, "CAMPAIGN_FILE", path), unittest.mock.patch.object(vintage_autorun.subprocess, "run", lambda cmd, **k: calls.append(cmd) or done):
                runner.apply_repo_target()
                runner.apply_repo_target()
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0][3:], ["80000", "--directory", str(Path(directory)), "--apply"])
            self.assertEqual(runner.notices, ["Vintage: objetivo subido"])

    def test_an_equal_or_lower_target_is_silent_and_bad_files_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            runner, path = self.runner(directory, '{"target_total": 80000}')
            same = types.SimpleNamespace(returncode=1, stdout="", stderr="No se cambió nada: target_not_higher")
            with unittest.mock.patch.object(vintage_autorun, "CAMPAIGN_FILE", path), unittest.mock.patch.object(vintage_autorun.subprocess, "run", lambda cmd, **k: same):
                runner.apply_repo_target()
            self.assertEqual(runner.notices, [])
            for bad in ('{"target_total": 999999999}', '{"target_total": "80000"}', "no es json", "[]"):
                path.write_text(bad, "utf-8")
                with unittest.mock.patch.object(vintage_autorun, "CAMPAIGN_FILE", path):
                    self.assertIsNone(runner.repo_target())

    def test_the_committed_campaign_file_is_valid(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = vintage_autorun.Runner(types.SimpleNamespace(directory=directory, excel=None, connection=None, secret_file=None, sbs_file=None, node=None, target=10000, notify_url=None))
            self.assertEqual(runner.repo_target(), 80000)


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


class NotifyUrlTest(unittest.TestCase):
    OLD = "https://ntfy.sh/viejo-publico"
    NEW = "https://ntfy.sh/secreto-largo-al-azar"

    def runner(self, directory, notify_url="https://ntfy.sh/viejo-publico"):
        args = types.SimpleNamespace(directory=directory, excel=None, connection=None, secret_file=None, sbs_file=None, node=None, target=10000, notify_url=notify_url, no_update=False)
        return vintage_autorun.Runner(args)

    def put(self, runner, content):
        (runner.private / "notify-url.txt").write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))

    def send(self, runner, fail=False):
        sent = []

        def fake(request, timeout=None):
            sent.append(request.full_url)
            if fail:
                raise OSError("fallo contra " + request.full_url)
            return types.SimpleNamespace(read=lambda: b"")
        with unittest.mock.patch("urllib.request.urlopen", side_effect=fake):
            runner.notify("Vintage: prueba", "mensaje", every_s=0)
        return sent

    def test_the_private_file_wins_over_the_launcher_argument(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.runner(directory)
            self.put(runner, self.NEW + chr(10))
            self.assertEqual(self.send(runner), [self.NEW])

    def test_without_the_file_the_argument_is_still_used(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.send(self.runner(directory)), [self.OLD])

    def test_the_file_alone_is_enough_and_tolerates_bom_and_windows_newlines(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.runner(directory, notify_url=None)
            self.put(runner, bytes([0xEF, 0xBB, 0xBF]) + self.NEW.encode("utf-8") + bytes([13, 10]))
            self.assertEqual(self.send(runner), [self.NEW])

    def test_a_file_that_is_not_an_https_url_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.runner(directory)
            for content in ("hola", "http://ntfy.sh/inseguro", ""):
                self.put(runner, content)
                self.assertEqual(self.send(runner), [self.OLD], content)

    def test_the_file_is_read_on_every_notice_so_it_changes_without_a_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.runner(directory)
            self.put(runner, self.NEW)
            self.assertEqual(self.send(runner), [self.NEW])
            self.put(runner, "https://ntfy.sh/otro-tema")
            self.assertEqual(self.send(runner), ["https://ntfy.sh/otro-tema"])

    def test_a_failed_send_never_writes_the_topic_to_the_log(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = self.runner(directory)
            self.put(runner, self.NEW)
            self.send(runner, fail=True)
            log = "".join(p.read_text("utf-8") for p in runner.logs.glob("autorun-*.log"))
            self.assertIn("aviso no enviado", log)
            self.assertNotIn("secreto-largo-al-azar", log)
            self.assertNotIn("viejo-publico", log)


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


class PublishCorrectSplitTest(unittest.TestCase):
    def test_engine_gets_half_of_each_hour(self):
        with tempfile.TemporaryDirectory() as directory:
            command = make_runner(directory, [10000]).engine_command()
            self.assertEqual(command[command.index("--max-minutes") + 1], "30")
            self.assertEqual(vintage_autorun.PUBLISH_SLICE_MIN + vintage_autorun.CORRECT_SLICE_MIN, 60)

    def test_after_the_publishing_turn_it_corrects_prices_and_goes_straight_back(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [10000])
            runner.status = lambda: {"state": "time_slice_done", "published_total": 10100}
            runner.run_engine = lambda: (0, None)
            self.assertIsNone(runner.cycle())
            self.assertEqual(runner.corrections, [True])
            self.assertEqual(runner.waits, [])

    def test_correction_runs_stock_sync_in_correct_mode_for_30_minutes(self):
        with tempfile.TemporaryDirectory() as directory:
            args = types.SimpleNamespace(directory=directory, excel=None, connection=None, secret_file=None, sbs_file=None, node="node", target=10000, notify_url=None, stock_sync="pause_and_reactivate")
            runner = vintage_autorun.Runner(args)
            runner.node = "node"
            seen = []
            def run(command, **kwargs):
                seen.append(command)
                return types.SimpleNamespace(returncode=0, stdout='{"state":"corrected","repriced":3}', stderr="")
            with unittest.mock.patch.object(vintage_autorun.subprocess, "run", side_effect=run):
                runner.correct_prices()
            command = seen[0]
            self.assertEqual(command[command.index("--mode") + 1], "correct")
            self.assertEqual(command[command.index("--max-minutes") + 1], "30")


class HungEngineTest(unittest.TestCase):
    """Un motor colgado (red cortada a mitad de un alta) no puede dejar al supervisor esperando para siempre."""

    def hung_process(self):
        class Hung:
            terminated = False
            killed = False

            def wait(self, timeout=None):
                if self.terminated or self.killed:
                    return -15
                raise vintage_autorun.subprocess.TimeoutExpired("node", timeout)

            def terminate(self):
                self.terminated = True

            def kill(self):
                self.killed = True
        return Hung()

    def test_engine_limit_is_the_slice_plus_a_grace_period(self):
        self.assertGreater(vintage_autorun.ENGINE_HARD_LIMIT_MIN, vintage_autorun.PUBLISH_SLICE_MIN)
        self.assertLessEqual(vintage_autorun.ENGINE_HARD_LIMIT_MIN, vintage_autorun.PUBLISH_SLICE_MIN + 30)

    def test_a_hung_engine_is_stopped_and_reported_as_a_retryable_error(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [10000])
            process = self.hung_process()
            clock = iter([0, 0, 10, vintage_autorun.ENGINE_HARD_LIMIT_MIN * 60 + 1] + [10 ** 9] * 20)
            with unittest.mock.patch.object(vintage_autorun.subprocess, "Popen", return_value=process), \
                    unittest.mock.patch.object(vintage_autorun.time, "monotonic", side_effect=lambda: next(clock)):
                runner.engine_command = lambda: ["node", "engine.mjs", "--target", "1"]
                code, error = vintage_autorun.Runner.run_engine(runner)
            self.assertTrue(process.terminated)
            self.assertNotEqual(code, 0)
            self.assertEqual(error, "engine_timeout")
            self.assertNotIn("engine_timeout", vintage_autorun.FATAL)

    def test_a_hung_engine_makes_the_cycle_wait_and_retry_without_a_stop_file(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [10000])
            runner.status = lambda: {}
            runner.run_engine = lambda: (124, "engine_timeout")
            self.assertIsNone(runner.cycle())
            self.assertIn("error del motor", runner.waits)
            self.assertFalse((Path(directory) / "STOP").exists())


class RecoverableStopTest(unittest.TestCase):
    """Un cupo de ML o un alta sin verificar no necesitan una persona: se espera y se sigue, sin STOP."""

    def test_listing_quota_waits_for_the_next_day_without_a_stop_file(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [10000])
            runner.status = lambda: {"state": "stopped_listing_quota", "published_total": 10000}
            runner.run_engine = lambda: (0, None)
            runner.seconds_until_next_day = lambda: 4321
            self.assertIsNone(runner.cycle())
            self.assertFalse((Path(directory) / "STOP").exists())
            self.assertEqual(runner.waits, ["cupo de publicaciones"])
            self.assertEqual(runner.wait_seconds, [4321])
            self.assertNotIn("stopped_listing_quota", vintage_autorun.FATAL)

    def test_a_failed_readback_retries_after_half_an_hour_without_a_stop_file(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [10000])
            runner.status = lambda: {"state": "stopped_item_readback_failed", "published_total": 10000}
            runner.run_engine = lambda: (0, None)
            self.assertIsNone(runner.cycle())
            self.assertFalse((Path(directory) / "STOP").exists())
            self.assertEqual(runner.waits, ["alta sin verificar"])
            self.assertEqual(runner.wait_seconds, [30 * 60])
            self.assertNotIn("stopped_item_readback_failed", vintage_autorun.FATAL)

    def test_a_wrong_account_still_stops_everything(self):
        with tempfile.TemporaryDirectory() as directory:
            runner = make_runner(directory, [10000])
            runner.status = lambda: {"state": "seller_mismatch", "published_total": 10000}
            runner.run_engine = lambda: (0, None)
            self.assertEqual(runner.cycle(), 2)
            self.assertIn("seller_mismatch", (Path(directory) / "STOP").read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
