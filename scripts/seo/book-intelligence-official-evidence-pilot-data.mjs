// FICHAS-VIDRIERA-2 / OFFICIAL-EVIDENCE-PILOT-1
//
// Snapshot manual, pequeño y auditable, de evidencia primaria/curada encontrada
// para ISBN con demanda GSC. NO contiene sinopsis copiadas: sólo hechos cortos,
// temas neutrales derivados de la fuente y la URL que permite revalidarlos.
//
// Reglas:
// - `publisher` / `author_site` sólo cuando el dominio es de la editorial o el autor;
// - `distributor` para libreros/distribuidores externos aunque el ISBN sea exacto;
// - una edición distinta conserva SU ISBN real o null; nunca hereda el ISBN objetivo;
// - los datos físicos sólo pertenecen a registros con ISBN exacto;
// - este archivo alimenta investigación offline, no el renderer público.

const VERIFIED_AT = '2026-08-22';

function freezeRecords(records) {
  return Object.freeze(records.map(record => Object.freeze({
    verified_at: VERIFIED_AT,
    ...record,
    topics: Object.freeze([...(record.topics || [])]),
  })));
}

export const OFFICIAL_EVIDENCE_BY_ISBN = Object.freeze({
  // Murdoku — ficha oficial Temas de Hoy / PlanetadeLibros, ISBN exacto.
  '9791387869380': freezeRecords([
    {
      source: 'publisher',
      source_provider: 'planetadelibros_temas_de_hoy',
      source_url: 'https://www.planetadelibros.com/libro-murdoku-80-acertijos-de-logica-y-asesinatos/426932',
      isbn: '9791387869380',
      title: 'Murdoku: 80 acertijos de lógica y asesinatos',
      author: 'Manuel Garand',
      publisher: 'Temas de Hoy',
      pages: 208,
      language: 'es',
      format: 'Rústica con solapas',
      publication_year: '2025',
      topics: [
        'acertijos de lógica',
        'misterios detectivescos',
        'sudokus',
        'resolución de crímenes',
        'desafíos mentales',
      ],
    },
  ]),

  // SOPICIDIOS 1 — sitio oficial del autor/proyecto. No expone ISBN en página,
  // por lo que deliberadamente queda como evidencia de OBRA, no de edición.
  '9798181647725': freezeRecords([
    {
      source: 'author_site',
      source_provider: 'sopicidios_daniel_vergel',
      source_url: 'https://sopicidios.com/pages/sopicidios-1',
      isbn: null,
      title: 'SOPICIDIOS',
      author: 'Daniel Vergel',
      topics: [
        'sopas de letras',
        'misterios criminales',
        'deducción',
        'dificultad progresiva',
        'casos para resolver',
        'pasatiempos para adultos',
      ],
      audience: 'Lectores de misterio, novela negra y pasatiempos de deducción.',
    },
  ]),

  // 30 Chispas — una edición Jojmá de la misma obra + distribuidor argentino
  // exacto para el ISBN objetivo. La edición Jojmá conserva su ISBN diferente.
  '9789878629933': freezeRecords([
    {
      source: 'publisher',
      source_provider: 'jojma_ediciones',
      source_url: 'https://jojmalibros.com/libro/30-chispas-de-luz-reflexiones-cabalisticas-para-el-dia-a-dia/',
      isbn: '9788494017513',
      title: '30 Chispas de luz',
      author: 'Mario Javier Sabán',
      publisher: 'Jojmá Ediciones',
      pages: 129,
      publication_year: '2019',
      topics: [
        'Cábala aplicada',
        'autoconocimiento',
        'conciencia',
        'meditación',
        'amor',
        'crecimiento espiritual',
      ],
    },
    {
      source: 'distributor',
      source_provider: 'ediciones_continente',
      source_url: 'https://www.edicontinente.com.ar/tpl_libro_item_detail.php?id=SAB038',
      isbn: '9789878629933',
      title: '30 Chispas de Luz. Reflexiones cabalísticas para el día a día',
      author: 'Mario Javier Sabán',
      publisher: 'Editorial Saban',
      pages: 132,
      language: 'es',
      format: 'Rústica con solapa',
      publication_year: '2020',
      topics: [
        'Cábala',
        'judaísmo',
        'espiritualidad cotidiana',
        'potencial humano',
      ],
    },
  ]),

  // My Hero Academia 42 cofre — Planeta aporta contenido de obra/edición especial,
  // Norma confirma el ISBN y los hechos físicos; no se usa su sinopsis como una
  // segunda fuente semántica para fabricar GREEN.
  '9791387781323': freezeRecords([
    {
      source: 'publisher',
      source_provider: 'planeta_comic',
      source_url: 'https://proapi.planetadelibros.com/descargas/sala-prensa-libro/sinopsis-y-biografia/428522/my-hero-academia-n-42-edicion-especial-cofre.pdf?_locale=es',
      isbn: null,
      title: 'My Hero Academia 42 edición especial cofre',
      author: 'Kohei Horikoshi',
      publisher: 'Planeta Cómic',
      publication_year: '2025',
      topics: [
        'cierre de la serie',
        'escuela de héroes',
        'amistad y apoyo',
        'sueños y futuro',
        'edición especial con extras',
      ],
    },
    {
      source: 'distributor',
      source_provider: 'norma_comics',
      source_url: 'https://www.normacomics.com/my-hero-academia-42-edicion-especial-cofre.html',
      isbn: '9791387781323',
      title: 'My Hero Academia 42 edición especial cofre',
      author: 'Kohei Horikoshi',
      publisher: 'Planeta Cómic',
      pages: 184,
      publication_year: '2025',
      format: 'Cofre edición especial',
      topics: [],
    },
  ]),

  // Bisounours — ficha oficial Hachette exacta. El autor compatible permite
  // resolver el falso conflicto de identidad del único registro Google exacto.
  '9782017312703': freezeRecords([
    {
      source: 'publisher',
      source_provider: 'hachette_heroes',
      source_url: 'https://www.hachette.fr/livre/coloriages-mysteres-bisounours-9782017312703/',
      isbn: '9782017312703',
      title: 'Coloriages mystères - Bisounours',
      author: 'Eugénie Varone',
      publisher: 'Hachette Heroes',
      pages: 112,
      language: 'fr',
      format: 'Grand format broché',
      publication_year: '2025',
      topics: [
        'coloriage par numéros',
        'Bisounours',
        '50 coloriages mystères',
        'loisir créatif',
        'papier premium',
      ],
      audience: 'Fans de coloriage y del universo Bisounours de distintas edades.',
    },
  ]),

  // El Legado — Básquet Plus declara ser editor del libro y publica una
  // entrevista original extensa al autor sobre el contenido y la construcción.
  '9789878675701': freezeRecords([
    {
      source: 'publisher',
      source_provider: 'basquet_plus',
      source_url: 'https://www.basquetplus.com/node/67934',
      isbn: null,
      title: 'El Legado',
      author: 'Germán Beder',
      publisher: 'Básquet Plus',
      topics: [
        'selección argentina de básquetbol',
        'Mundial de China 2019',
        'recambio generacional',
        'testimonios de jugadores',
        'liderazgo y presión deportiva',
        'crónica desde adentro',
      ],
    },
  ]),

  // La jubilación — sitio oficial del autor, centrado en este libro y su
  // investigación con 150 jubilados. Work-level: no inventa ISBN ni páginas.
  '9788416894864': freezeRecords([
    {
      source: 'author_site',
      source_provider: 'bartolome_freire',
      source_url: 'https://www.bartolomefreire.es/la-jubilacion-una-nueva-oportunidad/',
      isbn: null,
      title: 'La jubilación, una nueva oportunidad',
      author: 'Bartolomé Freire',
      topics: [
        'transición a la jubilación',
        'identidad después del trabajo',
        'gestión del tiempo',
        'pareja y familia',
        'estrategias de adaptación',
        'sentido personal de la nueva etapa',
      ],
    },
  ]),
});

export const OFFICIAL_EVIDENCE_PILOT_ISBNS = Object.freeze(
  Object.keys(OFFICIAL_EVIDENCE_BY_ISBN),
);

export function officialEvidenceForIsbn(isbn) {
  return OFFICIAL_EVIDENCE_BY_ISBN[String(isbn || '').replace(/[^0-9Xx]/g, '')] || Object.freeze([]);
}
