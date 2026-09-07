/**
 * Content script. Runs on every page of the configured sites, but only does something
 * on a /view page. Waits for the question cards to be in the DOM, scrapes, and
 * hands the result to the service worker, which stores it under the exam key.
 * Functions come from scraper.js, loaded before this file in the same world.
 */
(() => {
  // Host is already constrained by the manifest matches; re-checking keeps .env the
  // single source of truth even if the manifest is ever broadened by hand.
  if (!isSupportedHost() || !isViewUrl()) return;

  const SETTLE_MS = 400; // quiet period after the last DOM change
  const GIVE_UP_MS = 15000; // stop waiting for cards that never arrive
  const started = Date.now();

  let lastSent = '';
  let settleTimer = null;
  let observer = null;

  function send() {
    const data = scrapeExamPage();
    if (!data.count) return false;

    // Don't re-send an identical page (SPA re-renders, observer noise).
    const fingerprint = `${data.exam_key}|${data.page_number}|${data.count}|${data.questions
      .map((q) => q.question_id || q.question_number)
      .join(',')}`;
    if (fingerprint === lastSent) return true;
    lastSent = fingerprint;

    chrome.runtime.sendMessage({ type: 'exam-page-scraped', data }, () => {
      void chrome.runtime.lastError; // popup/SW may not be listening; not an error worth surfacing
    });
    return true;
  }

  function schedule() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      send();
      if (Date.now() - started > GIVE_UP_MS) observer?.disconnect();
    }, SETTLE_MS);
  }

  // First pass immediately, then keep watching so lazy-rendered or
  // "Reveal Solution"-toggled cards get picked up too.
  send();

  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  setTimeout(() => observer?.disconnect(), GIVE_UP_MS);

  // Client-side navigation between /view pages (if the site uses pushState).
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    lastSent = '';
    if (isViewUrl()) schedule();
  }, 700);
})();
