r"""Vigía local del publicador Vintage: corre cada 10 minutos desde una tarea programada.

No necesita a nadie mirando. Cada vuelta decide una sola cosa:

  - STOP presente                         → no hace nada (la parada es deliberada).
  - el supervisor no está corriendo       → relanza la tarea AmadoVintagePublisher y avisa.
  - espera normal (lista SBS vencida, tope diario, renovación, escaneo del
    inventario tras una lista nueva)      → no hace nada.
  - sin altas nuevas por más de --stall-minutes sin una espera que lo explique
                                          → avisa por ntfy (una vez por hora).

Cómo sabe si el supervisor está vivo: vintage_autorun.py mantiene un bloqueo
exclusivo sobre process.lock mientras corre. Si el vigía consigue ese bloqueo,
no hay supervisor. Nunca mata procesos, nunca borra STOP, nunca toca la base.

  python scripts\vintage-local\watchdog.py --notify-url https://ntfy.sh/<tu-tema>
  python scripts\vintage-local\watchdog.py --dry-run     (muestra la decisión, no actúa)

Sólo usa la biblioteca estándar de Python.
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

TASK = "AmadoVintagePublisher"
STALL_MINUTES = 45
ALERT_EVERY_S = 3600
RELAUNCH_EVERY_S = 600
# Motivos de "esperando" del supervisor que explican por sí solos la falta de altas.
NORMAL_WAITS = {"stock vencido", "tope diario", "sin pendientes", "hace falta renovar", "pausa breve"}
# Fallos que el autorun reintenta solo: se toleran un rato, pero si pasa el umbral sin altas avisan
# (antes estaban en NORMAL_WAITS y un motor fallando en bucle no avisaba nunca).
RETRY_WAITS = {"error del motor", "fallo de renovación", "objetivo subido"}


def parse_iso(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def lock_is_held(path):
    """True si otro proceso mantiene el bloqueo de process.lock (el supervisor está vivo)."""
    if not path.exists():
        return False
    try:
        handle = path.open("a+b")
    except OSError:
        return True
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                return True
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            return False
        import fcntl
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            return True
        fcntl.flock(handle, fcntl.LOCK_UN)
        return False
    finally:
        handle.close()


def read_json(path):
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return None


def last_autorun_line(logs):
    files = sorted(logs.glob("autorun-*.log"))
    if not files:
        return None
    try:
        lines = files[-1].read_text("utf-8", errors="replace").strip().splitlines()
        return json.loads(lines[-1]) if lines else None
    except (OSError, ValueError, IndexError):
        return None


def snapshot(directory):
    """Lo que el vigía mira, reunido en un dict para poder decidir sin tocar disco en los tests."""
    status = read_json(directory / "status.json") or {}
    run = status.get("run") or {}
    return {
        "stop": (directory / "STOP").exists(),
        "running": lock_is_held(directory / "process.lock"),
        "status_at": parse_iso(status.get("at")),
        "published_total": status.get("published_total"),
        "state": status.get("state"),
        "index_done": (run.get("index") or {}).get("done", True),
        "autorun": last_autorun_line(directory / "logs"),
    }


def decide(snap, memory, now, stall_minutes=STALL_MINUTES):
    """Devuelve (acción, motivo, memoria nueva). Acciones: none, relaunch, alert."""
    memory = dict(memory or {})
    total = snap.get("published_total")
    if isinstance(total, int) and total != memory.get("last_total"):
        memory["last_total"], memory["changed_at"] = total, now
    memory.setdefault("changed_at", now)
    if snap.get("stop"):
        return "none", "stop", memory
    if not snap.get("running"):
        return "relaunch", "autorun_not_running", memory
    autorun = snap.get("autorun") or {}
    reason = autorun.get("reason") if autorun.get("msg") == "esperando" else None
    if reason in NORMAL_WAITS:
        return "none", "waiting:" + reason, memory
    if reason in RETRY_WAITS and now - memory["changed_at"] <= stall_minutes * 60:
        return "none", "retrying:" + reason, memory
    if snap.get("index_done") is False:
        return "none", "scanning_inventory", memory
    stalled_s = now - memory["changed_at"]
    status_age = now - snap["status_at"] if snap.get("status_at") else None
    if stalled_s > stall_minutes * 60 or (status_age is not None and status_age > stall_minutes * 60):
        return "alert", f"stalled:{int(stalled_s // 60)}min:{snap.get('state')}" + (f":{reason}" if reason else ""), memory
    return "none", "ok", memory


def read_notify_url(private_dir, fallback=None):
    """Tópico de ntfy desde private/notify-url.txt (primera línea, https). Es un secreto: quien conoce
    el nombre puede leer y escribir avisos, así que vive fuera del repo, y se lee en cada aviso para
    poder cambiarlo sin reiniciar. Sin archivo válido se usa el argumento o VINTAGE_NOTIFY_URL."""
    try:
        lines = (Path(private_dir) / "notify-url.txt").read_text("utf-8-sig").strip().splitlines()
    except OSError:
        lines = []
    candidate = lines[0].strip() if lines else ""
    return candidate if candidate.startswith("https://") else fallback


class Watchdog:
    def __init__(self, directory, notify_url=None, task=TASK, stall_minutes=STALL_MINUTES, dry_run=False):
        self.directory = Path(directory).resolve()
        self.logs = self.directory / "logs"
        self.logs.mkdir(parents=True, exist_ok=True)
        self.memory_file = self.directory / "watchdog-state.json"
        self.notify_url = notify_url or os.environ.get("VINTAGE_NOTIFY_URL")
        self.task = task
        self.stall_minutes = stall_minutes
        self.dry_run = dry_run

    def log(self, message, **data):
        line = json.dumps({"at": dt.datetime.now().astimezone().isoformat(timespec="seconds"), "msg": message, **data}, ensure_ascii=False)
        if self.dry_run or (sys.stdout and sys.stdout.isatty()):
            print(line, flush=True)
        day = dt.datetime.now().strftime("%Y-%m-%d")
        with (self.logs / f"watchdog-{day}.log").open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")

    def notify(self, title, message):
        self.log("aviso", title=title, detail=message)
        url = read_notify_url(self.directory / "private", self.notify_url)
        if self.dry_run or not url:
            return
        try:
            request = urllib.request.Request(url, data=message.encode("utf-8"), headers={"Title": title.encode("latin-1", "replace").decode("latin-1"), "Priority": "high"})
            urllib.request.urlopen(request, timeout=20).read()
        except Exception as error:  # un aviso fallido no cambia la decisión
            self.log("aviso no enviado", error=str(error).replace(url, "<url>")[:200])

    def relaunch(self):
        if self.dry_run:
            return True
        result = subprocess.run(["schtasks", "/Run", "/TN", self.task], capture_output=True, text=True)
        self.log("relanzamiento", code=result.returncode, detail=(result.stdout or result.stderr).strip()[:200])
        return result.returncode == 0

    def once(self, now=None):
        now = now or time.time()
        memory = read_json(self.memory_file) or {}
        snap = snapshot(self.directory)
        action, reason, memory = decide(snap, memory, now, self.stall_minutes)
        total = snap.get("published_total")
        autorun = snap.get("autorun") or {}
        wait_reason = autorun.get("reason") if autorun.get("msg") == "esperando" else None
        if action == "relaunch":
            if now - memory.get("relaunched_at", 0) >= RELAUNCH_EVERY_S:
                memory["relaunched_at"] = now
                ok = self.relaunch()
                self.notify("Vintage: publicador relanzado" if ok else "Vintage: no pude relanzar", f"El supervisor no estaba corriendo (publicados: {total}). {'Tarea ' + self.task + ' lanzada.' if ok else 'schtasks falló; revisá la tarea ' + self.task + '.'}")
            else:
                reason += ":recent_relaunch"
                if now - memory.get("alerted_at", 0) >= ALERT_EVERY_S:
                    memory["alerted_at"] = now
                    self.notify("Vintage: el publicador no arranca", f"Lo relancé hace menos de 10 minutos y sigue sin correr. Mirá logs\\task.log. Publicados: {total}.")
        elif action == "alert":
            if now - memory.get("alerted_at", 0) >= ALERT_EVERY_S:
                memory["alerted_at"] = now
                self.notify("Vintage: sin altas nuevas", f"Publicados: {total}, sin cambios hace {int((now - memory['changed_at']) // 60)} min. Estado: {snap.get('state')}. Supervisor vivo, sin espera que lo explique." + (f" Último motivo del autorun: {wait_reason}." if wait_reason else ""))
        self.log("vuelta", action=action, reason=reason, published_total=total, state=snap.get("state"))
        self.memory_file.write_text(json.dumps(memory), "utf-8")
        return action, reason


def main():
    parser = argparse.ArgumentParser(description="Vigía local del publicador Vintage")
    parser.add_argument("--directory", default=str(Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Amado" / "VintagePublisher"))
    parser.add_argument("--notify-url")
    parser.add_argument("--task", default=TASK)
    parser.add_argument("--stall-minutes", type=int, default=STALL_MINUTES)
    parser.add_argument("--dry-run", action="store_true", help="decide y muestra, sin relanzar ni avisar")
    args = parser.parse_args()
    action, reason = Watchdog(args.directory, args.notify_url, args.task, args.stall_minutes, args.dry_run).once()
    print(f"{action} {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
