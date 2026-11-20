"""Junta los bloques de libros de GLIC (data/glic-bloque-*.csv, copiados del listado de la tienda) en un JSON de fichas.

Uso: python3 hermes-monitor/leer_glic.py <salida.json>
Cada bloque: n;producto;precio_actual;precio_lista (el producto es la ficha de catálogo MLU... del enlace /p/MLU...).
"""
import csv, glob, json, os, re, sys

aqui = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
vistos, fichas = set(), []
for ruta in sorted(glob.glob(os.path.join(aqui, 'glic-bloque-*.csv'))):
    with open(ruta, encoding='utf-8') as f:
        for r in csv.DictReader(f, delimiter=';'):
            p = (r.get('producto') or '').strip()
            if not re.fullmatch(r'MLU\d+', p) or p in vistos:
                continue
            vistos.add(p)
            try:
                lista = int(r['precio_lista'])
            except (ValueError, TypeError):
                lista = None
            fichas.append({'n': f"glic-{len(fichas) + 1}", 'titulo': '', 'producto': p, 'precio_ref': int(r['precio_actual']), 'precio_lista': lista, 'mi_mlu': None})
json.dump(fichas, open(sys.argv[1], 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f"{len(fichas)} fichas de GLIC")
