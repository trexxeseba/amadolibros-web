/**
 * functions/montessori.js
 *
 * Redirect 301 permanente: /montessori → /libros-maria-montessori-uruguay
 * Preserva descubribilidad para URLs cortas compartidas.
 */

export async function onRequest() {
    return Response.redirect('https://www.amadolibros.com/libros-maria-montessori-uruguay', 301);
}
