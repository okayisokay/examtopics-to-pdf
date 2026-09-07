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

/* ------------------------------------------------------------------ theme */

/**
 * One palette for the whole document, as PDF DeviceRGB triples. The names and values
 * are Tailwind's, because the pages this scrapes are styled with it — the export then
 * reads as the same product rather than as a generic text dump.
 */
const COLOR = {
  ink: [0.059, 0.09, 0.165], // slate-900, question and choice text
  body: [0.2, 0.255, 0.333], // slate-700, explanation text
  muted: [0.392, 0.455, 0.545], // slate-500, secondary lines
  faint: [0.58, 0.639, 0.722], // slate-400, metadata
  line: [0.886, 0.91, 0.941], // slate-200, card borders
  sky: [0.055, 0.647, 0.914], // sky-500, question headers
  skyDark: [0.008, 0.518, 0.78], // sky-600, cover banner
  skyDeep: [0.012, 0.412, 0.631], // sky-700, labels on tinted panels
  skyEdge: [0.729, 0.902, 0.984], // sky-200, tinted-panel border
  skyPale: [0.878, 0.949, 0.996], // sky-100, badge fill
  skyTint: [0.941, 0.976, 1], // sky-50, explanation background
  good: [0.02, 0.588, 0.412], // emerald-600, the answer
  goodEdge: [0.431, 0.906, 0.718], // emerald-300, correct-choice border
  goodTint: [0.925, 0.992, 0.961], // emerald-50, correct-choice fill
  white: [1, 1, 1],
};

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
const chan = (n) => (Math.round(n * 1000) / 1000).toString();

/** Colour operator. A colour is either an [r,g,b] triple or a plain grey level. */
function paint(color, stroke = false) {
  return Array.isArray(color)
    ? `${chan(color[0])} ${chan(color[1])} ${chan(color[2])} ${stroke ? 'RG' : 'rg'}`
    : `${chan(color)} ${stroke ? 'G' : 'g'}`;
}

/** Rectangle path, with rounded corners when `r` > 0. */
function roundPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  if (r <= 0) return `${num(x)} ${num(y)} ${num(w)} ${num(h)} re`;
  const k = r * 0.4477; // control-point offset for a quarter-circle bezier
  const x2 = x + w;
  const y2 = y + h;
  return (
    `${num(x + r)} ${num(y)} m ` +
    `${num(x2 - r)} ${num(y)} l ` +
    `${num(x2 - k)} ${num(y)} ${num(x2)} ${num(y + k)} ${num(x2)} ${num(y + r)} c ` +
    `${num(x2)} ${num(y2 - r)} l ` +
    `${num(x2)} ${num(y2 - k)} ${num(x2 - k)} ${num(y2)} ${num(x2 - r)} ${num(y2)} c ` +
    `${num(x + r)} ${num(y2)} l ` +
    `${num(x + k)} ${num(y2)} ${num(x)} ${num(y2 - k)} ${num(x)} ${num(y2 - r)} c ` +
    `${num(x)} ${num(y + r)} l ` +
    `${num(x)} ${num(y + k)} ${num(x + k)} ${num(y)} ${num(x + r)} ${num(y)} c h`
  );
}

