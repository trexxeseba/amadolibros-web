"""Borra de una tapa lo que Mercado Libre no deja en las fotos (direcciones web, @, redes, teléfonos, etiquetas).

Uso: python3 hermes-monitor/limpiar_tapa.py <entrada.jpg> <salida.jpg>
Imprime un JSON: {"estado": "limpia" | "borrada" | "no_se_pudo", "borradas": [...], "motivo": ...}

1. Lee la tapa con tesseract (con la posición de cada palabra).
2. Toda LÍNEA de texto con algo no permitido se borra completa (con un margen), rellenando con lo que hay alrededor (inpaint).
3. Vuelve a leer la tapa ya limpia: si todavía queda algo no permitido, no sirve (estado no_se_pudo) y el libro se salta.
La regla de qué es "no permitido" es la misma que usa el publicador (textoNoPermitido en lib.mjs): se mantiene en un solo lugar y se pasa por --reglas.
"""
import csv, io, json, re, subprocess, sys, unicodedata
import cv2
import numpy as np

def norm(t):
    return unicodedata.normalize('NFD', t or '').encode('ascii', 'ignore').decode().lower()

REGLAS = [
    ('arroba_o_correo', r'@'),
    ('direccion_web', r'\bwww\b|https?|\bwww\.|\.(com|net|org|es|uy|ar|mx|cl|co|io|me)\b'),
    ('red_social', r'instagram|facebook|twitter|tiktok|youtube|whatsapp|telegram|pinterest'),
    ('etiqueta_mercado_libre', r'mercado ?libre|mercadolibre|mercado ?pago|mercado ?envios|envio gratis|\bfull\b'),
    ('domicilio_o_datos_fiscales', r'\bdomicilio\b|\bimportador\b|\bcuit\b|\bcuil\b'),
]

def motivo(texto):
    t = norm(texto)
    for nombre, rx in REGLAS:
        if re.search(rx, t):
            return nombre
    for m in re.finditer(r'\+?\d[\d\s().-]{6,}\d', t):
        d = re.sub(r'\D', '', m.group(0))
        if len(d) >= 8 and not re.match(r'97[89]', d):
            return 'telefono'
    return None

def leer(ruta):
    out = subprocess.run(['tesseract', ruta, 'stdout', '-l', 'spa+eng', '--psm', '11', 'tsv'], capture_output=True, text=True, timeout=120).stdout
    filas = list(csv.DictReader(io.StringIO(out), delimiter='\t', quoting=csv.QUOTE_NONE))
    palabras = []
    for f in filas:
        try:
            if f['text'] and f['text'].strip() and float(f['conf']) >= 0:
                palabras.append({'t': f['text'], 'x': int(f['left']), 'y': int(f['top']), 'w': int(f['width']), 'h': int(f['height']), 'linea': (f['block_num'], f['par_num'], f['line_num'])})
        except (ValueError, KeyError, TypeError):
            pass
    return palabras

def cajas_a_borrar(palabras):
    """Cajas de las líneas que tienen algo no permitido (también las que lo tienen repartido en varias palabras)."""
    por_linea = {}
    for p in palabras:
        por_linea.setdefault(p['linea'], []).append(p)
    cajas = []
    for ps in por_linea.values():
        texto = ' '.join(p['t'] for p in ps)
        malas = [p for p in ps if motivo(p['t'])]
        if malas or motivo(texto):
            x0 = min(p['x'] for p in ps); y0 = min(p['y'] for p in ps)
            x1 = max(p['x'] + p['w'] for p in ps); y1 = max(p['y'] + p['h'] for p in ps)
            cajas.append((x0, y0, x1, y1, motivo(texto) or motivo(malas[0]['t'])))
    return cajas

def main(entrada, salida):
    img = cv2.imread(entrada)
    if img is None:
        print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'imagen_ilegible'})); return
    # Un código QR no se puede borrar sin dejar rastros (y suele venir con más datos): esa imagen no sirve.
    if cv2.QRCodeDetector().detect(img)[0]:
        print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'codigo_qr'})); return
    palabras = leer(entrada)
    texto = ' '.join(p['t'] for p in palabras)
    if not motivo(texto) and not cajas_a_borrar(palabras):
        print(json.dumps({'estado': 'limpia'})); return
    h, w = img.shape[:2]
    borradas = []
    for _ in range(2):  # hasta dos pasadas
        cajas = cajas_a_borrar(leer(entrada if not borradas else salida))
        if not cajas: break
        mascara = np.zeros((h, w), np.uint8)
        for x0, y0, x1, y1, m in cajas:
            mg = max(6, int(0.35 * (y1 - y0)))
            mascara[max(0, y0 - mg):min(h, y1 + mg), max(0, x0 - mg):min(w, x1 + mg)] = 255
            borradas.append({'caja': [x0, y0, x1, y1], 'motivo': m})
        base = img
        img = cv2.inpaint(base, mascara, 5, cv2.INPAINT_TELEA)
        cv2.imwrite(salida, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not borradas:
        print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'texto_sin_ubicar'})); return
    resto = motivo(' '.join(p['t'] for p in leer(salida)))
    if resto:
        print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'sigue_' + resto, 'borradas': borradas})); return
    print(json.dumps({'estado': 'borrada', 'borradas': borradas}))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
