/**
 * Tipografías del sitio, alojadas en el propio dominio.
 *
 * Antes se pedían al CDN de Bunny Fonts con una hoja de estilos externa que
 * bloqueaba el primer pintado en móvil (~770 ms en Lighthouse). Ahora los
 * woff2 viven en astro-front/public/fonts/ (Astro los copia a dist/fonts/) y
 * los @font-face van en línea en el <head>: no hay ninguna hoja que esperar.
 *
 * Familias y pesos: los mismos que se pedían antes a bunny
 * (playfair-display:700 | inter:400,600,800), subconjuntos latin (todo el
 * español: á, é, ñ, ü, ¿, ¡) y latin-ext (ł, ő, ş, č...), cada uno con su
 * unicode-range, igual que los servía bunny.
 *
 * Los nombres llevan los primeros 8 caracteres del sha256 del archivo: si un
 * día se cambia una fuente, cambia el nombre, y la caché larga e inmutable
 * que aplica functions/_middleware.js a /fonts/*.<hash>.woff2 no sirve la
 * versión vieja.
 *
 * Fuentes con licencia SIL Open Font License 1.1 (Inter: Rasmus Andersson;
 * Playfair Display: Claus Eggers Sørensen).
 */

const UNICODE_RANGES = Object.freeze({
    latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
    // latin-ext: letras como ł, ő, ş o č de nombres de autores. No se
    // precarga: el navegador lo baja solo si la página muestra una de ellas.
    'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
});

export const SITE_FONT_FILES = Object.freeze([
    { family: 'Playfair Display', weight: 700, subset: 'latin', file: '/fonts/playfair-display-latin-700.28453852.woff2', preload: true },
    { family: 'Inter', weight: 400, subset: 'latin', file: '/fonts/inter-latin-400.8909904a.woff2', preload: true },
    { family: 'Inter', weight: 600, subset: 'latin', file: '/fonts/inter-latin-600.f9a06e79.woff2', preload: false },
    { family: 'Inter', weight: 800, subset: 'latin', file: '/fonts/inter-latin-800.a7d0a50f.woff2', preload: false },
    { family: 'Playfair Display', weight: 700, subset: 'latin-ext', file: '/fonts/playfair-display-latin-ext-700.edb9f5d8.woff2', preload: false },
    { family: 'Inter', weight: 400, subset: 'latin-ext', file: '/fonts/inter-latin-ext-400.6744a7f5.woff2', preload: false },
    { family: 'Inter', weight: 600, subset: 'latin-ext', file: '/fonts/inter-latin-ext-600.e4bdf67b.woff2', preload: false },
    { family: 'Inter', weight: 800, subset: 'latin-ext', file: '/fonts/inter-latin-ext-800.eade5559.woff2', preload: false },
]);

export const SITE_FONT_FACES_CSS = SITE_FONT_FILES.map(font =>
    `@font-face{font-family:'${font.family}';font-style:normal;font-weight:${font.weight};font-display:swap;src:url(${font.file}) format('woff2');unicode-range:${UNICODE_RANGES[font.subset]}}`,
).join('');

/**
 * Bloque para el <head>: precarga de las dos fuentes que pinta el primer
 * contenido (títulos en Playfair 700 y cuerpo en Inter 400) y los @font-face
 * en línea. Las otras dos se bajan cuando el navegador las necesita.
 */
export const SITE_FONTS_HEAD = [
    ...SITE_FONT_FILES
        .filter(font => font.preload)
        .map(font => `<link rel="preload" href="${font.file}" as="font" type="font/woff2" crossorigin>`),
    `<style>${SITE_FONT_FACES_CSS}</style>`,
].join('\n  ');
