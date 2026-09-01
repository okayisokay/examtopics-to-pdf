const $ = (id) => document.getElementById(id);
const statusEl = $('status');

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle('err', isError);
  statusEl.classList.toggle('muted', !isError);
}

/* ---------------------------------------------------------------- export */

/** Pages of ONE exam, in page order, deduped. Questions are never mixed across exams. */
function flatten(exam) {
  const pages = Object.values(exam.pages).sort((a, b) => a.page_number - b.page_number);
  const seen = new Set();
  const questions = [];
  for (const page of pages) {
    for (const q of page.questions) {
      const id = q.question_id || `${page.page_number}#${q.question_number}`;
      if (seen.has(id)) continue;
      seen.add(id);
      questions.push(q);
    }
  }
  const letters = [];
  questions.forEach((q) =>
    q.choices.forEach((c) => {
      if (c.letter && !letters.includes(c.letter)) letters.push(c.letter);
    })
  );
  return { pages, questions, letters: letters.sort() };
}

function slug(s) {
  return (
    (s || 'exam')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 70)
      .toLowerCase() || 'exam'
  );
}

function download(data, mime, filename) {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  });
}

/* ---------------------------------------------------------------- upload */

/** The stored pages in the shape the datastore's ingest-pages/ endpoint takes. */
function ingestPayload(exam, pages) {
  return pages.map((p) => ({
    ok: true,
    url: p.url || '',
    title: exam.title || '',
    // Sent explicitly so the server buckets by the same key the popup does,
    // rather than re-deriving it from the page URL.
    exam_key: exam.exam_key,
    exam_slug: exam.exam_slug || '',
    page_number: p.page_number,
    count: p.count,
    letters: p.letters || [],
    questions: p.questions || [],
  }));
}

function uploadSummary(res) {
  if (!res) return 'Upload: no reply from the service worker.';
  if (res.skipped) return 'Upload skipped — DATASTORE_API_URL is not set.';
  if (!res.ok) return `Upload failed: ${res.error}`;
  const created = res.questions_created ?? 0;
  const updated = res.questions_updated ?? 0;
  const errs = res.errors?.length ? ` ${res.errors.length} page(s) rejected.` : '';
  return `Uploaded ${res.pages_received ?? 0} page(s): ${created} new, ${updated} updated.${errs}`;
}

/**
 * Fetch the images, build the PDF, hand it to the downloader, then mirror the exam
 * to the datastore. Images that cannot be fetched are reported and their
 * [IMG: url] marker stays in the text. The PDF is the deliverable: a datastore that
 * is unconfigured or down only appends to the status line.
 */
