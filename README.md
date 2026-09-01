# Exam Question Scraper (Chrome extension)

Auto-scrapes exam `/view` pages on the configured sites as you browse them, then exports each exam as its own PDF — one file per exam.

**Install:** `chrome://extensions` → turn on **Developer mode** → **Load unpacked** → select `extension/`, then pin it so the badge is visible.



## Config + build

`.env` is the **build-time** source of truth — Chrome cannot read it at runtime. Keys: `SCRAPE_HOSTS`, `SCRAPE_SCHEMES`, `VIEW_PATH_PATTERN`. Copy `.env.sample` (the committed template, and the file to read/edit) to `.env`; `.env` is gitignored and off-limits to Claude — see [CLAUDE.md](CLAUDE.md). After any change to it, run:

```bash
node build.js
```

Then hit **Reload** on the extension at `chrome://extensions`. The build regenerates `extension/sites.generated.js` and patches `host_permissions` / `content_scripts.matches` in `extension/manifest.json` — never edit generated files by hand.

## Use

Browse the exam's `/view` pages: each is scraped on load (re-visits replace, pages merge in order and dedupe) and the toolbar badge shows the running question count. Then click the icon → **Download as PDF**. **Scrape this page now** is a manual override that works on any page, e.g. `test/fixture.html` (expect 2 questions, letters `ABCDE`, answers `A` and `BE`).
