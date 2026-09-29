import { JSONParser } from '../_vendor/streamparser-json/index.js';

// Public reads need a few current pointers, not the mirror's full probe history.
// Parse one entry at a time and release it before reading the next entry. The
// original manifest and R2 masters remain unchanged.
export async function streamCoverManifest(object, { productIds = null } = {}) {
    const startedAt = performance.now();
    let parseMs = 0;
    const selected = productIds === null ? null : new Set(productIds);
    const entries = Object.create(null);
    const parser = new JSONParser();
    let root;
    let bytesRead = 0;
    let entriesRead = 0;
    let entriesContainerSeen = false;
    parser.onValue = ({ value, key, parent, stack }) => {
        if (stack.length === 2 && stack[1].key === 'entries') {
            entriesRead += 1;
            const match = /^(MLU\d+):([0-9]|1[0-5])$/.exec(String(key));
            if (match && (!selected || selected.has(match[1]))) {
                const current = value?.current;
                entries[key] = {
                    product_id: value?.product_id,
                    position: value?.position,
                    ...(current && typeof current === 'object' ? { current: {
                        object_key: current.object_key,
                        sha256: current.sha256,
                        mime: current.mime,
                        source_url: current.source_url,
                        width: current.width,
                        height: current.height,
                        bytes: current.bytes,
                    } } : {}),
                };
            }
            delete parent[key];
        }
        if (stack.length === 1 && key === 'entries') {
            if (entriesContainerSeen) throw new Error('Duplicate entries container.');
            entriesContainerSeen = true;
        }
        if (stack.length === 0) root = value;
    };
    const reader = object?.body?.getReader?.();
    if (reader) {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                bytesRead += value.byteLength;
                // Decode complete Unicode characters before handing chunks to
                // the parser (including code points split across R2 chunks).
                const decoded = decoder.decode(value, { stream: true });
                if (decoded) {
                    const parseStart = performance.now();
                    parser.write(decoded);
                    parseMs += performance.now() - parseStart;
                }
            }
            const tail = decoder.decode();
            if (tail) parser.write(tail);
            if (!parser.isEnded) parser.end();
        } catch (error) {
            await reader.cancel(error).catch(() => {});
            throw error;
        } finally {
            reader.releaseLock();
        }
    } else {
        // Compatibility with small in-memory test buckets. Real R2 objects
        // always expose a stream; large objects must never use text().
        if (Number(object?.size) > 1024 * 1024 || typeof object?.text !== 'function') {
            throw new Error('Cover manifest stream unavailable.');
        }
        const text = await object.text();
        if (text.length > 1024 * 1024) throw new Error('Cover manifest requires streaming.');
        bytesRead = new TextEncoder().encode(text).byteLength;
        const parseStart = performance.now();
        parser.write(text);
        parseMs += performance.now() - parseStart;
        if (!parser.isEnded) parser.end();
    }
    if (!root || !Object.hasOwn(root, 'schema_version') || !Object.hasOwn(root, 'entries') ||
        root.schema_version !== 1 || !root.entries ||
        typeof root.entries !== 'object' || Array.isArray(root.entries)) {
        throw new Error('Invalid cover manifest.');
    }
    return {
        schema_version: 1,
        updated_at: root.updated_at,
        entries,
        read_stats: { bytes: bytesRead, entries_scanned: entriesRead, entries_retained: Object.keys(entries).length,
            parse_ms: parseMs, body_ms: Math.max(0, performance.now() - startedAt - parseMs) },
    };
}
