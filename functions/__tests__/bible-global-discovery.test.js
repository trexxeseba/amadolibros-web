import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FOOTER_LINKS, footerHtml } from '../_shared/brand.js';

const astroFooter = readFileSync(
    fileURLToPath(new URL('../../astro-front/src/components/Footer.astro', import.meta.url)),
    'utf8',
);

const expected = [
    { href: '/libros/biblias', label: 'Biblias en Uruguay' },
    { href: '/libros/biblias/reina-valera', label: 'Biblias Reina-Valera' },
];

test('las landings bíblicas prioritarias reciben enlaces internos globales y rastreables', () => {
    const ssrFooter = footerHtml(2026);

    for (const link of expected) {
        assert.deepEqual(
            FOOTER_LINKS.find(entry => entry.href === link.href),
            link,
        );
        assert.match(astroFooter, new RegExp(`<a href="${link.href}">${link.label}</a>`));
        assert.match(ssrFooter, new RegExp(`<a href="${link.href}">${link.label}</a>`));
    }
});

test('los enlaces bíblicos no dependen de filtros ni JavaScript', () => {
    for (const { href } of expected) {
        assert.ok(href.startsWith('/libros/'));
        assert.doesNotMatch(href, /[?#]/);
    }
});