/** One drawing operator for a filled and/or stroked box. Returns '' when it is neither. */
function boxOp(x, y, w, h, { fill = null, stroke = null, width = 0.7, radius = 0 } = {}) {
  if (!fill && !stroke) return '';
  const style = fill && stroke ? 'B' : fill ? 'f' : 'S';
  return (
    'q ' +
    (fill ? `${paint(fill)} ` : '') +
    (stroke ? `${paint(stroke, true)} ${num(width)} w ` : '') +
    `${roundPath(x, y, w, h, radius)} ${style} Q`
  );
}

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
  constructor({ width = 595.28, height = 841.89, margin = 52, footer = 34 } = {}) {
    this.width = width;
    this.height = height;
    this.margin = margin;
    this.footerY = footer;
    this.pages = [];
    this.blocks = []; // panels still open, innermost last
    this.images = []; // { name, desc }, shared by every page's resource dict
    this.imageNames = new Map();
    this.addPage();
  }

  get right() {
    return this.width - this.margin;
  }

  /**
   * Each page keeps its painted backgrounds apart from its text and writes them first,
   * so a card's fill can be emitted after the text that decided how tall it is.
   */
  addPage() {
    // A panel that is still open spans the page break: close its run here, and start
    // another at the top of the page that follows.
    for (const b of this.blocks) b.segments[b.segments.length - 1].bottom = this.footerY + 14;
    this.page = { bg: [], ops: [] };
    this.ops = this.page.ops;
    this.pages.push(this.page);
    this.y = this.height - this.margin;
    for (const b of this.blocks) b.segments.push({ page: this.page, top: this.y + 7 });
  }

  /** Break to a new page unless `height` points still fit above the footer. */
  reserve(height) {
    if (this.y - height < this.footerY + 22) this.addPage();
  }

  gap(h) {
    this.y -= h;
  }

  box(x, y, w, h, opts = {}) {
    const op = boxOp(x, y, w, h, opts);
    if (op) this.ops.push(op);
  }

  draw(s, x, y, font, size, color = COLOR.ink) {
    this.ops.push(
      `BT /${FONTS[font].res} ${num(size)} Tf ${paint(color)} ${num(x)} ${num(y)} Td ` +
        `(${escapeText(s)}) Tj ET`
    );
  }

  /** Right-aligned single line, for the topic tag in a question header. */
  drawRight(s, xRight, y, font, size, color) {
    this.draw(s, xRight - widthOf(s, font, size), y, font, size, color);
  }

  rule(color = COLOR.line) {
    this.reserve(8);
    this.y -= 6;
    this.ops.push(
      `q ${paint(color, true)} 0.7 w ${num(this.margin)} ${num(this.y)} m ` +
        `${num(this.right)} ${num(this.y)} l S Q`
    );
    this.y -= 6;
  }

  /**
   * Open a panel — a filled and/or outlined box whose height is whatever the content
   * written before the matching endBlock() turns out to be. Panels nest, and one that
   * runs past the bottom of a page is repainted on the next.
   */
  beginBlock(style = {}) {
    const { padTop = 7, minHeight = 24 } = style;
    this.reserve(minHeight);
    this.blocks.push({ style, segments: [{ page: this.page, top: this.y }] });
    this.y -= padTop;
  }

  endBlock() {
    const block = this.blocks.pop();
    const { indent = 0, padBottom = 8, bar = 0, barColor = COLOR.line, ...boxStyle } = block.style;
    this.y -= padBottom;
    block.segments[block.segments.length - 1].bottom = this.y;

    const x = this.margin + indent;
    const w = this.right - x;
    for (const seg of block.segments) {
      const h = seg.top - seg.bottom;
      if (h <= 0.5) continue;
      const ops = [boxOp(x, seg.bottom, w, h, boxStyle)];
      if (bar) {
        ops.push(boxOp(x, seg.bottom, bar, h, { fill: barColor, radius: Math.min(bar / 2, 1.5) }));
      }
      // Unshifted, not pushed: an enclosing panel closes last but has to be painted
      // underneath the nested panels that closed before it.
      seg.page.bg.unshift(...ops.filter(Boolean));
    }
  }

  /**
   * Wrapped text block. `label` is a hanging marker ("B.") drawn in the gutter beside
   * the first line, which is what keeps the choices lined up under each other.
   */
  paragraph(text, opts = {}) {
    const {
      font = 'reg',
      size = 10,
      color = COLOR.ink,
      leading = size * 1.36,
      indent = 0,
      rightInset = 0,
      label = '',
      labelFont = 'bold',
      labelColor = color,
      labelIndent = 0,
    } = opts;

    const x = this.margin + indent;
    const max = this.right - rightInset - x;
    const marker = toWinAnsi(label);
    let first = true;

    // Split on the source's own newlines BEFORE encoding: toWinAnsi() drops control
    // characters, so a break left in the string until then would be swallowed with them.
    // An empty hard line wraps to [''], which advances y and leaves a blank line behind.
    for (const hard of String(text ?? '').split(/\r?\n/)) {
      for (const line of wrap(toWinAnsi(hard), font, size, max)) {
        this.reserve(leading);
        this.y -= leading;
        if (first && marker) {
          this.draw(marker, this.margin + labelIndent, this.y, labelFont, size, labelColor);
        }
        if (line) this.draw(line, x, this.y, font, size, color);
        first = false;
      }
    }
  }

  /**
   * Place an image, scaled to fit the column and never taller than one page. `desc` is
   * what images.js produces: { key, width, height, bytes, filter, colorSpace }.
   */
  image(desc, { indent = 0, rightInset = 0, maxHeight = 460 } = {}) {
    let name = this.imageNames.get(desc.key);
    if (!name) {
      name = `Im${this.images.length + 1}`;
      this.imageNames.set(desc.key, name);
      this.images.push({ name, desc });
    }

    const columnWidth = this.right - rightInset - (this.margin + indent);
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

  /** Hairline, slug and "Page 2 of 7" on every page. Call once, after the layout. */
  footers(text) {
    const s = toWinAnsi(text);
    this.pages.forEach((page, i) => {
      const label = `Page ${i + 1} of ${this.pages.length}`;
      const y = this.footerY;
      page.ops.push(
        `q ${paint(COLOR.line, true)} 0.7 w ${num(this.margin)} ${num(y + 13)} m ` +
          `${num(this.right)} ${num(y + 13)} l S Q`
      );
      if (s) {
        page.ops.push(
          `BT /F1 8 Tf ${paint(COLOR.faint)} ${num(this.margin)} ${num(y)} Td ` +
            `(${escapeText(s)}) Tj ET`
        );
      }
      const x = this.right - widthOf(label, 'reg', 8);
      page.ops.push(
        `BT /F1 8 Tf ${paint(COLOR.muted)} ${num(x)} ${num(y)} Td (${escapeText(label)}) Tj ET`
      );
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

    const kids = this.pages.map((page) => {
      const stream = page.bg.concat(page.ops).join('\n');
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
        `/Producer (Exam Questions to PDF) /CreationDate (${stamp}) >>`
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

const CHOICE_LETTER_X = 12; // gutter for "A.", from the card's left edge
const CHOICE_TEXT_X = 30; // where the choice's own text starts
const CARD_PAD_RIGHT = 14;

/** Splits on the marker cleanText() leaves behind for an <img>, keeping the URL. */
const IMG_SPLIT = /\[IMG:\s*([^\]]+?)\s*\]/;

/**
 * Text that may carry [IMG: url] markers. A marker becomes the image itself when it was
 * fetched, and stays as its original text when it was not (blocked host, dead link), so
 * nothing silently vanishes from the export.
 */
function blockWithImages(doc, text, images, opts = {}) {
  const { label = '', indent = 0, rightInset = 0, ...rest } = opts;
  const parts = String(text ?? '').split(IMG_SPLIT);
  let pending = label; // hanging marker ("B.") still waiting for its first line
  let drew = false;

  parts.forEach((part, i) => {
    if (i % 2) {
      const desc = images && images.get(part);
      if (desc) {
        if (pending) doc.paragraph('', { ...rest, indent, rightInset, label: pending });
        doc.image(desc, { indent, rightInset });
      } else {
        doc.paragraph(`[IMG: ${part}]`, {
          ...rest,
          indent,
          rightInset,
          label: pending,
          color: COLOR.faint,
        });
      }
    } else {
      const chunk = part.trim();
      if (!chunk) return;
      doc.paragraph(chunk, { ...rest, indent, rightInset, label: pending });
    }
    pending = '';
    drew = true;
  });

  if (!drew && pending) doc.paragraph('', { ...rest, indent, rightInset, label: pending });
}

/**
 * Sites that publish a rationale under each option leave it in the choice's own text,
 * one hard line below the option itself. Splitting the two lets the option read as the
 * answer and the rationale as a supporting note. Anything not of that shape — a single
 * line, an image, a first line as long as the rest — is returned untouched.
 */
function splitChoice(text) {
  const raw = String(text ?? '');
  if (raw.includes('[IMG:')) return [raw, ''];
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (lines.length < 2 || lines[0].length > 120) return [raw, ''];
  const rest = lines.slice(1).join('\n');
  return rest.length > lines[0].length ? [lines[0], rest] : [raw, ''];
}

/**
 * Hotspot and drag-drop questions put a whole "Answer Area" image inside the site's
 * correct-answer box, above the prose that walks through it. That image is explanation
 * material, not an answer key of its own, so an image-only correct answer is handed back
 * as the second half of the pair and rendered with the explanation. Anything with real
 * text alongside — a letter, a sentence — stays an answer.
 */
function splitAnswerImages(correctAnswer) {
  const raw = String(correctAnswer ?? '');
  if (!raw.includes('[IMG:')) return [raw, ''];
  const words = raw
    .split(IMG_SPLIT)
    .filter((_, i) => i % 2 === 0)
    .join(' ')
    .trim();
  return words ? [raw, ''] : ['', raw];
}

/** The sky band that opens every question. */
function questionHeader(doc, q, index) {
  const h = 23;
  // Keep the band with the first lines of its question rather than orphaning it.
  doc.reserve(h + 46);
  doc.y -= h;
  doc.box(doc.margin, doc.y, doc.right - doc.margin, h, { fill: COLOR.sky, radius: 5 });
  doc.draw(
    toWinAnsi(`Question #${q.question_number || index + 1}`),
    doc.margin + 12,
    doc.y + 7.4,
    'bold',
    10.5,
    COLOR.white
  );
  const topic = toWinAnsi(q.topic || '');
  if (topic) doc.drawRight(topic, doc.right - 12, doc.y + 7.6, 'reg', 8.5, COLOR.skyPale);
  doc.y -= 9;
}

/** The tick that marks the correct option, where the site shows one. */
function checkMark(doc, x, y, size = 9) {
  const s = size / 9;
  doc.ops.push(
    `q ${paint(COLOR.good, true)} 1.4 w 1 J 1 j ` +
      `${num(x)} ${num(y + 3.4 * s)} m ${num(x + 3 * s)} ${num(y + 0.6 * s)} l ` +
      `${num(x + 8.4 * s)} ${num(y + 7 * s)} l S Q`
  );
}

/** One option: a bordered card, tinted green when it is the marked answer. */
function choiceCard(doc, choice, images) {
  const correct = !!choice.markedCorrect;
  const [head, why] = splitChoice(choice.text);
  const rightInset = correct ? CARD_PAD_RIGHT + 16 : CARD_PAD_RIGHT;

  doc.beginBlock({
    fill: correct ? COLOR.goodTint : null,
    stroke: correct ? COLOR.goodEdge : COLOR.line,
    radius: 4.5,
    padTop: 7.5,
    padBottom: 7.5,
    minHeight: 30,
  });

  const top = doc.y;
  const page = doc.page;
  blockWithImages(doc, head, images, {
    size: 9.8,
    leading: 13,
    color: COLOR.ink,
    font: correct ? 'bold' : 'reg',
    indent: CHOICE_TEXT_X,
    rightInset,
    label: choice.letter ? `${choice.letter}.` : '•',
    labelFont: 'bold',
    labelColor: correct ? COLOR.good : COLOR.muted,
    labelIndent: CHOICE_LETTER_X,
  });
  // Skipped when the option spilled onto the next page, where the tick would end up
  // beside nothing.
  if (correct && doc.page === page) checkMark(doc, doc.right - CARD_PAD_RIGHT - 10, top - 11);

  if (why) {
    doc.gap(3);
    doc.beginBlock({
      indent: CHOICE_TEXT_X,
      bar: 1.6,
      barColor: correct ? COLOR.goodEdge : COLOR.line,
      padTop: 1,
      padBottom: 1,
      minHeight: 16,
    });
    blockWithImages(doc, why, images, {
      size: 8.8,
      leading: 11.6,
      color: COLOR.muted,
      indent: CHOICE_TEXT_X + 9,
      rightInset: CARD_PAD_RIGHT,
    });
    doc.endBlock();
  }

  doc.endBlock();
  doc.gap(5);
}

/** A row of small pills: the answer key, and the crowd's pick. */
function badgeRow(doc, items) {
  const size = 8.5;
  const h = 15;
  const padX = 8;
  doc.reserve(h * 2 + 6);
  doc.y -= h;
  let x = doc.margin;
  for (const item of items) {
    const s = toWinAnsi(item.text);
    const w = widthOf(s, 'bold', size) + padX * 2;
    if (x > doc.margin && x + w > doc.right) {
      doc.y -= h + 4;
      x = doc.margin;
    }
    doc.box(x, doc.y, Math.min(w, doc.right - x), h, {
      fill: item.fill,
      stroke: item.stroke || null,
      radius: 3.5,
    });
    doc.draw(s, x + padX, doc.y + 4.6, 'bold', size, item.color);
    x += w + 6;
  }
}

function questionBlock(doc, q, index, images) {
  questionHeader(doc, q, index);

  const bits = [
    q.question_id && `ID ${q.question_id}`,
    q.source_page && `source page ${q.source_page}`,
    q.discussion_count && `${q.discussion_count} comments`,
  ].filter(Boolean);
  if (bits.length) {
    doc.paragraph(bits.join('  •  '), { size: 8, color: COLOR.faint, leading: 10.5 });
    doc.gap(1);
  }

  if (q.question_text) {
    doc.gap(3);
    blockWithImages(doc, q.question_text, images, { size: 10.2, leading: 13.8, color: COLOR.ink });
  }

  if (q.choices?.length) {
    doc.gap(8);
    for (const c of q.choices) choiceCard(doc, c, images);
  }

  doc.gap(3);
  const [answerText, answerImages] = splitAnswerImages(q.correct_answer);
  // Not always a letter: a few sites give a whole sentence, which does not fit in a pill,
  // so those keep the block form below.
  const answerLine = answerText ? `Correct answer: ${answerText}` : '';
  const asPill =
    answerLine &&
    !answerLine.includes('[IMG:') &&
    widthOf(toWinAnsi(answerLine), 'bold', 8.5) + 16 <= doc.right - doc.margin;
  const pills = [];
  if (asPill) pills.push({ text: answerLine, fill: COLOR.good, color: COLOR.white });
  if (q.most_voted) {
    const votes = q.total_votes ? ` (${q.total_votes} votes)` : '';
    pills.push({
      text: `Most voted: ${q.most_voted}${votes}`,
      fill: COLOR.skyPale,
      stroke: COLOR.skyEdge,
      color: COLOR.skyDeep,
    });
  }
  // The answer always comes first, whichever shape it took.
  if (answerText && !asPill) {
    doc.paragraph('Correct answer', { font: 'bold', size: 9, color: COLOR.good, leading: 12 });
    blockWithImages(doc, answerText, images, { size: 9.5, leading: 12, color: COLOR.body });
    doc.gap(2);
  }
  if (pills.length) badgeRow(doc, pills);
  if (q.vote_distribution) {
    doc.gap(2);
    doc.paragraph(q.vote_distribution, { size: 8, color: COLOR.faint, leading: 10.5 });
  }

  const explanation = [answerImages, q.answer_description].filter(Boolean).join('\n');
  if (explanation) {
    doc.gap(7);
    doc.beginBlock({
      fill: COLOR.skyTint,
      stroke: COLOR.skyEdge,
      radius: 4,
      bar: 3,
      barColor: COLOR.sky,
      padTop: 8,
      padBottom: 8,
      minHeight: 34,
    });
    doc.paragraph('EXPLANATION', {
      font: 'bold',
      size: 7.6,
      color: COLOR.skyDeep,
      leading: 10,
      indent: 14,
    });
    doc.gap(1);
    blockWithImages(doc, explanation, images, {
      size: 9,
      leading: 12,
      color: COLOR.body,
      indent: 14,
      rightInset: CARD_PAD_RIGHT,
    });
    doc.endBlock();
  }
}

/** The sky banner on page one: exam name, with the page title underneath. */
function coverBanner(doc, exam, heading) {
  const width = doc.right - doc.margin;
  const subtitle =
    exam.title && exam.title !== heading
      ? wrap(toWinAnsi(exam.title), 'reg', 9.5, width - 32).slice(0, 2)
      : [];
  const h = 44 + subtitle.length * 12;

  doc.y -= h;
  doc.box(doc.margin, doc.y, width, h, { fill: COLOR.skyDark, radius: 7 });
  doc.draw(toWinAnsi(heading), doc.margin + 16, doc.y + h - 26, 'bold', 17, COLOR.white);
  subtitle.forEach((line, i) => {
    doc.draw(line, doc.margin + 16, doc.y + h - 40 - i * 12, 'reg', 9.5, COLOR.skyPale);
  });
  doc.y -= 10;
}

/**
 * One exam -> PDF bytes. `questions` is the flattened, deduped list the popup already
 * builds, `summary` the same one-line summary shown on the exam card, and `images` the
 * Map(url -> descriptor) from images.js — omit it and the [IMG: url] markers stay text.
 */
function buildExamPdf(exam, questions, summary = '', images = null) {
  const doc = new Pdf();
  const heading = exam.exam_slug || exam.exam_key || 'exam';

  coverBanner(doc, exam, heading);
  const exported = `exported ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  doc.paragraph([summary, exported].filter(Boolean).join('  •  '), {
    size: 8.5,
    color: COLOR.muted,
    leading: 11,
  });
  if (exam.exam_key) doc.paragraph(exam.exam_key, { size: 8.5, color: COLOR.faint, leading: 11 });
  doc.rule();

  if (!questions.length) {
    doc.gap(6);
    doc.paragraph('No questions collected for this exam.', { size: 10, color: COLOR.muted });
  }
  questions.forEach((q, i) => {
    doc.gap(i ? 16 : 6);
    questionBlock(doc, q, i, images);
  });

  doc.footers(heading);
  return doc.build({ title: heading, subject: exam.exam_key || '' });
}
