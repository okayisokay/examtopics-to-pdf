/**
 * Minimal PDF writer, plus the exam layout used by the popup's "Download as PDF".
 *
 * No dependencies and no embedded fonts: the document uses the three standard
 * Helvetica faces (every viewer has them) with WinAnsiEncoding, so text is written one
 * byte per character and a JS string index is also a byte offset — which is what the
 * xref table needs. buildExamPdf() returns a Uint8Array ready for a Blob.
 */

/* --------------------------------------------------------------- encoding */

/** The characters the scraper meets that live in the WinAnsi high range. */
const WIN_ANSI = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85,
  '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a,
  '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91, '’': 0x92,
  '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97,
  '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c,
  'ž': 0x9e, 'Ÿ': 0x9f,
};

/**
 * Unicode -> one WinAnsi byte per character, as a latin-1 JS string. Codes 0x20..0x7e
 * and 0xa0..0xff pass through (Latin-1 and WinAnsi agree from 0xa0 up); anything else
 * becomes "?" so a stray CJK glyph or emoji cannot corrupt the stream.
 */
function toWinAnsi(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0);
    if (code === 9) out += ' ';
    else if (code >= 0x20 && code <= 0x7e) out += ch;
    else if (code >= 0xa0 && code <= 0xff) out += ch;
    else if (WIN_ANSI[ch] !== undefined) out += String.fromCharCode(WIN_ANSI[ch]);
    else if (code < 0x20) out += '';
    else out += '?';
  }
  return out;
}

/** Escaping for a PDF literal string. The input is already WinAnsi. */
function escapeText(s) {
  return s.replace(/[\\()]/g, '\\$&');
}

/* ---------------------------------------------------------------- metrics */

// Adobe AFM advance widths (1/1000 em) for codes 32..126.
const W_HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const W_HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// High-range characters whose width is nowhere near the fallback. Accented letters
// (0xc0 up) are within a few units of their base letter, so the fallback covers them;
// these are the ones it does not.
const W_HIGH = {
  0x85: 1000, 0x89: 1000, 0x8c: 1000, 0x91: 222, 0x92: 222, 0x93: 333, 0x94: 333,
  0x95: 350, 0x96: 556, 0x97: 1000, 0x99: 1000, 0x9c: 944, 0xa0: 278, 0xad: 333,
};
const W_FALLBACK = 556;

const FONTS = {
  reg: { res: 'F1', widths: W_HELVETICA },
  bold: { res: 'F2', widths: W_HELVETICA_BOLD },
  obl: { res: 'F3', widths: W_HELVETICA }, // Oblique shares Helvetica's metrics
};

/** Width in points of an already-encoded string. */
function widthOf(s, font, size) {
  const table = FONTS[font].widths;
  let units = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    units += c >= 32 && c <= 126 ? table[c - 32] : W_HIGH[c] ?? W_FALLBACK;
  }
  return (units * size) / 1000;
}

