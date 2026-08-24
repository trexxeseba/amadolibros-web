import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, validateClassification, normalizeText, REVIEW_THRESHOLD } from '../classify.js';
import { CATEGORY_IDS, TYPES, isValidSubcategoryId } from '../taxonomy.js';

test('un mismo MLU produce un único resultado (determinístico)', () => {
  const record = { mlu: 'MLU1', title: 'Tarot De Los Ángeles', author: '', publisher: '', isbn: '123', status: 'active' };
  const a = classify(record);
  const b = classify(record);
  assert.deepEqual(a, b);
});

test('solo devuelve categorías autorizadas', () => {
  const record = { mlu: 'MLU2', title: 'Historia Del Uruguay', author: 'Ian Kershaw', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.ok(CATEGORY_IDS.has(result.primaryCategoryId));
});

test('CF-CATEGORÍAS-2C: ningún activo queda sin categoría — primaryCategoryId nunca es null', () => {
  const casos = [
    { mlu: 'MLU3', title: 'Candelabro Bronce Antiguo Decorativo', author: '', publisher: 'Genérica', isbn: '', status: 'active' },
    { mlu: 'MLU4', title: 'xkzq blorp fnarp', author: '', publisher: '', isbn: '', status: 'active' },
    { mlu: 'MLU5', title: 'Cualquier título sin señal alguna', author: '', publisher: '', isbn: '', status: 'active' },
  ];
  for (const c of casos) {
    const result = classify(c);
    assert.notEqual(result.primaryCategoryId, null, `MLU ${c.mlu} quedó sin categoría`);
    assert.ok(CATEGORY_IDS.has(result.primaryCategoryId));
  }
});

test('un objeto de colección va a otros-productos con subcategoría, visible, no excluido', () => {
  const record = { mlu: 'MLU3b', title: 'Candelabro Bronce Antiguo Decorativo', author: '', publisher: 'Genérica', isbn: '', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.OBJECT);
  assert.equal(result.primaryCategoryId, 'otros-productos');
  assert.equal(result.subcategoryId, 'objetos-coleccion');
});

test('un disco/CD va a otros-productos > discos-vinilos con type music', () => {
  const record = { mlu: 'MLU3c', title: 'Vinilo Pink Floyd The Dark Side Of The Moon', author: '', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.MUSIC);
  assert.equal(result.primaryCategoryId, 'otros-productos');
  assert.equal(result.subcategoryId, 'discos-vinilos');
});

test('una revista va a otros-productos > revistas con type magazine', () => {
  const record = { mlu: 'MLU3d', title: 'Revista Patrones 421 Mayo 2021', author: '', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.MAGAZINE);
  assert.equal(result.primaryCategoryId, 'otros-productos');
  assert.equal(result.subcategoryId, 'revistas');
});

test('sin evidencia de materia pero con autor/ISBN cae en otros-libros (libro real, categoría genérica)', () => {
  const record = { mlu: 'MLU4b', title: 'xkzq blorp fnarp', author: '', publisher: '', isbn: '9781234567890', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.BOOK);
  assert.equal(result.primaryCategoryId, 'otros-libros');
  assert.equal(result.needsReview, true);
});

test('sin autor, sin ISBN y sin ninguna señal cae en otros-productos (type other), nunca null', () => {
  const record = { mlu: 'MLU4c', title: 'xkzq blorp fnarp', author: '', publisher: '', isbn: '', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.OTHER);
  assert.equal(result.primaryCategoryId, 'otros-productos');
});

test('autor reconocido clasifica como libro con alta confianza y subcategoría de autor son sub null', () => {
  const record = { mlu: 'MLU5b', title: 'Cualquier título', author: 'Judith Butler', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.BOOK);
  assert.equal(result.primaryCategoryId, 'filosofia-ciencias-sociales');
  assert.ok(result.confidence >= 0.9);
  assert.equal(result.needsReview, false);
});

test('frase de título distintiva (tarot) asigna categoría y subcategoría', () => {
  const record = { mlu: 'MLU6', title: 'Mazo De Tarot Egipcio', author: '', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.BOOK);
  assert.equal(result.primaryCategoryId, 'esoterismo-tarot');
  assert.equal(result.subcategoryId, 'tarot-oraculos');
});

test('subcategoría siempre pertenece a la categoría principal declarada', () => {
  const titulos = [
    { title: 'Novela Policial De Suspenso', author: '', isbn: '1' },
    { title: 'Biblia De Estudio', author: '', isbn: '1' },
    { title: 'Manual De Psicoanálisis Lacaniano', author: '', isbn: '1' },
  ];
  for (const t of titulos) {
    const result = classify({ mlu: 'MLUx', ...t, publisher: '', status: 'active' });
    assert.ok(isValidSubcategoryId(result.primaryCategoryId, result.subcategoryId),
      `subcategoría ${result.subcategoryId} inválida para ${result.primaryCategoryId}`);
  }
});

test('una palabra corta y genérica sola no decide categoría específica de golpe', () => {
  const record = { mlu: 'MLU7', title: 'Un libro de nada en particular', author: '', publisher: '', isbn: '', status: 'active' };
  const result = classify(record);
  // Sin autor/isbn y sin señal real, cae en el último recurso (otros-productos).
  assert.equal(result.primaryCategoryId, 'otros-productos');
});

test('objeto con señal débil pero con autor e ISBN se prioriza como libro (otros-libros), no objeto', () => {
  // "espada" es señal de objeto (OBJECT_SIGNALS) pero no coincide con
  // ninguna keyword de categoría — aísla el caso "ambiguo con evidencia".
  const record = { mlu: 'MLU8', title: 'El Ladrón Y La Espada Encantada', author: 'Autor Real Conocido', publisher: '', isbn: '9781234567890', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.BOOK);
  assert.equal(result.primaryCategoryId, 'otros-libros');
  assert.equal(result.needsReview, true);
});

test('corrección manual gana siempre, incluso contra una regla fuerte', () => {
  const record = { mlu: 'MLU9', title: 'Cualquier título', author: 'Judith Butler', publisher: '', isbn: '1', status: 'active' };
  const correction = { type: 'book', primaryCategoryId: 'historia', subcategoryId: null, secondaryCategoryIds: [], tags: [], note: 'corrección de prueba' };
  const result = classify(record, correction);
  assert.equal(result.primaryCategoryId, 'historia');
  assert.equal(result.method, 'manual');
  assert.equal(result.confidence, 1);
  assert.equal(result.needsReview, false);
});

test('un CD con palabra de categoría en el título no se clasifica como libro de esa categoría', () => {
  const record = { mlu: 'MLU10', title: 'Vox Dei La Biblia Cd Nuevo Estándar', author: '', publisher: 'AMADO LIBROS', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.equal(result.type, TYPES.MUSIC);
  assert.equal(result.primaryCategoryId, 'otros-productos');
});

test('un workbook de inglés con CD de audio no se clasifica como música (encontrado en QA)', () => {
  const record = { mlu: 'MLU10b', title: 'Impact 2b Workbook Split Con Cd', author: '', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.notEqual(result.type, TYPES.MUSIC);
  assert.equal(result.primaryCategoryId, 'idiomas-aprendizaje');
});

test('"cd" como substring dentro de otra palabra no dispara falso positivo de objeto', () => {
  const record = { mlu: 'MLU11', title: 'Manual De Acdc Y Otras Bandas', author: 'Autor Real', publisher: '', isbn: '9781234567890', status: 'active' };
  const result = classify(record);
  assert.notEqual(result.type, TYPES.MUSIC);
  assert.notEqual(result.type, TYPES.OBJECT);
});

test('categorías secundarias: un título que toca dos temas guarda la segunda como secondaryCategoryIds', () => {
  const record = { mlu: 'MLU12', title: 'Filosofía Y Sociología De La Novela Contemporánea', author: '', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.ok(CATEGORY_IDS.has(result.primaryCategoryId));
  for (const sec of result.secondaryCategoryIds) assert.ok(CATEGORY_IDS.has(sec));
});

test('tags incluye el autor cuando está presente', () => {
  const record = { mlu: 'MLU13', title: 'Cualquier título', author: 'Judith Butler', publisher: '', isbn: '1', status: 'active' };
  const result = classify(record);
  assert.ok(result.tags.includes('Judith Butler'));
});

test('validateClassification detecta primaryCategoryId inválido', () => {
  const bad = { type: TYPES.BOOK, primaryCategoryId: 'categoria-inventada', subcategoryId: null, secondaryCategoryIds: [] };
  const errors = validateClassification(bad);
  assert.ok(errors.length > 0);
});

test('validateClassification detecta primaryCategoryId null', () => {
  const bad = { type: TYPES.OTHER, primaryCategoryId: null, subcategoryId: null, secondaryCategoryIds: [] };
  const errors = validateClassification(bad);
  assert.ok(errors.some(e => e.includes('null')));
});

test('validateClassification detecta subcategoría que no pertenece a la categoría', () => {
  const bad = { type: TYPES.BOOK, primaryCategoryId: 'derecho', subcategoryId: 'novela', secondaryCategoryIds: [] };
  const errors = validateClassification(bad);
  assert.ok(errors.some(e => e.includes('subcategoryId') || e.includes('no pertenece')));
});

test('normalizeText quita acentos y normaliza espacios', () => {
  assert.equal(normalizeText('Educación Física'), 'educacion fisica');
});

test('REVIEW_THRESHOLD está definido y es coherente con el umbral usado', () => {
  assert.equal(typeof REVIEW_THRESHOLD, 'number');
  assert.ok(REVIEW_THRESHOLD > 0 && REVIEW_THRESHOLD < 1);
});

test('QA religión: Messi "El Dios" va a Deportes > Fútbol, no a Religión', () => {
  const result = classify({
    mlu: 'MLU652656116',
    title: 'Messi, por amor a la camiseta. El Dios',
    author: 'Pasman, Juan Carlos',
    publisher: '',
    isbn: '9789507544255',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'deportes');
  assert.equal(result.subcategoryId, 'futbol');
});

test('QA religión: Sabiduría de los psicópatas va a Psicología por autor verificado', () => {
  const result = classify({
    mlu: 'MLU707190270',
    title: 'La Sabiduría de los Psicópatas',
    author: 'Dutton, Kevin',
    publisher: '',
    isbn: '9788408294672',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'psicologia');
});

test('QA religión: Tolstói no entra por la palabra genérica sabiduría', () => {
  const result = classify({
    mlu: 'MLU1183119300',
    title: 'Un Año de Sabiduría',
    author: 'Tolstói, Lev',
    publisher: '',
    isbn: '9798242179523',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'filosofia-ciencias-sociales');
});

test('QA religión: Louise Hay va a Desarrollo personal, no por sabiduría a Religión', () => {
  const result = classify({
    mlu: 'MLU660545320',
    title: '64 Cartas de Sabiduría',
    author: 'Louise L. Hay',
    publisher: '',
    isbn: '9788484455349',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'desarrollo-personal');
});

test('QA religión: Solo por Hoy de NAWS va a Desarrollo personal', () => {
  const result = classify({
    mlu: 'MLU717742182',
    title: 'Solo Por Hoy Adictos Recuperación Narcóticos Anónimos',
    author: 'NAWS',
    publisher: '',
    isbn: '9781557762528',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'desarrollo-personal');
});

test('QA religión: Kebra Nagast se separa de Biblias como otra tradición religiosa', () => {
  const result = classify({
    mlu: 'MLU711624600',
    title: 'Kebra Nagast',
    author: 'Mazzoni, Lorenzo',
    publisher: '',
    isbn: '9781793013040',
    status: 'active',
  }, {
    mlu: 'MLU711624600',
    type: 'book',
    primaryCategoryId: 'religion-espiritualidad',
    subcategoryId: 'otras-tradiciones',
    secondaryCategoryIds: [],
    tags: ['Rastafari', 'Etiopía'],
  });
  assert.equal(result.primaryCategoryId, 'religion-espiritualidad');
  assert.equal(result.subcategoryId, 'otras-tradiciones');
});

test('QA religión: Astrología Kabbalística va a Esoterismo > Cábala', () => {
  const result = classify({
    mlu: 'MLU707790092',
    title: 'Astrología Kabbalística',
    author: 'Rav Berg',
    publisher: '',
    isbn: '9781571893048',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'esoterismo-tarot');
  assert.equal(result.subcategoryId, 'cabala-kabbalah');
});

test('QA Biblias: Reina-Valera obtiene su subcategoría incluso con autor reconocido', () => {
  const result = classify({
    mlu: 'MLU1201985260',
    title: 'Santa Biblia Reina Valera 1960 Letra Grande Con Cierre',
    author: 'Reina Valera',
    publisher: '',
    isbn: '9780000000000',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'religion-espiritualidad');
  assert.equal(result.subcategoryId, 'reina-valera');
});

test('QA autores: un nombre parcial no suplanta una señal de autor más específica', () => {
  const result = classify({
    mlu: 'MLU614544321',
    title: 'Práctica Psicomotriz en el Tratamiento Psíquico',
    author: 'José Rodríguez',
    publisher: '',
    isbn: '9780000000001',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'psicologia');
  assert.equal(result.subcategoryId, 'psicologia-clinica');
});

test('QA Sufismo: Idries Shah obtiene una sección propia, no Biblia', () => {
  const result = classify({
    mlu: 'MLU688184434',
    title: 'La Sabiduría de los Idiotas Idries Shah',
    author: 'IDRIES SHAH',
    publisher: '',
    isbn: '9781784799502',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'esoterismo-tarot');
  assert.equal(result.subcategoryId, 'sufismo');
});

test('QA cómics: God of War no entra en Religión por la palabra dios', () => {
  const result = classify({
    mlu: 'MLU625778990',
    title: 'God of War 2. El Dios Caído',
    author: 'CHRIS ROBERSON',
    publisher: 'Norma Editorial',
    isbn: '9788467949124',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'comics-manga');
});

test('QA naturaleza: una obra zoológica puede quedar separada de Caballos', () => {
  const result = classify({
    mlu: 'MLU828407348',
    title: 'Hermano Animal',
    author: 'Karl König',
    publisher: 'Antroposófica',
    isbn: '9789876820868',
    status: 'active',
  }, {
    mlu: 'MLU828407348',
    type: 'book',
    primaryCategoryId: 'naturaleza-animales',
    subcategoryId: 'zoologia-animales',
    secondaryCategoryIds: [],
    tags: ['Animales', 'Zoología'],
  });
  assert.equal(result.primaryCategoryId, 'naturaleza-animales');
  assert.equal(result.subcategoryId, 'zoologia-animales');
});

test('QA caballos: un título inequívocamente ecuestre obtiene su subcategoría', () => {
  const result = classify({
    mlu: 'MLU625770700',
    title: '85 Ejercicios de Pista para el Caballo Jinete y Monitor Equitación',
    author: 'Venamore, Sarah',
    publisher: '',
    isbn: '9788479027100',
    status: 'active',
  });
  assert.equal(result.primaryCategoryId, 'naturaleza-animales');
  assert.equal(result.subcategoryId, 'caballos-equitacion');
});
