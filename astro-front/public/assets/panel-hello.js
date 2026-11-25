// Panel interno: entrar con Windows Hello (o la huella del celular) y registrar
// equipos desde Ajustes. El servidor emite el desafío y verifica la firma
// (functions/_shared/panel-passkey.js); acá solo se habla con el equipo.
(function () {
  'use strict';
  var MARCA = 'amado_panel_hello';

  function b64(buf) {
    var s = '';
    var b = new Uint8Array(buf);
    for (var i = 0; i < b.length; i += 1) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function bin(t) {
    t = String(t).replace(/-/g, '+').replace(/_/g, '/');
    while (t.length % 4) t += '=';
    var s = atob(t);
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i += 1) b[i] = s.charCodeAt(i);
    return b;
  }

  async function postJson(url, body) {
    var resp = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    var data = {};
    try { data = await resp.json(); } catch (e) { data = {}; }
    if (!resp.ok || data.ok === false) {
      var err = new Error(data.error || ('http_' + resp.status));
      err.code = data.error;
      throw err;
    }
    return data;
  }

  function marcar() { try { localStorage.setItem(MARCA, '1'); } catch (e) { /* sin almacenamiento */ } }
  function marcado() { try { return localStorage.getItem(MARCA) === '1'; } catch (e) { return false; } }
  function desmarcar() { try { localStorage.removeItem(MARCA); } catch (e) { /* idem */ } }

  // ---- Entrada ------------------------------------------------------------
  var entrarBtn = document.getElementById('entrar-hello');
  var avisoEntrada = document.getElementById('aviso-hello');
  if (entrarBtn) {
    if (!window.PublicKeyCredential) {
      entrarBtn.disabled = true;
      avisoEntrada.textContent = 'Este navegador no permite Windows Hello. Entrá con la contraseña.';
    } else {
      var entrar = async function () {
        entrarBtn.disabled = true;
        avisoEntrada.textContent = 'Esperando a Windows Hello…';
        try {
          var o = await postJson('/panel/passkey/opciones-entrada');
          var cred = await navigator.credentials.get({ publicKey: {
            challenge: bin(o.challenge),
            rpId: o.rpId,
            timeout: 60000,
            userVerification: 'required',
            allowCredentials: o.ids.map(function (id) { return { type: 'public-key', id: bin(id) }; }),
          } });
          await postJson('/panel/passkey/entrar', {
            id: cred.id,
            clientDataJSON: b64(cred.response.clientDataJSON),
            authenticatorData: b64(cred.response.authenticatorData),
            signature: b64(cred.response.signature),
          });
          marcar();
          location.reload();
        } catch (e) {
          entrarBtn.disabled = false;
          if (e && e.code === 'sin_equipos') {
            desmarcar();
            avisoEntrada.textContent = 'Todavía no hay equipos registrados. Entrá con la contraseña y registralo en Ajustes.';
          } else if (e && e.code === 'demasiados_intentos') {
            avisoEntrada.textContent = 'Demasiados intentos fallidos. Probá de nuevo en 15 minutos.';
          } else if (e && e.name === 'NotAllowedError') {
            avisoEntrada.textContent = 'Se canceló. Tocá el botón para probar otra vez.';
          } else {
            avisoEntrada.textContent = 'No se pudo entrar con Windows Hello. Si este equipo no está registrado, entrá con la contraseña y registralo en Ajustes.';
          }
        }
      };
      entrarBtn.addEventListener('click', entrar);
      // Si este equipo ya entró alguna vez así, no hace falta ni tocar el botón.
      if (marcado()) entrar();
    }
  }

  // ---- Registro (Ajustes) -------------------------------------------------
  var registrarBtn = document.getElementById('registrar-hello');
  var avisoRegistro = document.getElementById('aviso-registro');
  if (registrarBtn) {
    if (!window.PublicKeyCredential) {
      registrarBtn.disabled = true;
      avisoRegistro.textContent = 'Este navegador no permite Windows Hello.';
      return;
    }
    registrarBtn.addEventListener('click', async function () {
      var nombre = (document.getElementById('nombre-equipo').value || '').trim();
      if (!nombre) { avisoRegistro.textContent = 'Poné un nombre, por ejemplo: PC de Seba.'; return; }
      registrarBtn.disabled = true;
      avisoRegistro.textContent = 'Esperando a Windows Hello…';
      try {
        var o = await postJson('/panel/passkey/opciones-registro');
        var cred = await navigator.credentials.create({ publicKey: {
          challenge: bin(o.challenge),
          rp: { id: o.rpId, name: 'Panel Amado Libros' },
          user: { id: bin(o.userId), name: nombre, displayName: nombre },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
          excludeCredentials: o.ids.map(function (id) { return { type: 'public-key', id: bin(id) }; }),
          attestation: 'none',
          timeout: 60000,
        } });
        var llave = cred.response.getPublicKey ? cred.response.getPublicKey() : null;
        if (!llave) throw new Error('navegador_sin_getPublicKey');
        await postJson('/panel/passkey/registrar', {
          nombre: nombre,
          id: cred.id,
          alg: cred.response.getPublicKeyAlgorithm(),
          publicKey: b64(llave),
          clientDataJSON: b64(cred.response.clientDataJSON),
          authenticatorData: b64(cred.response.getAuthenticatorData()),
        });
        marcar();
        location.reload();
      } catch (e) {
        registrarBtn.disabled = false;
        if (e && e.name === 'InvalidStateError') avisoRegistro.textContent = 'Este equipo ya estaba registrado.';
        else if (e && e.name === 'NotAllowedError') avisoRegistro.textContent = 'Se canceló. Probá otra vez.';
        else avisoRegistro.textContent = 'No se pudo registrar este equipo (' + ((e && e.message) || 'error') + ').';
      }
    });
  }
})();
