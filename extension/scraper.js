/**
 * Pure DOM reader. Loaded two ways:
 *   1. as a content script on the supported sites (autoscrape.js calls scrapeExamPage())
 *   2. via chrome.scripting.executeScript from the popup, where the trailing
 *      scrapeExamPage() call is what gets returned to the popup.
 * Top-level function declarations are shared with autoscrape.js (same isolated world).
 */

const MAX_CHOICE_COLS = 8; // A..H

/**
 * Site config comes from sites.generated.js (built from .env by build.js), which is
 * loaded before this file as a content script. The popup injects this file on its own,
 * where those globals are absent — hence the fallbacks.
 */
const HOST_PATTERNS =
  typeof SCRAPE_HOST_PATTERNS !== 'undefined' ? SCRAPE_HOST_PATTERNS : [/(^|\.)example\.com$/i];
const VIEW_PATTERN =
  typeof VIEW_PATH_PATTERN !== 'undefined' ? VIEW_PATH_PATTERN : /\/view\/?$|\/view\/\d+\/?$/;

/** Is this a host we auto-scrape at all? */
function isSupportedHost(url = location.href) {
  return HOST_PATTERNS.some((re) => re.test(new URL(url).hostname));
}

/**
 * True for .../view, .../view/ and .../view/2 — e.g.
 * https://www.examtopics.com/exams/amazon/aws-certified-advanced-networking-specialty-ans-c01/view/
 * https://www.examtopics.com/exams/amazon/aws-...-ans-c01/view/2
 */
function isViewUrl(url = location.href) {
  return VIEW_PATTERN.test(new URL(url).pathname);
}

/** ".../exams/amazon/aws-...-ans-c01/view/2" -> "aws-...-ans-c01" (used for filenames). */
function examSlugFromUrl(url = location.href) {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  const i = parts.lastIndexOf('view');
  return (i > 0 ? parts[i - 1] : parts[parts.length - 1]) || 'exam';
}

/** ".../view/3" -> 3, ".../view" and ".../view/" -> 1 */
function pageNumberFromUrl(url = location.href) {
  const m = new URL(url).pathname.match(/\/view\/(\d+)\/?$/);
  return m ? Number(m[1]) : 1;
}

/**
 * Identity of the exam, shared by all of its pages: origin + path up to and including /view.
 * "www." is normalised away so www.example.com and example.com are one bucket; other
 * subdomains (local., staging.) stay distinct, as they are genuinely different data.
 */
function examKeyFromUrl(url = location.href) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/view\/\d+\/?$/, '/view').replace(/\/+$/, '');
  const origin = `${u.protocol}//${u.host.replace(/^www\./i, '')}`;
  return origin + path;
}

/** Turn a DOM node into clean plain text: strip letters/badges, keep line breaks, note images. */
function cleanText(node, { dropLetters = false } = {}) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  const junk = ['script', 'style', 'noscript', '.badge', '.vote-answer-button', '.voting-summary'];
  if (dropLetters) junk.push('.multi-choice-letter');
  clone.querySelectorAll(junk.join(',')).forEach((el) => el.remove());
  clone.querySelectorAll('img').forEach((img) => {
    img.replaceWith(document.createTextNode(` [IMG: ${img.src}] `));
  });
  clone.querySelectorAll('br').forEach((br) => br.replaceWith(document.createTextNode('\n')));
  clone.querySelectorAll('p, div, li').forEach((el) => el.append(document.createTextNode('\n')));
  return clone.textContent
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** "Question #12" -> "12" (ignores the topic span). */
function questionNumber(card) {
  const header = card.querySelector('.card-header');
  if (!header) return '';
  const clone = header.cloneNode(true);
  clone.querySelectorAll('.question-title-topic').forEach((el) => el.remove());
  const m = clone.textContent.match(/#\s*(\d+)/);
  return m ? m[1] : clone.textContent.trim();
}

/** Parse the embedded JSON vote tally. */
function parseVotes(body) {
  const tag = body.querySelector('.voted-answers-tally script[type="application/json"]');
  if (!tag) return { dist: '', mostVoted: '', total: '' };
  let data;
  try {
    data = JSON.parse(tag.textContent);
  } catch (e) {
    return { dist: '', mostVoted: '', total: '' };
  }
  if (!Array.isArray(data)) return { dist: '', mostVoted: '', total: '' };
  const total = data.reduce((s, v) => s + (Number(v.vote_count) || 0), 0);
  const dist = data
    .map((v) => `${v.voted_answers}:${v.vote_count}${v.is_most_voted ? '*' : ''}`)
    .join('; ');
  const most = data.find((v) => v.is_most_voted);
  return { dist, mostVoted: most ? most.voted_answers : '', total: String(total) };
}

function scrapeCard(card, pageNumber) {
  const body = card.querySelector('.question-body') || card;

  const choices = [...body.querySelectorAll('.question-choices-container li')].map((li) => {
    const letterEl = li.querySelector('.multi-choice-letter');
    const letter =
      letterEl?.dataset.choiceLetter?.trim() ||
      (letterEl?.textContent || '').replace(/[^A-Za-z]/g, '');
    return {
      letter,
      text: cleanText(li, { dropLetters: true }),
      markedCorrect: li.classList.contains('correct-choice'),
      mostVotedBadge: !!li.querySelector('.most-voted-answer-badge'),
    };
  });

  const v = parseVotes(body);

  return {
    question_number: questionNumber(card),
    topic: (card.querySelector('.question-title-topic')?.textContent || '').trim(),
    question_id: body.dataset.id || '',
    question_text: cleanText(body.querySelector('p.card-text')),
    choices,
    // cleanText, not textContent: on hotspot and drag-drop questions the answer is an
    // <img>, which has no text at all — it has to survive as an [IMG: url] marker.
    correct_answer:
      cleanText(body.querySelector('.correct-answer')) ||
      choices.filter((c) => c.markedCorrect).map((c) => c.letter).join(''),
    most_voted: v.mostVoted || choices.filter((c) => c.mostVotedBadge).map((c) => c.letter).join(''),
    vote_distribution: v.dist,
    total_votes: v.total,
    answer_description: cleanText(body.querySelector('.answer-description')),
    discussion_count: (
      body.querySelector('.question-discussion-button .badge')?.textContent || ''
    ).trim(),
    source_page: String(pageNumber),
    page_url: location.href,
    scraped_at: new Date().toISOString(),
  };
}

function scrapeExamPage() {
  const pageNumber = pageNumberFromUrl();
  const questions = [...document.querySelectorAll('.exam-question-card')].map((card) =>
    scrapeCard(card, pageNumber)
  );

  const letters = [];
  questions.forEach((q) =>
    q.choices.forEach((c) => {
      if (c.letter && !letters.includes(c.letter)) letters.push(c.letter);
    })
  );
  letters.sort().splice(MAX_CHOICE_COLS);

  return {
    ok: true,
    url: location.href,
    title: document.title,
    exam_key: examKeyFromUrl(),
    exam_slug: examSlugFromUrl(),
    page_number: pageNumber,
    count: questions.length,
    letters,
    questions,
  };
}

// Value returned to popup.js when injected via chrome.scripting.executeScript.
scrapeExamPage();
