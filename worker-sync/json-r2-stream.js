const encoder = new TextEncoder();
const OUTPUT_CHUNK_BYTES = 64 * 1024;
const SMALL_BODY_FALLBACK_BYTES = 1024 * 1024;

// These documents are plain JSON objects whose large root properties are an
// entries object or report arrays. Split those containers into individual rows,
// retaining every field, including private histories and unknown metadata.
// Additional serialization memory holds one row, container keys and an output
// chunk, rather than a string containing the complete document.
function* jsonParts(value, depth = 0) {
  const plainObject = value !== null && typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  if (depth < 2 && (Array.isArray(value) || plainObject) && typeof value.toJSON !== 'function') {
    const array = Array.isArray(value);
    yield array ? '[' : '{';
    let comma = false;
    const keys = array ? value.keys() : Object.keys(value);
    for (const key of keys) {
      const member = value[key];
      const omitted = member === undefined || typeof member === 'function' || typeof member === 'symbol';
      if (!array && omitted) continue;
      if (comma) yield ',';
      comma = true;
      if (!array) yield JSON.stringify(key) + ':';
      if (omitted) yield 'null';
      else yield* jsonParts(member, depth + 1);
    }
    yield array ? ']' : '}';
  } else {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError('R2 JSON body must have a JSON value.');
    yield text;
  }
}

function* jsonByteChunks(value) {
  let buffer = new Uint8Array(OUTPUT_CHUNK_BYTES);
  let used = 0;
  for (const part of jsonParts(value)) {
    // encodeInto never splits a UTF-8 character. Keeping at least four bytes
    // free also guarantees progress for surrogate pairs at a chunk boundary.
    let offset = 0;
    while (offset < part.length) {
      if (buffer.byteLength - used < 4) {
        yield buffer.subarray(0, used);
        buffer = new Uint8Array(OUTPUT_CHUNK_BYTES);
        used = 0;
      }
      const { read, written } = encoder.encodeInto(part.slice(offset), buffer.subarray(used));
      offset += read;
      used += written;
    }
  }
  if (used) yield buffer.subarray(0, used);
}

// Callers must keep this plain JSON document immutable until the PUT completes.
// Side-effectful getters/custom toJSON methods are outside this contract: two
// serialization passes cannot guarantee their values or byte lengths agree.
export async function putJsonToR2(bucket, key, value, options = {}) {
  // R2 requires a known stream length. Count without accumulating the chunks;
  // both passes serialize the same immutable, plain JSON document.
  let bytes = 0;
  for (const chunk of jsonByteChunks(value)) bytes += chunk.byteLength;

  if (typeof FixedLengthStream !== 'function') {
    // Native Node tests and small compatible buckets have no Cloudflare stream
    // implementation. This fallback is explicitly capped; a large production
    // document must never silently revert to a full buffered JSON.stringify().
    if (bytes > SMALL_BODY_FALLBACK_BYTES) throw new Error('R2 JSON upload requires FixedLengthStream.');
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of jsonByteChunks(value)) { body.set(chunk, offset); offset += chunk.byteLength; }
    return bucket.put(key, body, options);
  }

  const { readable, writable } = new FixedLengthStream(bytes);
  const writer = writable.getWriter();
  let stopped = false;
  const producing = (async () => {
    try {
      for (const chunk of jsonByteChunks(value)) {
        if (stopped) return;
        await writer.write(chunk);
      }
      if (!stopped) await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    } finally {
      writer.releaseLock();
    }
  })();
  // Attach immediately: an encoding/write failure can precede put() settling.
  producing.catch(() => {});

  async function stop(reason) {
    stopped = true;
    // Some native streams wait for a pending write before completing abort.
    // Cancel an unconsumed readable concurrently to release its backpressure;
    // cancellation of a readable still locked by R2 may reject harmlessly.
    await Promise.allSettled([writer.abort(reason), readable.cancel(reason)]);
    await producing.catch(() => {});
  }

  try {
    // Start consuming concurrently with the producer; otherwise backpressure
    // would deadlock before R2 ever receives the readable stream.
    const result = await bucket.put(key, readable, options);
    if (result === null) {
      await stop(new Error('R2 JSON conditional write was not committed.'));
      return null;
    }
    await producing;
    return result;
  } catch (error) {
    await stop(error);
    throw error;
  }
}
