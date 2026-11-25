import test from 'node:test';
import assert from 'node:assert/strict';
import { purchaseTrustHtml } from '../../shared/purchase-trust.js';

test('las señales de confianza distinguen pagos, devolución y conexión sin atribuir certificaciones', () => {
  for (const compact of [true, false]) {
    const html = purchaseTrustHtml({ compact });
    assert.match(html, /Pago seguro/);
    assert.match(html, /Mercado Pago/);
    assert.match(html, /datos de tu tarjeta se ingresan en Mercado Pago/);
    assert.match(html, /Si no te convence, podés devolverlo/);
    assert.match(html, /5 días hábiles desde que lo recibís/);
    assert.match(html, /libro sin uso y en el mismo estado/);
    assert.match(html, /gastos de retorno a cargo del comprador/);
    assert.match(html, /Conexión segura HTTPS/);
    assert.doesNotMatch(html, /VeriSign|DigiCert|Norton|Compra Protegida|100% segura|<script/i);
    for (const route of ['/terminos/', '/devoluciones/', '/privacidad/', '/contacto/']) {
      assert.ok(html.includes('href="' + route + '"'));
    }
  }
});
