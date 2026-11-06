// Motor local de precios de Amado Libros (MLU). Reglas y frenos.
// Nada de credenciales ni montos de la cuenta acá: el repo es público.
// Costos, estado e informes viven en precios-libros-local/datos/ (ignorado por git).

export const ML_ORIGIN = 'https://api.mercadolibre.com';
export const SELLER_ID = '440298103';
export const SITE_ID = 'MLU';
export const MONEDA = 'UYU';
export const TIMEZONE = 'America/Montevideo';

// Regla comercial definitiva (Seba, 06/11/2026). P = precio efectivo propio,
// C = precio del competidor externo válido, D = P - C.
//   0 < D < 400  -> objetivo = C x 0,99 (hacia abajo al peso)
//   D >= 400     -> no tocar
//   D <= 0       -> no iniciar una baja
// El umbral se mide antes del 1 %: el descuento total puede pasar de 400.
export const REGLA = Object.freeze({
  umbralUyu: 400,
  factor: 0.99,
  // Qué precio externo es "C". 'mas_barata': la oferta comparable más barata del
  // mismo producto de catálogo (por defecto). 'ganador': el precio del ganador de
  // la ficha si es de otro vendedor. Decisión de negocio pendiente: ver README.
  referencia: 'mas_barata',
  // La regla aprobada no distingue si ya ganamos la ficha. true = se aplica igual.
  incluirGanando: true,
  // Límite acumulado propuesto respecto del precio base aprobado (las dos condiciones).
  // 15 % bloquearía el ejemplo de la regla (2000 → 1683 = 15,85 %); 20 % y 500 pesos lo dejan
  // pasar y frenan bajas en cadena y las de libros baratos (1000 vs 700 → 30,7 %).
  limiteAcumPct: 0.20,
  limiteAcumUyu: 500,
  // Recuperación (propuesta; apagada hasta el GO).
  recuperacionHabilitada: false,
  pasoMinimoSubida: 10,
  confirmacionesDesaparicion: 2,
});

// Piso rentable: (costo puesto en UY + envío a cargo + cargo fijo) / (1 - comisión - margen).
// Valores por defecto de comisión y margen: a confirmar por Seba. Sin costo, no hay piso.
export const PISO_DEFECTO = Object.freeze({ comisionPct: null, cargoFijoUyu: 0, envioUyu: null, margenMinPct: null });

export const FRENOS = Object.freeze({
  maxCambiosPorCorrida: 10,   // piloto
  umbralFallosPct: 0.05,
  minIntentosParaUmbral: 3,
  lockVenceMin: 120,
  concurrencia: 4,
});

// Corridas diarias propuestas (hora de Montevideo).
export const HORARIOS = ['09:30', '14:30', '20:30'];

// Destino de las alertas: variable ALERTA_DESTINO en secretos.cmd (fuera del repo, que es público).
export const ALERTA_DESTINO = null;
