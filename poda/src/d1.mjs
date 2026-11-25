// Acceso a la D1 de producción (amadolibros-orders-production) y token de ML.
//
// En Actions: API de Cloudflare con los secretos que ya usa Precio Ganador.
// En la PC: wrangler (sesión del usuario). Los montos y el detalle del registro van
// SOLO a D1 y a la mesa; nada de esto se imprime en logs públicos.
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { D1_DATABASE_ID } from '../../precio-ganador/src/config.mjs';

export const lit = v => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? (Number.isFinite(v) ? String(v) : 'NULL') : `'${String(v).replace(/'/g, "''")}'`;

const WORKER_DIR = new URL('../../worker-sync/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

export function crearD1({ env = process.env, fetcher = (...a) => globalThis.fetch(...a) } = {}) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const tokens = [env.CLOUDFLARE_ADMIN_API_TOKEN, env.CLOUDFLARE_API_TOKEN].filter(Boolean);
  if (accountId && tokens.length) {
    return {
      via: 'api',
      async query(sql) {
        let ultimo = 'cloudflare_sin_respuesta';
        for (const t of tokens) {
          const res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${D1_DATABASE_ID}/query`, {
            method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql }), signal: AbortSignal.timeout(30000),
          }).catch(() => null);
          if (!res) { ultimo = 'cloudflare_transporte'; continue; }
          const body = await res.json().catch(() => null);
          if (!res.ok || body?.success === false) { ultimo = `cloudflare_http_${res.status}`; continue; }
          return body?.result?.[0]?.results ?? [];
        }
        throw Object.assign(new Error(ultimo), { code: ultimo, fatal: true });
      },
    };
  }
  return {
    via: 'wrangler',
    async query(sql) {
      const dir = mkdtempSync(join(tmpdir(), 'poda-'));
      const archivo = join(dir, 'q.sql');
      try {
        writeFileSync(archivo, sql);
        const out = execFileSync('npx', ['wrangler@3', 'd1', 'execute', 'amadolibros-orders-production', '--remote', '--json', '--file', archivo], { cwd: WORKER_DIR, shell: true, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
        const json = JSON.parse(out.slice(out.indexOf('[')));
        return json.flatMap(r => r?.results ?? []).filter(Boolean);
      } catch (e) { throw Object.assign(new Error('wrangler_d1_fallo'), { code: 'wrangler_d1_fallo', fatal: true }); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}

export const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS poda_registro(ad_group_id TEXT PRIMARY KEY, external_id TEXT, tipo TEXT, item_ids_json TEXT, titulo TEXT, campaign_id TEXT, campaign_nombre TEXT, estado TEXT NOT NULL, origen TEXT NOT NULL, motivo TEXT, precio REAL, precio_lista REAL, promo INTEGER, gasto REAL, clics INTEGER, cpc REAL, tope REAL, tope_clics INTEGER, fecha_propuesta TEXT, fecha_pausa TEXT, fecha_reactivar_propuesta TEXT, regla_reactivar INTEGER, contar_desde TEXT, fecha_reactivada TEXT, actualizado TEXT)`,
  `CREATE TABLE IF NOT EXISTS poda_corridas(id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL, accion TEXT NOT NULL, modo TEXT NOT NULL, contadores_json TEXT, detalle_json TEXT, creado_ms INTEGER NOT NULL)`,
];

const COLS = ['ad_group_id', 'external_id', 'tipo', 'item_ids_json', 'titulo', 'campaign_id', 'campaign_nombre', 'estado', 'origen', 'motivo', 'precio', 'precio_lista', 'promo', 'gasto', 'clics', 'cpc', 'tope', 'tope_clics', 'fecha_propuesta', 'fecha_pausa', 'fecha_reactivar_propuesta', 'regla_reactivar', 'contar_desde', 'fecha_reactivada', 'actualizado'];

export function sqlUpsert(fila) {
  const f = { ...fila, item_ids_json: JSON.stringify(fila.item_ids ?? (fila.item_ids_json ? JSON.parse(fila.item_ids_json) : [])) };
  const vals = COLS.map(c => lit(f[c] === undefined ? null : f[c]));
  const sets = COLS.filter(c => c !== 'ad_group_id').map(c => `${c}=excluded.${c}`).join(',');
  return `INSERT INTO poda_registro(${COLS.join(',')}) VALUES(${vals.join(',')}) ON CONFLICT(ad_group_id) DO UPDATE SET ${sets};`;
}
export const sqlBorrar = id => `DELETE FROM poda_registro WHERE ad_group_id=${lit(String(id))};`;

export async function grabarCambios(d1, cambios) {
  if (!cambios.length) return 0;
  const stmts = cambios.map(c => c.tipo === 'borrar' ? sqlBorrar(c.ad_group_id) : sqlUpsert(c.fila));
  for (let i = 0; i < stmts.length; i += 40) await d1.query(stmts.slice(i, i + 40).join('\n'));
  return stmts.length;
}
