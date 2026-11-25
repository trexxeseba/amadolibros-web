import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createContactValidation, contactValidation } from '../../shared/contact-validation.js';

test('contact syntax accepts local and international customers without accepting junk', () => {
    for (const phone of ['099 123 456', '99123456', '2900 1234', '4732 1234', '+598 99 123 456', '59899123456', '00598 99 123 456', '+54 9 11 1234 5678', '+34 612 345 678']) {
        assert.equal(contactValidation.validPhone(phone), true, phone);
    }
    for (const phone of ['', 'abc', '123', '000000000', '11111111', '099 123', '+598 123', '99abc123456', '++59899123456', '099\n123456', null, 99123456]) {
        assert.equal(contactValidation.validPhone(phone), false, String(phone));
    }
    assert.deepEqual(contactValidation.replyContact(' Nombre@dominio.com '), { type: 'email', value: 'nombre@dominio.com' });
    assert.equal(contactValidation.replyContact('nombre@dominio'), null);
    assert.equal(contactValidation.replyContact('abc'), null);
});

test('the exact browser factory works without server imports', () => {
    const browser = vm.runInNewContext('(' + createContactValidation.toString() + ')()');
    for (const value of ['099123456', '+598 99 123 456', 'abc', '123', 'test@example.com']) {
        assert.equal(browser.validPhone(value), contactValidation.validPhone(value));
        assert.equal(JSON.stringify(browser.replyContact(value)), JSON.stringify(contactValidation.replyContact(value)));
    }
});
