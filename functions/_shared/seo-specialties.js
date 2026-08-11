/**
 * Especialidades con landing SEO autorizada.
 *
 * La lista es deliberadamente corta. Cada página debe responder una intención
 * comercial concreta, mostrar catálogo real y tener contenido propio. No se
 * crean variantes por país hasta que existan precios, pagos y logística
 * internacional específicos para esas variantes.
 */
export const SEO_SPECIALTIES = Object.freeze([
  {
    id: 'medicina',
    name: 'Medicina',
    title: 'Libros de Medicina de España y Latinoamérica | Amado',
    h1: 'Libros de medicina de España y Latinoamérica',
    description: 'Buscá libros de medicina publicados en España y Latinoamérica. Catálogo disponible en Uruguay y búsqueda manual de ediciones técnicas por autor, ISBN o especialidad.',
    audience: 'estudiantes, docentes, residentes y profesionales de la salud',
    intro: 'Reunimos textos de medicina disponibles en Uruguay y buscamos por encargo ediciones publicadas en España, Argentina y otros mercados editoriales. Trabajamos con la referencia exacta para distinguir una edición nueva de una reimpresión y evitar ofrecer un manual desactualizado.',
    topics: ['medicina clínica y diagnóstico', 'anatomía y fisiología', 'farmacología y terapéutica', 'patología', 'especialidades médicas', 'preparación académica y residencia'],
    keywords: ['medicina', 'medico', 'medica', 'anatomia', 'fisiologia', 'farmacologia', 'patologia', 'diagnostico clinico', 'terapeutica'],
    excludeKeywords: ['medicalizacion de', 'anatomia del espiritu'],
  },
  {
    id: 'oftalmologia',
    name: 'Oftalmología',
    title: 'Libros de Oftalmología de España y Latinoamérica | Amado',
    h1: 'Libros de oftalmología de España y Latinoamérica',
    description: 'Libros de oftalmología, retina, córnea, glaucoma y optometría. Consultá títulos de España y Latinoamérica, stock en Uruguay o búsqueda por encargo.',
    audience: 'oftalmólogos, residentes, optometristas, docentes y estudiantes',
    intro: 'Buscamos bibliografía de oftalmología por subespecialidad, autor, editorial, ISBN y edición. Podemos revisar catálogos de España, Argentina y otros países cuando el título no está disponible en Uruguay, confirmando siempre idioma, año de edición, formato, precio y plazo antes de cotizar.',
    topics: ['retina y vítreo', 'córnea y superficie ocular', 'glaucoma', 'cirugía ocular', 'diagnóstico por imágenes', 'optometría y baja visión'],
    keywords: ['oftalmologia', 'oftalmologico', 'oftalmologica', 'retina', 'cornea', 'glaucoma', 'optometria', 'refraccion ocular', 'cirugia ocular'],
  },
  {
    id: 'cirugia',
    name: 'Cirugía',
    title: 'Libros de Cirugía de España y Latinoamérica | Amado',
    h1: 'Libros de cirugía de España y Latinoamérica',
    description: 'Libros de cirugía general y especialidades quirúrgicas publicados en España y Latinoamérica. Catálogo en Uruguay y búsqueda manual de ediciones profesionales.',
    audience: 'cirujanos, residentes, instrumentistas, docentes y estudiantes de ciencias de la salud',
    intro: 'La bibliografía quirúrgica cambia según técnica, especialidad y edición. Por eso buscamos la referencia concreta y verificamos si se trata de cirugía general, abordajes mínimamente invasivos, anestesia, cuidados perioperatorios o instrumental, sin presentar una reimpresión como actualización.',
    topics: ['cirugía general', 'técnicas quirúrgicas', 'laparoscopia y cirugía mínimamente invasiva', 'anestesia', 'cuidados perioperatorios', 'instrumentación quirúrgica'],
    keywords: ['cirugia', 'quirurgico', 'quirurgica', 'laparoscopia', 'perioperatorio', 'perioperatoria', 'anestesia', 'instrumental quirurgico'],
  },
  {
    id: 'agricultura',
    name: 'Agricultura',
    title: 'Libros de Agricultura de España y Latinoamérica | Amado',
    h1: 'Libros de agricultura de España y Latinoamérica',
    description: 'Libros de agricultura, cultivos, suelos, riego y maquinaria agrícola de España y Latinoamérica. Comprá en Uruguay o pedí una búsqueda técnica por encargo.',
    audience: 'productores, técnicos rurales, ingenieros agrónomos, docentes y estudiantes',
    intro: 'Seleccionamos y buscamos bibliografía agrícola según cultivo, sistema productivo y nivel técnico. Consultamos ediciones de España, Argentina y otros mercados latinoamericanos, aclarando cuando una norma, producto fitosanitario o práctica depende del país de publicación.',
    topics: ['cultivos y producción vegetal', 'suelos y fertilidad', 'riego', 'sanidad vegetal', 'horticultura y fruticultura', 'maquinaria y agricultura sostenible'],
    keywords: ['agricultura', 'agronomia', 'agricola', 'cultivo', 'suelos', 'riego', 'fitosanitaria', 'horticultura', 'fruticultura', 'citricultura', 'agroecologia'],
  },
  {
    id: 'electrotecnia',
    name: 'Electrotecnia',
    title: 'Libros de Electrotecnia de España y Latinoamérica | Amado',
    h1: 'Libros de electrotecnia de España y Latinoamérica',
    description: 'Libros de electrotecnia, instalaciones, máquinas eléctricas y automatización publicados en España y Latinoamérica. Catálogo en Uruguay y encargos técnicos.',
    audience: 'técnicos, instaladores, ingenieros, docentes y estudiantes',
    intro: 'Buscamos manuales y textos de electrotecnia por tema, nivel, autor, editorial o ISBN. Antes de ofrecer una edición verificamos el país y el año, porque la normativa eléctrica, las unidades y los criterios de instalación pueden variar entre España, Uruguay y otros países latinoamericanos.',
    topics: ['instalaciones eléctricas', 'circuitos y medidas', 'máquinas eléctricas', 'automatización industrial', 'protecciones y tableros', 'seguridad y normativa'],
    keywords: ['electrotecnia', 'instalaciones electricas', 'maquinas electricas', 'circuitos electricos', 'electricidad industrial', 'automatizacion industrial', 'tableros electricos', 'alta tension'],
  },
]);

