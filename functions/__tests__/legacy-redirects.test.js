import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequest as redirectLegacyBook365 } from '../365.js';

test('/365 redirige permanentemente a la ficha actual', () => {
    const response = redirectLegacyBook365();

    assert.equal(response.status, 301);
    assert.equal(
        response.headers.get('location'),
        'https://www.amadolibros.com/libro/MLU1330191560/libro-club-de-brujas-mel-knarik-ayelen-romano',
    );
});
