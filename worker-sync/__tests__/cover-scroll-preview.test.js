import test from 'node:test';
import assert from 'node:assert/strict';
import preview from '../cover-scroll-preview.js';

const env = { SCROLL_EXPIRES_AT: String(Date.now() + 60_000), INCIDENT_TOKEN: 'test-only-secret',
    ACCEPTANCE_NAME: 'amado-cover-index-123-1', INCIDENT_BUILD_SHA: 'test-head' };
const execution = { waitUntil() {} };

test('public browser cannot invoke preparation, snapshot or cleanup APIs', async () => {
    for (const path of ['/prepare', '/manifest', '/cleanup', '/ready', '/index-state', '/written-manifest']) {
        for (const method of ['GET', 'POST', 'DELETE']) {
            const response = await preview.fetch(new Request(`https://qa.example${path}`, { method }), env, execution);
            assert.ok([404, 405].includes(response.status), `${method} ${path}`);
        }
    }
    const authorized = await preview.fetch(new Request('https://qa.example/ready', {
        headers: { authorization: `Bearer ${env.INCIDENT_TOKEN}` },
    }), env, execution);
    assert.equal(authorized.status, 200);
    assert.deepEqual(await authorized.json(), { head: 'test-head' });
});

test('expired public preview fails closed while authenticated cleanup remains usable', async () => {
    const expired = { ...env, SCROLL_EXPIRES_AT: '1' };
    assert.equal((await preview.fetch(new Request('https://qa.example/libros/psicologia'), expired, execution)).status, 410);
    const authorized = await preview.fetch(new Request('https://qa.example/ready', {
        headers: { authorization: `Bearer ${env.INCIDENT_TOKEN}` },
    }), expired, execution);
    assert.equal(authorized.status, 200);
});

test('responsive preview rejects external and arbitrary source paths before image/R2 access', async () => {
    for (const path of [
        '/resize/width=360,fit=scale-down/https://example.org/private',
        '/resize/width=360,fit=scale-down/book-cover/../../manifest.json',
        '/resize/width=99999,fit=scale-down/book-cover/MLU123/cover.jpg',
        '/resize/width=360,fit=crop/book-cover/MLU123/cover.jpg',
    ]) {
        const response = await preview.fetch(new Request(`https://qa.example${path}`), env, execution);
        assert.ok([400, 404].includes(response.status), path);
    }
});
