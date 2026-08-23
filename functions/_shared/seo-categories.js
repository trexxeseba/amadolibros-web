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
        name: 'Tarot y oráculos',
        title: 'Tarot y oráculos en Uruguay | Mazos y libros | Amado Libros',
        h1: 'Tarot, oráculos y libros de esoterismo en Uruguay',
        description: 'Mazos de tarot, oráculos y libros de esoterismo disponibles en Uruguay. Compará el tipo de producto, idioma y edición antes de comprar o pedir por encargo.',
        intro: 'Encontrá mazos de tarot, oráculos y libros para estudiar cada sistema. La ficha de cada producto identifica la edición y sus características cuando esos datos están disponibles; también buscamos títulos y mazos difíciles de conseguir por encargo.',
        about: ['Tarot', 'Cartas de oráculo', 'Libros de esoterismo'],
        buyerGuide: {
            title: 'Cómo elegir un tarot, un oráculo o un libro de estudio',
            intro: 'Antes de comprar, identificá exactamente qué contiene la edición. No todos los productos de esta categoría son mazos ni todos usan el mismo sistema.',
            points: [
                {
                    title: 'Tipo de producto',
                    text: 'Comprobá si es un mazo, un libro o un conjunto de mazo más guía. La ficha sólo muestra esa clasificación cuando está identificada.',
                },
                {
                    title: 'Sistema',
                    text: 'Tarot, oráculo, Lenormand y Kipper son sistemas distintos. Elegí por el sistema indicado por la propia edición, no sólo por la imagen de tapa.',
                },
                {
                    title: 'Idioma y guía',
                    text: 'Revisá el idioma de las cartas y del manual, y si la edición informa que incluye guía o instructivo.',
                },
                {
                    title: 'Edición física',
                    text: 'Compará editorial, ISBN, formato y medidas cuando estén disponibles. Si falta un dato decisivo, consultanos antes de comprar.',
                },
            ],
            serviceNote: 'Amado Libros ayuda a identificar y conseguir la edición correcta. No ofrece lecturas de tarot ni interpreta el contenido del mazo.',
        },
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
        name: 'Biblias, religión y espiritualidad',
        title: 'Biblias y libros de religión en Uruguay | Amado Libros',
        h1: 'Biblias y libros de religión en Uruguay',
        description: 'Biblias Reina-Valera, Biblias católicas y libros de religión disponibles en Uruguay. Compará versión, letra, formato y encuadernación o consultá por encargos y pedidos para iglesias.',
        intro: 'Elegí la edición por sus datos concretos: traducción o versión, tamaño de letra, formato, encuadernación, índices y materiales adicionales cuando estén identificados. También buscamos Biblias y libros de religión difíciles de conseguir por encargo.',
        about: ['Biblia', 'Reina-Valera 1960', 'Biblia católica', 'Libros de religión'],
        buyerGuide: {
            title: 'Cómo elegir una Biblia por la edición',
            intro: 'Dos Biblias pueden compartir el texto bíblico y ser productos físicos muy distintos. Para comprar correctamente, compará la edición concreta.',
            points: [
                {
                    title: 'Traducción o versión',
                    text: 'Identificá si buscás Reina-Valera 1960, otra revisión o una edición católica. Amado informa la versión declarada por la edición, sin recomendar una interpretación doctrinal.',
                },
                {
                    title: 'Letra y tamaño',
                    text: 'Letra grande, tamaño compacto y Biblia de estudio describen características diferentes. Revisá letra, medidas, peso y cantidad de páginas cuando estén informados.',
                },
                {
                    title: 'Encuadernación y ayudas',
                    text: 'Confirmá tapa, cierre, índice, concordancia y mapas sólo cuando la ficha de esa edición los declare. Si falta un atributo importante, consultanos.',
                },
                {
                    title: 'Regalo o pedido institucional',
                    text: 'Podemos preparar presentación, accesorios y lotes para iglesias o congregaciones. El cliente aporta cualquier texto religioso personalizado.',
                },
            ],
            serviceNote: 'En determinadas Biblias con stock puede haber entrega express de aproximadamente 2 horas en Montevideo, según zona, horario y disponibilidad. El 12% menos por transferencia se aplica cuando corresponda.',
        },
    },
];

export const SEO_CATEGORY_IDS = new Set(SEO_CATEGORIES.map(category => category.id));

export function findSeoCategory(id) {
    return SEO_CATEGORIES.find(category => category.id === id) || null;
}