async function exportPdf(exam, questions, pages, summary, urls, granted, button) {
  button.disabled = true;
  try {
    await granted; // resolves false when the host prompt was declined; fetches then fail
    let images = new Map();
    let failures = [];
    if (urls.length) {
      setStatus(`Fetching ${urls.length} image${urls.length === 1 ? '' : 's'}…`);
      ({ images, failures } = await loadImages(urls, (done, total) => {
        setStatus(`Fetching images ${done}/${total}…`);
      }));
    }

    setStatus('Building PDF…');
    const bytes = buildExamPdf(exam, questions, summary, images);
    download(bytes, 'application/pdf', `${slug(exam.exam_slug)}-questions.pdf`);

    const size = `${(bytes.length / 1024).toFixed(0)} KB`;
    const shots = images.size ? `, ${images.size} image${images.size === 1 ? '' : 's'}` : '';
    let msg = `PDF: ${questions.length} questions${shots}, ${size}.`;
    let bad = false;
    if (failures.length) {
      msg =
        `PDF: ${questions.length} questions${shots}, ${size} — ${failures.length} image(s) ` +
        `skipped (${failures[0].error}); their URLs are printed instead.`;
      bad = true;
    }

    setStatus(`${msg} Uploading ${pages.length} page${pages.length === 1 ? '' : 's'}…`, bad);
    const up = await chrome.runtime.sendMessage({
      type: 'upload-exam',
      pages: ingestPayload(exam, pages),
    });
    setStatus(`${msg} ${uploadSummary(up)}`, bad || !(up?.ok || up?.skipped));
  } catch (err) {
    setStatus(`PDF failed: ${err.message}`, true);
  } finally {
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------- ui */

/** "1-3, 5" from the page numbers actually collected. */
function pageRanges(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const out = [];
  let start = null;
  let prev = null;
  for (const n of sorted) {
    if (start === null) start = prev = n;
    else if (n === prev + 1) prev = n;
    else {
      out.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = prev = n;
    }
  }
  if (start !== null) out.push(start === prev ? `${start}` : `${start}-${prev}`);
  return out.join(', ');
}

function examCard(exam, isCurrent) {
  const { questions, pages, letters } = flatten(exam);
  const nums = pages.map((p) => p.page_number);

  const el = document.createElement('div');
  el.className = `exam${isCurrent ? ' current' : ''}`;

  const h = document.createElement('h2');
  h.textContent = exam.exam_slug || exam.exam_key;
  const meta = document.createElement('div');
  meta.className = 'meta muted';
  meta.textContent =
    `${questions.length} questions · page${nums.length === 1 ? '' : 's'} ${pageRanges(nums)}` +
    (letters.length ? ` · choices ${letters.join('')}` : '');

  const row = document.createElement('div');
  row.className = 'row';

  const pdf = document.createElement('button');
  pdf.textContent = 'Download as PDF';
  pdf.onclick = () => {
    // Ask for the image hosts first, synchronously: chrome.permissions.request is only
    // honoured while the click gesture is still live, so nothing may be awaited before it.
    const urls = imageUrlsIn(questions);
    const origins = imageOrigins(urls);
    const granted = origins.length
      ? chrome.permissions.request({ origins }).catch(() => false)
      : Promise.resolve(true);

    exportPdf(exam, questions, pages, meta.textContent, urls, granted, pdf);
  };

  const clear = document.createElement('button');
  clear.className = 'danger';
  clear.textContent = 'Clear';
  clear.onclick = async () => {
    await chrome.runtime.sendMessage({ type: 'clear-exam', exam_key: exam.exam_key });
    render();
  };

  row.append(pdf, clear);
  el.append(h, meta, row);
  return el;
}

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function render() {
  const [{ collection = {} }, tab] = await Promise.all([
    chrome.storage.local.get('collection'),
    currentTab(),
  ]);

  const box = $('exams');
  box.innerHTML = '';

  const exams = Object.values(collection);
  if (!exams.length) {
    const p = document.createElement('div');
    p.className = 'empty muted';
    p.textContent =
      'Nothing collected yet. Open a /view page on local.something.com — it is scraped automatically as you browse.';
    box.append(p);
    return;
  }

  // Current exam first; each exam stays its own bucket.
  const url = tab?.url || '';
  exams.sort((a, b) => {
    const ca = url.startsWith(a.exam_key) ? 0 : 1;
    const cb = url.startsWith(b.exam_key) ? 0 : 1;
    return ca - cb || (b.updated_at || '').localeCompare(a.updated_at || '');
  });
  exams.forEach((exam) => box.append(examCard(exam, url.startsWith(exam.exam_key))));
}

$('refresh').addEventListener('click', () => {
  render();
  setStatus('');
});

$('scrape').addEventListener('click', async () => {
  setStatus('Scraping…');
  try {
    const tab = await currentTab();
    const [{ result: data }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: ['scraper.js'],
    });

    if (!data || !data.count) {
      setStatus('No .exam-question-card elements found on this page.', true);
      return;
    }
    const stats = await chrome.runtime.sendMessage({ type: 'exam-page-scraped', data });
    setStatus(`Page ${data.page_number}: ${data.count} questions · exam total ${stats.questions}`);
    render();
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
});

// Live-update the popup if a page reports while it is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.collection) render();
});

render();
