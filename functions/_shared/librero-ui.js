/**
 * functions/_shared/librero-ui.js
 *
 * Pantalla del asistente «Ayudame a encontrarlo». Se muestra solo en la
 * página de resultados cuando una búsqueda no encontró nada. La conversación
 * es guionada (sin IA): los datos de los libros, el precio y el stock los
 * manda el servidor (/api/librero); el navegador nunca los inventa.
 *
 * Todo texto que viene de afuera se pone con textContent, nunca como HTML.
 */

import { WHATSAPP_NUMBER } from '../../shared/whatsapp-messages.js';

function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Botón de entrada y contenedor. Va arriba del bloque «Pedir que lo busquemos». */
export function libreroHtml(rawQuery) {
    const query = String(rawQuery ?? '').trim().slice(0, 200);
    return `<section class="librero" id="librero" data-query="${escapeAttr(query)}" data-wa="https://wa.me/${WHATSAPP_NUMBER}?text=" aria-label="Ayuda para encontrar tu libro">
      <div class="librero-intro">
        <strong>¿Te ayudo a encontrarlo?</strong>
        <span>Charlamos un minuto, te muestro lo que se parezca y, si hace falta, armamos tu pedido para que lo busquemos.</span>
        <button type="button" class="librero-open" id="librero-open">Ayudame a encontrarlo</button>
      </div>
      <div class="librero-chat" id="librero-chat" hidden>
        <div class="librero-log" id="librero-log" role="log" aria-live="polite"></div>
        <div class="librero-actions" id="librero-actions"></div>
        <input type="text" name="website" class="librero-trap" tabindex="-1" autocomplete="off" aria-hidden="true">
      </div>
    </section>`;
}

export const LIBRERO_STYLES = `
    .librero{max-width:720px;margin-top:1.35rem;padding:1.25rem;border:1px solid #e3d3c4;border-radius:1rem;background:#fffdf9;color:#1e293b}
    .librero [hidden]{display:none!important}
    .librero-intro strong,.librero-intro span{display:block}
    .librero-intro strong{font-size:1.1rem;line-height:1.35}
    .librero-intro span{margin-top:.45rem;color:#64748b;font-size:.9rem}
    .librero-open,.librero-btn{display:inline-flex;min-height:46px;align-items:center;justify-content:center;padding:.65rem 1.1rem;border:1px solid #d9c3b3;border-radius:.65rem;background:#fff;color:#18120e;font:inherit;font-weight:700;cursor:pointer}
    .librero-open{margin-top:1rem;border-color:#18120e;background:#18120e;color:#fff}
    .librero-btn.is-primary{border-color:#a94e3d;background:#a94e3d;color:#fff}
    .librero-open:focus-visible,.librero-btn:focus-visible,.librero input:focus-visible,.librero textarea:focus-visible{outline:2px solid #a94e3d;outline-offset:2px}
    .librero-log{display:flex;flex-direction:column;gap:.6rem}
    .librero-msg{max-width:92%;padding:.65rem .85rem;border-radius:.9rem;font-size:.95rem;line-height:1.45;white-space:pre-line}
    .librero-msg.bot{align-self:flex-start;background:#f5efe6;color:#18120e}
    .librero-msg.me{align-self:flex-end;background:#18120e;color:#fff}
    .librero-cards{display:grid;gap:.6rem;margin:.2rem 0}
    .librero-card{padding:.75rem .85rem;border:1px solid #e3d3c4;border-radius:.8rem;background:#fff}
    .librero-card b{display:block;font-size:.95rem;line-height:1.3}
    .librero-card small{display:block;margin-top:.2rem;color:#64748b}
    .librero-card a{display:inline-block;margin-top:.5rem;color:#a94e3d;font-weight:700}
    .librero-actions{display:flex;flex-wrap:wrap;gap:.6rem;margin-top:.9rem}
    .librero-form{display:grid;gap:.6rem;width:100%}
    .librero-form label{display:grid;gap:.25rem;font-size:.85rem;font-weight:600;color:#475569}
    .librero input[type=text],.librero input[type=number],.librero textarea{width:100%;padding:.6rem .7rem;border:1px solid #cbd5e1;border-radius:.55rem;font:inherit;font-size:1rem}
    .librero .librero-check{display:flex;align-items:flex-start;gap:.5rem;font-weight:500}
    .librero .librero-check input{margin-top:.2rem}
    .librero .librero-err{color:#b91c1c;font-size:.85rem}
    .librero-trap{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
    @media (prefers-reduced-motion:no-preference){.librero-msg{animation:libreroIn .18s ease-out}}
    @keyframes libreroIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
`;

