/**
 * Turns the `[IMG: url]` markers the scraper leaves in the text into images the PDF can
 * embed. Runs in the popup.
 *
 * Bytes come from the service worker, because only there does a fetch get the extension's
 * host permissions instead of the page's CORS rules. Baseline JPEGs are handed to the PDF
 * untouched (DCTDecode is JPEG), which keeps the file small; everything else is decoded on
 * a canvas and re-encoded as deflated RGB, which covers PNG, GIF, WebP and AVIF in one
 * path and flattens transparency onto white.
 *
 * A URL that cannot be fetched or decoded is simply left out of the map, and pdf.js falls
 * back to printing the marker text.
 */

const IMG_MARKER = /\[IMG:\s*([^\]]+?)\s*\]/g;
const MAX_PIXELS = 1200; // long edge; the page column is ~483pt, so this is plenty

/** Every image URL referenced by these questions, in first-seen order. */
function imageUrlsIn(questions) {
  const urls = [];
  const scan = (text) => {
    for (const m of String(text ?? '').matchAll(IMG_MARKER)) {
      if (!urls.includes(m[1])) urls.push(m[1]);
    }
  };
  for (const q of questions) {
    scan(q.question_text);
    scan(q.correct_answer);
    scan(q.answer_description);
    (q.choices || []).forEach((c) => scan(c.text));
  }
  return urls;
}

/** The origins those URLs live on, as match patterns for chrome.permissions. */
function imageOrigins(urls) {
  const origins = new Set();
  for (const url of urls) {
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') origins.add(`${u.origin}/*`);
    } catch (e) {
      /* not a URL we can ask for */
    }
  }
  return [...origins];
}

/**
 * Dimensions of a baseline JPEG, or null when it is one we should not pass through:
 * progressive scans and CMYK are outside what PDF's DCTDecode filter accepts.
 */
function baselineJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marker === 0xc0 || marker === 0xc1) {
      const components = bytes[i + 9];
      if (components !== 1 && components !== 3) return null; // CMYK needs a /Decode array
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
        colorSpace: components === 1 ? 'DeviceGray' : 'DeviceRGB',
      };
    }
    if (marker === 0xda) return null; // scan data before any baseline frame header
    i += 2 + length;
  }
  return null;
}

/** zlib-wrapped deflate, which is what PDF's /FlateDecode expects. */
async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Anything the browser can decode -> deflated RGB, alpha flattened onto white. */
async function rasterize(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_PIXELS / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const { data } = ctx.getImageData(0, 0, width, height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    rgb[j++] = data[i];
    rgb[j++] = data[i + 1];
    rgb[j++] = data[i + 2];
  }
  return {
    width,
    height,
    bytes: await deflate(rgb),
    filter: 'FlateDecode',
    colorSpace: 'DeviceRGB',
  };
}

/** data: URLs are already local; everything else goes through the service worker. */
async function fetchBlob(url) {
  if (/^data:/i.test(url)) return (await fetch(url)).blob();
  const res = await chrome.runtime.sendMessage({ type: 'fetch-image', url });
  if (!res?.ok) throw new Error(res?.error || 'fetch failed');
  return (await fetch(res.dataUrl)).blob();
}

async function loadImage(url) {
  const blob = await fetchBlob(url);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const jpeg = baselineJpeg(bytes);
  if (jpeg) return { key: url, bytes, filter: 'DCTDecode', ...jpeg };
  return { key: url, ...(await rasterize(blob)) };
}

/**
 * Map(url -> descriptor) for everything that loaded. `onProgress(done, total, failures)`
 * is called as they land so the popup can show where it is up to.
 */
async function loadImages(urls, onProgress = () => {}) {
  const images = new Map();
  const failures = [];
  let done = 0;

  // Sequential on purpose: a 300-question exam should not open 300 sockets at once.
  for (const url of urls) {
    try {
      images.set(url, await loadImage(url));
    } catch (err) {
      failures.push({ url, error: err.message });
    }
    onProgress(++done, urls.length, failures);
  }
  return { images, failures };
}
