"""Lee el Excel de Hermes y escribe las fichas en JSON (para el chequeo diario).

Uso: python3 hermes-monitor/leer_excel.py <excel> <salida.json> [publicadas.json]
Columnas: B titulo, D precio Hermes, F link a la ficha, I "Mi publicación (MLU)".
"""
import json, re, sys
import openpyxl

ws = openpyxl.load_workbook(sys.argv[1]).worksheets[0]
try:
    publicadas = json.load(open(sys.argv[3])) if len(sys.argv) > 3 else {}
except (OSError, ValueError):
    publicadas = {}
fichas = []
for r in range(5, ws.max_row + 1):
    link = ws.cell(r, 6).hyperlink.target if ws.cell(r, 6).hyperlink else None
    m = re.search(r"/p/(MLU\d+)", link or "")
    if not m:
        continue
    mi = str(ws.cell(r, 9).value or "").strip().upper()
    fichas.append({
        "n": ws.cell(r, 1).value,
        "titulo": ws.cell(r, 2).value,
        "producto": m.group(1),
        "precio_ref": ws.cell(r, 4).value,
        "mi_mlu": mi if re.fullmatch(r"MLU\d+", mi) else (publicadas.get(m.group(1)) or {}).get("item_id"),
    })
json.dump(fichas, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(fichas)} fichas, {sum(1 for f in fichas if f['mi_mlu'])} con publicación mía")
