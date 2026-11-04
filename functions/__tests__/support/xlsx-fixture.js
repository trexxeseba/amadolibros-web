// Construye un .xlsx mínimo pero real (zip con las partes que importan), sin
// ninguna librería, para probar worker-sync/xlsx-reader.js y el panel de
// importación contra bytes de verdad en vez de un mock. Sólo para tests.
import zlib from 'node:zlib';

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }

function zipFile(name, text, { stored = false } = {}) {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = Buffer.from(text, 'utf8');
  const method = stored ? 0 : 8;
  const compressed = stored ? data : zlib.deflateRawSync(data);
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
    u32(0), u32(compressed.length), u32(data.length),
    u16(nameBuf.length), u16(0), nameBuf, compressed,
  ]);
  return { local, nameBuf, method, compSize: compressed.length, uncompSize: data.length };
}

export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, text, stored } of entries) {
    const { local, nameBuf, method, compSize, uncompSize } = zipFile(name, text, { stored });
    locals.push(local);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(0), u32(compSize), u32(uncompSize),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += local.length;
  }
  const localBuf = Buffer.concat(locals), centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(centralBuf.length), u32(localBuf.length), u16(0)]);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

const colLetter = idx => { let n = idx + 1, s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// grid: array de filas, cada celda { s: 'texto' } o { n: numero } o null.
export function buildXlsx(grid, { sharedStrings = true, rels = true, withWorkbook = true } = {}) {
  const shared = [];
  const sharedIndex = text => { const i = shared.indexOf(text); if (i >= 0) return i; shared.push(text); return shared.length - 1; };
  const rowsXml = grid.map((row, r) => {
    const cells = row.map((cell, c) => {
      if (cell == null) return '';
      const ref = `${colLetter(c)}${r + 1}`;
      if ('s' in cell) {
        if (sharedStrings) return `<c r="${ref}" t="s"><v>${sharedIndex(cell.s)}</v></c>`;
        return `<c r="${ref}" t="inlineStr"><is><t>${esc(cell.s)}</t></is></c>`;
      }
      return `<c r="${ref}"><v>${cell.n}</v></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const sheetXml = `<?xml version="1.0"?><worksheet><sheetData>${rowsXml}</sheetData></worksheet>`;
  const sharedXml = `<?xml version="1.0"?><sst count="${shared.length}" uniqueCount="${shared.length}">${shared.map(s => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  const workbookXml = withWorkbook ? '<?xml version="1.0"?><workbook><sheets><sheet name="Hoja1" sheetId="1" r:id="rId1"/></sheets></workbook>' : '<?xml version="1.0"?><workbook><sheets></sheets></workbook>';
  const relsXml = rels ? '<?xml version="1.0"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>' : '<?xml version="1.0"?><Relationships></Relationships>';
  const entries = [
    { name: 'xl/workbook.xml', text: workbookXml },
    { name: 'xl/_rels/workbook.xml.rels', text: relsXml },
    { name: 'xl/worksheets/sheet1.xml', text: sheetXml, stored: true },
  ];
  if (sharedStrings) entries.push({ name: 'xl/sharedStrings.xml', text: sharedXml });
  return buildZip(entries);
}
