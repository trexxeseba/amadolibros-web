"""Tests del vigía local: python -m unittest discover -s scripts/__tests__ -p "test_vintage_watchdog.py"."""
import json
import os
import sys
import tempfile
import unittest
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
    def test_dry_run_relaunch_is_remembered_and_not_repeated(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "status.json").write_text(json.dumps({"at": "2027-01-15T12:00:00.000Z", "published_total": 7500, "state": "publishing", "run": {"index": {"done": True}}}), "utf-8")
            dog = watchdog.Watchdog(directory, dry_run=True)
            self.assertEqual(dog.once(NOW), ("relaunch", "autorun_not_running"))
            self.assertEqual(dog.once(NOW + 60), ("relaunch", "autorun_not_running:recent_relaunch"))
            memory = json.loads(Path(directory, "watchdog-state.json").read_text("utf-8"))
            self.assertEqual(memory["relaunched_at"], NOW)
            self.assertTrue(list(Path(directory, "logs").glob("watchdog-*.log")))


if __name__ == "__main__":
    unittest.main()
