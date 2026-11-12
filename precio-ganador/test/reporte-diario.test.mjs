// Reporte diario claro (Seba, 12/11/2026): sin jerga, con títulos y precios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarReporteDiario } from '../src/reporte.mjs';

const cuenta = { clave: 'libros', nombre: 'Amado Libros' };
const base = () => ({
  corridas: [{ modo: 'real', bajadas: 3, ajustadas: 1, subidas: 2, restauradas: 1, errores: 0, verificadas: 7, no_verificadas: 0 }, { modo: 'real', bajadas: 0, ajustadas: 0, subidas: 0, restauradas: 0, errores: 0, verificadas: 0, no_verificadas: 0 }],
  cambios: [
    { id: 'A', titulo: 'Gestión del Talento Humano', antes: 3164, despues: 3100, accion: 'ajustar', hora: '09:03' },
    { id: 'A', titulo: 'Gestión del Talento Humano', antes: 3100, despues: 3132, accion: 'subir', hora: '11:04' },
    { id: 'A', titulo: 'Gestión del Talento Humano', antes: 3132, despues: 3069, accion: 'ajustar', hora: '13:05' },
    { id: 'B', titulo: 'Fantastic Mr. Fox', antes: 1400, despues: 747, accion: 'bajar', hora: '09:03' },
  ],
  foto: {
    estados: { winning: 3037, sharing_first_place: 22, competing: 15 },
    perdiendo: [
      { id: 'C', titulo: 'A mí no me va a pasar', precio: 2800, ganador: 719, causa: 'precio', dias: null, contra_demanda: false, accion: 'sin_tocar_pct' },
      { id: 'D', titulo: 'Curate a ti mismo', precio: 2327, ganador: 1680, causa: 'precio', dias: 23, contra_demanda: true, accion: 'bajar' },
    ],
  },
});

test('dice cuántas fichas ganamos y compara con ayer', () => {
  const r = armarReporteDiario({ cuenta, acum: base(), ayer: { foto: { estados: { winning: 3000, sharing_first_place: 20, competing: 60 } } }, fecha: '2026-11-12' });
  assert.match(r.texto, /Ganamos la ficha de catálogo en 3059 de 3074 publicaciones \(99\.5 %\)\. Ayer: 98\.1 %\./);
  assert.match(r.asunto, /ganamos 99\.5 % de las fichas · 4 cambios de precio/);
});
test('lista los cambios con título y precios, y detecta la persecución (3 o más cambios)', () => {
  const r = armarReporteDiario({ cuenta, acum: base(), fecha: '2026-11-12' });
  assert.match(r.texto, /- Fantastic Mr\. Fox: \$ 1\.?400 → \$ 747 \(bajó el precio para ganar, 09:03\)/);
  assert.match(r.texto, /3\. QUIÉN NOS PERSIGUE\n- Gestión del Talento Humano: 3 cambios hoy/);
  assert.equal(r.datos.persegidas, 1);
});
test('explica por qué perdemos y qué hay que decidir', () => {
  const r = armarReporteDiario({ cuenta, acum: base(), fecha: '2026-11-12' });
  assert.match(r.texto, /2 porque otro vendedor cobra menos/);
  assert.match(r.texto, /A mí no me va a pasar: nosotros \$ 2\.?800, el que gana \$ 719/);
  assert.match(r.texto, /5\. PARA DECIDIR VOS[\s\S]*pierden la ficha y el sistema NO los baja/);
  assert.match(r.texto, /1 libros están ocultos detrás de vendedores que tardan días/);
});
test('un día tranquilo dice "Nada. Todo en orden." y sin errores', () => {
  const r = armarReporteDiario({ cuenta, acum: { corridas: [{ modo: 'real', errores: 0, verificadas: 0, no_verificadas: 0 }], cambios: [], foto: { estados: { winning: 3000, sharing_first_place: 10, competing: 0 }, perdiendo: [] } }, fecha: '2026-11-12' });
  assert.match(r.texto, /No cambió ningún precio\./);
  assert.match(r.texto, /Nada\. Todo en orden\./);
  assert.match(r.texto, /No perdemos ninguna ficha\./);
  assert.match(r.texto, /6\. ¿HUBO PROBLEMAS\?\nNo\./);
});
test('con errores lo dice de frente y el html escapa el texto', () => {
  const a = base(); a.corridas[0].errores = 4; a.cambios[3].titulo = 'Libro <b>raro</b> & más';
  const r = armarReporteDiario({ cuenta, acum: a, fecha: '2026-11-12' });
  assert.match(r.texto, /Sí: 4 errores/);
  assert.match(r.html, /Libro &lt;b&gt;raro&lt;\/b&gt; &amp; más/);
  assert.doesNotMatch(r.html, /<b>raro/);
});