/** Greedy word wrap. A word wider than the column (a URL) is broken mid-word. */
function wrap(s, font, size, max) {
  const lines = [];
  for (const word of s.split(/ +/)) {
    let w = word;
    while (widthOf(w, font, size) > max) {
      let cut = 1;
      while (cut < w.length && widthOf(w.slice(0, cut + 1), font, size) <= max) cut++;
      lines.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    if (!lines.length) {
      lines.push(w);
      continue;
    }
    const last = lines[lines.length - 1];
    const joined = last ? `${last} ${w}` : w;
    if (widthOf(joined, font, size) <= max) lines[lines.length - 1] = joined;
    else lines.push(w);
  }
  return lines.length ? lines : [''];
}

/* -------------------------------------------------------------------- doc */

const num = (n) => (Math.round(n * 100) / 100).toString();

/** Image bytes as a latin-1 string, so they concatenate with the rest of the file. */
function bytesToLatin1(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return out;
}

/** A4 portrait, one content stream per page. */
class Pdf {
  constructor({ width = 595.28, height = 841.89, margin = 56, footer = 34 } = {}) {
    this.width = width;
    this.height = height;
    this.margin = margin;
    this.footerY = footer;
    this.pages = [];
    this.images = []; // { name, desc }, shared by every page's resource dict
    this.imageNames = new Map();
    this.addPage();
  }

  get right() {
    return this.width - this.margin;
  }

  addPage() {
    this.ops = [];
    this.pages.push(this.ops);
    this.y = this.height - this.margin;
  }

  /** Break to a new page unless `height` points still fit above the footer. */
  reserve(height) {
    if (this.y - height < this.footerY + 16) this.addPage();
  }

  gap(h) {
    this.y -= h;
  }

  draw(s, x, y, font, size, gray) {
    this.ops.push(
      `BT /${FONTS[font].res} ${num(size)} Tf ${num(gray)} g ${num(x)} ${num(y)} Td ` +
        `(${escapeText(s)}) Tj ET`
    );
  }

  rule(gray = 0.8) {
    this.reserve(8);
    this.y -= 6;
    this.ops.push(
      `${num(gray)} G 0.5 w ${num(this.margin)} ${num(this.y)} m ` +
        `${num(this.right)} ${num(this.y)} l S`
    );
    this.y -= 6;
  }

  /**
   * Wrapped text block. `label` is a hanging marker ("B.") drawn in the gutter beside
   * the first line, which is what keeps the choices lined up under each other.
   */
  paragraph(text, opts = {}) {
    const {
      font = 'reg',
      size = 10,
      gray = 0,
      leading = size * 1.32,
      indent = 0,
      label = '',
      labelFont = 'bold',
      labelIndent = 0,
    } = opts;

    const x = this.margin + indent;
    const max = this.right - x;
    const marker = toWinAnsi(label);
    let first = true;

    // Split on the source's own newlines BEFORE encoding: toWinAnsi() drops control
    // characters, so a break left in the string until then would be swallowed with them.
    // An empty hard line wraps to [''], which advances y and leaves a blank line behind.
    for (const hard of String(text ?? '').split(/\r?\n/)) {
      for (const line of wrap(toWinAnsi(hard), font, size, max)) {
        this.reserve(leading);
        this.y -= leading;
        if (first && marker) this.draw(marker, this.margin + labelIndent, this.y, labelFont, size, gray);
        if (line) this.draw(line, x, this.y, font, size, gray);
        first = false;
      }
    }
  }

  /**
   * Place an image, scaled to fit the column and never taller than one page. `desc` is
   * what images.js produces: { key, width, height, bytes, filter, colorSpace }.
   */
  image(desc, { indent = 0, maxHeight = 460 } = {}) {
    let name = this.imageNames.get(desc.key);
    if (!name) {
      name = `Im${this.images.length + 1}`;
      this.imageNames.set(desc.key, name);
      this.images.push({ name, desc });
    }

    const columnWidth = this.right - (this.margin + indent);
    const cap = Math.min(maxHeight, this.height - 2 * this.margin - 20);
    // Never upscale: a 200px diagram stays 200px rather than turning into a blur.
    const scale = Math.min(columnWidth / desc.width, cap / desc.height, 1);
    const w = desc.width * scale;
    const h = desc.height * scale;

    this.reserve(h + 8);
    this.y -= h + 4;
    this.ops.push(
      `q ${num(w)} 0 0 ${num(h)} ${num(this.margin + indent)} ${num(this.y)} cm /${name} Do Q`
    );
    this.y -= 4;
  }

  /** "slug • Page 2 of 7", centred, on every page. Call once, after the layout. */
  footers(text) {
    const s = toWinAnsi(text);
    this.pages.forEach((ops, i) => {
      const label = `${s}${s ? '  •  ' : ''}Page ${i + 1} of ${this.pages.length}`;
      const x = (this.width - widthOf(label, 'reg', 8)) / 2;
      ops.push(`BT /F1 8 Tf 0.55 g ${num(x)} ${num(this.footerY)} Td (${escapeText(label)}) Tj ET`);
    });
  }

  /** Serialise to PDF bytes. */
  build({ title = '', subject = '' } = {}) {
    const objects = [];
    const add = (body) => objects.push(body); // push() returns the 1-based object number

    const catalogId = add('');
    const pagesId = add('');
    const font = (name) =>
      add(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`);
    const f1 = font('Helvetica');
    const f2 = font('Helvetica-Bold');
    const f3 = font('Helvetica-Oblique');

    // Every page shares one XObject dict — simpler than tracking which page used what,
    // and unused entries cost a viewer nothing.
    const xobjects = this.images
      .map(({ name, desc }) => {
        const id = add(
          `<< /Type /XObject /Subtype /Image /Width ${desc.width} /Height ${desc.height} ` +
            `/ColorSpace /${desc.colorSpace} /BitsPerComponent 8 /Filter /${desc.filter} ` +
            `/Length ${desc.bytes.length} >>\nstream\n${bytesToLatin1(desc.bytes)}\nendstream`
        );
        return `/${name} ${id} 0 R`;
      })
      .join(' ');
    const resources =
      `<< /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >>` +
      (xobjects ? ` /XObject << ${xobjects} >>` : '') +
      ' >>';

    const kids = this.pages.map((ops) => {
      const stream = ops.join('\n');
      const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const pageId = add(
        `<< /Type /Page /Parent ${pagesId} 0 R ` +
          `/MediaBox [0 0 ${num(this.width)} ${num(this.height)}] ` +
          `/Resources ${resources} /Contents ${contentId} 0 R >>`
      );
      return `${pageId} 0 R`;
    });

    objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
    objects[pagesId - 1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${this.pages.length} >>`;

    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp =
      `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}` +
      `${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
    const infoId = add(
      `<< /Title (${escapeText(toWinAnsi(title))}) ` +
        `/Subject (${escapeText(toWinAnsi(subject))}) ` +
        `/Producer (Exam Question Scraper) /CreationDate (${stamp}) >>`
    );

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = objects.map((body, i) => {
      const at = out.length;
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
      return at;
    });

    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
    out +=
      `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xref}\n%%EOF\n`;

    return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
  }
}

/* ------------------------------------------------------------- exam layout */

const CHOICE_INDENT = 22;

/** Splits on the marker cleanText() leaves behind for an <img>, keeping the URL. */
const IMG_SPLIT = /\[IMG:\s*([^\]]+?)\s*\]/;

/**
 * Text that may carry [IMG: url] markers. A marker becomes the image itself when it was
 * fetched, and stays as its original text when it was not (blocked host, dead link), so
 * nothing silently vanishes from the export.
 */
function blockWithImages(doc, text, images, opts = {}) {
  const { label = '', indent = 0, ...rest } = opts;
  const parts = String(text ?? '').split(IMG_SPLIT);
  let pending = label; // hanging marker ("B.") still waiting for its first line
  let drew = false;

  parts.forEach((part, i) => {
    if (i % 2) {
      const desc = images && images.get(part);
      if (desc) {
        if (pending) doc.paragraph('', { ...rest, indent, label: pending });
        doc.image(desc, { indent });
      } else {
        doc.paragraph(`[IMG: ${part}]`, { ...rest, indent, label: pending, gray: 0.45 });
      }
    } else {
      const chunk = part.trim();
      if (!chunk) return;
      doc.paragraph(chunk, { ...rest, indent, label: pending });
    }
    pending = '';
    drew = true;
  });

  if (!drew && pending) doc.paragraph('', { ...rest, indent, label: pending });
}

function questionBlock(doc, q, index, images) {
  // Keep the heading with the start of its question rather than orphaning it.
  doc.reserve(58);

  doc.paragraph(`Question ${q.question_number || index + 1}`, {
    font: 'bold',
    size: 11.5,
    leading: 15,
  });

  const bits = [
    q.topic,
    q.question_id && `ID ${q.question_id}`,
    q.source_page && `source page ${q.source_page}`,
    q.discussion_count && `${q.discussion_count} comments`,
  ].filter(Boolean);
  if (bits.length) doc.paragraph(bits.join('  •  '), { size: 8.5, gray: 0.45, leading: 11 });

  if (q.question_text) {
    doc.gap(4);
    blockWithImages(doc, q.question_text, images, { size: 10, leading: 13.2 });
  }

  if (q.choices?.length) {
    doc.gap(5);
    for (const c of q.choices) {
      // The correct choice is bold, so the answer reads without hunting for the key.
      blockWithImages(doc, c.text, images, {
        size: 10,
        leading: 13.2,
        indent: CHOICE_INDENT,
        font: c.markedCorrect ? 'bold' : 'reg',
        label: c.letter ? `${c.letter}.` : '•',
        labelFont: c.markedCorrect ? 'bold' : 'reg',
        labelIndent: 6,
      });
    }
  }

  doc.gap(5);
  if (q.correct_answer) {
    // Not always a letter: hotspot and drag-drop answers are images, so this goes
    // through blockWithImages the same way the question and the explanation do.
    blockWithImages(doc, `Correct answer: ${q.correct_answer}`, images, {
      font: 'bold',
      size: 9.5,
      leading: 12,
    });
  }
  if (q.most_voted) {
    const votes = q.total_votes ? ` (${q.total_votes} votes)` : '';
    doc.paragraph(`Most voted: ${q.most_voted}${votes}`, { font: 'bold', size: 9.5, leading: 12 });
  }
  if (q.vote_distribution) {
    doc.paragraph(q.vote_distribution, { size: 8.5, gray: 0.45, leading: 11 });
  }
  if (q.answer_description) {
    doc.gap(3);
    doc.paragraph('Explanation', { font: 'bold', size: 9, leading: 11.5 });
    blockWithImages(doc, q.answer_description, images, {
      font: 'obl',
      size: 9,
      gray: 0.2,
      leading: 11.8,
    });
  }
}

/**
 * One exam -> PDF bytes. `questions` is the flattened, deduped list the popup already
 * builds, `summary` the same one-line summary shown on the exam card, and `images` the
 * Map(url -> descriptor) from images.js — omit it and the [IMG: url] markers stay text.
 */
function buildExamPdf(exam, questions, summary = '', images = null) {
  const doc = new Pdf();
  const heading = exam.exam_slug || exam.exam_key || 'exam';

  doc.paragraph(heading, { font: 'bold', size: 17, leading: 21 });
  if (exam.title && exam.title !== heading) {
    doc.paragraph(exam.title, { size: 10, gray: 0.35, leading: 13 });
  }
  doc.gap(2);
  const exported = `exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  doc.paragraph([summary, exported].filter(Boolean).join('  •  '), {
    size: 8.5,
    gray: 0.45,
    leading: 11,
  });
  if (exam.exam_key) doc.paragraph(exam.exam_key, { size: 8.5, gray: 0.45, leading: 11 });
  doc.rule();

  if (!questions.length) {
    doc.gap(6);
    doc.paragraph('No questions collected for this exam.', { size: 10, gray: 0.4 });
  }
  questions.forEach((q, i) => {
    if (i) doc.rule(0.85);
    doc.gap(6);
    questionBlock(doc, q, i, images);
    doc.gap(6);
  });

  doc.footers(heading);
  return doc.build({ title: heading, subject: exam.exam_key || '' });
}
