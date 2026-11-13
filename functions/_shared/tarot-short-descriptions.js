// Descripciones breves de mazos de tarot sin ficha editorial en el registro.
// Cada texto se limita a lo que confirman la publicación y la página de la
// editorial o fabricante (tipo de mazo, cantidad de cartas, medidas, autoría).
// Sin precio, stock ni datos de envío. Se usa solo si el catálogo no trae
// una descripción propia y el ISBN/EAN no tiene ficha editorial.

const SHORT = Object.freeze({
  // Tarot of the Druids, Lo Scarabeo (loscarabeo.com): 78 cartas, 66 x 120 mm.
  '9788883953538': 'Tarot de los Druidas, mazo de 78 cartas de 66 x 120 mm de Lo Scarabeo. Texto de Bepi Vigna e ilustraciones de Severino Baraldi y Antonio Lupatelli, con una mirada al mundo de los druidas celtas. Edición multilingüe con folleto de instrucciones.',
  // Fournier, Tarot de Marsella.
  '8420707089085': 'Tarot de Marsella de Naipes Heraclio Fournier, mazo completo de 78 cartas con 22 arcanos mayores y 56 arcanos menores. Una baraja clásica para estudiar y leer el tarot en su tradición marsellesa.',
  // Fournier, Tarot Español.
  '8420707089016': 'Tarot Español de Naipes Heraclio Fournier, baraja clásica de la línea de tarots de la casa. Mazo en edición multilingüe pensado para la lectura del tarot.',
  // Alchemy 1977 (título de la publicación: libro + cartas, folleto multilingüe).
  '8420707417208': 'Tarot Alchemy 1977, mazo de tarot con folleto multilingüe. Una edición para quienes buscan una baraja de diseño particular para lectura y colección.',
  // Tarot de los Ángeles (publicación: libro de instrucciones en español).
  '8420707305710': 'Tarot de los Ángeles, mazo de cartas de Lo Scarabeo con libro de instrucciones en español. Una baraja pensada para la lectura del tarot con imágenes angelicales.',
  // Gothic Tarot, colección Anne Stokes (publicación: 78 cartas + libro).
  '8420707415907': 'Gothic Tarot de la colección Anne Stokes, mazo de 78 cartas con libro. Ilustraciones de la artista Anne Stokes, de estética gótica, para lectura y colección.',
  // El Tarot del Sueño Cósmico, Guy Trédaniel, edición en español.
  '9782813226426': 'El Tarot del Sueño Cósmico de Tillie Walden, cartas y libro en español de la editorial Guy Trédaniel. Una baraja de tarot de ilustración artística, con guía para su lectura.',
  // El Tarot Dorado Real, Guy Trédaniel (Marchetti y Moore).
  '9782813227744': 'El Tarot Dorado Real de Ciro Marchetti, con texto de Barbara Moore, en edición en español de la editorial Guy Trédaniel. Mazo de 78 cartas con libro, de ilustración digital detallada.',
});

export function getTarotShortDescription(isbn) {
  const key = String(isbn || '').replace(/[^0-9X]/gi, '');
  return SHORT[key] || null;
}
