import { pathToFileURL } from 'node:url';

const ALLOWED_HOST = 'http2.mlstatic.com';
const TARGET_COUNT = 20;

function normalizedUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.hostname !== ALLOWED_HOST || !['http:', 'https:'].includes(url.protocol)) return null;
  url.protocol = 'https:';
  url.hash = '';
  return url.toString();
}

function candidateUrls(item) {
  const pictures = Array.isArray(item?.pictures) ? item.pictures : [];
  return [
    ...pictures.map(picture => typeof picture === 'string'
      ? picture
      : picture?.secure_url || picture?.url),
    item?.thumbnail,
  ];
}

export function selectRealCovers(catalog, targetCount = TARGET_COUNT) {
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const selected = [];
  const seenUrls = new Set();

  for (const item of items) {
    if (selected.length >= targetCount) break;
    if (item?.status !== 'active' || Number(item.available_quantity) <= 0 ||
        !/^MLU\d{6,20}$/.test(String(item.id || ''))) continue;
    const url = candidateUrls(item).map(normalizedUrl).find(Boolean);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);
    selected.push({ product_id: item.id, position: 0, url });
  }

  if (selected.length !== targetCount) {
    throw new Error(`Sólo se encontraron ${selected.length} portadas válidas; se esperaban ${targetCount}.`);
  }
  return { items: selected };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const catalog = JSON.parse(input);
  process.stdout.write(`${JSON.stringify(selectRealCovers(catalog))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
