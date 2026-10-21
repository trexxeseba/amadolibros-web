"""Publicador Vintage desatendido para la PC del dueño.

Mantiene la campaña de Amado Vintage corriendo sola:
  - renueva la conexión local cuando falta poco para que venza, bajando el
    Excel del proveedor y pidiendo una conexión nueva al servidor;
  - ejecuta el motor validado (scripts/vintage-local/engine.mjs) y lo reinicia
    tras cortes, errores transitorios o cuando vuelve a haber stock fresco;
  - respeta el tope diario esperando al día siguiente de Montevideo;
  - se detiene sola ante cuota de publicaciones, lectura fallida de un alta,
    cuenta distinta o conexión inválida, y avisa;
  - evita que Windows suspenda la PC mientras corre.

Un archivo STOP en la carpeta de estado la detiene (stop.cmd lo crea).
Sólo usa la biblioteca estándar de Python y Node 22.13 o posterior.
"""
import argparse
import ctypes
import datetime as dt
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ENGINE = REPO / "scripts" / "vintage-local" / "engine.mjs"
RENEW = REPO / "scripts" / "vintage-local" / "renew.mjs"
STOCK_SYNC = REPO / "scripts" / "vintage-local" / "stock-sync.mjs"
MONTEVIDEO = dt.timezone(dt.timedelta(hours=-3))
RENEW_MARGIN_S = 30 * 60
FATAL = {
    "stopped_listing_quota": "Mercado Libre rechazó altas por cupo de publicaciones",
    "stopped_item_readback_failed": "Un alta no pasó la verificación posterior",
    "seller_mismatch": "La cuenta conectada no es Amado Vintage",
    "inventory_seller_mismatch": "El inventario leído no es de Amado Vintage",
    "foreign_seller_receipt": "La conexión trae recibos de otra cuenta",
    "invalid_vintage_connection": "La conexión descargada no es válida",
    "invalid_vintage_policy": "La política de la conexión no cumple el mínimo de Vintage",
    "connection_policy_changed": "La política cambió desde que se emitió la conexión",
    "local_policy_changed_review_required": "La política local no coincide y requiere revisión",
}
RENEW_NEEDED = {
    "stock_stale", "auth_error", "vintage_connection_expired",
    "workbook_does_not_match_current_approved_stock", "local_access_expired_or_revoked",
    "local_campaign_not_exclusive", "supplier_stock_stale_or_missing",
}


