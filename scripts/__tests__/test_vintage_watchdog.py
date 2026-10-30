"""Tests del vigía local: python -m unittest discover -s scripts/__tests__ -p "test_vintage_watchdog.py"."""
import json
import os
import sys
import tempfile
import types
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "vintage-local"))
import watchdog  # noqa: E402

NOW = 1_800_000_000.0
ALIVE = {"stop": False, "running": True, "status_at": NOW - 60, "published_total": 7500, "state": "publishing", "index_done": True, "autorun": {"msg": "motor iniciado"}}
FRESH = {"last_total": 7500, "changed_at": NOW - 120}


def decide(**changes):
    snap = {**ALIVE, **{k: v for k, v in changes.items() if k != "memory"}}
    return watchdog.decide(snap, changes.get("memory", FRESH), NOW)


class DecideTest(unittest.TestCase):
    def test_stop_wins_over_everything(self):
        self.assertEqual(decide(stop=True, running=False)[:2], ("none", "stop"))

    def test_correct_only_mode_never_alerts_for_missing_new_books_but_still_relaunches(self):
        old = {"last_total": 7500, "changed_at": NOW - 5 * 3600}
        action, why, _ = decide(mode="correct_only", memory=old)
        self.assertEqual((action, why), ("none", "correct_only"))
        self.assertEqual(decide(mode="correct_only", running=False, memory=old)[:2], ("relaunch", "autorun_not_running"))
        self.assertEqual(decide(mode="correct_only", stop=True, memory=old)[:2], ("none", "stop"))

    def test_dead_supervisor_is_relaunched(self):
        self.assertEqual(decide(running=False)[:2], ("relaunch", "autorun_not_running"))

    def test_known_waits_are_not_alerts(self):
        for reason in ("stock vencido", "tope diario", "hace falta renovar"):
            action, why, _ = decide(autorun={"msg": "esperando", "reason": reason}, memory={"last_total": 7500, "changed_at": NOW - 5 * 3600})
            self.assertEqual((action, why), ("none", "waiting:" + reason))

    def test_inventory_scan_after_new_list_is_not_an_alert(self):
        action, why, _ = decide(index_done=False, memory={"last_total": 7500, "changed_at": NOW - 3600})
        self.assertEqual((action, why), ("none", "scanning_inventory"))

    def test_no_new_books_for_too_long_is_an_alert(self):
        action, why, _ = decide(memory={"last_total": 7500, "changed_at": NOW - 50 * 60})
        self.assertEqual(action, "alert")
        self.assertTrue(why.startswith("stalled:50min"))

    def test_unknown_wait_with_old_status_is_an_alert(self):
        # El caso del 22/10: "renovación repetida" durante 6 h con el motor sano.
        action, _, _ = decide(status_at=NOW - 2 * 3600, autorun={"msg": "esperando", "reason": "renovación repetida"}, memory={"last_total": 7500, "changed_at": NOW - 2 * 3600})
        self.assertEqual(action, "alert")

    def test_engine_error_loop_without_progress_is_an_alert(self):
        # El 21/10 el motor falló unas 10 veces seguidas con el total clavado durante horas y nadie avisó.
        for reason in ("error del motor", "fallo de renovación", "objetivo subido"):
            action, why, _ = decide(autorun={"msg": "esperando", "reason": reason}, memory={"last_total": 7500, "changed_at": NOW - 50 * 60})
            self.assertEqual(action, "alert", reason)
            self.assertTrue(why.endswith(":" + reason), why)

    def test_a_recent_engine_error_is_still_tolerated(self):
        for reason in ("error del motor", "fallo de renovación", "objetivo subido"):
            action, why, _ = decide(autorun={"msg": "esperando", "reason": reason}, memory={"last_total": 7500, "changed_at": NOW - 10 * 60})
            self.assertEqual((action, why), ("none", "retrying:" + reason))

    def test_engine_errors_that_still_publish_never_alert(self):
        action, _, _ = decide(published_total=7501, autorun={"msg": "esperando", "reason": "error del motor"}, memory={"last_total": 7500, "changed_at": NOW - 3 * 3600})
        self.assertEqual(action, "none")

    def test_long_normal_waits_are_still_silent(self):
        # La espera nocturna de la lista de SBS puede durar horas sin altas y no es una falla.
        action, why, _ = decide(autorun={"msg": "esperando", "reason": "stock vencido"}, memory={"last_total": 7500, "changed_at": NOW - 6 * 3600})
        self.assertEqual((action, why), ("none", "waiting:stock vencido"))

    def test_progress_resets_the_stall_clock(self):
        action, why, memory = decide(published_total=7501, memory={"last_total": 7500, "changed_at": NOW - 3 * 3600})
        self.assertEqual((action, why), ("none", "ok"))
        self.assertEqual((memory["last_total"], memory["changed_at"]), (7501, NOW))


