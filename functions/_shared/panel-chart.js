/**
 * functions/_shared/panel-chart.js
 *
 * El gráfico de facturación del tablero, dibujado en SVG a mano.
 *
 * POR QUE BARRAS Y NO UNA LINEA
 *
 * Son totales de períodos discretos —lo facturado en cada mes—, no una medición
 * continua. Con barras, un mes sin ventas se lee como lo que es: no hay barra.
 * Con una línea, ese mismo mes sería una caída hasta cero y después una subida,
 * que sugiere un movimiento que nunca pasó. Con el volumen real de la librería,
 * eso importa: hay meses en cero de verdad.
 *
 * POR QUE SIN LIBRERIA
 *
 * El panel corre en un Worker y todo lo que sirve viaja en cada carga. Doce
 * barras y un eje no justifican traer una librería de gráficos, y además el
 * sitio no carga scripts de terceros.
 *
 * UNA SOLA SERIE, A PROPOSITO
 *
 * Plata y cantidad de pedidos son dos magnitudes distintas y meterlas en el
 * mismo gráfico obligaría a dos ejes verticales, que es la forma más común de
 * hacer mentir a un gráfico. La cantidad de pedidos va en el tooltip de cada
 * mes, no como segunda serie.
 */

const ALTO = 180;
const ANCHO = 720;
const MARGEN = { arriba: 24, derecha: 8, abajo: 26, izquierda: 8 };
const RADIO = 4;
const SEPARACION = 2;

const MES_CORTO = ['ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function pesos(value) {
  return `$ ${new Intl.NumberFormat('es-UY', { maximumFractionDigits: 0 }).format(Number(value) || 0)}`;
}

/** "2026-09" → "sep 26". El año sólo en enero y en el primer mes de la serie. */
function etiquetaMes(clave, primero) {
  const [anio, mes] = String(clave).split('-');
  const indice = Number(mes) - 1;
  const nombre = MES_CORTO[indice] || '?';
  return (indice === 0 || primero) ? `${nombre} ${String(anio).slice(2)}` : nombre;
}

/**
 * Un techo redondo para el eje: 5.100 no se dibuja contra 5.100 sino contra
 * 6.000. Si la barra más alta toca el borde, no se ve que es la más alta.
 */
export function techoDelEje(maximo) {
  const valor = Number(maximo) || 0;
  if (valor <= 0) return 1000;
  const magnitud = 10 ** Math.floor(Math.log10(valor));
  for (const paso of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    const candidato = paso * magnitud;
    if (candidato >= valor) return candidato;
  }
  return 10 * magnitud;
}

/**
 * @param {object} revenue  lo que devuelve loadRevenueByMonth
 * @returns {string} el SVG listo para incrustar
 */
export function revenueChart(revenue) {
  const meses = Array.isArray(revenue?.months) ? revenue.months : [];
  if (meses.length === 0) {
    return '<p class="empty">Todavía no hay ventas cobradas para graficar.</p>';
  }

  const techo = techoDelEje(revenue.max);
  const util = { ancho: ANCHO - MARGEN.izquierda - MARGEN.derecha,
    alto: ALTO - MARGEN.arriba - MARGEN.abajo };
  const paso = util.ancho / meses.length;
  const anchoBarra = Math.max(6, paso - SEPARACION * 2);
  const base = MARGEN.arriba + util.alto;

  // Se etiqueta sólo el mes más alto. Un número sobre cada barra es ruido: el
  // resto de los valores están en el tooltip, que es donde se los busca.
  const masAlto = meses.reduce((mayor, fila, indice) =>
    (fila.total_uyu > meses[mayor].total_uyu ? indice : mayor), 0);

  const grilla = [0, 0.5, 1].map(fraccion => {
    const y = MARGEN.arriba + util.alto * (1 - fraccion);
    return `<line class="grilla" x1="${MARGEN.izquierda}" y1="${y.toFixed(1)}"
      x2="${ANCHO - MARGEN.derecha}" y2="${y.toFixed(1)}"></line>`;
  }).join('');

  const barras = meses.map((fila, indice) => {
    const alto = techo > 0 ? (fila.total_uyu / techo) * util.alto : 0;
    const x = MARGEN.izquierda + paso * indice + (paso - anchoBarra) / 2;
    const y = base - alto;
    const etiqueta = etiquetaMes(fila.month, indice === 0);
    const detalle = `${etiqueta}: ${pesos(fila.total_uyu)}`
      + ` · ${fila.orders} pedido${fila.orders === 1 ? '' : 's'}`;

    // El rectángulo transparente de toda la altura es el blanco del mouse: una
    // barra de dos pixeles en un mes flojo sería imposible de apuntar.
    return `<g class="mes">
      <rect class="blanco" x="${(MARGEN.izquierda + paso * indice).toFixed(1)}"
            y="${MARGEN.arriba}" width="${paso.toFixed(1)}" height="${util.alto}">
        <title>${escapeHtml(detalle)}</title>
      </rect>
      ${alto > 0 ? `<rect class="barra" x="${x.toFixed(1)}" y="${y.toFixed(1)}"
            width="${anchoBarra.toFixed(1)}" height="${alto.toFixed(1)}"
            rx="${Math.min(RADIO, anchoBarra / 2)}"></rect>` : ''}
      ${indice === masAlto && fila.total_uyu > 0
        ? `<text class="valor" x="${(x + anchoBarra / 2).toFixed(1)}"
                 y="${(y - 7).toFixed(1)}">${escapeHtml(pesos(fila.total_uyu))}</text>`
        : ''}
      <text class="eje" x="${(MARGEN.izquierda + paso * indice + paso / 2).toFixed(1)}"
            y="${(base + 16).toFixed(1)}">${escapeHtml(etiqueta)}</text>
    </g>`;
  }).join('');

  return `<figure class="grafico">
  <svg viewBox="0 0 ${ANCHO} ${ALTO}" role="img"
       aria-label="Facturación cobrada por mes, últimos ${meses.length} meses">
    ${grilla}
    <line class="base" x1="${MARGEN.izquierda}" y1="${base}"
          x2="${ANCHO - MARGEN.derecha}" y2="${base}"></line>
    ${barras}
  </svg>
</figure>`;
}

/**
 * La misma serie como tabla. No es un extra: es la vía de lectura para quien
 * no puede ver el gráfico, y la que permite copiar los números.
 */
export function revenueTable(revenue) {
  const meses = Array.isArray(revenue?.months) ? revenue.months : [];
  if (meses.length === 0) return '';
  return `<details class="tabla-datos">
  <summary>Ver los números</summary>
  <div class="scroll"><table>
    <thead><tr><th>Mes</th><th>Pedidos</th><th>Facturado</th></tr></thead>
    <tbody>${meses.map(fila => `<tr>
      <td>${escapeHtml(etiquetaMes(fila.month, true))}</td>
      <td>${escapeHtml(fila.orders)}</td>
      <td>${escapeHtml(pesos(fila.total_uyu))}</td>
    </tr>`).join('')}</tbody>
  </table></div>
</details>`;
}
