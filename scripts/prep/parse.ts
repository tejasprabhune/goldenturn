/**
 * Reads a prep backfile (the markdown prep-gen writes and builds into a Google
 * Doc) into its blocks.
 *
 * The format is the one prep-gen's build scripts accept: `#` file title, `##`
 * block family, `###` block, an italic *Use* line opening each block, then
 * paragraphs and lists nested by four spaces ("1. " numbered, "- " bulleted)
 * with **bold**, *italic* and [text](url). The HTML is rendered the way
 * prep-gen/scripts/build_html.py renders it, minus the inline styles, so what
 * the page shows and what the doc says are the same structure.
 */

export interface ParsedBlock {
  family: string;
  title: string;
  use: string;
  /** The block's markdown after the Use line. */
  body: string;
}

export interface ParsedFile {
  title: string;
  blocks: ParsedBlock[];
  /** The Freshness table's "Checked M/D/YY" date as YYYY-MM-DD, if stated. */
  freshness: string | null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface Link {
  start: number;
  end: number;
  text: string;
  url: string;
}

/**
 * Markdown links, scanned rather than matched with a regex, because sources
 * such as Wikipedia carry parentheses inside the URL
 * (`National_Security_Strategy_(United_States)`). A bracket with no `(` after it
 * is a slot like [PLAN ACTION], not a link.
 */
function findLinks(s: string): Link[] {
  const out: Link[] = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf('[', i);
    if (open < 0) break;
    const close = s.indexOf(']', open + 1);
    if (close < 0) break;
    if (s[close + 1] !== '(') {
      i = open + 1;
      continue;
    }
    let depth = 0;
    let j = close + 1;
    for (; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')' && --depth === 0) break;
      else if (/\s/.test(s[j])) { j = -1; break; }
    }
    if (j < 0 || j >= s.length) {
      i = open + 1;
      continue;
    }
    out.push({ start: open, end: j + 1, text: s.slice(open + 1, close), url: s.slice(close + 2, j) });
    i = j + 1;
  }
  return out;
}

function emphasis(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '<i>$1</i>');
}

/** One line of markdown as HTML. */
export function inlineHtml(s: string): string {
  let out = '';
  let at = 0;
  for (const l of findLinks(s)) {
    out += emphasis(escapeHtml(s.slice(at, l.start)));
    // The page renders this HTML as is, so only web and mail links survive.
    out += /^(https?:|mailto:)/i.test(l.url)
      ? `<a href="${escapeHtml(l.url)}">${emphasis(escapeHtml(l.text))}</a>`
      : emphasis(escapeHtml(l.text));
    at = l.end;
  }
  return out + emphasis(escapeHtml(s.slice(at)));
}

/** One line of markdown as the words a reader hears. */
export function inlineText(s: string): string {
  let out = '';
  let at = 0;
  for (const l of findLinks(s)) {
    out += s.slice(at, l.start) + l.text;
    at = l.end;
  }
  return (out + s.slice(at)).replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '$1');
}

const LIST_RE = /^( *)(\d+\.|-) +(.*)$/;

/**
 * A block body as HTML. Lists open and close by indent the way build_html.py
 * does it, so a sub-point sits inside its parent's <li> and numbering
 * restarts under each parent, as in the doc.
 */
export function bodyHtml(md: string): string {
  const out: string[] = [];
  const stack: string[] = [];
  const close = (to = 0) => {
    while (stack.length > to) out.push(`</li></${stack.pop()}>`);
  };

  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const m = line.match(LIST_RE);
    if (m) {
      const level = Math.floor(m[1].length / 4) + 1;
      const tag = /^\d/.test(m[2]) ? 'ol' : 'ul';
      if (level > stack.length) {
        while (level > stack.length) {
          out.push(`<${tag}>`);
          stack.push(tag);
        }
      } else {
        close(level);
        if (stack[stack.length - 1] !== tag) {
          out.push(`</li></${stack.pop()}><${tag}>`);
          stack.push(tag);
        } else {
          out.push('</li>');
        }
      }
      out.push(`<li>${inlineHtml(m[3])}`);
      continue;
    }
    close();
    if (!line.trim()) continue;
    out.push(`<p>${inlineHtml(line.trim())}</p>`);
  }
  close();
  return out.join('');
}

/** A block body as plain words, one list item or paragraph per line. */
export function bodyText(md: string): string {
  return md
    .split('\n')
    .map(line => {
      const m = line.match(LIST_RE);
      return inlineText((m ? m[3] : line).trim());
    })
    .filter(Boolean)
    .join('\n');
}

/** "Checked 11/13/26." as 2026-11-13. */
function parseChecked(s: string): string | null {
  // The house format is "Checked Nov 13, 2026"; older files wrote 11/13/26.
  const w = s.match(/Checked\s+([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (w) {
    const month = 'JanFebMarAprMayJunJulAugSepOctNovDec'.indexOf(w[1]) / 3 + 1;
    if (Number.isInteger(month) && month >= 1) {
      return `${w[3]}-${String(month).padStart(2, '0')}-${w[2].padStart(2, '0')}`;
    }
  }
  const m = s.match(/Checked\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (!m) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** Strip the asterisks off an italic line: `*Use for ...*` is `Use for ...`. */
function unitalic(s: string): string {
  const t = s.trim();
  const m = t.match(/^\*(?!\*)([\s\S]*?)\*$/) ?? t.match(/^_([\s\S]*?)_$/);
  return m ? m[1].trim() : t;
}

export function parseFile(md: string): ParsedFile {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let title = '';
  let family = '';
  let freshness: string | null = null;
  const blocks: ParsedBlock[] = [];
  let current: { family: string; title: string; lines: string[] } | null = null;

  const finish = () => {
    if (!current) return;
    // The Use line is the first non-blank line, when it is italic and says Use.
    const body = current.lines.slice();
    while (body.length && !body[0].trim()) body.shift();
    let use = '';
    if (body.length && /^\*?_?\s*Use\b/i.test(unitalic(body[0])) && /^[*_]/.test(body[0].trim())) {
      use = unitalic(body.shift()!);
    }
    blocks.push({
      family: current.family,
      title: current.title,
      use,
      body: body.join('\n').trim(),
    });
    current = null;
  };

  for (const line of lines) {
    const h = line.match(/^(#{1,3}) +(.*?)\s*$/);
    if (h) {
      finish();
      const text = h[2];
      if (h[1] === '#') title = text;
      else if (h[1] === '##') family = text;
      else current = { family, title: text, lines: [] };
      continue;
    }
    if (/^freshness$/i.test(family) && freshness === null) freshness = parseChecked(line);
    if (current) current.lines.push(line);
  }
  finish();

  return { title, blocks, freshness };
}
