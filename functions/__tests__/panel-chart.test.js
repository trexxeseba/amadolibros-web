import test from 'node:test';
import assert from 'node:assert/strict';

import { revenueChart, revenueTable, techoDelEje } from '../_shared/panel-chart.js';
import { loadRevenueByMonth } from '../_shared/panel-data.js';

function serie(valores) {
  const months = valores.map((total_uyu, i) => ({
    month: `2026-${String(i + 1).padStart(2, '0')}`,
    orders: total_uyu > 0 ? 1 : 0,
    total_uyu,
  }));
  return { months, max: Math.max(0, ...valores) };
}

test('el techo del eje deja aire arriba de la barra más alta', () => {
  // Si la barra más alta toca el borde, no se ve que es la más alta.
  for (const maximo of [1, 37, 5100, 84350, 999999]) {
    const techo = techoDelEje(maximo);
    assert.ok(techo >= maximo, `${maximo} no entra en un techo de ${techo}`);
    assert.ok(techo <= maximo * 2.5, `${maximo} contra ${techo} deja demasiado aire`);
  }
});

test('un catálogo sin ventas todavía no rompe el techo', () => {
  for (const vacio of [0, -1, null, undefined, NaN, 'nada']) {
    assert.ok(techoDelEje(vacio) > 0, `${String(vacio)} tiene que dar un techo usable`);
  }
});

test('los meses sin ventas se dibujan como ausencia, no como hueco', () => {
  // Un mes en cero NO es "no hay dato": es "no se vendió". Por eso no hay
  // barra, pero sí etiqueta de mes en el eje.
  const svg = revenueChart(serie([0, 5100, 0, 2350]));
  assert.equal((svg.match(/class="barra"/g) || []).length, 2, 'sólo los meses con venta tienen barra');
  assert.equal((svg.match(/class="eje"/g) || []).length, 4, 'los cuatro meses se rotulan igual');
});

test('sólo se etiqueta el mes más alto, no todos', () => {
  // Un número sobre cada barra es ruido; el resto están en el tooltip.
  const svg = revenueChart(serie([1000, 5100, 2350, 800]));
  assert.equal((svg.match(/class="valor"/g) || []).length, 1);
  assert.match(svg, /class="valor"[^>]*>\$ 5[.,]100</);
});

test('cada mes tiene un blanco de mouse de altura completa', () => {
  // Una barra de dos pixeles en un mes flojo sería imposible de apuntar.
  const svg = revenueChart(serie([50, 5100, 0]));
  assert.equal((svg.match(/class="blanco"/g) || []).length, 3,
    'incluso el mes en cero se puede apuntar');
  assert.match(svg, /<title>.*5[.,]100.*1 pedido<\/title>/);
});

test('el gráfico dice qué es para quien no lo puede ver', () => {
  const svg = revenueChart(serie([1000, 2000]));
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="Facturación cobrada por mes, últimos 2 meses"/);
});

test('sin datos no se dibuja un gráfico vacío: se dice que no hay', () => {
  for (const nada of [{ months: [] }, {}, null, undefined]) {
    const salida = revenueChart(nada);
    assert.doesNotMatch(salida, /<svg/);
    assert.match(salida, /Todavía no hay ventas/);
    assert.equal(revenueTable(nada), '', 'tampoco una tabla vacía');
  }
});

test('la tabla trae los mismos números que el gráfico', () => {
  // No es un extra: es la vía de lectura para quien no ve el gráfico.
  const tabla = revenueTable(serie([0, 5100, 2350]));
  assert.match(tabla, /\$ 5[.,]100/);
  assert.match(tabla, /\$ 2[.,]350/);
  assert.match(tabla, /\$ 0/);
  assert.equal((tabla.match(/<tr>/g) || []).length, 4, 'tres meses más el encabezado');
});

test('un título hostil no puede escaparse del SVG', () => {
  // Los meses los arma el propio código, pero el escape es del molde: si
  // mañana entra algo de afuera, tiene que salir escapado igual.
  const svg = revenueChart({
    months: [{ month: '<script>x</script>', orders: 1, total_uyu: 100 }], max: 100,
  });
  assert.doesNotMatch(svg, /<script>x<\/script>/);
});

test('la consulta rellena los meses sin ventas y no los saltea', async () => {
  // Ésta es la parte que hace que el gráfico no mienta: la base sólo
  // devuelve los meses que tuvieron ventas.
  const db = {
    prepare() {
      const st = {
        bind: () => st,
        all: async () => ({ results: [{ month: '2026-09', orders: 2, total_uyu: 5100 }] }),
      };
      return st;
    },
  };
  const revenue = await loadRevenueByMonth(db, { now: Date.parse('2026-09-10T23:00:00Z') });

  assert.equal(revenue.months.length, 12, 'siempre doce meses, con ventas o sin ellas');
  assert.equal(revenue.months.at(-1).month, '2026-09', 'el último es el mes en curso');
  assert.equal(revenue.months.at(-1).total_uyu, 5100);
  assert.equal(revenue.months[0].total_uyu, 0, 'los meses sin ventas vienen en cero, no faltan');
  assert.equal(revenue.max, 5100);
  assert.equal(revenue.total_uyu, 5100);
  assert.equal(revenue.orders, 2);

  const claves = revenue.months.map(fila => fila.month);
  assert.deepEqual([...new Set(claves)], claves, 'sin meses repetidos');
  assert.deepEqual([...claves].sort(), claves, 'en orden');
});

test('la consulta de facturación no escribe nada', async () => {
  const vistas = [];
  const db = {
    prepare(sql) {
      vistas.push(sql);
      const st = { bind: () => st, all: async () => ({ results: [] }) };
      return st;
    },
  };
  await loadRevenueByMonth(db, { now: Date.parse('2026-09-10T23:00:00Z') });
  assert.ok(vistas.length > 0);
  for (const sql of vistas) {
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i, `escribe: ${sql}`);
  }
});
