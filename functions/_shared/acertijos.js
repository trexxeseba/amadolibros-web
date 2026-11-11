/**
 * El Acertijo del Librero: un acertijo literario por día, rotando desde
 * data/acertijos.json. La respuesta se valida siempre en el servidor.
 */
import DATA from './acertijos-data.js';

/** Minúsculas, sin tildes ni signos, espacios simples. */
export function normalizarRespuesta(value) {
    return String(value ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Días enteros desde 1970 del día calendario AAAA-MM-DD (independiente de la hora). */
export function diasDesdeEpoca(dia) {
    return Math.floor(Date.parse(`${dia}T00:00:00Z`) / 86400000);
}

/** Acertijo de un día (AAAA-MM-DD, hora de Montevideo): rota en orden. */
export function acertijoDelDia(dia, data = DATA) {
    const lista = data.acertijos;
    if (!Array.isArray(lista) || !lista.length) return null;
    return lista[((diasDesdeEpoca(dia) % lista.length) + lista.length) % lista.length];
}

/**
 * ¿Es correcta la respuesta? Coincide si, normalizada, es igual a una respuesta
 * aceptada o la contiene como palabras completas (por ejemplo "fue Borges").
 * Una respuesta vacía o de una sola letra nunca acierta.
 */
export function esRespuestaCorrecta(respuesta, acertijo) {
    const r = normalizarRespuesta(respuesta);
    if (r.length < 2 || !acertijo) return false;
    const padded = ` ${r} `;
    return acertijo.respuestas.some(a => {
        const n = normalizarRespuesta(a);
        return n.length >= 2 && (r === n || padded.includes(` ${n} `));
    });
}

/** Texto del regalo del acertijo: configurable por JSON y, si hace falta, por ACERTIJO_REGALO. */
export function regaloTexto(env = {}, data = DATA) {
    const clave = String(env?.ACERTIJO_REGALO || data.regalo || '');
    return data.regalos?.[clave] || data.regalos?.[data.regalo] || 'Marcapáginas de Amado';
}

export function acertijoPublico(acertijo, dia) {
    return { id: acertijo.id, pregunta: acertijo.pregunta, dia };
}
