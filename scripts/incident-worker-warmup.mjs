// Arranque del Worker temporal de aceptación.
//
// Los chequeos de portadas despliegan un Worker efímero y RECIÉN DESPUÉS le
// cargan el secreto INCIDENT_TOKEN, porque `wrangler deploy` no puede subir un
// secreto en el mismo paso. Eso crea una versión nueva, y la propagación de una
// versión no es instantánea: durante unos segundos un pedido puede caer en un
// isolate que todavía tiene la versión sin el secreto. Ese isolate compara el
// token contra `undefined` y contesta 403.
//
// O sea que un 403 durante el arranque significa «la versión nueva todavía no
// llegó acá», no «el token está mal». El bucle de /ready ya lo trataba así —un
// 403 no es `response.ok`, así que seguía esperando—, pero se daba por listo con
// UN solo 200, y un 200 prueba que ese isolate está al día, no que lo estén
// todos. El 2026-09-14 la corrida 34838315641 falló exactamente ahí: /ready
// contestó 200 y el pedido siguiente, /manifest, cayó en un isolate viejo y
// devolvió «Manifest HTTP 403». Nada del PR estaba roto.
//
// La tolerancia se corta en la primera respuesta buena y no vuelve nunca más:
// una vez que el Worker contestó bien, un 403 posterior es una falla de verdad y
// se propaga en el acto. Y el presupuesto de reintentos es uno solo para todo el
// chequeo, no uno por pedido, así que un token realmente mal no alarga la
// corrida: termina en rojo igual, unos segundos después.
export const WARMUP_ATTEMPTS = 12;
export const WARMUP_DELAY_MS = 2000;

const dormir = ms => new Promise(resolve => setTimeout(resolve, ms));

export function withWarmup(request, { attempts = WARMUP_ATTEMPTS, delayMs = WARMUP_DELAY_MS, sleep = dormir } = {}) {
    let restantes = attempts;
    let arrancado = false;
    return async function requestConArranque(...args) {
        for (;;) {
            const response = await request(...args);
            if (response.ok) {
                arrancado = true;
                return response;
            }
            if (arrancado || response.status !== 403 || restantes <= 0) return response;
            restantes -= 1;
            await sleep(delayMs);
        }
    };
}
