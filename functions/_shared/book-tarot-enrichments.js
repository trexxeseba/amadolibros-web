// TAROT-FICHAS-1
//
// Fichas editoriales de mazos de tarot cuya publicación de Mercado Libre es de
// catálogo y no trae descripción (ni propia ni en la ficha de catálogo). Sin
// este registro salen en la web y en el feed de Merchant con la plantilla
// título/autor/ISBN.
//
// Cada dato sale de la página oficial de la editorial o distribuidora para el
// ISBN exacto. No contiene precio, stock, imágenes ni URL comercial.

const VERIFIED_AT = '2026-11-12';

const TAROT_LINKS = Object.freeze([
  Object.freeze({ href: '/catalogo?q=tarot', label: 'Ver más mazos de tarot disponibles' }),
  Object.freeze({ href: '/catalogo?q=or%C3%A1culo', label: 'Explorar oráculos' }),
]);

function source({ provider, url, isbn, fields, type = 'publisher' }) {
  return Object.freeze({
    type,
    provider,
    url,
    relationship: 'exact_edition',
    isbn,
    verified_at: VERIFIED_AT,
    fields: Object.freeze(fields),
  });
}

function deck({ isbn, sampleListingId, editorial, facts, provenance }) {
  return Object.freeze({
    schema_version: 1,
    isbn,
    sample_listing_id: sampleListingId,
    decision: 'auto_publish',
    verified_at: VERIFIED_AT,
    editorial: Object.freeze({
      ...editorial,
      paragraphs: Object.freeze(editorial.paragraphs),
      highlights: Object.freeze(editorial.highlights),
      links: TAROT_LINKS,
    }),
    facts: Object.freeze({
      ...facts,
      bibliographic: Object.freeze(facts.bibliographic),
    }),
    schema: Object.freeze({ inLanguage: facts.bibliographic.language === 'Inglés' ? 'en' : 'mul' }),
    provenance: Object.freeze(provenance),
  });
}

