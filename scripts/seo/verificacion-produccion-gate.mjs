import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Decide si una verificación de Producción se puede dar por buena.
//
// Esta es la ÚNICA implementación de la decisión: la usan el workflow y las
// pruebas. Si el workflow la reescribiera en su propio `node -e`, las pruebas
// estarían probando una copia y no lo que realmente corre.
//
// La versión anterior aprobaba tres situaciones que no verifican nada:
// todas las fichas en 404, todas en 500 y el plan vacío. Las tres llegaban a
// imprimir «Producción verificada: 0 fichas». El criterio ahora es el
// contrario: sólo se aprueba con evidencia positiva.

// Un campo ausente no es cero. Si el informe no trae el número, el informe
// está incompleto y eso ya es motivo para no aprobar.
function entero(valor) {
  return Number.isInteger(valor) && valor >= 0 ? valor : null;
}

const CAMPOS = Object.freeze([
  'fichas_esperadas', 'verificadas', 'fallidas', 'no_verificadas', 'comprobaciones_totales',
]);

export function evaluarCierre({ diff, validacion } = {}) {
  const motivos = [];

  if (!diff || typeof diff !== 'object') {
    motivos.push('Falta el informe de reconciliación: no se sabe qué debía mejorar cada ficha.');
  }
  if (!validacion || typeof validacion !== 'object') {
    motivos.push('Falta el informe de verificación: no se verificó ninguna ficha.');
  }

  const totales = validacion?.totales;
  const cifras = {};
  if (validacion && typeof validacion === 'object') {
    for (const campo of CAMPOS) {
      cifras[campo] = entero(totales?.[campo]);
      if (cifras[campo] === null) {
        motivos.push(`El informe de verificación está incompleto: falta "${campo}".`);
      }
    }
  }

  const perdidas = diff && typeof diff === 'object'
    ? entero(diff?.totales?.fichas_que_pierden_algun_campo)
    : null;
  if (diff && typeof diff === 'object' && perdidas === null) {
    motivos.push('El informe de reconciliación está incompleto: falta "fichas_que_pierden_algun_campo".');
  }

  // Con los informes incompletos no se puede seguir juzgando: cualquier
  // conclusión sería sobre datos que no están.
  if (motivos.length) return { ok: false, motivos, resumen: null };

  const { fichas_esperadas: esperadas, verificadas, fallidas, no_verificadas: sinVerificar,
    comprobaciones_totales: comprobaciones } = cifras;

  if (esperadas === 0) {
    motivos.push('El plan no contiene ninguna ficha: no hay nada verificado. Un plan vacío no es un éxito.');
  }
  if (comprobaciones === 0) {
    motivos.push('No se hizo ninguna comprobación de campo: cero comprobaciones no prueban nada.');
  }
  if (verificadas === 0) {
    motivos.push('Ninguna ficha quedó verificada.');
  }
  if (esperadas > 0 && verificadas !== esperadas) {
    motivos.push(`Sólo ${verificadas} de ${esperadas} fichas quedaron verificadas.`);
  }
  if (fallidas > 0) {
    motivos.push(`${fallidas} ficha(s) no muestran lo prometido.`);
  }
  // Un 404 se informa como "sin verificar" y no se le atribuye causa, pero
  // tampoco se lo excluye del total: una ficha que no se pudo mirar no es una
  // ficha aprobada.
  if (sinVerificar > 0) {
    motivos.push(
      `${sinVerificar} ficha(s) quedaron SIN VERIFICAR (404 u otro error). No se les atribuye causa: `
      + 'hay que revisarlas una por una antes de dar la corrida por buena.',
    );
  }
  if (perdidas > 0) {
    motivos.push(`${perdidas} ficha(s) perdieron algún campo que antes mostraban.`);
  }
  // Un informe cuyas partes no suman está mal armado, aunque cada cifra
  // parezca inocente por separado.
  if (verificadas + fallidas + sinVerificar !== esperadas) {
    motivos.push(
      `El informe no cierra: ${verificadas} verificadas + ${fallidas} fallidas + ${sinVerificar} sin verificar `
      + `no suman las ${esperadas} esperadas.`,
    );
  }

  return {
    ok: motivos.length === 0,
    motivos,
    resumen: { esperadas, verificadas, fallidas, sin_verificar: sinVerificar, comprobaciones, perdidas },
  };
}

async function leerJson(ruta) {
  try {
    return JSON.parse(await readFile(ruta, 'utf8'));
  } catch {
    return null;
  }
}

export async function main() {
  const diffPath = process.env.GATE_DIFF || 'artifacts/produccion/effective-ficha-diff.json';
  const validacionPath = process.env.GATE_VALIDACION || 'artifacts/produccion/ficha-validation.json';

  const { ok, motivos, resumen } = evaluarCierre({
    diff: await leerJson(diffPath),
    validacion: await leerJson(validacionPath),
  });

  if (!ok) {
    console.error('=== LA VERIFICACIÓN DE PRODUCCIÓN NO SE PUEDE DAR POR BUENA ===');
    for (const motivo of motivos) console.error(`- ${motivo}`);
    console.error('Detalle por ficha en el artefacto de esta corrida, que se conserva igual.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `Producción verificada: ${resumen.verificadas}/${resumen.esperadas} fichas, `
    + `${resumen.comprobaciones} comprobaciones, 0 fallidas, 0 sin verificar, 0 pérdidas.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
