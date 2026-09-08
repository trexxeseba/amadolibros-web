const INPUT_CHUNK_BYTES = 64 * 1024;
const SMALL_TEXT_FALLBACK_BYTES = 1024 * 1024;
const whitespace = char => char === ' ' || char === '\n' || char === '\r' || char === '\t';
const setMember = (object, key, value) => Object.defineProperty(object, key, {
  value, enumerable: true, configurable: true, writable: true,
});

// Frame root properties and individual entries, then use native JSON.parse for
// their values. This retains every private/unknown field and JSON.parse's exact
// string, number, duplicate-key and __proto__ semantics. The public projection
// parser intentionally discards history and is not suitable for writer reads.
// Memory holds the resulting graph plus one entry/root property and input chunk;
// there is never a string containing the complete manifest body.
function manifestFramer() {
  let root = null;
  const contexts = [];
  let ended = false;
  let token = null;

  function startToken(kind, char) {
    token = {
      kind, parts: [], quoted: char === '"', escaped: false,
      container: char === '{' || char === '[', depth: char === '{' || char === '[' ? 1 : 0,
    };
  }

  function finishToken() {
    const current = token;
    token = null;
    const value = JSON.parse(current.parts.join(''));
    const context = contexts.at(-1);
    if (current.kind === 'key') {
      if (typeof value !== 'string') throw new Error('Invalid JSON member name.');
      context.key = value;
      context.state = 'colon';
    } else {
      setMember(context.value, context.key, value);
      context.state = 'after-value';
    }
  }

  function closeObject() {
    contexts.pop();
    if (!contexts.length) ended = true;
    else contexts.at(-1).state = 'after-value';
  }

  return {
    write(text) {
      let index = 0;
      while (index < text.length) {
        if (token) {
          const start = index;
          let complete = false;
          while (index < text.length) {
            const char = text[index];
            if (token.quoted) {
              if (token.escaped) token.escaped = false;
              else if (char === '\\') token.escaped = true;
              else if (char === '"') {
                token.quoted = false;
                if (!token.container) { index++; complete = true; break; }
              }
            } else if (token.container) {
              if (char === '"') token.quoted = true;
              else if (char === '{' || char === '[') token.depth++;
              else if (char === '}' || char === ']') {
                token.depth--;
                if (token.depth === 0) { index++; complete = true; break; }
              }
            } else if (whitespace(char) || char === ',' || char === '}' || char === ']') {
              complete = true;
              break;
            }
            index++;
          }
          if (index > start) token.parts.push(text.slice(start, index));
          if (complete) finishToken();
          continue;
        }

        const char = text[index];
        if (whitespace(char)) { index++; continue; }
        if (ended) throw new Error('Unexpected data after JSON manifest.');
        if (!contexts.length) {
          if (char !== '{') throw new Error('JSON manifest root must be an object.');
          root = {};
          contexts.push({ value: root, state: 'first-key', key: null });
          index++;
          continue;
        }
        const context = contexts.at(-1);
        if (context.state === 'first-key' || context.state === 'key') {
          if (char === '}' && context.state === 'first-key') { closeObject(); index++; continue; }
          if (char !== '"') throw new Error('Expected JSON member name.');
          startToken('key', char);
          token.parts.push(char);
          index++;
        } else if (context.state === 'colon') {
          if (char !== ':') throw new Error('Expected JSON member colon.');
          context.state = 'value';
          index++;
        } else if (context.state === 'value') {
          if (contexts.length === 1 && context.key === 'entries' && char === '{') {
            const entries = {};
            setMember(root, context.key, entries);
            context.state = 'child';
            contexts.push({ value: entries, state: 'first-key', key: null });
            index++;
          } else {
            startToken('value', char);
            // Consume the opening string/container marker exactly once. A
            // primitive starts at this character and ends at its delimiter.
            if (token.quoted || token.container) { token.parts.push(char); index++; }
          }
        } else if (context.state === 'after-value') {
          if (char === ',') { context.state = 'key'; index++; }
          else if (char === '}') { closeObject(); index++; }
          else throw new Error('Expected JSON comma or closing brace.');
        } else throw new Error('Invalid JSON manifest state.');
      }
    },
    end() {
      if (!ended || contexts.length || token) throw new Error('Truncated JSON manifest.');
      return root;
    },
  };
}

export async function readFullCoverManifest(object) {
  const parser = manifestFramer();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  function writeBytes(bytes) {
    for (let offset = 0; offset < bytes.byteLength; offset += INPUT_CHUNK_BYTES) {
      const text = decoder.decode(bytes.subarray(offset, offset + INPUT_CHUNK_BYTES), { stream: true });
      if (text) parser.write(text);
    }
  }
  const reader = object?.body?.getReader?.();
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        writeBytes(value);
      }
      const tail = decoder.decode();
      if (tail) parser.write(tail);
      return parser.end();
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  // Native test buckets may already hold bytes. Parse those in bounded pieces
  // too, without creating an additional full-body decoded string.
  if (ArrayBuffer.isView(object?.body)) {
    writeBytes(new Uint8Array(object.body.buffer, object.body.byteOffset, object.body.byteLength));
    const tail = decoder.decode();
    if (tail) parser.write(tail);
    return parser.end();
  }
  if (Number(object?.size) > SMALL_TEXT_FALLBACK_BYTES || typeof object?.text !== 'function') {
    throw new Error('Full cover manifest requires a readable stream.');
  }
  const text = await object.text();
  if (text.length > SMALL_TEXT_FALLBACK_BYTES || new TextEncoder().encode(text).byteLength > SMALL_TEXT_FALLBACK_BYTES) {
    throw new Error('Full cover manifest requires streaming.');
  }
  parser.write(text);
  return parser.end();
}