export const BOOK_TAROT_ENRICHMENTS = Object.freeze([
  deck({
    isbn: '9780738700076',
    sampleListingId: 'MLU635308709',
    editorial: {
      eyebrow: 'Mazo de tarot · Lo Scarabeo',
      heading: 'Qué trae el Universal Tarot de Roberto De Angelis',
      paragraphs: [
        'El Universal Tarot es un mazo de 78 cartas ilustrado por Roberto De Angelis y editado por Lo Scarabeo. Está dibujado siguiendo las indicaciones de Arthur E. Waite, por lo que quien conoce el Rider-Waite reconoce enseguida cada escena, con composiciones más despejadas y un uso cuidado del color.',
        'Reúne todos los elementos del tarot tradicional y funciona tanto para estudiar como para leer. Es una caja con mazo de 2,75 × 4,75 pulgadas (unos 7 × 12 cm). La editorial indica que los folletos de la mayoría de sus mazos vienen en cinco idiomas, entre ellos español.',
      ],
      highlights_heading: 'Características del mazo',
      highlights: [
        '78 cartas: arcanos mayores y menores completos.',
        'Ilustraciones de Roberto De Angelis sobre la tradición Rider-Waite.',
        'Formato de carta de 2,75 × 4,75 pulgadas, aproximadamente 7 × 12 cm.',
        'Editado por Lo Scarabeo y distribuido por Llewellyn.',
      ],
      decision_heading: '¿Para quién es este mazo?',
      decision_copy: 'Es una buena elección para empezar con el tarot y para quien ya lee con Rider-Waite y busca un mazo de trabajo claro, con imágenes familiares y fáciles de interpretar.',
      meta_description: 'Universal Tarot de Roberto De Angelis, Lo Scarabeo: mazo de 78 cartas basado en la tradición Rider-Waite. ISBN 9780738700076. Disponible en Uruguay.',
      merchant_description: 'Universal Tarot, mazo de 78 cartas ilustrado por Roberto De Angelis y editado por Lo Scarabeo. Dibujado según las indicaciones de Arthur E. Waite: conserva las escenas clásicas del Rider-Waite con composiciones despejadas y un uso cuidado del color. Apto para estudio y lectura, tanto para quien empieza como para lectores con experiencia. Cartas de 2,75 × 4,75 pulgadas (unos 7 × 12 cm). ISBN 9780738700076.',
    },
    facts: {
      publisher: 'Lo Scarabeo',
      dimensions_text: 'Caja de 2,75 × 4,75 × 1,19 pulgadas',
      bibliographic: { format: 'Mazo de 78 cartas en caja', publication_year: '2001' },
    },
    provenance: [
      source({
        provider: 'Llewellyn Worldwide',
        url: 'https://www.llewellyn.com/product.php?ean=9780738700076',
        isbn: '9780738700076',
        fields: ['description', 'publisher', 'format', 'publication_year', 'dimensions', 'contents'],
      }),
    ],
  }),
  deck({
    isbn: '9780738759845',
    sampleListingId: 'MLU643231351',
    editorial: {
      eyebrow: 'Mazo de tarot con guía · Llewellyn',
      heading: 'Qué trae el Tarot de la Nuit',
      paragraphs: [
        'Tarot de la Nuit es una creación de Carole-Anne Eschenazi con ilustraciones de la artista francesa Alexandra V. Bach. Su nombre significa "la noche" en francés y propone un recorrido por una oscuridad poderosa, a la luz de la luna, con una estética de misterio y energía femenina.',
        'La caja incluye 78 cartas y una guía de 128 páginas. Es una edición de Llewellyn, publicada en 2018, en formato de caja grande de 3,25 × 5 pulgadas (unos 8 × 13 cm). El mazo fue nominado en los premios CARTA de la International Tarot Foundation en 2019.',
      ],
      highlights_heading: 'Características del mazo',
      highlights: [
        '78 cartas ilustradas por Alexandra V. Bach.',
        'Guía de 128 páginas escrita por Carole-Anne Eschenazi.',
        'Estética nocturna, con atmósfera de cuento gótico y fantasía.',
        'Edición de Llewellyn en caja grande, publicada en 2018.',
      ],
      decision_heading: '¿Para quién es este mazo?',
      decision_copy: 'Es para quien disfruta de los mazos de arte oscuro y evocador y quiere una guía completa para acompañar la lectura. La guía de esta edición está en inglés.',
      meta_description: 'Tarot de la Nuit, de Carole-Anne Eschenazi y Alexandra V. Bach: 78 cartas y guía de 128 páginas. Llewellyn, ISBN 9780738759845. Disponible en Uruguay.',
      merchant_description: 'Tarot de la Nuit, de Carole-Anne Eschenazi con ilustraciones de Alexandra V. Bach. Mazo de 78 cartas con guía de 128 páginas, editado por Llewellyn. Un recorrido por la noche, a la luz de la luna, con una estética de misterio y energía femenina; cada arcano es una pequeña obra de arte. Caja grande de 3,25 × 5 pulgadas (unos 8 × 13 cm). Guía en inglés. ISBN 9780738759845.',
    },
    facts: {
      publisher: 'Llewellyn',
      pages: 128,
      dimensions_text: 'Caja de 3,25 × 5 × 2,05 pulgadas',
      bibliographic: { language: 'Inglés', format: 'Mazo de 78 cartas con guía', publication_year: '2018' },
    },
    provenance: [
      source({
        provider: 'Llewellyn Worldwide',
        url: 'https://www.llewellyn.com/product.php?ean=9780738759845',
        isbn: '9780738759845',
        fields: ['description', 'author', 'publisher', 'pages', 'format', 'publication_year', 'dimensions', 'contents'],
      }),
      source({
        type: 'commercial_reference',
        provider: 'Tarot.nl',
        url: 'https://www.tarot.nl/en/product/tarot-de-la-nuit',
        isbn: '9780738759845',
        fields: ['language', 'pages', 'contents'],
      }),
    ],
  }),
  deck({
    isbn: '9780738744438',
    sampleListingId: 'MLU654142476',
    editorial: {
      eyebrow: 'Mazo de tarot · Lo Scarabeo',
      heading: 'Qué trae el Ceccoli Tarot',
      paragraphs: [
        'El Ceccoli Tarot lleva las ilustraciones de Nicoletta Ceccoli, artista de San Marino reconocida por su estilo de encanto inquietante. El mazo se mueve entre la armonía y la locura y transmite una inocencia extraña, muy propia de su obra.',
        'Son 78 cartas pensadas para mirar preguntas complejas, donde lo oscuro se mezcla con lo luminoso. Edición de Lo Scarabeo publicada en 2014, en caja de 2,75 × 4,75 pulgadas (unos 7 × 12 cm). La editorial indica que los folletos de la mayoría de sus mazos vienen en cinco idiomas, entre ellos español.',
      ],
      highlights_heading: 'Características del mazo',
      highlights: [
        '78 cartas ilustradas por Nicoletta Ceccoli.',
        'Estilo surrealista y onírico, de inocencia inquietante.',
        'Formato de carta de 2,75 × 4,75 pulgadas, aproximadamente 7 × 12 cm.',
        'Editado por Lo Scarabeo y distribuido por Llewellyn.',
      ],
      decision_heading: '¿Para quién es este mazo?',
      decision_copy: 'Es para quien sigue la obra de Nicoletta Ceccoli, para coleccionistas de mazos de autor y para lectores que buscan imágenes sugerentes que inviten a la interpretación intuitiva.',
      meta_description: 'Ceccoli Tarot, de Nicoletta Ceccoli: mazo de 78 cartas de estilo surrealista editado por Lo Scarabeo. ISBN 9780738744438. Disponible en Uruguay.',
      merchant_description: 'Ceccoli Tarot, mazo de 78 cartas con ilustraciones de Nicoletta Ceccoli, editado por Lo Scarabeo. Un tarot de estilo surrealista y onírico que se mueve entre la armonía y la locura, con una inocencia inquietante muy propia de la artista. Pensado para mirar preguntas complejas, donde lo oscuro se mezcla con lo luminoso. Cartas de 2,75 × 4,75 pulgadas (unos 7 × 12 cm). ISBN 9780738744438.',
    },
    facts: {
      publisher: 'Lo Scarabeo',
      dimensions_text: 'Caja de 2,75 × 4,75 × 1,20 pulgadas',
      bibliographic: { format: 'Mazo de 78 cartas en caja', publication_year: '2014' },
    },
    provenance: [
      source({
        provider: 'Llewellyn Worldwide',
        url: 'https://www.llewellyn.com/product.php?ean=9780738744438',
        isbn: '9780738744438',
        fields: ['description', 'author', 'publisher', 'format', 'publication_year', 'dimensions', 'contents'],
      }),
    ],
  }),
  deck({
    isbn: '9781572818033',
    sampleListingId: 'MLU644712147',
    editorial: {
      eyebrow: 'Mazo de tarot en lata · U.S. Games Systems',
      heading: 'Qué trae el Radiant Rider-Waite en lata',
      paragraphs: [
        'El Radiant Rider-Waite toma las ilustraciones originales de Pamela Colman Smith y las presenta con una paleta de colores más viva, que aporta energía y luminosidad a las escenas de siempre. El brillo y el sombreado suave resaltan el simbolismo tradicional que se usa en la lectura.',
        'Esta edición viene en una lata de recuerdo, en tamaño de bolsillo: 78 cartas de 2 × 3,5 pulgadas (unos 5 × 9 cm), con dorso de cielo azul estrellado. Incluye un folleto de instrucciones con introducción de Stuart R. Kaplan. Edición de U.S. Games Systems en inglés.',
      ],
      highlights_heading: 'Características del mazo',
      highlights: [
        '78 cartas con el arte de Pamela Colman Smith recoloreado.',
        'Tamaño de bolsillo: cartas de 2 × 3,5 pulgadas, unos 5 × 9 cm.',
        'Presentado en lata, práctico para llevar y guardar.',
        'Folleto de instrucciones con introducción de Stuart R. Kaplan.',
      ],
      decision_heading: '¿Para quién es este mazo?',
      decision_copy: 'Es ideal para quien quiere el Rider-Waite clásico en un formato chico y resistente para llevar en el bolso, y para quien empieza y prefiere colores vivos y escenas fáciles de leer.',
      meta_description: 'Radiant Rider-Waite Tarot en lata: 78 cartas de bolsillo con el arte de Pamela Colman Smith. U.S. Games, ISBN 9781572818033. Disponible en Uruguay.',
      merchant_description: 'Radiant Rider-Waite Tarot en lata, de U.S. Games Systems. Mazo de 78 cartas de bolsillo con las ilustraciones de Pamela Colman Smith realzadas con una paleta de colores vivos, que resalta el simbolismo tradicional del Rider-Waite. Cartas de 2 × 3,5 pulgadas (unos 5 × 9 cm), dorso de cielo azul estrellado y folleto de instrucciones con introducción de Stuart R. Kaplan. Viene en lata de recuerdo. Edición en inglés. ISBN 9781572818033.',
    },
    facts: {
      publisher: 'U.S. Games Systems',
      dimensions_text: 'Cartas de 2 × 3,5 pulgadas',
      bibliographic: { language: 'Inglés', format: 'Mazo de 78 cartas en lata' },
    },
    provenance: [
      source({
        provider: 'U.S. Games Systems',
        url: 'https://www.usgamesinc.com/radiant-rider-waite-in-a-tin.html',
        isbn: '9781572818033',
        fields: ['description', 'publisher', 'language', 'format', 'dimensions', 'contents', 'illustrator'],
      }),
    ],
  }),
  deck({
    isbn: '9781646711604',
    sampleListingId: 'MLU793445314',
    editorial: {
      eyebrow: 'Mazo de tarot con guía · U.S. Games Systems',
      heading: 'Qué trae el Black & White Rider-Waite Tarot',
      paragraphs: [
        'El Black & White Rider-Waite Tarot presenta el dibujo de línea y los títulos escritos a mano que Pamela Colman Smith creó en 1909, sin color. Al quedar el trazo limpio, se aprecian detalles del arte original que en las versiones coloreadas pasan más inadvertidos.',
        'Son 78 cartas sin borde, con acabado de lino y cantos en lámina negra, de 2,75 × 4,72 pulgadas (unos 7 × 12 cm). Lo acompaña una guía de 54 páginas escrita por Jody Boginski Barbessi, con significados al derecho y al revés e ideas de tiradas. Edición de U.S. Games Systems en inglés.',
      ],
      highlights_heading: 'Características del mazo',
      highlights: [
        '78 cartas sin borde con el dibujo original de Pamela Colman Smith.',
        'Acabado de lino y cantos en lámina negra.',
        'Guía de 54 páginas con significados al derecho y al revés.',
        'Cartas de 2,75 × 4,72 pulgadas, aproximadamente 7 × 12 cm.',
      ],
      decision_heading: '¿Para quién es este mazo?',
      decision_copy: 'Es para coleccionistas del Rider-Waite y para lectores que buscan una versión sobria y elegante del mazo más conocido, que además combina bien con otros mazos y oráculos.',
      meta_description: 'Black & White Rider-Waite Tarot: 78 cartas sin borde, acabado de lino, cantos negros y guía de 54 páginas. ISBN 9781646711604. Disponible en Uruguay.',
      merchant_description: 'Black & White Rider-Waite Tarot, de U.S. Games Systems. Mazo de 78 cartas sin borde con el dibujo de línea y los títulos a mano que Pamela Colman Smith creó en 1909, en blanco y negro. Acabado de lino y cantos en lámina negra. Incluye guía de 54 páginas de Jody Boginski Barbessi con significados al derecho y al revés e ideas de tiradas. Cartas de 2,75 × 4,72 pulgadas (unos 7 × 12 cm). Edición en inglés. ISBN 9781646711604.',
    },
    facts: {
      publisher: 'U.S. Games Systems',
      pages: 54,
      dimensions_text: 'Cartas de 2,75 × 4,72 pulgadas',
      bibliographic: { language: 'Inglés', format: 'Mazo de 78 cartas con guía' },
    },
    provenance: [
      source({
        provider: 'U.S. Games Systems',
        url: 'https://www.usgamesinc.com/black-and-white-rider-waite-tarot-deck',
        isbn: '9781646711604',
        fields: ['description', 'author', 'publisher', 'pages', 'language', 'format', 'dimensions', 'contents', 'illustrator'],
      }),
    ],
  }),
  deck({
    isbn: '9781572818774',
    sampleListingId: 'MLU794511038',
    editorial: {
      eyebrow: 'Mazo de tarot en lata · U.S. Games Systems',
      heading: 'Qué trae el Barbara Walker Tarot en lata',
      paragraphs: [
        'El Barbara Walker Tarot propone una mirada feminista del tarot, que honra las enseñanzas de la Triple Diosa. Las figuras de la corte representan dioses y diosas de mitologías de todo el mundo, y los colores dominantes son el rojo, el negro y el blanco, asociados a la Doncella, la Madre y la Anciana.',
        'Es un mazo clásico con pinturas originales de Barbara G. Walker. En los arcanos menores, el significado de cada carta se resume en una palabra clave impresa arriba, con el título tradicional abajo. Incluye 78 cartas de bolsillo de 2,30 × 3,70 pulgadas (unos 6 × 9,5 cm) y un folleto de 48 páginas, en lata. Edición en inglés.',
      ],
      highlights_heading: 'Características del mazo',
      highlights: [
        '78 cartas de bolsillo con pinturas originales de Barbara G. Walker.',
        'Palabra clave impresa en cada arcano menor.',
        'Figuras de la corte inspiradas en mitologías de todo el mundo.',
        'Folleto de 48 páginas y lata para guardar el mazo.',
      ],
      decision_heading: '¿Para quién es este mazo?',
      decision_copy: 'Es para quien se interesa por la mitología, el simbolismo y la tradición de la Diosa, y para lectores que valoran tener una palabra clave a la vista en cada arcano menor.',
      meta_description: 'Barbara Walker Tarot en lata: 78 cartas de bolsillo, palabras clave y folleto de 48 páginas. U.S. Games, ISBN 9781572818774. Disponible en Uruguay.',
      merchant_description: 'Barbara Walker Tarot en lata, de U.S. Games Systems. Mazo clásico de 78 cartas de bolsillo con pinturas originales de Barbara G. Walker y una mirada feminista del tarot que honra a la Triple Diosa. Las figuras de la corte representan dioses y diosas de mitologías de todo el mundo, y cada arcano menor lleva una palabra clave impresa. Incluye folleto de 48 páginas. Cartas de 2,30 × 3,70 pulgadas (unos 6 × 9,5 cm). Edición en inglés. ISBN 9781572818774.',
    },
    facts: {
      publisher: 'U.S. Games Systems',
      pages: 48,
      dimensions_text: 'Cartas de 2,30 × 3,70 pulgadas',
      bibliographic: { language: 'Inglés', format: 'Mazo de 78 cartas en lata' },
    },
    provenance: [
      source({
        provider: 'U.S. Games Systems',
        url: 'https://www.usgamesinc.com/barbara-walker-in-a-tin.html',
        isbn: '9781572818774',
        fields: ['description', 'author', 'publisher', 'pages', 'language', 'format', 'dimensions', 'contents'],
      }),
    ],
  }),
  deck({
    isbn: '9781572818804',
    sampleListingId: 'MLU693687666',
    editorial: {
      eyebrow: 'Mazo de tarot en lata · U.S. Games Systems',
      heading: 'Qué trae el Tarot de Maria Celia',
      paragraphs: [
        'El Tarot de Maria Celia es la propuesta del artista Lynyrd-Jym Narciso para actualizar el Tarot de Marsella. Se inspira en varias versiones del estilo marsellés tradicional y suma rasgos propios: una paleta de colores pastel y detalles de aire antiguo.',
        'Siguiendo la tradición europea, los títulos de las cartas están en francés. Es un mazo de bolsillo de 80 cartas que viene en lata, con un folleto de instrucciones de 56 páginas que incluye pautas para leer con mazos de Marsella. Edición de U.S. Games Systems; el folleto está en inglés.',
      ],
      highlights_heading: 'Características del mazo',
      highlights: [
        '80 cartas de bolsillo en estilo Marsella actualizado.',
        'Ilustraciones de Lynyrd-Jym Narciso en tonos pastel.',
        'Títulos de las cartas en francés, como en la tradición europea.',
        'Folleto de 56 páginas y lata para guardar el mazo.',
      ],
      decision_heading: '¿Para quién es este mazo?',
      decision_copy: 'Es para quien lee o quiere aprender a leer con Tarot de Marsella y busca una versión de trazo claro y colores suaves, en un formato chico para llevar.',
      meta_description: 'Tarot de Maria Celia, de Lynyrd-Jym Narciso: 80 cartas de bolsillo en estilo Marsella, en lata. U.S. Games, ISBN 9781572818804. Disponible en Uruguay.',
      merchant_description: 'Tarot de Maria Celia, de Lynyrd-Jym Narciso, editado por U.S. Games Systems. Una versión actualizada del Tarot de Marsella, inspirada en varias variantes del estilo tradicional, con paleta de colores pastel y detalles de aire antiguo. Los títulos de las cartas están en francés. Mazo de bolsillo de 80 cartas en lata, con folleto de instrucciones de 56 páginas en inglés. ISBN 9781572818804.',
    },
    facts: {
      publisher: 'U.S. Games Systems',
      pages: 56,
      bibliographic: { language: 'Inglés', format: 'Mazo de 80 cartas en lata' },
    },
    provenance: [
      source({
        provider: 'U.S. Games Systems',
        url: 'https://www.usgamesinc.com/Tarot-de-Maria-Celia.html',
        isbn: '9781572818804',
        fields: ['description', 'author', 'publisher', 'pages', 'format', 'contents'],
      }),
      source({
        type: 'commercial_reference',
        provider: 'ThriftBooks',
        url: 'https://www.thriftbooks.com/w/tarot-de-maria-celia/24770078',
        isbn: '9781572818804',
        fields: ['description', 'pages', 'language', 'contents'],
      }),
    ],
  }),
]);
