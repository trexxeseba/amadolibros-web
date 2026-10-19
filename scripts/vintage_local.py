"""Publicador Vintage local: Python supervisa el motor compartido y su SQLite.

No lee credenciales de Amado Libros. La conexión temporal se obtiene del panel.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description="Publicador local exclusivo de Vintage")
    parser.add_argument("--excel", required=True)
    parser.add_argument("--connection")
    parser.add_argument("--directory", default=str(Path(os.environ.get("LOCALAPPDATA", Path.home())) / "Amado" / "VintagePublisher"))
    parser.add_argument("--target", type=int, default=1000)
    parser.add_argument("--validate-only", type=int, default=0)
    parser.add_argument("--limit-new", type=int, default=0)
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--sync-stock", choices=["report", "pause_only", "pause_and_reactivate"],
                        help="antes de publicar, pausa lo que SBS ya no ofrece (report = solo informa)")
    parser.add_argument("--sync-only", action="store_true", help="sincroniza el stock y termina, sin publicar")
    args = parser.parse_args()
    if not args.inspect and not args.connection:
        parser.error("falta --connection (archivo privado descargado del panel)")
    node = shutil.which("node")
    if not node:
        parser.error("Node.js 22.13 o posterior es necesario para reutilizar el motor validado")
    directory = Path(args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    lock = (directory / "process.lock").open("a+b")
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
    engine = Path(__file__).resolve().parent / "vintage-local" / "engine.mjs"
    command = [node, "--experimental-sqlite", str(engine), "--excel", str(Path(args.excel).resolve())]
    if args.inspect:
        command.append("--inspect")
    else:
        command += ["--connection", str(Path(args.connection).resolve()), "--directory", str(directory), "--target", str(args.target)]
        if args.validate_only:
            command += ["--validate-only", str(args.validate_only)]
        if args.limit_new:
            command += ["--limit-new", str(args.limit_new)]
        if args.sync_stock:
            command += ["--sync-stock", args.sync_stock]
        if args.sync_only:
            command += ["--sync-only"]
    try:
        return subprocess.call(command)
    except KeyboardInterrupt:
        return 130
    finally:
        lock.close()


if __name__ == "__main__":
    sys.exit(main())
