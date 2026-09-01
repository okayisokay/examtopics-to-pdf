# etpdf — project instructions

Chrome extension that auto-scrapes exam `/view` pages and exports them to PDF.
See [README.md](README.md) for how it works and how to run the build.

## Secrets: never read or write `.env`

**Do not read, open, edit, write, or print the contents of `.env`** (or `.env.local`, or any
other real environment file). This applies to every tool — `Read`, `Edit`, `Write`, and also
shell commands such as `cat`, `type`, `head`, `grep`, `Get-Content`, or anything that would
echo the file into the transcript.

**Use `.env.sample` instead.** It carries the same keys with placeholder values and the
documentation comments, so it is the file to consult when you need to know what a variable is
called, add a new one, or explain the configuration.

**Why:** environment files hold real credentials and machine-specific values. Anything read into
the conversation becomes part of the transcript and may be sent to the model on later turns, so
the safest rule is that the real file is never opened at all.

**How to apply:**

- Need to know which variables exist, or what one means? → read `.env.sample`.
- Adding a new setting? → add the key with a placeholder to `.env.sample` and **tell the user**
  to copy it into their `.env` with the real value. Do not edit `.env` for them.
- Need the effective config to debug? → ask the user to paste the specific value, or run the
  program that consumes it (`node build.js`) and read its *output*, not the file. Prefer
  commands that do not echo the whole file.
- The deny rules in [.claude/settings.json](.claude/settings.json) enforce this for the file
  tools. That is a backstop, not the rule — the rule above also covers shell commands, which
  the deny list cannot fully constrain.

## Build step

`.env` is the source of truth for which sites the extension scrapes, but Chrome cannot read it
at runtime. After it changes, `node build.js` regenerates `extension/sites.generated.js` and
patches `extension/manifest.json`. `build.js` falls back to `.env.sample` when `.env` is absent.

`extension/sites.generated.js` is generated — never edit it by hand.
