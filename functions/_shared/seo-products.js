const MURDOKU_CANONICAL_PATH =
  '/libro/MLU1416777650/libro-murdoku-80-acertijos-de-logica-y-asesinatos-de-garand-';

export const PRODUCT_ID_REDIRECTS = Object.freeze({
  // Misma edición e ISBN 9791387869380. La URL terminada en 7650 conserva
  // las señales históricas de GSC; 7648 no debe competir con ella.
  MLU1416777648: Object.freeze({
    id: 'MLU1416777650',
    path: MURDOKU_CANONICAL_PATH,
  }),
});

export const PRODUCT_SEO_OVERRIDES = Object.freeze({
  MLU1416777650: Object.freeze({
    title: 'Murdoku en Uruguay: 80 acertijos de lógica',
    description: 'Conseguí Murdoku: 80 acertijos de lógica y asesinatos, de Manuel Garand, en Uruguay. Consultá disponibilidad o pedilo por encargo.',
    indexWhenPaused: true,
    sitemapPath: MURDOKU_CANONICAL_PATH,
    heading: 'Murdoku en Uruguay: verificamos la edición exacta',
    copy: 'Esta ficha corresponde a Murdoku: 80 acertijos de lógica y asesinatos, de Manuel Garand (ISBN 9791387869380). Si no está disponible, consultanos: verificamos esta edición exacta o la buscamos por encargo, con envíos en Montevideo y todo Uruguay.',
  }),
  MLU676002408: Object.freeze({
    title: 'Mientras dormíamos: El engaño maestro, de Giuseppe Nocera',
    description: 'Comprá Mientras dormíamos: El engaño maestro, de Giuseppe Nocera Costabile, en Amado Libros. Precio en UYU y envíos a todo Uruguay.',
  }),
  MLU633445690: Object.freeze({
    title: 'Así fue como llegaste: donación de espermatozoides',
    description: 'Comprá Así fue como llegaste: donación de espermatozoides, de Silvia Jadur y Constanza Duhalde. Envíos a todo Uruguay.',
  }),
  MLU646420175: Object.freeze({
    title: 'Urmah: Los sembradores siderales, de Luis Ángel Loaiza',
    description: 'Comprá Urmah: Los sembradores siderales, de Luis Ángel Loaiza Ferreira, en Uruguay. Consultá precio, stock y forma de entrega.',
  }),
  MLU662039047: Object.freeze({
    title: 'Jujutsu Kaisen 25, de Gege Akutami',
    description: 'Comprá Jujutsu Kaisen tomo 25, de Gege Akutami, en Amado Libros. Precio en UYU, cuotas y envíos a todo Uruguay.',
  }),
  MLU707743600: Object.freeze({
    title: 'Colección Grandes Aventuras y Genios: 11 libros',
    description: 'Comprá la colección Grandes Aventuras y Genios de 11 libros. Consultá disponibilidad, precio en UYU y envíos a todo Uruguay.',
  }),
  MLU626854956: Object.freeze({
    title: 'Amagi, de Sagar Prakash Khatnani: precio en Uruguay',
    description: 'Comprá Amagi, de Sagar Prakash Khatnani, en Amado Libros. Consultá precio en UYU, disponibilidad y envíos en Uruguay.',
  }),
  MLU653980087: Object.freeze({
    title: '¡Qué misterio! Princesas: dibujos para colorear',
    description: 'Consultá por ¡Qué misterio! Princesas, libro de dibujos para colorear de Jeremy Mariez. Podemos verificar stock o buscarlo por encargo.',
  }),
  MLU1467423248: Object.freeze({
    title: 'Más astuto que el diablo, de Napoleon Hill',
    description: 'Comprá Más astuto que el diablo, de Napoleon Hill, en Amado Libros. Precio en UYU, cuotas y envíos a todo Uruguay.',
  }),
  MLU889085304: Object.freeze({
    title: 'Primeros pasos en la clínica psicopedagógica',
    description: 'Comprá Primeros pasos en la clínica psicopedagógica, de Guillermina Ferra. Consultá precio y envíos en Uruguay.',
  }),
  MLU696157645: Object.freeze({
    title: 'La taza de la mañana: sanación y reflexión diaria',
    description: 'Comprá La taza de la mañana: sanación y reflexión diaria, de Camille J. Sage. Precio en UYU y envíos a todo Uruguay.',
  }),
});

export const INDEXABLE_PAUSED_PRODUCT_PATHS = Object.freeze(
  Object.values(PRODUCT_SEO_OVERRIDES)
    .filter(item => item.indexWhenPaused && item.sitemapPath)
    .map(item => item.sitemapPath),
);
