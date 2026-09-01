/**
 * Service worker. Owns the stored collection.
 *
 * Storage shape — one entry per exam, never merged across exams:
 *   collection[examKey] = {
 *     exam_key, exam_slug, title, first_seen, updated_at,
 *     pages: { "1": { page_number, url, count, letters, questions, scraped_at } }
 *   }
 */

// DATASTORE_API_URL / DATASTORE_API_KEY, generated from .env by build.js.
importScripts('datastore.generated.js');

const STORE = 'collection';

// Serialise writes so two tabs reporting at once cannot clobber each other.
let queue = Promise.resolve();
function withCollection(mutate) {
  queue = queue.then(async () => {
    const { [STORE]: collection = {} } = await chrome.storage.local.get(STORE);
    const result = await mutate(collection);
    await chrome.storage.local.set({ [STORE]: collection });
    return result;
  });
  return queue;
}

function totals(exam) {
  const pages = Object.values(exam.pages);
  return {
    pages: pages.length,
    questions: pages.reduce((n, p) => n + p.questions.length, 0),
  };
}

async function savePage(data, tabId) {
  const stats = await withCollection((collection) => {
    const now = new Date().toISOString();
    const exam = (collection[data.exam_key] ??= {
      exam_key: data.exam_key,
      exam_slug: data.exam_slug,
      title: data.title,
      first_seen: now,
      pages: {},
    });
    exam.title = data.title || exam.title;
    exam.exam_slug = data.exam_slug || exam.exam_slug;
    exam.updated_at = now;
    // Re-visiting a page replaces it rather than duplicating.
    exam.pages[String(data.page_number)] = {
      page_number: data.page_number,
      url: data.url,
      count: data.count,
      letters: data.letters,
      questions: data.questions,
      scraped_at: now,
    };
    return totals(exam);
  });

  if (tabId != null) {
    chrome.action.setBadgeBackgroundColor({ color: '#0d6efd' });
    chrome.action.setBadgeText({ tabId, text: String(stats.questions) });
    chrome.action.setTitle({
      tabId,
      title: `Exam Question Scraper — ${stats.questions} questions across ${stats.pages} page(s) of this exam`,
    });
  }
  return stats;
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * Fetch one image for the PDF export. This has to happen here rather than in the popup:
 * a fetch from the service worker carries the extension's host permissions, so it is not
 * subject to the image host's CORS headers. Returns a data URL because messages have to
 * be JSON.
 */
async function fetchImage(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return { ok: false, error: 'not a URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `unsupported scheme ${parsed.protocol}` };
  }

  try {
    const res = await fetch(url, { credentials: 'omit', redirect: 'follow' });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const type = (res.headers.get('content-type') || '').split(';')[0].trim();
    if (!/^image\//i.test(type)) return { ok: false, error: `not an image (${type || 'no type'})` };

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      return { ok: false, error: `${Math.round(buffer.byteLength / 1024)} KB is too large` };
    }

    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { ok: true, dataUrl: `data:${type};base64,${btoa(binary)}` };
  } catch (err) {
    // Almost always a missing host permission for this image's origin.
    return { ok: false, error: err.message };
  }
}

/**
 * POST a whole exam to the datastore's ingest-pages/ endpoint. Runs here rather
 * than in the popup for the same reason image fetches do: a service-worker fetch
 * carries the extension's host permissions, so it is not subject to CORS.
 *
 * Ingestion is idempotent server-side — a page whose questions have not changed
 * is reported "unchanged" and writes nothing — so re-clicking Download is cheap.
 */
async function uploadExam(pages) {
  const base = (DATASTORE_API_URL || '').replace(/\/+$/, '');
  if (!base) return { ok: false, skipped: true };

  const headers = { 'Content-Type': 'application/json' };
  if (DATASTORE_API_KEY) headers['X-API-Key'] = DATASTORE_API_KEY;

  try {
    const res = await fetch(`${base}/ingest-pages/`, {
      method: 'POST',
      headers,
      credentials: 'omit',
      body: JSON.stringify({ pages }),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
    try {
      return { ok: true, ...JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: 'response was not JSON' };
    }
  } catch (err) {
    // Server down, wrong host, or no host permission for this origin.
    return { ok: false, error: err.message };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'exam-page-scraped') {
    savePage(msg.data, sender.tab?.id).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'upload-exam') {
    uploadExam(msg.pages).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'fetch-image') {
    fetchImage(msg.url).then(sendResponse);
    return true; // async response
  }
  if (msg?.type === 'clear-exam') {
    withCollection((collection) => {
      delete collection[msg.exam_key];
    }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});
