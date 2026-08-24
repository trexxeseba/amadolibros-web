// functions/_shared/mojibake.js
//
// Repara texto UTF-8 que fue mal interpretado una vez como Latin-1/
// Windows-1252 en algun punto del pipeline (sync, import legado, etc.) --
// el patron clasico "SuperniA?a" en vez de "Supernina" (con la enie real).
// No es un diccionario de reemplazos por producto: revierte la
// transformacion de bytes que produjo el mojibake, asi que corrige
// cualquier texto afectado por la misma causa, sin listar casos
// particulares.
//
// Como funciona:
// 1. Busca corridas contiguas de caracteres "altos" (codepoint >= 0x80)
//    que tengan un byte Windows-1252 valido -- es decir, exactamente los
//    caracteres que aparecen cuando bytes UTF-8 reales se re-interpretan
//    de a uno como Windows-1252.
// 2. Convierte esa corrida de vuelta a sus bytes originales y los
//    decodifica como UTF-8 en modo estricto (`fatal: true`).
// 3. Solo reemplaza la corrida si la decodificacion UTF-8 tiene exito. Una
//    corrida de caracteres Latin-1 "sanos" (por ejemplo, una unica vocal
//    acentuada) casi nunca forma una secuencia UTF-8 valida al
//    reinterpretarse como bytes, asi que el modo estricto la deja intacta
//    -- de ahi que la funcion nunca "arregle" texto que ya esta bien,
//    nunca introduzca el caracter de reemplazo Unicode, y sea idempotente
//    (aplicarla sobre texto ya reparado no vuelve a encontrar corridas
//    reparables).

// Windows-1252 solo difiere de Latin-1 (ISO-8859-1) en el rango 0x80-0x9F.
// Los bytes sin entrada en esta tabla (0x81, 0x8D, 0x8F, 0x90, 0x9D) no
// estan definidos en Windows-1252 y por lo tanto nunca se usan revertidos.
const CP1252_HIGH_TO_CODEPOINT = Object.freeze({
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
});

// Codepoint Unicode -> byte Windows-1252 (inversa de la tabla anterior, mas
// el rango Latin-1 0xA0-0xFF donde Windows-1252 y Unicode coinciden 1:1).
const CODEPOINT_TO_CP1252_BYTE = new Map();
for (let byte = 0xa0; byte <= 0xff; byte += 1) CODEPOINT_TO_CP1252_BYTE.set(byte, byte);
for (const [byteText, codepoint] of Object.entries(CP1252_HIGH_TO_CODEPOINT)) {
  CODEPOINT_TO_CP1252_BYTE.set(codepoint, Number(byteText));
}

// Corrida de caracteres "altos" (codepoint >= 0x0080): candidatos a ser
// bytes UTF-8 reinterpretados como Windows-1252. repairRun() decide si la
// corrida es realmente reparable; este regex solo la recorta del resto del
// texto. Escrito con \u explicito para no depender de glifos no-ASCII
// literales en el codigo fuente.
const HIGH_RUN_RE = /[-￿]+/gu;
const REPLACEMENT_CHAR = '�';

let cachedDecoder = null;
function utf8StrictDecoder() {
  // TextDecoder es global en Cloudflare Workers y en Node -- no depende de
  // Buffer, asi que la misma funcion corre igual en functions/ (Workers) y
  // si algun script de mantenimiento la reutiliza en Node.
  if (!cachedDecoder) cachedDecoder = new TextDecoder('utf-8', { fatal: true });
  return cachedDecoder;
}

// Intenta reinterpretar una corrida de caracteres "altos" como bytes
// Windows-1252 y decodificarlos como UTF-8. Devuelve el texto reparado, o
// null si la corrida no es mojibake reparable (deja el original intacto).
function repairRun(run) {
  const bytes = [];
  for (const char of run) {
    const codepoint = char.codePointAt(0);
    const byte = CODEPOINT_TO_CP1252_BYTE.get(codepoint);
    if (byte == null) return null; // caracter fuera de Windows-1252: no es este tipo de mojibake
    bytes.push(byte);
  }
  try {
    const decoded = utf8StrictDecoder().decode(Uint8Array.from(bytes));
    if (!decoded || decoded.includes(REPLACEMENT_CHAR)) return null;
    return decoded;
  } catch {
    return null; // secuencia UTF-8 invalida => la corrida no era mojibake
  }
}

/**
 * Repara texto UTF-8 mal interpretado como Latin-1/Windows-1252, solo
 * cuando encuentra una corrida de bytes que decodifica limpiamente como
 * UTF-8 valido. Texto ya correcto (incluyendo vocales acentuadas sueltas,
 * espanol, u otros idiomas) queda intacto porque una corrida "sana" casi
 * nunca decodifica como UTF-8 valido en modo estricto.
 *
 * Idempotente: aplicarla dos veces da el mismo resultado que aplicarla una
 * vez, porque el texto ya reparado no contiene mas corridas reparables.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function fixMojibake(value) {
  const text = value == null ? '' : String(value);
  if (!text) return text;
  return text.replace(HIGH_RUN_RE, run => repairRun(run) ?? run);
}

// Senales de que un texto probablemente contiene mojibake, para medicion y
// reportes (no se usan para decidir si reparar -- eso lo decide
// fixMojibake por si sola, de forma deterministica). Cubre los patrones
// mencionados en el reporte: "A" + diacritico suelto (UTF-8 de 2 bytes mal
// interpretado), "A-circunfleja" seguido de moneda/comillas (secuencias de
// 3 bytes), y el caracter de reemplazo Unicode, que senala una perdida de
// datos ya irreversible (no reparable por esta funcion).
const MOJIBAKE_SIGNAL_RE = new RegExp(
  'Ã[-¿]' + // Ã + byte de continuación típico (ej. Ã±, Ã­, Ã³, Ã º)
  '|Â[-¿]' + // Â + byte de continuación típico
  '|â€' + // â€ (comillas/rayas de 3 bytes mal interpretadas)
  '|ðŸ' + // ðŸ (emoji de 4 bytes mal interpretado)
  '|' + REPLACEMENT_CHAR,
  'u',
);

/**
 * true si el texto tiene una senal reconocible de mojibake o de perdida de
 * datos ya irreversible (caracter de reemplazo). Uso exclusivo de medicion
 * y reportes -- fixMojibake no depende de esta funcion para decidir si
 * reparar un texto.
 * @param {unknown} value
 */
export function hasMojibakeSignal(value) {
  const text = value == null ? '' : String(value);
  return MOJIBAKE_SIGNAL_RE.test(text);
}

/**
 * true si el texto contiene el caracter de reemplazo Unicode, senal de que
 * los bytes originales ya se perdieron en algun punto anterior y no se
 * pueden reconstruir a partir del texto solo.
 * @param {unknown} value
 */
export function hasIrreversibleDataLoss(value) {
  const text = value == null ? '' : String(value);
  return text.includes(REPLACEMENT_CHAR);
}
