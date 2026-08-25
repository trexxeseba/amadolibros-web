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
        excludedClassificationIds: ['biblia', 'reina-valera'],
        name: 'Religión y espiritualidad',
        title: 'Libros de religión y espiritualidad en Uruguay | Amado Libros',
        h1: 'Libros de religión y espiritualidad en Uruguay',
        description: 'Libros de religión, teología, tradición religiosa y espiritualidad disponibles en Uruguay. Comprá online o pedí títulos difíciles de conseguir por encargo.',
        intro: 'Consultá libros de teología, tradición religiosa y espiritualidad disponibles en Uruguay. Las Biblias tienen una colección propia para que puedas comparar ediciones sin mezclarlas con el resto de la categoría.',
    },
    {
        id: 'biblias',
        classificationIds: ['biblia', 'reina-valera'],
        parentId: 'religion-espiritualidad',
        parentName: 'Religión y espiritualidad',
        kind: 'bibles',
        name: 'Biblias',
        title: 'Biblias en Uruguay | Ediciones, Reina-Valera y católicas | Amado Libros',
        h1: 'Biblias en Uruguay: ediciones para comparar y comprar',
        description: 'Biblias disponibles en Uruguay: Reina-Valera, ediciones católicas, de estudio, letra grande, infantiles y para regalo. Compará la edición y consultá stock real.',
        intro: 'Elegí una Biblia por traducción, tamaño de letra, tipo de estudio y formato. Mostramos únicamente ejemplares con stock real y también buscamos por encargo una edición o ISBN específico.',
    },
    {
        id: 'biblias/reina-valera',
        classificationId: 'reina-valera',
        parentId: 'biblias',
        parentName: 'Biblias',
        kind: 'reina-valera',
        name: 'Reina-Valera',
        title: 'Biblia Reina-Valera en Uruguay | RVR 1960 y ediciones | Amado Libros',
        h1: 'Biblia Reina-Valera en Uruguay',
        description: 'Biblias Reina-Valera disponibles en Uruguay: RVR 1960 y otras ediciones, letra grande, estudio y distintos formatos. Compará datos y consultá stock real.',
        intro: 'Encontrá Biblias Reina-Valera y distinguí la revisión, el tamaño de letra, las ayudas de estudio y la encuadernación antes de comprar. Si buscás una edición exacta, la verificamos por ISBN.',
    },
];

export const SEO_CATEGORY_IDS = new Set(SEO_CATEGORIES.map(category => category.id));

export function findSeoCategory(id) {
    return SEO_CATEGORIES.find(category => category.id === id) || null;
}
