// Lector de XLSX puro JS (sin dependencias: el Worker no tiene node_modules).
// Lee la primera hoja de un .xlsx — que es un zip con XML adentro — y la
// convierte a texto CSV, para reusar tal cual el contrato de carga que ya
// existe para CSV pegado a mano (hash del original, trazabilidad por fila)
// en worker-sync/importacion-externa.js: este módulo sólo traduce formato,
// no decide nada del contrato de importación.
//
// Soporta lo que graba Excel/LibreOffice de forma estándar: entradas sin
// comprimir o con deflate, shared strings y celdas en línea. No decodifica
// fechas de Excel (el número de serie queda crudo en el CSV): ninguna
// plantilla confirmada hasta ahora (ver PLANTILLAS en importacion-externa.js)
// usa una columna de fecha real, sólo texto y números.
export class XlsxError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const CDIR_SIG = 0x02014b50, LOCAL_SIG = 0x04034b50;
const MAX_COLUMNS = 2000, MAX_SHEET_XML_BYTES = 30 * 1024 * 1024;

function findEndOfCentralDirectory(bytes) {
  const max = Math.min(bytes.length, 65557); // 22 (EOCD fijo) + 65535 (comentario máximo)
  for (let i = bytes.length - 22; i >= bytes.length - max && i >= 0; i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) return i;
  }
  throw new XlsxError('zip_sin_fin_de_directorio');
}

function readCentralDirectory(bytes, view) {
  const eocd = findEndOfCentralDirectory(bytes);
  const numEntries = view.getUint16(eocd + 10, true);
  const cdirOffset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  let p = cdirOffset;
  for (let i = 0; i < numEntries; i++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CDIR_SIG) throw new XlsxError('zip_directorio_invalido');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateEntry(bytes, view, entry) {
  const p = entry.localOffset;
  if (p + 30 > bytes.length || view.getUint32(p, true) !== LOCAL_SIG) throw new XlsxError('zip_entrada_invalida');
  const nameLen = view.getUint16(p + 26, true);
  const extraLen = view.getUint16(p + 28, true);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = bytes.subarray(dataStart, dataStart + entry.compSize);
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new XlsxError('zip_compresion_no_soportada');
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readEntryText(bytes, view, entries, name) {
  const entry = entries.get(name);
  if (!entry) return null;
  const data = await inflateEntry(bytes, view, entry);
  if (data.length > MAX_SHEET_XML_BYTES) throw new XlsxError('xlsx_demasiado_grande');
  return new TextDecoder('utf-8').decode(data);
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = s => s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e) => {
  if (e[0] === '#') {
    const code = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  }
  return XML_ENTITIES[e] ?? m;
});

// xl/sharedStrings.xml: una lista de <si> (string item); cada una puede tener
// texto simple <t> o texto enriquecido en varias <r><t>, que se concatenan.
function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let text = '', t;
    while ((t = tRe.exec(m[1]))) text += unescapeXml(t[1]);
    out.push(text);
  }
  return out;
}

// "AB12" → índice de columna de base 0 (A=0, B=1, ..., Z=25, AA=26, ...).
function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// xl/worksheets/sheetN.xml → filas de celdas, ubicadas por su referencia de
// columna (no por orden de aparición: una fila puede saltear celdas vacías).
function parseSheetGrid(xml, shared) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const cells = [];
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(rm[1]))) {
      const attrs = cm[1], inner = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const idx = colIndex(ref);
      if (idx < 0 || idx >= MAX_COLUMNS) throw new XlsxError('xlsx_demasiadas_columnas');
      const type = /\bt="([a-zA-Z]+)"/.exec(attrs)?.[1];
      let value = '';
      if (type === 's') {
        const vi = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        value = vi != null ? (shared[Number(vi)] ?? '') : '';
      } else if (type === 'inlineStr') {
        const t = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(inner)?.[1];
        value = t != null ? unescapeXml(t) : '';
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        value = v != null ? unescapeXml(v) : '';
      }
      cells[idx] = value;
    }
    rows.push(Array.from(cells, c => c ?? ''));
  }
  return rows;
}

const csvEscape = v => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Convierte la primera hoja (el orden de las tapas, no el orden del zip) de
// un .xlsx a texto CSV con comillas por celda que lo necesite. Tira XlsxError
// con un código legible si el archivo no es un .xlsx válido, usa cifrado o
// una compresión que este lector no soporta: nunca devuelve datos a medias.
export async function xlsxToCsv(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 22) throw new XlsxError('archivo_vacio');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readCentralDirectory(bytes, view);
  const workbookXml = await readEntryText(bytes, view, entries, 'xl/workbook.xml');
  if (!workbookXml) throw new XlsxError('no_es_xlsx');
  const sheetTag = /<sheet\b[^>]*\/>/.exec(workbookXml)?.[0];
  const rId = sheetTag && /\br:id="([^"]+)"/.exec(sheetTag)?.[1];
  if (!rId) throw new XlsxError('sin_hojas');
  const relsXml = await readEntryText(bytes, view, entries, 'xl/_rels/workbook.xml.rels');
  const relTag = relsXml && new RegExp(`<Relationship\\b[^>]*\\bId="${rId}"[^>]*/>`).exec(relsXml)?.[0];
  const target = relTag && /\bTarget="([^"]+)"/.exec(relTag)?.[1];
  if (!target) throw new XlsxError('sin_hojas');
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.?\//, '')}`;
  const sheetXml = await readEntryText(bytes, view, entries, sheetPath);
  if (!sheetXml) throw new XlsxError('hoja_no_encontrada');
  const sharedXml = await readEntryText(bytes, view, entries, 'xl/sharedStrings.xml');
  const grid = parseSheetGrid(sheetXml, parseSharedStrings(sharedXml));
  return grid.map(row => row.map(csvEscape).join(',')).join('\n');
}