class LockTest(unittest.TestCase):
    def test_lock_reflects_a_live_supervisor(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "process.lock"
            self.assertFalse(watchdog.lock_is_held(path))  # no existe: nadie corre
            handle = path.open("a+b")
            handle.write(b"0")
            handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                self.assertTrue(watchdog.lock_is_held(path))
            finally:
                handle.close()
            self.assertFalse(watchdog.lock_is_held(path))


class OnceTest(unittest.TestCase):
    def setUp(self):
        # Aislado del campaign.json real del repo: estas pruebas son del modo normal.
        patcher = unittest.mock.patch.object(watchdog, "CAMPAIGN_FILE", Path(tempfile.gettempdir()) / "no-existe-campaign.json")
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_mode_is_read_from_the_campaign_file(self):
        with tempfile.TemporaryDirectory() as directory:
            campaign = Path(directory, "campaign.json")
            with unittest.mock.patch.object(watchdog, "CAMPAIGN_FILE", campaign):
                self.assertEqual(watchdog.repo_mode(), "publish_and_correct")
                campaign.write_text('{"target_total": 80000, "mode": "correct_only"}', "utf-8")
                self.assertEqual(watchdog.repo_mode(), "correct_only")
                campaign.write_text('{"mode": "otra cosa"}', "utf-8")
                self.assertEqual(watchdog.repo_mode(), "publish_and_correct")

    def test_dry_run_relaunch_is_remembered_and_not_repeated(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "status.json").write_text(json.dumps({"at": "2027-01-15T12:00:00.000Z", "published_total": 7500, "state": "publishing", "run": {"index": {"done": True}}}), "utf-8")
            dog = watchdog.Watchdog(directory, dry_run=True)
            self.assertEqual(dog.once(NOW), ("relaunch", "autorun_not_running"))
            self.assertEqual(dog.once(NOW + 60), ("relaunch", "autorun_not_running:recent_relaunch"))
            memory = json.loads(Path(directory, "watchdog-state.json").read_text("utf-8"))
            self.assertEqual(memory["relaunched_at"], NOW)
            self.assertTrue(list(Path(directory, "logs").glob("watchdog-*.log")))


    def test_alert_message_names_the_last_autorun_wait_reason(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "logs").mkdir()
            (root / "status.json").write_text(json.dumps({"at": "2027-01-15T12:00:00.000Z", "published_total": 7500, "state": "publishing", "run": {"index": {"done": True}}}), "utf-8")
            (root / "logs" / "autorun-2027-01-15.log").write_text(json.dumps({"msg": "esperando", "reason": "error del motor"}) + "\n", "utf-8")
            (root / "watchdog-state.json").write_text(json.dumps({"last_total": 7500, "changed_at": NOW - 50 * 60}), "utf-8")
            original, watchdog.lock_is_held = watchdog.lock_is_held, lambda path: True
            try:
                action, why = watchdog.Watchdog(directory, dry_run=True).once(NOW)
            finally:
                watchdog.lock_is_held = original
            self.assertEqual(action, "alert")
            self.assertTrue(why.endswith(":error del motor"), why)
            log = "".join(p.read_text("utf-8") for p in (root / "logs").glob("watchdog-*.log"))
            self.assertIn("Último motivo del autorun: error del motor", log)


class NotifyUrlTest(unittest.TestCase):
    OLD = "https://ntfy.sh/viejo-publico"
    NEW = "https://ntfy.sh/secreto-largo-al-azar"

    def send(self, directory, private=None, fail=False, url=OLD):
        root = Path(directory)
        if private is not None:
            (root / "private").mkdir()
            (root / "private" / "notify-url.txt").write_bytes(private)
        sent = []

        def fake(request, timeout=None):
            sent.append(request.full_url)
            if fail:
                raise OSError("fallo contra " + request.full_url)
            return types.SimpleNamespace(read=lambda: b"")
        with unittest.mock.patch("urllib.request.urlopen", side_effect=fake):
            watchdog.Watchdog(directory, notify_url=url).notify("Vintage: prueba", "mensaje")
        return sent

    def test_the_private_file_wins_over_the_task_argument(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.send(directory, private=self.NEW.encode("utf-8") + bytes([10])), [self.NEW])

    def test_without_the_file_the_argument_is_still_used(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.send(directory), [self.OLD])

    def test_bom_and_windows_newlines_are_tolerated(self):
        with tempfile.TemporaryDirectory() as directory:
            content = bytes([0xEF, 0xBB, 0xBF]) + self.NEW.encode("utf-8") + bytes([13, 10])
            self.assertEqual(self.send(directory, private=content), [self.NEW])

    def test_a_file_that_is_not_an_https_url_is_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(self.send(directory, private=b"http://ntfy.sh/inseguro"), [self.OLD])

    def test_a_failed_send_never_writes_the_topic_to_the_log(self):
        with tempfile.TemporaryDirectory() as directory:
            self.send(directory, private=self.NEW.encode("utf-8"), fail=True)
            log = "".join(p.read_text("utf-8") for p in (Path(directory) / "logs").glob("watchdog-*.log"))
            self.assertIn("aviso no enviado", log)
            self.assertNotIn("secreto-largo-al-azar", log)
            self.assertNotIn("viejo-publico", log)


if __name__ == "__main__":
    unittest.main()