export const SEO_SPECIALTY_IDS = new Set(SEO_SPECIALTIES.map(item => item.id));

export function findSeoSpecialty(id) {
  return SEO_SPECIALTIES.find(item => item.id === id) || null;
}

export function specialtyPath(id) {
  return `/especialidades/${id}`;
}

export function normalizeSpecialtyText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function isSpecialtyMatch(item, specialty) {
  const haystack = normalizeSpecialtyText([
    item?.title,
    item?.author,
  ].filter(Boolean).join(' '));
  const padded = ` ${haystack.replace(/[^a-z0-9]+/g, ' ').trim()} `;
  const containsKeyword = keyword => padded.includes(` ${normalizeSpecialtyText(keyword).replace(/[^a-z0-9]+/g, ' ').trim()} `);
  if ((specialty.excludeKeywords || []).some(containsKeyword)) return false;
  return specialty.keywords.some(containsKeyword);
}

function isbnKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 || digits.length === 13 ? digits : '';
}

export function dedupeSpecialtyItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const isbn = isbnKey(item?.isbn);
    const title = normalizeSpecialtyText(item?.title).replace(/[^a-z0-9]+/g, ' ').trim();
    const author = normalizeSpecialtyText(item?.author).replace(/[^a-z0-9]+/g, ' ').trim();
    const key = isbn ? `isbn:${isbn}` : (title && author ? `title-author:${title}|${author}` : '');
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