export const LIBRERO_SCRIPT = `<script>
(function () {
  var root = document.getElementById('librero');
  if (!root) return;
  var openBtn = document.getElementById('librero-open');
  var chat = document.getElementById('librero-chat');
  var log = document.getElementById('librero-log');
  var actions = document.getElementById('librero-actions');
  var trap = root.querySelector('.librero-trap');
  var query = root.getAttribute('data-query') || '';
  var waBase = root.getAttribute('data-wa') || '';
  var state = { sessionId: null, answers: {}, submitting: false, key: null, started: false, sent: false, clicked: false };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function say(who, text) {
    var m = el('div', 'librero-msg ' + who, text);
    log.appendChild(m);
    return m;
  }
  function clear() { actions.textContent = ''; }
  function button(label, onClick, primary) {
    var b = el('button', 'librero-btn' + (primary ? ' is-primary' : ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function choose(label, handler) { clear(); say('me', label); handler(); }

  function api(body) {
    body.website = trap ? trap.value : '';
    return fetch('/api/librero', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().then(function (data) { return { status: res.status, data: data }; });
    });
  }
  function track(type, payload) {
    if (!state.sessionId) return;
    api({ action: 'event', session_id: state.sessionId, type: type, payload: payload || '' }).catch(function () {});
  }
  function waHref(extra) {
    var msg = 'Hola, busqué un libro en Amado Libros y quisiera que me ayudaran.\\nLibro: ' + query + (extra ? '\\n' + extra : '');
    return waBase + encodeURIComponent(msg);
  }
  function whatsappLink(label, extra) {
    var a = el('a', 'librero-btn', label);
    a.className = 'librero-btn';
    a.href = waHref(extra);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  }

  // ── Pasos ────────────────────────────────────────────────────────────────
  function begin() {
    if (state.started) return;
    state.started = true;
    openBtn.hidden = true;
    chat.hidden = false;
    say('bot', 'Hola, soy el Asistente de Amado Libros. Busquemos juntos «' + query + '».');
    api({ action: 'start', query: query }).then(function (r) {
      if (r.status === 429) { say('bot', r.data.error); actions.appendChild(whatsappLink('Escribir por WhatsApp')); return; }
      if (r.status !== 201) { say('bot', 'Ahora no pude consultar el catálogo. Podés seguir con el pedido igual.'); return offerSearch(); }
      state.sessionId = r.data.session_id;
      showCandidates(r.data);
    }).catch(function () {
      say('bot', 'Ahora no pude consultar el catálogo. Podés seguir con el pedido igual.');
      offerSearch();
    });
  }

  function showCandidates(data) {
    if (!data.catalog_ok) {
      say('bot', 'No pudimos comprobar el catálogo en este momento, así que no puedo decirte si lo tenemos. Si querés, armamos tu pedido igual.');
      return offerSearch();
    }
    if (!data.candidates.length) {
      say('bot', 'No encontré nada parecido en el catálogo. Eso no significa que no podamos conseguirlo.');
      return offerSearch();
    }
    say('bot', 'Pediste «' + query + '». Encontré esto que podría ser lo que buscás. Fijate si alguno es.');
    cardsList(data.candidates, true);
    track('candidates_shown', data.candidates.map(function (c) { return c.id; }).join(','));
    clear();
    var more = data.same_author;
    if (more && more.author) { var p = more.author.split(','); if (p.length === 2) more.author = p[1].trim() + ' ' + p[0].trim(); }
    if (more && more.books && more.books.length) {
      actions.appendChild(button('Ver más libros de ' + more.author, function () {
        choose('Ver más libros de ' + more.author, function () {
          track('answer', 'mas-del-autor');
          say('bot', 'Estos son otros libros de ' + more.author + ' que tenemos en el catálogo.');
          cardsList(more.books, false);
          afterBrowse();
        });
      }));
    }
    actions.appendChild(button('Ninguno es lo que busco', function () {
      choose('Ninguno es lo que busco', function () { track('none_fit'); offerSearch(); });
    }));
  }

  function cardsList(list, countClicks) {
    var cards = el('div', 'librero-cards');
    list.forEach(function (c) {
      var card = el('div', 'librero-card');
      card.appendChild(el('b', null, c.title));
      if (c.author) card.appendChild(el('small', null, c.author));
      card.appendChild(el('small', null, c.available && c.price ? '$' + c.price.toLocaleString('es-UY') + ' · Disponible' : 'Disponible por encargo'));
      var a = el('a', null, 'Ver este libro');
      a.href = c.url;
      a.addEventListener('click', function () { state.clicked = true; track('candidate_click', c.id); });
      card.appendChild(a);
      cards.appendChild(card);
    });
    log.appendChild(cards);
  }

  function afterBrowse() {
    clear();
    say('bot', '¿Alguno de esos era el que buscabas?');
    actions.appendChild(button('No, quiero que busquen «' + shortQuery() + '»', function () {
      choose('No, quiero que busquen lo que pedí', function () { track('none_fit'); offerSearch(); });
    }, true));
    actions.appendChild(button('Voy a mirar el catálogo', function () {
      choose('Voy a mirar el catálogo', function () {
        track('left', 'miro-catalogo');
        say('bot', 'Perfecto, queda el catálogo a tu disposición cuando quieras.');
      });
    }));
  }
  function shortQuery() { return query.length > 40 ? query.slice(0, 37) + '...' : query; }

  function offerSearch() {
    say('bot', 'Pediste «' + query + '». ¿Querés que lo busquemos por vos? Una persona de Amado lo revisa y verifica la edición antes de ofrecerte una opción.');
    clear();
    actions.appendChild(button('Sí, que lo busquen', function () { choose('Sí, que lo busquen', askUsed); }, true));
    actions.appendChild(button('Por ahora no', function () {
      choose('Por ahora no', function () {
        track('left', 'no-quiere-pedido');
        say('bot', 'Perfecto, queda el catálogo a tu disposición cuando quieras.');
      });
    }));
  }

  function askUsed() {
    say('bot', '¿Te sirve que sea usado?');
    clear();
    [['Sí, usado está bien', true], ['Prefiero nuevo', false], ['Me da igual', null]].forEach(function (o) {
      actions.appendChild(button(o[0], function () {
        choose(o[0], function () { state.answers.accepts_used = o[1]; track('answer', 'usado:' + o[1]); askEdition(); });
      }));
    });
  }
  function askEdition() {
    say('bot', 'Y si no está esa edición exacta, ¿te sirve otra?');
    clear();
    [['Sí, otra edición está bien', true], ['Quiero esa edición exacta', false], ['Me da igual', null]].forEach(function (o) {
      actions.appendChild(button(o[0], function () {
        choose(o[0], function () { state.answers.accepts_other_edition = o[1]; track('answer', 'edicion:' + o[1]); askBudget(); });
      }));
    });
  }
  function askBudget() {
    say('bot', '¿Hasta cuánto pensabas invertir?');
    clear();
    [['Hasta $500', 500], ['Hasta $1.000', 1000], ['Hasta $2.000', 2000], ['Hasta $5.000', 5000], ['No tengo un tope', null]].forEach(function (o) {
      actions.appendChild(button(o[0], function () {
        choose(o[0], function () { state.answers.budget_uyu = o[1]; track('answer', 'presupuesto:' + o[1]); askMore(); });
      }));
    });
  }
  function askMore() {
    var extra = state.answers.extra || (state.answers.extra = []);
    say('bot', extra.length
      ? '¿Querés sumar otro libro más a este pedido?'
      : 'Ya que estamos: ¿querés que busquemos también otro libro, de este autor o de otro, junto con este pedido?');
    clear();
    actions.appendChild(button('Sí, sumar otro libro', function () {
      choose('Sí, sumar otro libro', function () {
        say('bot', '¿Cuál? Escribí el título, el autor o lo que recuerdes.');
        clear();
        var form = el('div', 'librero-form');
        var input = el('input'); input.type = 'text'; input.maxLength = 150;
        var row = el('div', 'librero-actions');
        row.appendChild(button('Agregar', function () {
          var v = input.value.trim();
          if (!v) { input.focus(); return; }
          extra.push(v);
          track('answer', 'suma-otro');
          say('me', v);
          askMore();
        }, true));
        row.appendChild(button('Cancelar', function () { askMore(); }));
        form.appendChild(field('Otro libro', input));
        form.appendChild(row);
        actions.appendChild(form);
        input.focus();
      });
    }));
    actions.appendChild(button(extra.length ? 'No, con esto alcanza' : 'No, solo este', function () {
      choose(extra.length ? 'No, con esto alcanza' : 'No, solo este', askDetails);
    }, true));
  }

  function field(labelText, input) {
    var label = el('label', null, labelText);
    label.appendChild(input);
    return label;
  }
  function askDetails() {
    say('bot', '¿Sabés algo más que nos ayude a encontrarlo? Por ejemplo editorial, año o idioma. Si no, seguimos.');
    clear();
    var form = el('div', 'librero-form');
    var note = el('textarea'); note.rows = 3; note.maxLength = 700;
    form.appendChild(field('Lo que sepas del libro (opcional)', note));
    var row = el('div', 'librero-actions');
    function next() {
      var parts = [];
      if (note.value.trim()) parts.push(note.value.trim());
      if (state.answers.extra && state.answers.extra.length) parts.push('También busca: ' + state.answers.extra.join('; '));
      state.answers.notes = parts.join('\\n').slice(0, 900);
      say('me', note.value.trim() || 'Nada más');
      askContact();
    }
    row.appendChild(button('Seguir', next, true));
    form.appendChild(row);
    actions.appendChild(form);
  }

  function askContact() {
    say('bot', '¿Cómo preferís que te avisemos cuando tengamos novedades? Es opcional: también podés quedarte con el código del pedido.');
    clear();
    [['Por WhatsApp', 'whatsapp'], ['Por email', 'email']].forEach(function (o) {
      actions.appendChild(button(o[0], function () { choose(o[0], function () { askContactValue(o[1]); }); }, true));
    });
    actions.appendChild(button('Prefiero no dejar contacto', function () {
      choose('Prefiero no dejar contacto', function () {
        state.answers.contact_kind = null; state.answers.contact_value = null;
        state.answers.contact_preferred_time = ''; state.answers.consent_reply = false;
        confirmSummary();
      });
    }));
  }

  function askContactValue(kind) {
    var isMail = kind === 'email';
    say('bot', isMail ? '¿A qué email te escribimos?' : '¿A qué número de WhatsApp te escribimos?');
    clear();
    var form = el('div', 'librero-form');
    var value = el('input'); value.type = isMail ? 'email' : 'tel'; value.maxLength = 120; value.autocomplete = isMail ? 'email' : 'tel';
    var consentBox = el('input'); consentBox.type = 'checkbox';
    var consent = el('label', 'librero-check');
    consent.appendChild(consentBox);
    consent.appendChild(el('span', null, 'Autorizo que me respondan por este medio sobre este pedido.'));
    var err = el('div', 'librero-err'); err.setAttribute('role', 'alert');
    form.appendChild(field(isMail ? 'Tu email' : 'Tu WhatsApp', value));
    form.appendChild(consent);
    form.appendChild(err);
    var row = el('div', 'librero-actions');
    row.appendChild(button('Revisar el pedido', function () {
      err.textContent = '';
      var v = value.value.trim();
      if (!v) { err.textContent = 'Escribí tu ' + (isMail ? 'email' : 'WhatsApp') + ' o elegí seguir sin contacto.'; return; }
      if (!consentBox.checked) { err.textContent = 'Para guardar tu contacto, marcá que nos autorizás a responderte.'; return; }
      state.answers.contact_kind = kind;
      state.answers.contact_value = v;
      state.answers.contact_preferred_time = '';
      state.answers.consent_reply = true;
      say('me', (isMail ? 'Mi email: ' : 'Mi WhatsApp: ') + v);
      confirmSummary();
    }, true));
    row.appendChild(button('Seguir sin contacto', function () {
      state.answers.contact_kind = null; state.answers.contact_value = null;
      state.answers.contact_preferred_time = ''; state.answers.consent_reply = false;
      say('me', 'Prefiero no dejar contacto');
      confirmSummary();
    }));
    form.appendChild(row);
    actions.appendChild(form);
    value.focus();
  }

  function summaryLines() {
    var a = state.answers;
    var lines = ['Libro: ' + query];
    if (a.accepts_used === true) lines.push('Acepta usado');
    if (a.accepts_used === false) lines.push('Prefiere nuevo');
    if (a.accepts_other_edition === true) lines.push('Acepta otra edición');
    if (a.accepts_other_edition === false) lines.push('Quiere esa edición exacta');
    if (a.budget_uyu != null) lines.push('Presupuesto: hasta $' + a.budget_uyu);
    if (a.notes) lines.push('Datos: ' + a.notes);
    lines.push(a.contact_value ? 'Contacto: ' + a.contact_value + (a.contact_preferred_time ? ' (' + a.contact_preferred_time + ')' : '') : 'Sin contacto: seguís con el código del pedido');
    return lines;
  }
  function confirmSummary() {
    track('summary_shown');
    say('bot', 'Así quedaría tu pedido. ¿Lo enviamos?\\n\\n' + summaryLines().join('\\n'));
    clear();
    actions.appendChild(button('Sí, enviar el pedido', function () { choose('Sí, enviar el pedido', send); }, true));
    actions.appendChild(button('Cambiar algo', function () { choose('Cambiar algo', function () { state.answers = {}; askUsed(); }); }));
  }

  function send() {
    if (state.submitting) return;
    if (!state.sessionId) { say('bot', 'No pude abrir la sesión. Escribinos por WhatsApp y lo vemos juntos.'); actions.appendChild(whatsappLink('Escribir por WhatsApp')); return; }
    state.submitting = true;
    if (!state.key) state.key = 'lib-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    var a = state.answers;
    say('bot', 'Enviando tu pedido...');
    api({
      action: 'request', session_id: state.sessionId, idempotency_key: state.key, query: query,
      accepts_used: a.accepts_used, accepts_other_edition: a.accepts_other_edition,
      budget_uyu: a.budget_uyu, notes: a.notes, contact_kind: a.contact_kind, contact_value: a.contact_value,
      contact_preferred_time: a.contact_preferred_time, consent_reply: a.consent_reply
    }).then(function (r) {
      state.submitting = false;
      if (r.status === 201 || r.status === 200) {
        state.sent = true;
        say('bot', 'Listo, tu pedido quedó registrado con el código ' + r.data.request_code + '.\\nUna persona de Amado lo va a revisar' + (a.contact_value ? ' y te escribimos al medio que dejaste cuando haya novedades.' : '. Guardá el código por si querés escribirnos.'));
        clear();
        actions.appendChild(whatsappLink('Escribir por WhatsApp con mi código', 'Código de pedido: ' + r.data.request_code));
        return;
      }
      say('bot', (r.data && r.data.error) || 'No pudimos registrar el pedido ahora.');
      clear();
      if (r.status !== 400) actions.appendChild(button('Reintentar', function () { choose('Reintentar', send); }, true));
      actions.appendChild(whatsappLink('Escribir por WhatsApp'));
    }).catch(function () {
      state.submitting = false;
      say('bot', 'No pudimos registrar el pedido ahora. Tu pedido no se perdió por tu lado: podés reintentar.');
      clear();
      actions.appendChild(button('Reintentar', function () { choose('Reintentar', send); }, true));
      actions.appendChild(whatsappLink('Escribir por WhatsApp'));
    });
  }

  openBtn.addEventListener('click', begin);
  window.addEventListener('pagehide', function () {
    if (state.sessionId && !state.sent && !state.clicked) {
      try { navigator.sendBeacon('/api/librero', new Blob([JSON.stringify({ action: 'event', session_id: state.sessionId, type: 'left', website: '' })], { type: 'application/json' })); } catch (e) {}
    }
  });
})();
</script>`;
