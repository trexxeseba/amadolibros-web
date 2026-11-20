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
    # Una @ cuenta solo si va seguida de un usuario o un correo (una @ suelta suele ser ruido de la ilustración).
    ('arroba_o_correo', r'@\s?[a-z0-9_.]{3,}'),
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
        if len(d) >= 9 and not re.match(r'97[89]', d):
            return 'telefono'
    return None

def leer(ruta):
    """Lee la tapa con tesseract. Las tapas chicas (menos de 2000 px) se agrandan al doble y se les sube el contraste: a tamaño original
    el lector no veía textos finos (20/11/2026: '@autoenfoque' en una tapa de 650 px pasó sin verse). Las posiciones se devuelven en
    la escala de la imagen original."""
    from PIL import Image, ImageOps
    import os, tempfile
    im = Image.open(ruta).convert('RGB')
    w, h = im.size
    escala = 2 if max(w, h) < 2000 else 1
    g = ImageOps.autocontrast(im.convert('L'))
    if escala != 1:
        g = g.resize((w * escala, h * escala), Image.LANCZOS)
    fd, tmp = tempfile.mkstemp(suffix='.png'); os.close(fd)
    try:
        g.save(tmp)
        out = subprocess.run(['tesseract', tmp, 'stdout', '-l', 'spa+eng', '--psm', '11', 'tsv'], capture_output=True, text=True, timeout=180).stdout
    finally:
        os.remove(tmp)
    filas = list(csv.DictReader(io.StringIO(out), delimiter='\t', quoting=csv.QUOTE_NONE))
    palabras = []
    for f in filas:
        try:
            if f['text'] and f['text'].strip() and float(f['conf']) >= 0:
                palabras.append({'t': f['text'], 'x': int(int(f['left']) / escala), 'y': int(int(f['top']) / escala), 'w': int(int(f['width']) / escala), 'h': int(int(f['height']) / escala), 'linea': (f['block_num'], f['par_num'], f['line_num'])})
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
            cajas.append((x0, y0, x1, y1, motivo(texto) or motivo(malas[0]['t']), texto))
    return [extender(c, palabras) for c in cajas]


def extender(caja, palabras):
    """Suma a la caja las palabras vecinas del mismo renglón visual (el lector a veces parte un usuario en dos líneas)."""
    x0, y0, x1, y1, m, txt = caja
    cambio = True
    while cambio:
        cambio = False
        alto = max(1, y1 - y0)
        for p in palabras:
            cy = p['y'] + p['h'] / 2
            if not (y0 - 0.4 * alto <= cy <= y1 + 0.4 * alto):
                continue
            izq, der = p['x'], p['x'] + p['w']
            hueco = max(izq - x1, x0 - der)  # distancia horizontal a la caja (negativa si se pisan)
            if hueco <= 1.0 * alto and 0.5 <= p['h'] / alto <= 2.0 and (izq < x0 or der > x1):
                x0, x1 = min(x0, izq), max(x1, der)
                y0, y1 = min(y0, p['y']), max(y1, p['y'] + p['h'])
                txt += ' ' + p['t']
                cambio = True
    return (x0, y0, x1, y1, m, txt)

def rellenar(img, cajas):
    """Solo fondo liso: se pinta con el color del entorno y queda limpio. Si el entorno tiene dibujo, devuelve None (el libro se salta)."""
    h, w = img.shape[:2]
    resultado = img.copy()
    area_total = 0
    for x0, y0, x1, y1, m, txt in cajas:
        if (x1 - x0) > 0.45 * w or (y1 - y0) > 0.08 * h:
            return None  # una caja enorme no es un texto suelto: no se toca
        mg = max(6, int(0.35 * (y1 - y0)))
        a0, b0, a1, b1 = max(0, x0 - mg), max(0, y0 - mg), min(w, x1 + mg), min(h, y1 + mg)
        area_total += (a1 - a0) * (b1 - b0)
        anillo = max(10, 2 * mg)
        A0, B0, A1, B1 = max(0, a0 - anillo), max(0, b0 - anillo), min(w, a1 + anillo), min(h, b1 + anillo)
        entorno = img[B0:B1, A0:A1].copy()
        mk = np.ones(entorno.shape[:2], bool)
        mk[(b0 - B0):(b1 - B0), (a0 - A0):(a1 - A0)] = False
        pix = entorno[mk]
        if len(pix) < 50:
            return None
        mediana = np.median(pix, axis=0)
        parecido = float((np.abs(pix.astype(int) - mediana).max(axis=1) <= 30).mean())
        if parecido < 0.85:
            return None  # fondo con dibujo (menos del 85 % del entorno es del mismo color): no se puede borrar sin dejar rastro
        resultado[b0:b1, a0:a1] = mediana.astype(np.uint8)
    if area_total > 0.03 * h * w:
        return None
    return resultado


def main(entrada, salida):
    img = cv2.imread(entrada)
    if img is None:
        print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'imagen_ilegible'})); return
    # Un código QR no se puede borrar sin dejar rastros (y suele venir con más datos): esa imagen no sirve.
    if cv2.QRCodeDetector().detect(img)[0]:
        print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'codigo_qr'})); return
    palabras = leer(entrada)
    texto = ' '.join(p['t'] for p in palabras)
    # Regla de Seba (20/11/2026): con una @ de usuario en la tapa el libro no se publica. No se limpia ni se sube nada.
    if motivo(texto) == 'arroba_o_correo' or any(motivo(p['t']) == 'arroba_o_correo' for p in palabras):
        print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'arroba_en_tapa'})); return
    if not motivo(texto) and not cajas_a_borrar(palabras):
        print(json.dumps({'estado': 'limpia'})); return
    h, w = img.shape[:2]
    borradas = []
    for _ in range(2):  # hasta dos pasadas
        cajas = cajas_a_borrar(leer(entrada if not borradas else salida))
        if not cajas: break
        mascara = np.zeros((h, w), np.uint8)
        for x0, y0, x1, y1, m, txt in cajas:
            mg = max(6, int(0.35 * (y1 - y0)))
            mascara[max(0, y0 - mg):min(h, y1 + mg), max(0, x0 - mg):min(w, x1 + mg)] = 255
            borradas.append({'caja': [x0, y0, x1, y1], 'motivo': m, 'texto': txt[:80]})
        nuevo = rellenar(img, cajas)
        if nuevo is None:
            print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'fondo_con_dibujo', 'borradas': borradas})); return
        img = nuevo
        cv2.imwrite(salida, img, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not borradas:
        print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'texto_sin_ubicar'})); return
    resto = motivo(' '.join(p['t'] for p in leer(salida)))
    if resto:
        print(json.dumps({'estado': 'no_se_pudo', 'motivo': 'sigue_' + resto, 'borradas': borradas})); return
    print(json.dumps({'estado': 'borrada', 'borradas': borradas}))

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
