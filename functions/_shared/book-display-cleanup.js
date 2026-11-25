// Omite marcadores técnicos del proveedor sin inventar una encuadernación.
export function cleanBookFormat(value) {
    const text = String(value ?? '').trim();
    return /^(?:unknown(?: binding)?|desconocid[oa]|no especificad[oa]|n\/a)$/i.test(text) ? '' : text;
}

export function cleanBookDescription(value) {
    const text = String(value ?? '').trim();
    // Esta plantilla importada es una tabla de atributos, no una sinopsis.
    // Los datos comprobados ya se muestran en la ficha de esta edición.
    if (/^Formato\s+Libro f[ií]sico\b/i.test(text) &&
        /Encuadernaci[oó]n\s+Unknown binding\b/i.test(text) &&
        /Isbn13\s+\d{13}\b/i.test(text)) return '';
    return text.replace(/\b(?:Encuadernaci[oó]n|Binding|Formato)\s*:?\s*Unknown binding\b/gi, '')
        .replace(/[ \t]{2,}/g, ' ').trim();
}
