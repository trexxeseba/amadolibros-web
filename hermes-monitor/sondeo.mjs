// Temporal: rehace la foto (imagen nueva, sin datos ocultos) de 2 publicaciones de Vintage en revisión por "etiquetas de Mercado Libre".
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {CUENTAS} from '../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../precio-ganador/src/token.mjs';
import {crearCliente} from '../precio-ganador/src/ml.mjs';
import {CUENTA_HERMES} from './lib.mjs';
import {exigirVintage, exigirItemDeVintage} from './guardia.mjs';
const ids = ['MLU1542415460', 'MLU1542028890'];
const fuente = fuenteTokenD1(CUENTAS[CUENTA_HERMES]);
const ml = crearCliente(fuente, {concurrencia: 1});
await exigirVintage(ml);
try { execFileSync('pip', ['install', '-q', 'pillow'], {stdio: 'ignore'}); } catch {}
for (const id of ids) {
  const it = await ml.get(`/items/${id}`).catch(() => null);
  if (!it) { console.log(id, 'no se pudo leer'); continue; }
  exigirItemDeVintage(it);
  console.log(id, 'antes', it.status, JSON.stringify(it.sub_status), 'fotos', (it.pictures ?? []).length);
  const url = it.pictures?.[0]?.secure_url ?? it.pictures?.[0]?.url;
  const r = await fetch(url);
  const f = path.join(os.tmpdir(), `${id}-in.jpg`), g = path.join(os.tmpdir(), `${id}-out.jpg`);
  await fs.writeFile(f, Buffer.from(await r.arrayBuffer()));
  execFileSync('python3', ['-c', 'import sys\nfrom PIL import Image\nim=Image.open(sys.argv[1]).convert("RGB")\nim.save(sys.argv[2],"JPEG",quality=92,optimize=True)', f, g]);
  const form = new FormData();
  form.append('file', new Blob([await fs.readFile(g)], {type: 'image/jpeg'}), 'tapa.jpg');
  const up = await fetch('https://api.mercadolibre.com/pictures/items/upload', {method: 'POST', headers: {Authorization: 'Bearer ' + await fuente.getToken()}, body: form});
  const j = await up.json().catch(() => null);
  if (!j?.id) { console.log(id, 'no se pudo subir', up.status); continue; }
  try { await ml.put(`/items/${id}`, {pictures: [{id: j.id}]}); console.log(id, 'foto reemplazada'); } catch (e) { console.log(id, 'fallo reemplazo', e.code, JSON.stringify(e.body ?? '').slice(0, 300)); }
  await new Promise(r => setTimeout(r, 3000));
  const d = await ml.get(`/items/${id}`).catch(() => null);
  console.log(id, 'despues', d?.status, JSON.stringify(d?.sub_status));
}
