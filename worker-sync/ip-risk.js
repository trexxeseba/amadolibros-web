// Filtro de propiedad intelectual para altas automáticas (Amado Vintage, decisión de Seba 08/11/2026,
// después de la suspensión de la cuenta por "réplicas, falsificaciones y copias no autorizadas").
//
// Ultra agresivo a propósito: si el título o la editorial tienen una palabra de riesgo, el libro no se
// publica nunca, aunque sea un libro en papel legítimo. Perder un libro bueno cuesta poco; otra
// suspensión cuesta la cuenta.
//
// Casos reales que motivaron cada grupo:
//  - "Libro Digital Society For The Ib Diploma", "Dieci A1 - Libro + Ebook Interattivo": marcadas por
//    Mercado Libre como copia no autorizada (08/11/2026).
//  - "anillado", "encuadernado": marcadas antes por la misma política (suenan a fotocopia).
// Fuentes: política de Mercado Libre de propiedad intelectual (prohíbe descargables y copias de libros
// como PDF; pide no usar "réplica", "símil", "tipo", "igual a", "idéntico", "estilo" en títulos).

// Cada entrada es una expresión sobre el texto normalizado (minúsculas, sin acentos, sin signos).
export const IP_RISK_PATTERNS=[
 // Digital, descargable, acceso online
 ['digital','\\bdigital(es)?\\b|\\bdigitale\\b|\\bnumerique\\b|\\bdigitalausgabe\\b'],
 ['ebook','\\be ?books?\\b|\\be ?libro\\b|\\blibro electronico\\b|\\belectronic\\b|\\betext\\b|\\be text\\b'],
 ['formato_archivo','\\bpdf\\b|\\bepub\\b|\\bmobi\\b|\\bkindle\\b|\\bmp3\\b|\\bcd ?rom\\b|\\bdvd\\b|\\bmultirom\\b|\\bcd\\b'],
 ['descarga','\\bdescarga(s|ble|bles)?\\b|\\bdownload(able)?\\b|\\bonline\\b|\\bon line\\b|\\ben linea\\b'],
 ['acceso','\\bacceso\\b|\\baccess\\b|\\bcodigo\\b|\\bcode\\b|\\blicencia\\b|\\blicense\\b|\\bsuscripcion\\b|\\bsubscription\\b|\\bplataforma\\b|\\bplatform\\b'],
 ['interactivo','\\binteractiv[oae]s?\\b|\\binterattiv[oaei]\\b|\\binteractive\\b|\\bapp\\b|\\bapps\\b'],
 ['audio','\\baudio ?libro\\b|\\baudio ?book\\b|\\baudiolibro\\b'],
 // Copia, réplica, imitación
 ['copia','\\bcopias?\\b|\\bfotocopia(s|do|da)?\\b|\\bcopy\\b|\\bphotocop(y|ied)\\b|\\breplicas?\\b|\\breplica\\b|\\bfacsimil(ar|es)?\\b|\\bfacsimile\\b|\\bimitacion\\b|\\bpirata\\b|\\bgenerico\\b|\\bsimil\\b|\\bidentico\\b|\\bigual a\\b|\\bestilo\\b|\\btipo\\b'],
 // Encuadernación casera / impresión bajo demanda
 ['encuadernacion','\\banillad[oa]s?\\b|\\bespiralad[oa]s?\\b|\\bencuadernad[oa]s?\\b|\\bespiral\\b|\\bspiral\\b|\\bimpreso\\b|\\bimpresion\\b|\\breimpres[oa]\\b|\\bprint on demand\\b|\\bbajo demanda\\b'],
 // Kits y paquetes con componentes no físicos
 ['paquete','\\bpack\\b|\\bkit\\b|\\bbundle\\b|\\bcombo\\b'],
 // Material de curso y de estudio (el de IB Diploma fue marcado como "contenido de curso", 08/11/2026):
 // suelen venir con códigos o plataformas y las editoriales los denuncian.
 ['material_de_curso','\\bdiploma\\b|\\bib\\b|\\bcourse ?books?\\b|\\bcourse\\b|\\bcurso\\b|\\bstudent s book\\b|\\bstudents book\\b|\\bstudent book\\b|\\bworkbook\\b|\\bwork book\\b|\\bteacher s\\b|\\bteachers\\b|\\bteacher\\b|\\blibro del alumno\\b|\\blibro del profesor\\b|\\bcuaderno de ejercicios\\b|\\bguia docente\\b|\\bexam practice\\b|\\bpractice tests?\\b|\\btest prep\\b|\\bsolucionario\\b|\\bsolutions manual\\b|\\bpearson\\b|\\bkerboodle\\b|\\bmylab\\b'],
 // Marcas de entretenimiento y juguetes que denuncian (Disney y Marvel aparecieron en la moderación
 // de la cuenta el 08/11/2026). Los libros sobre esas marcas también se dejan afuera.
 ['marca','\\bdisney\\b|\\bmarvel\\b|\\bpixar\\b|\\bstar wars\\b|\\bdc comics\\b|\\bbatman\\b|\\bsuperman\\b|\\bspider ?man\\b|\\bavengers\\b|\\bpokemon\\b|\\bnintendo\\b|\\bmario bros\\b|\\blego\\b|\\bbarbie\\b|\\bmattel\\b|\\bhasbro\\b|\\bhello kitty\\b|\\bsanrio\\b|\\bpeppa\\b|\\bpaw patrol\\b|\\bfrozen\\b|\\bminecraft\\b|\\bfortnite\\b|\\broblox\\b|\\bnaruto\\b|\\bdragon ball\\b|\\bone piece\\b|\\bfunko\\b|\\bwarner\\b|\\bnetflix\\b'],
];
const COMPILED=IP_RISK_PATTERNS.map(([name,re])=>[name,new RegExp(re)]);

export function normalizeText(text){
 return String(text??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}
// Devuelve el nombre del grupo de riesgo que coincide, o null si el texto está limpio.
export function ipRisk(...texts){
 const text=normalizeText(texts.filter(Boolean).join(' '));
 if(!text)return null;
 for(const [name,re] of COMPILED)if(re.test(text))return name;
 return null;
}