class Runner:
    def __init__(self, args):
        self.args = args
        self.directory = Path(args.directory).resolve()
        self.private = self.directory / "private"
        self.logs = self.directory / "logs"
        for folder in (self.directory, self.private, self.logs):
            folder.mkdir(parents=True, exist_ok=True)
        self.excel = Path(args.excel) if args.excel else self.directory / "stock-sbs.xlsx"
        self.connection = Path(args.connection) if args.connection else self.private / "vintage-local-connection.json"
        self.secret_file = Path(args.secret_file) if args.secret_file else self.private / "renew-secret.txt"
        self.sbs_file = Path(args.sbs_file) if args.sbs_file else self.private / "sbs.json"
        self.stop_file = self.directory / "STOP"
        self.node = args.node if args.node and Path(args.node).exists() else shutil.which("node")
        self.failures = 0
        self.last_notice = {}
        self.force_renew = False

    # ── registro y avisos ────────────────────────────────────────────────
    def log(self, message, **data):
        line = json.dumps({"at": dt.datetime.now(MONTEVIDEO).isoformat(timespec="seconds"), "msg": message, **data}, ensure_ascii=False)
        print(line, flush=True)
        day = dt.datetime.now(MONTEVIDEO).strftime("%Y-%m-%d")
        with (self.logs / f"autorun-{day}.log").open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
        self.prune_logs()

    def prune_logs(self):
        limit = time.time() - 14 * 86400
        for old in self.logs.glob("autorun-*.log"):
            try:
                if old.stat().st_mtime < limit:
                    old.unlink()
            except OSError:
                pass

    def notify(self, title, message, key=None, every_s=3600):
        key = key or title
        now = time.time()
        if now - self.last_notice.get(key, 0) < every_s:
            return
        self.last_notice[key] = now
        self.log("aviso", title=title, detail=message)
        url = self.args.notify_url or os.environ.get("VINTAGE_NOTIFY_URL")
        if not url:
            return
        try:
            if "ntfy" in url:
                request = urllib.request.Request(url, data=message.encode("utf-8"), headers={"Title": title.encode("latin-1", "replace").decode("latin-1"), "Priority": "high"})
            else:
                request = urllib.request.Request(url, data=json.dumps({"title": title, "message": message}).encode("utf-8"), headers={"Content-Type": "application/json"})
            urllib.request.urlopen(request, timeout=20).read()
        except Exception as error:  # el aviso nunca detiene la campaña
            self.log("aviso no enviado", error=str(error)[:200])

    # ── Windows: no suspender mientras corre ─────────────────────────────
    def keep_awake(self, enable):
        if os.name != "nt":
            return
        es_continuous, es_system_required = 0x80000000, 0x00000001
        try:
            ctypes.windll.kernel32.SetThreadExecutionState(es_continuous | (es_system_required if enable else 0))
        except Exception:
            pass

    # ── estado ───────────────────────────────────────────────────────────
    def connection_expires_at(self):
        try:
            return int(json.loads(self.connection.read_text("utf-8")).get("expires_at", 0)) / 1000
        except Exception:
            return 0

    def status(self):
        try:
            return json.loads((self.directory / "status.json").read_text("utf-8"))
        except Exception:
            return {}

    def secret(self):
        value = os.environ.get("VINTAGE_RENEW_SECRET") or (self.secret_file.read_text("utf-8").strip() if self.secret_file.exists() else "")
        if len(value) < 32:
            raise SystemExit(f"Falta el secreto de renovación: guardalo en {self.secret_file} (VINTAGE_RENEW_SECRET de Cloudflare Pages)")
        return value

    # ── pasos ────────────────────────────────────────────────────────────
    def renew(self):
        self.log("renovando conexión", excel=str(self.excel))
        env = {**os.environ, "VINTAGE_RENEW_SECRET": self.secret()}
        command = [self.node, "--experimental-sqlite", str(RENEW), "--excel", str(self.excel), "--connection", str(self.connection)]
        if self.sbs_file.exists():  # portal de SBS con usuario; sin este archivo usa el Excel público
            command += ["--sbs-file", str(self.sbs_file)]
        result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=1800)
        last = {}
        for line in (result.stdout or "").splitlines():
            try:
                last = json.loads(line)
            except ValueError:
                continue
        self.log("renovación", code=result.returncode, result=last, stderr=(result.stderr or "")[-300:])
        return result.returncode, last

    def sync_stock(self):
        """Pausa en Mercado Libre lo que ya no viene en la lista fresca y reactiva lo que vuelve."""
        if self.args.stock_sync == "off":
            return
        self.log("sincronizando stock", mode=self.args.stock_sync)
        command = [self.node, "--experimental-sqlite", str(STOCK_SYNC), "--connection", str(self.connection), "--excel", str(self.excel), "--directory", str(self.directory), "--mode", self.args.stock_sync]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=4 * 3600)
        except subprocess.TimeoutExpired:
            self.log("sincronización de stock", error="timeout")
            return
        last = {}
        for line in (result.stdout or "").splitlines():
            try:
                last = json.loads(line)
            except ValueError:
                continue
        self.log("sincronización de stock", code=result.returncode, result=last, stderr=(result.stderr or "")[-300:])
        if result.returncode != 0:
            self.notify("Vintage: la sincronización de stock falló", f"Resultado: {last.get('error') or last.get('state')}. Se reintenta con la próxima lista.", every_s=6 * 3600)
        elif last.get("paused") or last.get("activated"):
            self.notify("Vintage: stock sincronizado", f"Pausados: {last.get('paused')}. Reactivados: {last.get('activated')}. Faltantes en lista: {last.get('missing')} de {last.get('published')}.", every_s=0)

    def run_engine(self):
        command = [self.node, "--experimental-sqlite", str(ENGINE), "--excel", str(self.excel), "--connection", str(self.connection), "--directory", str(self.directory), "--target", str(self.args.target)]
        self.log("motor iniciado", target=self.args.target)
        day = dt.datetime.now(MONTEVIDEO).strftime("%Y-%m-%d")
        with (self.logs / f"engine-{day}.log").open("a", encoding="utf-8") as output:
            result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT, text=True)
        tail = ""
        try:
            tail = (self.logs / f"engine-{day}.log").read_text("utf-8")[-4000:]
        except OSError:
            pass
        error = None
        for line in reversed(tail.splitlines()):
            try:
                parsed = json.loads(line)
            except ValueError:
                continue
            if "error" in parsed:
                error = str(parsed["error"])
                break
            if parsed.get("finished"):
                break
        return result.returncode, error

    def wait(self, seconds, reason):
        self.log("esperando", seconds=int(seconds), reason=reason)
        end = time.time() + seconds
        while time.time() < end:
            if self.stop_file.exists():
                return
            time.sleep(min(30, max(1, end - time.time())))

    def seconds_until_next_day(self):
        now = dt.datetime.now(MONTEVIDEO)
        tomorrow = (now + dt.timedelta(days=1)).replace(hour=0, minute=5, second=0, microsecond=0)
        return max(60, (tomorrow - now).total_seconds())

    # ── ciclo ────────────────────────────────────────────────────────────
    def loop(self):
        if not self.node:
            raise SystemExit("Node.js 22.13 o posterior es necesario")
        self.secret()
        self.keep_awake(True)
        try:
            while not self.stop_file.exists():
                if self.force_renew or self.connection_expires_at() - time.time() < RENEW_MARGIN_S:
                    code, result = self.renew()
                    if code == 3:
                        self.notify("Vintage: stock del proveedor vencido", f"El Excel sigue con fecha vieja ({result.get('source_date')}). Reintento cada 30 minutos.", every_s=6 * 3600)
                        self.wait(30 * 60, "stock vencido")
                        continue
                    if code != 0:
                        self.failures += 1
                        if self.failures >= 2:
                            self.notify("Vintage: no se pudo renovar la conexión", f"Error {result.get('error', 'desconocido')}. Intento {self.failures}.")
                        self.wait(min(3600, 300 * 2 ** min(self.failures, 4)), "fallo de renovación")
                        continue
                    self.force_renew = False
                    self.failures = 0
                    self.sync_stock()
                code, error = self.run_engine()
                status = self.status()
                state = status.get("state") or error or ("finished" if code == 0 else "engine_error")
                published = status.get("published_total")
                self.log("motor terminó", code=code, state=state, published_total=published, error=error)
                if state in FATAL or (error in FATAL):
                    reason = FATAL.get(state) or FATAL.get(error)
                    self.notify("Vintage DETENIDO", f"{reason}. Estado: {state}. Publicados: {published}. Revisá y borrá el archivo STOP para seguir.", every_s=0)
                    self.stop_file.write_text(f"{dt.datetime.now(MONTEVIDEO).isoformat()} {state}\n", "utf-8")
                    return 2
                if state == "daily_cap_reached":
                    self.notify("Vintage: tope diario alcanzado", f"Publicados en total: {published}. Sigue mañana.", every_s=20 * 3600)
                    self.wait(self.seconds_until_next_day(), "tope diario")
                    continue
                if state in RENEW_NEEDED or error in RENEW_NEEDED:
                    self.force_renew = True
                    self.wait(120, "hace falta renovar")
                    continue
                if state in ("complete", "complete_with_review") or (isinstance(published, int) and published >= self.args.target):
                    self.notify("Vintage: campaña sin pendientes", f"Publicados: {published}. Estado: {state}. Vuelvo a mirar con el próximo stock.", every_s=20 * 3600)
                    self.force_renew = True
                    self.wait(3 * 3600, "sin pendientes")
                    continue
                if code != 0:
                    self.failures += 1
                    if self.failures >= 3:
                        self.notify("Vintage: el motor falla seguido", f"Último error: {error or state}. Fallos seguidos: {self.failures}.")
                    self.wait(min(1800, 120 * 2 ** min(self.failures, 4)), "error del motor")
                    continue
                self.failures = 0
                self.wait(60, "pausa breve")
            self.log("detenido por STOP", reason=self.stop_file.read_text("utf-8", errors="replace")[:200] if self.stop_file.exists() else "")
            return 0
        finally:
            self.keep_awake(False)


def main():
    parser = argparse.ArgumentParser(description="Publicador Vintage desatendido")
    parser.add_argument("--excel")
    parser.add_argument("--connection")
    parser.add_argument("--secret-file")
    parser.add_argument("--sbs-file", help="JSON {email, password} del portal de SBS (por defecto private/sbs.json)")
    parser.add_argument("--notify-url")
    parser.add_argument("--node", help="ruta completa de node.exe (opcional)")
    parser.add_argument("--directory", default=str(Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Amado" / "VintagePublisher"))
    parser.add_argument("--target", type=int, default=10000)
    parser.add_argument("--stock-sync", choices=["off", "report", "pause_only", "pause_and_reactivate"], default="pause_and_reactivate", help="qué hacer con publicaciones que ya no vienen en la lista (por defecto pausar y reactivar)")
    args = parser.parse_args()
    runner = Runner(args)
    lock = (runner.directory / "process.lock").open("a+b")
    lock.seek(0)
    lock.write(b"0")
    lock.flush()
    lock.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        parser.error("ya hay un publicador Vintage local ejecutándose")
    try:
        return runner.loop()
    except KeyboardInterrupt:
        return 130
    finally:
        lock.close()


if __name__ == "__main__":
    sys.exit(main())
