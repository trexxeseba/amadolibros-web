// Enriquecimientos editoriales reales: contenido útil para decidir, SEO y Merchant.
// Cada afirmación debe quedar vinculada a la edición exacta o a la edición fuente
// identificada expresamente. No contiene precio, stock, imágenes ni URL comercial.
// `seo_title` repite el título comercial byte por byte: los términos SEO nuevos
// entran en el cuerpo, subtítulos, meta description y Merchant, nunca en títulos.

export const BOOK_EDITORIAL_UPGRADES = Object.freeze([
  Object.freeze({
    schema_version: 1,
    isbn: '9791388034435',
    sample_listing_id: 'MLU1453287196',
    decision: 'auto_publish',
    verified_at: '2026-08-31',
    editorial: Object.freeze({
      quality_level: 'editorial_real_v1',
      seo_title: 'Grandes Clasicos Tomo 11 Disney Pixar para Colorear',
      eyebrow: 'Libro para colorear por números · Disney y Pixar',
      heading: 'Qué contiene Grandes Clásicos tomo 11 de Disney y Pixar',
      paragraphs: Object.freeze([
        'Esta edición en castellano reúne 100 ilustraciones misteriosas inspiradas en películas de Disney y Pixar. Cada lámina se resuelve coloreando números y zonas según un código de color: la escena escondida aparece a medida que se completan las casillas. No es un cuaderno de coloreado libre, sino una actividad guiada de gran formato pensada para dedicar tiempo a cada imagen.',
        'El recorrido incluye personajes y momentos de Frozen, Encanto, Enredados, Los Aristogatos, 101 Dálmatas y La Bella y la Bestia, entre otros clásicos. Varias composiciones ocupan doble página. La edición española tiene 128 páginas, admite lápices de colores y rotuladores y forma parte de la colección Hachette Heroes – Disney – Arteterapia.',
      ]),
      highlights_heading: 'Cómo funciona y qué incluye',
      highlights: Object.freeze([
        '100 ilustraciones misteriosas de grandes clásicos de Disney y Pixar.',
        'Sistema de coloreado por números y códigos de color para revelar cada escena.',
        'Películas como Frozen, Encanto, Enredados, Los Aristogatos, 101 Dálmatas y La Bella y la Bestia.',
        'Numerosas composiciones a doble página y nivel de detalle pensado para una actividad prolongada.',
        'Papel preparado para trabajar con lápices de colores y rotuladores.',
      ]),
      decision_heading: '¿Para quién está recomendado?',
      decision_copy: 'Está recomendado para fans de Disney y Pixar, coleccionistas de la serie Dibujos para colorear, ¡qué misterio! y personas jóvenes o adultas que disfrutan actividades creativas guiadas y detalladas. También funciona como regalo para quien busca una propuesta de relajación y arteterapia. No es la mejor opción para quien prefiere dibujos simples de coloreado libre: el sistema por números requiere atención y paciencia.',
      meta_description: 'Libro para colorear por números Disney y Pixar, tomo 11: 100 dibujos misteriosos, códigos de color, escenas a doble página y 128 páginas.',
      merchant_description: 'Libro para colorear por números Disney y Pixar: Dibujos para colorear, ¡qué misterio! Grandes Clásicos, tomo 11. Incluye 100 ilustraciones misteriosas de Frozen, Encanto, Enredados, Los Aristogatos, 101 Dálmatas, La Bella y la Bestia y otros clásicos. Se completa siguiendo números y códigos de color, con escenas a doble página. Edición en castellano de Hachette Heroes, tapa blanda y 128 páginas.',
      links: Object.freeze([
        Object.freeze({ href: '/catalogo?q=Disney%20Pixar', label: 'Ver otros libros de Disney y Pixar' }),
        Object.freeze({ href: '/catalogo?q=colorear', label: 'Explorar libros para colorear' }),
      ]),
    }),
    facts: Object.freeze({
      publisher: 'Hachette Heroes',
      pages: 128,
      dimensions_text: '22 × 30,5 × 1,3 cm · 657 g',
      bibliographic: Object.freeze({
        language: 'Castellano',
        format: 'Tapa blanda',
        edition: '1.ª edición española',
        publication_year: '2026',
        publication_date: '2026-06-18',
        collection: 'Hachette HEROES – Disney – Arteterapia',
        translator: 'Servei Gràfic NJR',
        illustrator: 'Jérémy Mariez',
        genre: 'Libro de colorear por números · Arteterapia',
        subjects: Object.freeze([
          'Disney y Pixar',
          'Colorear por números',
          'Códigos de color',
          'Actividades creativas',
          'Arteterapia',
        ]),
      }),
    }),
    schema: Object.freeze({
      inLanguage: 'es',
      bookFormat: 'https://schema.org/Paperback',
      bookEdition: '1.ª edición española',
      datePublished: '2026-06-18',
      genre: 'Libro de colorear por números y arteterapia',
    }),
    provenance: Object.freeze([
      Object.freeze({
        type: 'commercial_reference',
        provider: 'Casa del Libro',
        url: 'https://www.casadellibro.com/libro-dibujos-para-colorear-que-misterio-grandes-clasicos-tomo-11-arte-terapia/9791388034435/18055107',
        relationship: 'exact_edition',
        isbn: '9791388034435',
        verified_at: '2026-08-31',
        fields: Object.freeze([
          'description', 'pages', 'language', 'format', 'publication_year',
          'publication_date', 'collection', 'dimensions', 'weight', 'translator',
        ]),
      }),
      Object.freeze({
        type: 'commercial_reference',
        provider: 'Librería Proteo',
        url: 'https://www.libreriaproteo.com/libro/ver/4248897-dibujos-para-colorear-que-misterio-grandes-clasicos-tomo-11.html',
        relationship: 'exact_edition',
        isbn: '9791388034435',
        verified_at: '2026-08-31',
        fields: Object.freeze([
          'description', 'publisher', 'pages', 'format', 'translator', 'contents',
        ]),
      }),
      Object.freeze({
        type: 'publisher',
        provider: 'Hachette Heroes',
        url: 'https://www.hachetteheroes.com/produit/85114/9782017256953/',
        relationship: 'source_edition',
        isbn: '9782017256953',
        verified_at: '2026-08-31',
        fields: Object.freeze([
          'contents', 'method', 'tools', 'audience', 'illustrator', 'pages', 'format',
        ]),
      }),
    ]),
  }),
]);
