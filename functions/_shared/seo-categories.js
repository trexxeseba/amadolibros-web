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
        id: 'esoterismo-tarot/mazos',
        classificationId: 'tarot-oraculos',
        parentId: 'esoterismo-tarot',
        parentName: 'Tarot y oráculos',
        kind: 'tarot-decks',
        tarotFilter: 'verified-tarot-decks',
        name: 'Mazos de tarot',
        title: 'Mazos de Tarot Uruguay | Entrega hoy | Amado Libros',
        h1: 'Mazos de tarot en Uruguay con entrega hoy en Montevideo',
        description: 'Mazos de tarot disponibles en Uruguay con stock real, entrega en el día coordinada en Montevideo, envío a $250 y atención personalizada para elegir la edición correcta.',
        intro: 'Compará mazos físicos de tarot disponibles ahora: sistema, idioma, cantidad de cartas, guía incluida y edición. Coordinamos entrega en el día en Montevideo según zona y horario, y te ayudamos personalmente a confirmar que sea el mazo que buscás.',
        about: ['Mazo de tarot', 'Tarot Rider-Waite-Smith', 'Tarot de Marsella', 'Tarot Thoth'],
        buyerGuide: {
            title: 'Cómo elegir un mazo de tarot sin equivocarte de edición',
            intro: 'La ilustración de la caja no alcanza para identificar un mazo. Antes de comprar, revisá el sistema, el contenido físico, el idioma y la edición exacta.',
            points: [
                {
                    title: 'Sistema del mazo',
                    text: 'Rider-Waite-Smith, Marsella y Thoth tienen estructuras e imágenes distintas. La ficha sólo declara el sistema cuando está verificado.',
                },
                {
                    title: 'Cartas y contenido',
                    text: 'Confirmá la cantidad de cartas y si el producto incluye libro, guía breve o solamente el mazo. No lo inferimos por la fotografía de portada.',
                },
                {
                    title: 'Idioma',
                    text: 'Revisá por separado el idioma de las cartas y el del manual. Algunas ediciones importadas combinan cartas sin texto con una guía en otro idioma.',
                },
                {
                    title: 'Editorial e identificador',
                    text: 'Usá editorial, ISBN, EAN o GTIN para distinguir reimpresiones y formatos. Si falta un dato decisivo, lo verificamos antes de la compra.',
                },
            ],
            serviceNote: 'Te ayudamos a comparar ediciones y a encontrar un mazo específico. Amado Libros vende productos; no realiza lecturas ni interpretaciones de tarot.',
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
        id: 'psicologia/psicoanalisis',
        classificationId: 'psicoanalisis',
        parentId: 'psicologia',
        parentName: 'Psicología',
        kind: 'knowledge-hub',
        name: 'Psicoanálisis',
        title: 'Libros de psicoanálisis en Uruguay | Amado Libros',
        h1: 'Libros de psicoanálisis en Uruguay',
        description: 'Libros de psicoanálisis disponibles en Uruguay: Freud, Lacan, escuelas, clínica y teoría. Comprá online o pedí textos profesionales por encargo.',
        intro: 'Explorá obras de teoría y clínica psicoanalítica, autores clásicos y desarrollos contemporáneos. La selección se basa en la materia declarada del libro y queda preparada para sumar guías editoriales y artículos con fuentes revisadas.',
        about: ['Psicoanálisis', 'Sigmund Freud', 'Jacques Lacan'],
        buyerGuide: {
            title: 'Cómo ubicar el texto de psicoanálisis que necesitás',
            intro: 'Antes de elegir, diferenciá una obra fundacional, un comentario teórico y un texto de práctica clínica. El título, el autor y la edición ayudan a evitar compras equivocadas.',
            points: [
                { title: 'Autor y escuela', text: 'Freud, Lacan y otras tradiciones usan marcos distintos. Confirmá el autor, la escuela y el propósito de lectura.' },
                { title: 'Edición y traducción', text: 'En textos clásicos, la editorial, la traducción y el tomo pueden cambiar el contenido disponible.' },
            ],
        },
    },
    {
        id: 'psicologia/psicomotricidad',
        classificationId: 'psicomotricidad',
        parentId: 'psicologia',
        parentName: 'Psicología',
        kind: 'knowledge-hub',
        name: 'Psicomotricidad',
        title: 'Libros de psicomotricidad en Uruguay | Amado Libros',
        h1: 'Libros de psicomotricidad en Uruguay',
        description: 'Libros de psicomotricidad, desarrollo, evaluación e intervención disponibles en Uruguay para estudiantes y profesionales. Comprá online o pedí por encargo.',
        intro: 'Encontrá bibliografía de psicomotricidad para formación y práctica profesional. Separamos esta materia de la psicología clínica general y dejamos el espacio preparado para incorporar artículos documentados y novedades editoriales.',
        about: ['Psicomotricidad', 'Desarrollo psicomotor'],
        buyerGuide: {
            title: 'Cómo elegir bibliografía de psicomotricidad',
            intro: 'El nivel académico, la población y el enfoque de trabajo determinan qué libro resulta útil. Revisá esos datos antes de comprar.',
            points: [
                { title: 'Formación o práctica', text: 'Diferenciá manuales introductorios, marcos teóricos, evaluación e intervención profesional.' },
                { title: 'Etapa y contexto', text: 'Confirmá si la obra trabaja primera infancia, edad escolar, adolescencia, adultez o un contexto educativo o clínico específico.' },
            ],
        },
    },
    {
        id: 'psicologia/autismo',
        classificationId: 'autismo-neurodesarrollo',
        parentId: 'psicologia',
        parentName: 'Psicología',
        kind: 'knowledge-hub',
        name: 'Autismo y neurodesarrollo',
        title: 'Libros sobre autismo en Uruguay | Amado Libros',
        h1: 'Libros sobre autismo y neurodesarrollo en Uruguay',
        description: 'Libros sobre autismo y neurodesarrollo disponibles en Uruguay para familias, estudiantes y profesionales. Comprá online o pedí bibliografía por encargo.',
        intro: 'Reunimos libros sobre autismo y neurodesarrollo según la materia declarada por cada obra. La colección distingue bibliografía profesional y divulgativa, y queda preparada para sumar artículos actualizados con autor, fecha y fuentes.',
        about: ['Autismo', 'Neurodesarrollo'],
        buyerGuide: {
            title: 'Cómo elegir un libro sobre autismo',
            intro: 'No todos los libros tienen el mismo público ni propósito. Identificar el enfoque evita mezclar material académico, guías para familias y propuestas educativas.',
            points: [
                { title: 'Público lector', text: 'Confirmá si está dirigido a familias, docentes, estudiantes, profesionales o lectores generales.' },
                { title: 'Propósito y edición', text: 'Revisá si es una introducción, una guía práctica o bibliografía profesional, además de su fecha y edición.' },
            ],
            serviceNote: 'La selección es bibliográfica y comercial; no reemplaza orientación profesional ni ofrece recomendaciones clínicas.',
        },
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
        title: 'Biblia Reina Valera Uruguay | Entrega hoy | Amado Libros',
        h1: 'Biblias Reina Valera en Uruguay con entrega hoy en Montevideo',
        description: 'Biblias Reina Valera disponibles en Uruguay con stock real, entrega en el día coordinada en Montevideo, envío a $250 y atención personalizada para comparar ediciones.',
        intro: 'Compará Biblias Reina Valera por revisión, tamaño de letra, ayudas de estudio, encuadernación e ISBN. Coordinamos entrega en el día en Montevideo según zona y horario, y verificamos personalmente la edición antes de la compra.',
    },
];

export const SEO_CATEGORY_IDS = new Set(SEO_CATEGORIES.map(category => category.id));

export function findSeoCategory(id) {
    return SEO_CATEGORIES.find(category => category.id === id) || null;
}
