// Reglas del perfil guardado en el checkout.
//
// Copia probada/canónica de las funciones inline en
// astro-front/src/pages/carrito.astro (bloque <script is:inline>, que no puede
// usar `import` porque corre sin bundler). Si se cambia acá, replicar allá —
// ver el comentario recíproco junto a `camposACompletar` en carrito.astro.
//
// La regla central: los datos guardados NUNCA pisan lo que la persona
// escribió. Se completa un campo sólo si sigue vacío y no fue tocado desde
// que se pidió el perfil. Así una respuesta que llega tarde no borra lo que
// se estuvo escribiendo mientras tanto.

// Nombre del campo en el perfil → id del control en el formulario. Los ids
// son los que ya existían; no se renombró ninguno.
export const CAMPO_A_ID = Object.freeze({
  buyer_name: 'buyer-name',
  buyer_phone: 'buyer-phone',
  address: 'delivery-address',
  locality: 'delivery-barrio',
  department: 'delivery-departamento',
});

export const CAMPOS_PERFIL = Object.freeze(Object.keys(CAMPO_A_ID));

function limpiar(valor) {
  return String(valor === null || valor === undefined ? '' : valor).replace(/\s+/g, ' ').trim();
}

export function camposACompletar(perfil, valoresActuales, tocados) {
  var yaTocado = {};
  for (var i = 0; i < (tocados || []).length; i++) yaTocado[tocados[i]] = true;

  var aCompletar = {};
  for (var j = 0; j < CAMPOS_PERFIL.length; j++) {
    var campo = CAMPOS_PERFIL[j];
    var guardado = perfil ? limpiar(perfil[campo]) : '';
    if (!guardado) continue;
    if (yaTocado[campo]) continue;
    if (limpiar(valoresActuales ? valoresActuales[campo] : '')) continue;
    aCompletar[campo] = guardado;
  }
  return aCompletar;
}

// Lo que se manda a guardar sale de lo que hay escrito en el formulario en
// ese momento. Un campo vacío se manda vacío: sirve para borrar un dato.
export function perfilDesdeValores(valoresActuales) {
  var perfil = {};
  for (var i = 0; i < CAMPOS_PERFIL.length; i++) {
    var campo = CAMPOS_PERFIL[i];
    perfil[campo] = limpiar(valoresActuales ? valoresActuales[campo] : '');
  }
  return perfil;
}

export function tieneAlgoParaGuardar(perfil) {
  for (var i = 0; i < CAMPOS_PERFIL.length; i++) {
    if (limpiar(perfil ? perfil[CAMPOS_PERFIL[i]] : '')) return true;
  }
  return false;
}
