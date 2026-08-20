// FICHAS-VIDRIERA-1: contenido editorial y bibliografía verificada por edición.
// Cada override se aplica a un único MLU + ISBN. No reemplaza precio, stock,
// condición, imágenes ni datos comerciales provenientes de Mercado Libre.

const PADRES_FUERTES = Object.freeze({
  h1: 'Padres fuertes, hijas felices',
  subtitle: '10 secretos que todo padre debería conocer',
  eyebrow: 'Guía práctica sobre el vínculo entre padres e hijas',
  summary: Object.freeze([
    'Padres fuertes, hijas felices es una guía de Meg Meeker para padres que quieren construir una relación cercana, firme y confiable con sus hijas. Desde su experiencia como pediatra y consejera familiar, la autora analiza cómo la presencia cotidiana, el afecto, los límites y el ejemplo del padre pueden influir en la seguridad personal y el equilibrio emocional de una hija.',
    'El libro recorre situaciones concretas de la infancia, la adolescencia y el comienzo de la vida adulta. Aborda la comunicación, la autoestima, la presión social, las decisiones de riesgo y la forma en que una hija aprende a relacionarse con los demás. El foco no está en controlar cada paso, sino en ofrecer una referencia estable: escuchar, acompañar, sostener límites razonables y estar disponible cuando aparecen dudas o conflictos.',
    'Meeker no propone un padre perfecto ni una receta idéntica para todas las familias. Su planteo es práctico: revisar hábitos, reconocer errores y fortalecer el vínculo a través de acciones consistentes. Es una lectura útil para quienes buscan herramientas claras para comprender mejor a sus hijas y ejercer una paternidad más presente, afectuosa y responsable.',
  ]),
  highlights: Object.freeze([
    'Cómo fortalecer la confianza y la comunicación entre padre e hija.',
    'Qué peso tienen la presencia, el ejemplo y los límites en la autoestima.',
    'Cómo acompañar la adolescencia sin perder cercanía ni autoridad.',
    'Qué conversaciones conviene sostener sobre decisiones, riesgos y relaciones.',
    'Ideas prácticas para reparar o profundizar un vínculo que necesita más atención.',
  ]),
  audience: 'Especialmente recomendado para padres de niñas y adolescentes. También puede resultar valioso para madres, cuidadores, educadores y profesionales interesados en los vínculos familiares y el desarrollo emocional.',
  authorBio: 'Meg Meeker es pediatra, consejera familiar y autora especializada en crianza, adolescencia y relaciones entre padres e hijos. Su trabajo combina experiencia clínica con orientación práctica para familias.',
  editionFacts: Object.freeze([
    Object.freeze({ label: 'Autora', value: 'Meg Meeker' }),
    Object.freeze({ label: 'Subtítulo', value: '10 secretos que todo padre debería conocer' }),
    Object.freeze({ label: 'Editorial', value: 'Ciudadela Libros' }),
    Object.freeze({ label: 'Colección', value: 'Vida práctica' }),
    Object.freeze({ label: 'ISBN-13', value: '9788496836693' }),
    Object.freeze({ label: 'ISBN-10', value: '849683669X' }),
    Object.freeze({ label: 'Edición', value: '3.ª edición' }),
    Object.freeze({ label: 'Publicación', value: '1 de julio de 2010' }),
    Object.freeze({ label: 'Páginas', value: '248' }),
    Object.freeze({ label: 'Encuadernación', value: 'Tapa blanda / rústica' }),
    Object.freeze({ label: 'Idioma', value: 'Español; original en inglés' }),
    Object.freeze({ label: 'Traducción', value: 'Mariano José Vázquez Alonso' }),
    Object.freeze({ label: 'Título original', value: 'Strong Fathers, Strong Daughters' }),
    Object.freeze({ label: 'Medidas editoriales', value: '24 × 16 × 1,8 cm' }),
  ]),
  links: Object.freeze([
    Object.freeze({ href: '/catalogo?q=meg%20meeker', label: 'Ver otros libros de Meg Meeker' }),
    Object.freeze({ href: '/libros/desarrollo-personal', label: 'Explorar desarrollo personal y familia' }),
  ]),
  schema: Object.freeze({
    name: 'Padres fuertes, hijas felices',
    alternateName: 'Padres fuertes, hijas felices: 10 secretos que todo padre debería conocer',
    description: 'Guía de Meg Meeker sobre cómo fortalecer el vínculo entre padres e hijas mediante presencia, comunicación, afecto, ejemplo y límites consistentes.',
    isbn: '9788496836693',
    numberOfPages: 248,
    inLanguage: 'es',
    bookFormat: 'https://schema.org/Paperback',
    bookEdition: '3.ª edición',
    datePublished: '2010-07-01',
    genre: 'Paternidad y maternidad: consejos y temas',
    publisher: Object.freeze({ '@type': 'Organization', name: 'Ciudadela Libros' }),
    translator: Object.freeze({ '@type': 'Person', name: 'Mariano José Vázquez Alonso' }),
  }),
});

export const PRODUCT_SHOWCASE_OVERRIDES = Object.freeze({
  MLU633557235: PADRES_FUERTES,
});
