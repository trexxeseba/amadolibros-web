/**
 * Categorías con landing SEO autorizada.
 *
 * La lista es deliberadamente cerrada: evita convertir automáticamente cada
 * categoría, subcategoría o filtro del catálogo en una URL indexable.
 */
export const SEO_CATEGORIES = [
    {
        id: 'infantil-juvenil',
        name: 'Infantil y juvenil',
        title: 'Libros infantiles y juveniles en Uruguay | Amado Libros',
        h1: 'Libros infantiles y juveniles en Uruguay',
        description: 'Libros infantiles y juveniles disponibles en Uruguay: cuentos, primeras lecturas, actividades y literatura juvenil. Comprá online o pedí títulos por encargo.',
        intro: 'Encontrá cuentos, primeras lecturas, libros de actividades y literatura juvenil para distintas edades. Seleccionamos títulos disponibles en Uruguay y también buscamos por encargo los libros difíciles de ubicar.',
    },
    {
        id: 'esoterismo-tarot',
        name: 'Esoterismo y tarot',
        title: 'Libros de esoterismo y tarot en Uruguay | Amado Libros',
        h1: 'Libros de esoterismo y tarot en Uruguay',
        description: 'Libros de tarot, oráculos, astrología y esoterismo disponibles en Uruguay. Comprá online, consultá stock o pedí ediciones difíciles de conseguir.',
        intro: 'Explorá libros de tarot, oráculos, astrología y otras tradiciones esotéricas. Reunimos opciones disponibles para comprar online y conseguimos ediciones especiales o agotadas por encargo.',
    },
    {
        id: 'medicina-salud',
        name: 'Medicina y salud',
        title: 'Libros de medicina y salud en Uruguay | Amado Libros',
        h1: 'Libros de medicina y salud en Uruguay',
        description: 'Libros de medicina, anatomía, enfermería, nutrición y salud mental disponibles en Uruguay. Textos para estudiantes y profesionales, con envíos a todo el país.',
        intro: 'Consultá libros de medicina, anatomía, enfermería, nutrición y salud mental para estudio, formación y práctica profesional. Si el texto que precisás no está disponible, lo buscamos por encargo.',
    },
    {
        id: 'literatura-ficcion',
        name: 'Literatura y ficción',
        title: 'Libros de literatura y ficción en Uruguay | Amado Libros',
        h1: 'Libros de literatura y ficción en Uruguay',
        description: 'Novelas, cuentos, poesía, policiales, ciencia ficción y fantasía disponibles en Uruguay. Comprá online y recibí en Montevideo o en el interior.',
        intro: 'Descubrí novelas, cuentos, poesía, teatro, policiales, ciencia ficción y fantasía. Nuestro catálogo combina títulos disponibles con un servicio de búsqueda para ediciones difíciles de conseguir.',
    },
    {
        id: 'idiomas-aprendizaje',
        name: 'Idiomas y aprendizaje',
        title: 'Libros para aprender idiomas en Uruguay | Amado Libros',
        h1: 'Libros para aprender idiomas en Uruguay',
        description: 'Libros para aprender inglés y otros idiomas en Uruguay: cursos, gramática, vocabulario y diccionarios. Comprá online o pedí el material que necesitás.',
        intro: 'Encontrá cursos, gramáticas, diccionarios y materiales de vocabulario para aprender inglés y otros idiomas. Trabajamos libros para distintos niveles y conseguimos por encargo materiales específicos.',
    },
    {
        id: 'psicologia',
        name: 'Psicología',
        title: 'Libros de psicología en Uruguay | Amado Libros',
        h1: 'Libros de psicología en Uruguay',
        description: 'Libros de psicología clínica, psicoanálisis, neuropsicología y psicología infantil disponibles en Uruguay. Comprá online o consultá por encargos.',
        intro: 'Reunimos libros de psicología clínica, psicoanálisis, neuropsicología y psicología infantil para estudiantes, profesionales y lectores interesados. También buscamos textos académicos y ediciones agotadas por encargo.',
    },
    {
        id: 'desarrollo-personal',
        name: 'Desarrollo personal',
        title: 'Libros de desarrollo personal en Uruguay | Amado Libros',
        h1: 'Libros de desarrollo personal en Uruguay',
        description: 'Libros de desarrollo personal, hábitos, bienestar y crecimiento disponibles en Uruguay. Comprá online, pagá hasta en 12 cuotas o consultá por encargos.',
        intro: 'Explorá libros sobre hábitos, bienestar, vínculos y crecimiento personal. Mostramos títulos con disponibilidad real y te ayudamos a conseguir por encargo el libro específico que estás buscando.',
    },
    {
        id: 'religion-espiritualidad',
        name: 'Religión y espiritualidad',
        title: 'Libros de religión y espiritualidad en Uruguay | Amado Libros',
        h1: 'Libros de religión y espiritualidad en Uruguay',
        description: 'Biblias y libros de religión, teología y espiritualidad disponibles en Uruguay. Consultá ediciones, comprá online o pedí títulos difíciles de conseguir.',
        intro: 'Consultá Biblias, libros de teología, tradición religiosa y espiritualidad. Indicamos las ediciones disponibles y buscamos por encargo versiones específicas o títulos difíciles de ubicar.',
    },
];

export const SEO_CATEGORY_IDS = new Set(SEO_CATEGORIES.map(category => category.id));

export function findSeoCategory(id) {
    return SEO_CATEGORIES.find(category => category.id === id) || null;
}
