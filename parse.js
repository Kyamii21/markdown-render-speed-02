// SwiftMark — a fast CommonMark 0.31.2 + GFM renderer.
//
// Written from scratch for the make.fun "Make Markdown rendering faster"
// bounty. It renders exactly the HTML that marked 18.1.3 produces with its
// default options (GFM on, breaks off, pedantic off, async off), but with a
// single-pass design instead of marked's tokenizer/renderer pipeline:
//
//   - one block pass over the document's lines, building a small tree of
//     block nodes (no per-block regexes, no token objects per span);
//   - one inline pass per leaf block: a char scanner with a delimiter stack
//     (the CommonMark emphasis algorithm) and recursive link-text parsing,
//     so delimiters can never match across a link boundary;
//   - link reference definitions are collected during the block pass and
//     inline rendering runs after, so definitions apply wherever they occur.
//
// Behavioural notes (all verified against marked 18.1.3 on the practice set):
//   - named character references (&copy; etc.) are passed through verbatim;
//     only numeric references (&#169; &#xA9;) are decoded, with 0, surrogates
//     and out-of-range values becoming U+FFFD;
//   - hrefs are encodeURI'd, then HTML-escaped without double-escaping
//     entity-looking sequences (&name; &#123; &#xAB;);
//   - extended autolinks: www. and http(s):// and ftp:// URLs, plus email
//     addresses (with an optional lowercase "mailto:" prefix); none of them
//     are recognised inside link text, while <...> autolinks are.

/** ASCII punctuation, per CommonMark (used for backslash escapes and flanking). */
const ASCII_PUNCT = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

/** Lookup: char code (0..127) -> 1 if ASCII punctuation, else 0. */
const IS_PUNCT_ASCII = new Uint8Array(128);
for (let i = 0; i < ASCII_PUNCT.length; i++) IS_PUNCT_ASCII[ASCII_PUNCT.charCodeAt(i)] = 1;

/** Unicode punctuation test, for non-ASCII characters only: CommonMark
 * counts Unicode categories P (punctuation) and S (symbols) as
 * punctuation, so e.g. £ and € are punctuation for flanking purposes. */
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
/** Unicode whitespace test, for non-ASCII characters only. */
const UNICODE_SPACE_RE = /\s/u;

function isSpaceCh(ch) {
  if (ch === null || ch === undefined) return false;
  const c = ch.charCodeAt(0);
  if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) return true;
  if (c < 128) return false;
  return UNICODE_SPACE_RE.test(ch);
}

function isPunctCh(ch) {
  if (ch === null || ch === undefined) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return IS_PUNCT_ASCII[c] === 1;
  return UNICODE_PUNCT_RE.test(ch);
}

function isAsciiPunctCode(code) {
  return code < 128 && IS_PUNCT_ASCII[code] === 1;
}

/** Escape &, <, >, ", ' — every & is escaped (code spans, fenced code). */
const ESC_TEST = /[&<>"']/;
function escPlain(s) {
  if (!ESC_TEST.test(s)) return s;
  // One native pass per character class; the common case (no specials) is a
  // single cheap test above.
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Escape for hrefs, titles and language names: like escPlain, except an &
 * that starts an entity-looking sequence (&word; &#123; &#xAB;) is left as
 * it is, exactly as marked's no-encode escape does.
 */
const ESC_ATTR_AMP_RE = /&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|[A-Za-z0-9_]+);)/g;
function escAttr(s) {
  if (!ESC_TEST.test(s)) return s;
  return s
    .replace(ESC_ATTR_AMP_RE, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve backslash escapes in a link destination, title or label: a
 * backslash before an ASCII punctuation character yields that character.
 */
function unescapeStr(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 && i + 1 < s.length && isAsciiPunctCode(s.charCodeAt(i + 1))) {
      out += s.slice(start, i) + s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

/** Percent-encode a href the way encodeURI does, without throwing on lone surrogates. */
function manualEncodeHref(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 128) {
      const ch = s[i];
      // encodeURI leaves ; , / ? : @ & = + $ - _ . ! ~ * ' ( ) # alone.
      if (
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) ||
        ch === ';' || ch === ',' || ch === '/' || ch === '?' || ch === ':' || ch === '@' ||
        ch === '&' || ch === '=' || ch === '+' || ch === '$' || ch === '-' || ch === '_' ||
        ch === '.' || ch === '!' || ch === '~' || ch === '*' || ch === "'" || ch === '(' ||
        ch === ')' || ch === '#' || ch === '%'
      ) {
        out += ch;
      } else {
        out += '%' + code.toString(16).toUpperCase().padStart(2, '0');
      }
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        const cp = 0x10000 + ((code - 0xd800) << 10) + (lo - 0xdc00);
        out +=
          '%' + (0xf0 | (cp >> 18)).toString(16).toUpperCase() +
          '%' + (0x80 | ((cp >> 12) & 0x3f)).toString(16).toUpperCase() +
          '%' + (0x80 | ((cp >> 6) & 0x3f)).toString(16).toUpperCase() +
          '%' + (0x80 | (cp & 0x3f)).toString(16).toUpperCase();
        i++;
      } else {
        out += '%EF%BF%BD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += '%EF%BF%BD';
    } else if (code < 0x800) {
      out += '%' + (0xc0 | (code >> 6)).toString(16).toUpperCase() + '%' + (0x80 | (code & 0x3f)).toString(16).toUpperCase();
    } else {
      out +=
        '%' + (0xe0 | (code >> 12)).toString(16).toUpperCase() +
        '%' + (0x80 | ((code >> 6) & 0x3f)).toString(16).toUpperCase() +
        '%' + (0x80 | (code & 0x3f)).toString(16).toUpperCase();
    }
  }
  return out;
}

/** A link destination as marked renders it in href="...": unescape,
 * encodeURI, then restore '%' (marked's `he` is
 * `encodeURI(a).replace(/%25/g, '%')`, so an existing %XX escape — and a
 * bare '%' — stays as written). */
function hrefOf(rawDest) {
  const dest = unescapeStr(rawDest);
  let encoded;
  try {
    encoded = encodeURI(dest).replace(/%25/g, '%');
  } catch {
    encoded = manualEncodeHref(dest);
  }
  return escAttr(encoded);
}

/** A link title as marked renders it in title="...". */
function titleOf(rawTitle) {
  return escAttr(unescapeStr(rawTitle));
}

/**
 * Normalise a link label for definition lookup: collapse runs of
 * whitespace (including newlines) to one space, trim, and case-fold — the
 * same normalisation for definitions and for uses. Backslash escapes are
 * NOT resolved: the label `foo\!` does not match the definition `foo!`.
 * Case folding is Unicode full case folding: `toLowerCase` handles most
 * characters, but the multi-character foldings (ß/ẞ → ss, ligatures) and
 * the final sigma (ς → σ) need a small table.
 */
const CASE_FOLD_EXTRA = {
  'ß': 'ss',
  'ẞ': 'ss',
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
  'ﬅ': 'st',
  'ﬆ': 'st',
  'ς': 'σ',
};
function normalizeLabel(raw) {
  let out = '';
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13) {
      if (started) pendingSpace = true;
    } else {
      if (pendingSpace) {
        out += ' ';
        pendingSpace = false;
      }
      const ch = raw[i];
      out += CASE_FOLD_EXTRA[ch] || ch;
      started = true;
    }
  }
  return out.toLowerCase();
}


// ---------------------------------------------------------------------------
// Inline parsing
//
// Node types: 0 text, 1 code span, 2 raw HTML, 3 hard break, 4 delimiter
// run, 5 emphasis/strong/del wrapper, 6 link, 7 image, 8 autolink,
// 9 open bracket (unmatched -> literal '['), 10 '!' before a possible image.
// Nodes form a doubly linked list (n/p) inside one parent (par, null at the
// top level); wrappers and links hold their children as fc/lc lists.
// Delimiter nodes are additionally linked through dn/dp for emphasis
// processing. Link text is parsed by a recursive call, so a delimiter inside
// link text can never match one outside it.

const T_TEXT = 0;
const T_CODE = 1;
const T_HTML = 2;
const T_BR = 3;
const T_DELIM = 4;
const T_WRAP = 5;
const T_LINK = 6;
const T_IMG = 7;
const T_AUTO = 8;
const T_BRACKET = 9;
const T_BANG = 10;

const WRAP_EM = 0;
const WRAP_STRONG = 1;
const WRAP_DEL = 2;

/** Append a node to the top-level list of an inline state. */
function listAppend(st, node) {
  node.p = st.tail;
  node.n = null;
  node.par = null;
  if (st.tail) st.tail.n = node;
  else st.head = node;
  st.tail = node;
  return node;
}

/** Remove a node from whichever list it is in (top level or a wrapper). */
function listRemove(st, node) {
  const parent = node.par;
  if (node.p) node.p.n = node.n;
  else if (parent) parent.fc = node.n;
  else st.head = node.n;
  if (node.n) node.n.p = node.p;
  else if (parent) parent.lc = node.p;
  else st.tail = node.p;
  node.p = null;
  node.n = null;
}

/** Remove a delimiter node from the delimiter list. */
function delimRemove(st, node) {
  if (node.dp) node.dp.dn = node.dn;
  else st.dHead = node.dn;
  if (node.dn) node.dn.dp = node.dp;
  else st.dTail = node.dp;
  node.dp = null;
  node.dn = null;
}

function delimAppend(st, node) {
  node.dp = st.dTail;
  node.dn = null;
  if (st.dTail) st.dTail.dn = node;
  else st.dHead = node;
  st.dTail = node;
}

/** Render a node list to HTML (plain=true renders text content only). */
function renderList(head, plain) {
  const out = [];
  for (let node = head; node; node = node.n) {
    switch (node.t) {
      case T_TEXT:
        out.push(plain || node.raw ? node.s : escPlain(node.s));
        break;
      case T_CODE:
        out.push(plain ? node.s : '<code>' + escPlain(node.s) + '</code>');
        break;
      case T_HTML:
        out.push(node.s);
        break;
      case T_BR:
        if (!plain) out.push('<br>');
        break;
      case T_DELIM: {
        let s = '';
        for (let k = 0; k < node.len; k++) s += node.ch;
        out.push(s);
        break;
      }
      case T_WRAP: {
        const inner = renderList(node.fc, plain);
        if (plain) out.push(inner);
        else if (node.kind === WRAP_EM) out.push('<em>' + inner + '</em>');
        else if (node.kind === WRAP_STRONG) out.push('<strong>' + inner + '</strong>');
        else out.push('<del>' + inner + '</del>');
        break;
      }
      case T_LINK: {
        if (plain) {
          out.push(node.plain);
        } else {
          out.push('<a href="' + node.href + '"' + (node.title !== null ? ' title="' + node.title + '"' : '') + '>' + node.html + '</a>');
        }
        break;
      }
      case T_IMG: {
        if (plain) out.push(node.alt);
        else {
          out.push('<img src="' + node.href + '" alt="' + node.alt + '"' + (node.title !== null ? ' title="' + node.title + '"' : '') + '>');
        }
        break;
      }
      case T_AUTO: {
        if (plain) out.push(node.s);
        else out.push('<a href="' + node.href + '">' + escPlain(node.s) + '</a>');
        break;
      }
      case T_BRACKET:
        out.push('[');
        break;
      case T_BANG:
        out.push('!');
        break;
    }
  }
  return out.join('');
}

/**
 * marked's emphasis algorithm (its emStrong / del tokenizers), opener-first
 * instead of the CommonMark spec appendix's closer-first scan. For each
 * delimiter that can open, scan forward for a closer of the same character:
 * `m` starts at the opener's length and accumulates the lengths of
 * opener-only runs between opener and closer; a closer is skipped while `m`
 * stays positive after subtracting its length. A "both" closer — or any
 * closer when the opener's R flag is set — is also skipped by the odd-match
 * rule when the opener's length is not a multiple of 3 but the sum of
 * opener+closer lengths is, and its length goes to `f`. On a match, `b` is
 * the closer's length clamped by `b + m + f`, and `use` is the smaller of
 * the opener's length and `b` (odd -> em, even -> strong). The wrapper only
 * consumes 1 delimiter from each end for em and 2 for strong, so the
 * opener's/closer's leftover delimiters belong to the wrapper's inner text:
 * they are moved inside the wrapper as its first/last child, and the
 * opener's leftover is re-processed before moving on (marked re-parses the
 * inner text recursively). For `~` the closer must have the same length as
 * the opener, there is no odd-match rule, and both sides are fully consumed.
 * Two run-splitting cases: when an opener finds no closer, marked retries
 * one delimiter shorter, so one delimiter is peeled off as literal text and
 * the rest is retried; and when the closer is longer than the clamped `b`,
 * its tail stays outside the wrapper as a fresh run. The scan stays inside
 * the opener's wrapper: a delimiter whose parent differs is outside the
 * scope.
 */
function processEmphasis(st) {
  let cur = st.dHead;
  while (cur) {
    let next = cur.dn;
    if (cur.canOpen) {
      const par = cur.par;
      const y = cur.len;
      let m = cur.len;
      let f = 0;
      let found = null;
      let use = 0;
      let b2 = 0;
      // marked's right-delimiter regex starts with a skip pattern: for a
      // `*` opener, a `__...*...__` span at the very start of the scan is
      // jumped over, so the single `*` inside it is not counted as an
      // opener-only run (and symmetrically for a `_` opener with a
      // `**..._...**` span). The outer runs must be exactly 2 long and the
      // inner run exactly 1, or the regex backtracks and the skip fails.
      let skipNode = null;
      if (cur.ch === '*' || cur.ch === '_') {
        const other = cur.ch === '*' ? '_' : '*';
        const d1 = cur.dn;
        const d2 = d1 && d1.par === par ? d1.dn : null;
        const d3 = d2 && d2.par === par ? d2.dn : null;
        if (d1 && d1.par === par && d1.ch === other && d1.len === 2 &&
            d2 && d2.par === par && d2.ch === cur.ch && d2.len === 1 &&
            d3 && d3.par === par && d3.ch === other && d3.len >= 2) {
          skipNode = d2;
        }
      }
      for (let scan = cur.dn; scan && scan.par === par; scan = scan.dn) {
        if (scan === skipNode) continue;
        if (scan.ch !== cur.ch) continue;
        const b = scan.len;
        if (cur.ch === '~') {
          if (b !== cur.len) continue;
          if (scan.canOpen && !scan.canClose) { m += b; continue; }
          if (!scan.canClose) continue;
          m -= b;
          if (m > 0) continue;
          found = scan;
          use = b;
          b2 = b;
          break;
        }
        if (scan.canOpen && !scan.canClose) { m += b; continue; }
        if (!scan.canClose) continue;
        if ((scan.canOpen && scan.canClose) || cur.R) {
          if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
        }
        m -= b;
        if (m > 0) continue;
        b2 = Math.min(b, b + m + f);
        use = Math.min(cur.len, b2);
        found = scan;
        break;
      }
      if (found) {
        const kind = cur.ch === '~' ? WRAP_DEL : use % 2 === 1 ? WRAP_EM : WRAP_STRONG;
        // The wrapper consumes `strip` delimiters from each end. Of the
        // closer's `b2` delimiters used in the raw match, `b2 - strip` stay
        // inside the wrapper as its last child; the closer's remaining
        // `found.len - b2` delimiters stay outside, after the wrapper.
        const strip = kind === WRAP_DEL ? cur.len : kind === WRAP_EM ? 1 : 2;
        const insideLen = b2 - strip;
        const outsideLen = found.len - b2;
        const afterFound = found.dn;
        cur.len -= strip;
        found.len = insideLen;
        const wrap = { t: T_WRAP, kind, fc: null, lc: null, n: null, p: null, par: cur.par };
        const first = cur.n === found ? null : cur.n;
        const last = cur.n === found ? null : found.p;
        const prevO = cur.p;
        const nextC = found.n;
        for (let nd = first; nd && nd !== found; nd = nd.n) nd.par = wrap;
        // Build the wrapper's children: opener leftover, middle nodes,
        // closer leftover (only the part inside the match).
        let fc = null;
        let lc = null;
        if (cur.len > 0) { fc = lc = cur; cur.par = wrap; }
        if (first) {
          if (!fc) fc = first;
          else lc.n = first;
          first.p = lc;
          lc = last;
        }
        if (insideLen > 0) {
          if (!fc) fc = found;
          else lc.n = found;
          found.p = lc;
          found.par = wrap;
          lc = found;
        }
        if (fc) fc.p = null;
        if (lc) lc.n = null;
        wrap.fc = fc;
        wrap.lc = lc;
        // Splice the wrapper into its parent list (the top-level list, or
        // the enclosing wrapper's child list) in place of the
        // opener..closer range. `par` is the opener's parent scope,
        // captured before the child building re-parents the opener.
        wrap.p = prevO;
        if (prevO) prevO.n = wrap;
        else if (par) par.fc = wrap;
        else st.head = wrap;
        wrap.n = nextC;
        if (nextC) nextC.p = wrap;
        else if (par) par.lc = wrap;
        else st.tail = wrap;
        if (cur.len === 0) delimRemove(st, cur);
        if (insideLen === 0 && outsideLen === 0) delimRemove(st, found);
        // The closer's tail stays outside the wrapper, after it: it starts
        // a fresh run (no preceding char), so it can open but never close.
        if (outsideLen > 0) {
          const [oOpen, oClose] = flankFlagsChars(null, found.after, found.ch);
          const outNode = { t: 4, ch: found.ch, len: outsideLen, olen: outsideLen, canOpen: oOpen, canClose: oClose, R: false, after: found.after, dn: null, dp: null, par };
          outNode.p = wrap;
          outNode.n = wrap.n;
          if (wrap.n) wrap.n.p = outNode;
          else if (par) par.lc = outNode;
          else st.tail = outNode;
          wrap.n = outNode;
          outNode.dp = found;
          outNode.dn = found.dn;
          if (found.dn) found.dn.dp = outNode;
          else st.dTail = outNode;
          found.dn = outNode;
          if (insideLen === 0) delimRemove(st, found);
        }
        // If the next delimiter to process was the closer and it has just
        // been removed from the list, skip on to the one after it instead
        // of re-processing a dead node (which the peel logic would then
        // splice back into the wrapper's children).
        if (insideLen === 0 && next === found) next = afterFound;
        if (cur.len > 0) {
          // The opener's leftover is the wrapper's first child: re-process
          // it as an opener inside the wrapper before moving on.
          continue;
        }
      } else if (cur.len > 1) {
        // No closer: marked tries the run again one delimiter shorter, with
        // the first delimiter emitted as literal text. Peel one off the
        // front and retry the rest (now preceded by a delimiter char).
        const peel = { t: 0, s: cur.ch, raw: false, n: null, p: null, par };
        peel.p = cur.p;
        if (cur.p) cur.p.n = peel;
        else if (par) par.fc = peel;
        else st.head = peel;
        peel.n = cur;
        cur.p = peel;
        cur.len -= 1;
        const [nOpen, nClose] = flankFlagsChars(cur.ch, cur.after, cur.ch);
        cur.canOpen = nOpen;
        cur.canClose = nClose;
        cur.R = cur.after !== null && isPunctCh(cur.after);
        if (cur.canOpen) continue;
      }
    }
    cur = next;
  }
}


// ---------------------------------------------------------------------------
// Inline scanner helpers

function isAsciiLetter(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isDigit(code) {
  return code >= 48 && code <= 57;
}
function isHex(code) {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

/** An autolink href: encodeURI, then escape every & (no entity passthrough),
 * and restore '%' like marked's `he` does for link destinations. */
function hrefOfAuto(raw) {
  let encoded;
  try {
    encoded = encodeURI(raw).replace(/%25/g, '%');
  } catch {
    encoded = manualEncodeHref(raw);
  }
  return escPlain(encoded);
}

/** Decode one character reference at src[i] ('&...;'), or null. */
function tryEntity(src, i) {
  const n = src.length;
  if (src.charCodeAt(i + 1) === 35) {
    // Numeric: &#123; or &#x1F600; (uppercase X allowed).
    let j = i + 2;
    let hex = false;
    if (src[j] === 'x' || src[j] === 'X') {
      hex = true;
      j++;
    }
    const start = j;
    if (hex) {
      while (j < n && isHex(src.charCodeAt(j))) j++;
    } else {
      while (j < n && isDigit(src.charCodeAt(j))) j++;
    }
    // A numeric reference holds at most 7 decimal digits or 6 hex digits.
    if (hex ? j - start > 6 : j - start > 7) return null;
    if (j > start && src[j] === ';') {
      const num = hex ? parseInt(src.slice(start, j), 16) : parseInt(src.slice(start, j), 10);
      const cp = !num || num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff) ? 0xfffd : num;
      return { text: String.fromCodePoint(cp), raw: false, end: j + 1 };
    }
    return null;
  }
  // Named: &[A-Za-z0-9]+; — passed through verbatim, never decoded.
  let j = i + 1;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (isAsciiLetter(c) || isDigit(c)) j++;
    else break;
  }
  if (j > i + 1 && src[j] === ';') return { text: src.slice(i, j + 1), raw: true, end: j + 1 };
  return null;
}

/** Find a closing backtick run of exactly `len`, starting the search at i. */
function findCodeSpanEnd(src, i, len) {
  const n = src.length;
  let j = i;
  while (j < n) {
    if (src.charCodeAt(j) !== 96) {
      j++;
      continue;
    }
    let k = j;
    while (k < n && src.charCodeAt(k) === 96) k++;
    if (k - j === len) return j;
    j = k;
  }
  return -1;
}

function isTagNameStart(code) {
  return isAsciiLetter(code);
}
function isTagNameChar(code) {
  return isAsciiLetter(code) || isDigit(code) || code === 45;
}
function isAttrNameStart(code) {
  return isAsciiLetter(code) || code === 95 || code === 58;
}
function isAttrNameChar(code) {
  return isAsciiLetter(code) || isDigit(code) || code === 95 || code === 58 || code === 46 || code === 45;
}

/** Match a tag name at src[start]; returns the index just past it, or -1. */
function matchTagName(src, start) {
  if (!isTagNameStart(src.charCodeAt(start))) return -1;
  let j = start + 1;
  while (j < src.length && isTagNameChar(src.charCodeAt(j))) j++;
  return j;
}

function isHtmlSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n';
}

/**
 * Match an inline HTML construct at src[i] ('<...'): comment, processing
 * instruction, declaration, CDATA section, open or closing tag. Returns the
 * index just past the construct, or -1.
 */
function matchHtml(src, i) {
  const n = src.length;
  if (src.startsWith('<!--', i)) {
    if (src[i + 4] === '>') return i + 5;
    if (src[i + 4] === '-' && src[i + 5] === '>') return i + 6;
    const k = src.indexOf('-->', i + 4);
    return k < 0 ? -1 : k + 3;
  }
  if (src.startsWith('<?', i)) {
    const k = src.indexOf('?>', i + 2);
    return k < 0 ? -1 : k + 2;
  }
  if (src.startsWith('<![CDATA[', i)) {
    const k = src.indexOf(']]>', i + 9);
    return k < 0 ? -1 : k + 3;
  }
  if (src[i + 1] === '!' && i + 2 < n && isAsciiLetter(src.charCodeAt(i + 2))) {
    const k = src.indexOf('>', i + 2);
    return k < 0 ? -1 : k + 1;
  }
  if (src[i + 1] === '/') {
    const nameEnd = matchTagName(src, i + 2);
    if (nameEnd < 0) return -1;
    let j = nameEnd;
    while (j < n && isHtmlSpace(src[j])) j++;
    return src[j] === '>' ? j + 1 : -1;
  }
  const nameEnd = matchTagName(src, i + 1);
  if (nameEnd < 0) return -1;
  let j = nameEnd;
  for (;;) {
    let k = j;
    while (k < n && isHtmlSpace(src[k])) k++;
    if (k >= n) return -1;
    const c = src[k];
    if (c === '>') return k + 1;
    if (c === '/' && src[k + 1] === '>') return k + 2;
    if (k === j) return -1; // an attribute needs whitespace before it
    if (!isAttrNameStart(src.charCodeAt(k))) return -1;
    k++;
    while (k < n && isAttrNameChar(src.charCodeAt(k))) k++;
    let k2 = k;
    while (k2 < n && isHtmlSpace(src[k2])) k2++;
    if (src[k2] === '=') {
      k2++;
      while (k2 < n && isHtmlSpace(src[k2])) k2++;
      if (src[k2] === '"') {
        const e = src.indexOf('"', k2 + 1);
        if (e < 0) return -1;
        k = e + 1;
      } else if (src[k2] === "'") {
        const e = src.indexOf("'", k2 + 1);
        if (e < 0) return -1;
        k = e + 1;
      } else {
        let e = k2;
        while (e < n) {
          const cc = src[e];
          if (cc === ' ' || cc === '\t' || cc === '\n' || cc === '"' || cc === "'" || cc === '=' || cc === '<' || cc === '>' || cc === '`') break;
          e++;
        }
        if (e === k2) return -1;
        k = e;
      }
    }
    // A boolean attribute (no '='): leave k just past the name, so the
    // whitespace before the next attribute is still there to be skipped.
    j = k;
  }
}

// Email local part (marked's simple charset) and domain labels.
function isEmailLocalChar(code) {
  return isAsciiLetter(code) || isDigit(code) || code === 46 || code === 95 || code === 43 || code === 45;
}
function isDomainChar(code) {
  return isAsciiLetter(code) || isDigit(code) || code === 95 || code === 45;
}

/**
 * Match an email address at s[start], following marked's `_extendedEmail`:
 * local@domain, the domain holding at least one dotted label, where every
 * dotted label must end with a letter or digit, and the character after the
 * address must not be a word character or '-'. Returns the index just past
 * it, or -1.
 */
/**
 * True when the delimiter run starting at src[pos] can close an emphasis
 * opened earlier in this scan (a delimiter of the same char that can open
 * is already in the list). Used by matchEmail: marked forms the emphasis
 * first and re-parses its inner text without the closing run, so an email
 * ending just before such a run is matched in full (doc-04:
 * `__...because@mark.example.com__` links the whole address, not just
 * `because@mark.example`).
 */
function isCloserRun(src, pos, st) {
  const ch = src[pos];
  if (ch !== '*' && ch !== '_' && ch !== '~') return false;
  let j = pos;
  while (j < src.length && src[j] === ch) j++;
  const flags = flankFlags(src, pos, j, ch);
  if (!flags[1]) return false;
  for (let d = st.dHead; d; d = d.dn) {
    if (d.ch === ch && d.canOpen) return true;
  }
  return false;
}

function matchEmail(s, start, st) {
  const n = s.length;
  let i = start;
  const ls = i;
  while (i < n && isEmailLocalChar(s.charCodeAt(i))) i++;
  if (i === ls || s[i] !== '@') return -1;
  i++;
  // First domain label: [A-Za-z0-9-_]+ (it may end with - or _).
  const ds = i;
  while (i < n && isDomainChar(s.charCodeAt(i))) i++;
  if (i === ds) return -1;
  let labels = 1;
  while (s[i] === '.') {
    let j = i + 1;
    while (j < n && isDomainChar(s.charCodeAt(j))) j++;
    if (j === i + 1) break; // '.' not followed by a label: the address ends here
    const last = s.charCodeAt(j - 1);
    if (!isAsciiLetter(last) && !isDigit(last)) {
      // The label ends with a non-alnum char. If the trailing run is a
      // delimiter run that will be consumed as an emphasis closer, trim
      // it and accept the label up to its last alnum char (see
      // isCloserRun); otherwise the label is invalid and the address ends
      // before this dot.
      if (st) {
        let k = j - 1;
        const dch = s[k];
        if (dch === '*' || dch === '_' || dch === '~') {
          while (k > i + 1 && s[k - 1] === dch) k--;
          const before = s.charCodeAt(k - 1);
          if ((isAsciiLetter(before) || isDigit(before)) && isCloserRun(s, k, st)) {
            labels++;
            i = k;
            continue;
          }
        }
      }
      break;
    }
    labels++;
    i = j;
  }
  if (labels < 2) return -1;
  if (i < n) {
    const c = s.charCodeAt(i);
    if (isAsciiLetter(c) || isDigit(c) || c === 95 || c === 45) {
      // A trailing delimiter run that will be consumed as an emphasis
      // closer does not block the match (see isCloserRun).
      if (!(st && (c === 42 || c === 95 || c === 126) && isCloserRun(s, i, st))) return -1;
    }
  }
  return i;
}

/**
 * Match an <...> autolink at src[i]. Returns {href, text, end} or null.
 * The href is the raw destination (scheme form) or 'mailto:' + address.
 */
function matchAngleAutolink(src, i) {
  const close = src.indexOf('>', i + 1);
  if (close < 0) return null;
  const inner = src.slice(i + 1, close);
  if (inner.length === 0) return null;
  for (let k = 0; k < inner.length; k++) {
    const c = inner.charCodeAt(k);
    if (c <= 32 || c === 60) return null;
  }
  // Scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  let k = 0;
  if (isAsciiLetter(inner.charCodeAt(0))) {
    while (k < inner.length) {
      const c = inner.charCodeAt(k);
      if (isAsciiLetter(c) || isDigit(c) || c === 43 || c === 45 || c === 46) k++;
      else break;
    }
    if (k >= 2 && k <= 32 && inner[k] === ':') {
      return { href: inner, text: inner, end: close + 1 };
    }
  }
  const emEnd = matchEmail(inner, 0);
  if (emEnd === inner.length) {
    return { href: 'mailto:' + inner, text: inner, end: close + 1 };
  }
  return null;
}

/** End of an extended-autolink run: stops at whitespace, <, " or '. */
function matchAutolinkRun(src, i) {
  const n = src.length;
  let j = i;
  while (j < n) {
    const c = src.charCodeAt(j);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c < 32 || c === 60 || c === 34 || c === 39) break;
    j++;
  }
  return j;
}

/**
 * Trim an extended autolink to marked's `_backpedal` prefix: the longest
 * prefix matching (?:[^?!.,:;*'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*'"~)]+(?!$))+.
 * A `(` is only kept as part of a balanced `(...)` group; a `)` is only
 * kept mid-text or as a group closer; trailing punctuation and an
 * entity-looking suffix at the very end are dropped. Simulating the
 * regex left to right gets the interplay right (a final `)` that closes
 * a group is kept even when an earlier `)` is unbalanced).
 */
function trimAutolink(text) {
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '(') {
      const close = text.indexOf(')', i + 1);
      if (close < 0) break; // unbalanced `(` ends the autolink
      i = close + 1;
      continue;
    }
    if (c === '&') {
      // An `&` starting an entity-looking suffix at the very end is trimmed.
      const semi = text.indexOf(';', i + 1);
      if (semi === n - 1) {
        let ok = true;
        for (let k = i + 1; k < semi; k++) {
          const cc = text.charCodeAt(k);
          if (!isAsciiLetter(cc) && !isDigit(cc)) { ok = false; break; }
        }
        if (ok) break;
      }
      i++;
      continue;
    }
    if (isTrimPunct(c)) {
      let j = i;
      while (j < n && isTrimPunct(text[j])) j++;
      if (j === n) break; // trailing punctuation is trimmed
      i = j;
      continue;
    }
    // A normal char: consume the run of normal chars.
    let j = i;
    while (j < n && !isTrimPunct(text[j]) && text[j] !== '(' && text[j] !== '&') j++;
    i = j;
  }
  return text.slice(0, i);
}

// Punctuation in marked's `_backpedal` (the `)` and `(` are handled above).
function isTrimPunct(c) {
  return c === '?' || c === '!' || c === '.' || c === ',' || c === ':' || c === ';' || c === '*' || c === '_' || c === '~' || c === "'" || c === '"' || c === ')';
}

function isWwwStartChar(code) {
  return isAsciiLetter(code) || isDigit(code) || code === 95 || code === 45;
}

/**
 * Try an extended (GFM) autolink at src[i]: www., http(s)://, ftp://,
 * mailto:/xmpp: + email, or a plain email address. Returns {href, text,
 * end} or null. href is the raw destination (without encoding); the caller
 * encodes it. `emailOk` says whether a plain email may start here (the
 * previous character is not part of the local part, or the text run starts
 * here).
 */
/**
 * True when the range [from, to) in src contains an unescaped `]` that
 * would close the nearest open bracket and form a link (the `]` is
 * followed by `(` or `[`, or the bracket's label is defined). marked
 * matches a link whole at its `[`, so a construct that would swallow that
 * `]` (a code span, an extended autolink) must not form inside brackets.
 */
/**
 * True when the backtick runs in src[from, to) are valid inside a link
 * label per marked's link/reflink regex: each run is either part of a
 * complete "code span" (`` `+ `` + non-backticks + `` `+ ``, lengths need
 * not match) inside the label, or a run of 2+ backticks immediately
 * before the label's end. A single unclosed backtick (cm-342, cm-525,
 * cm-537) makes the label invalid, so no link forms and a code span
 * spanning the `]` does form.
 */
function labelBackticksOk(src, from, to) {
  let k = from;
  while (k < to) {
    if (src[k] === '\\') { k += 2; continue; }
    if (src[k] !== '`') { k++; continue; }
    let j = k;
    while (j < to && src[j] === '`') j++;
    if (j === to) return j - k >= 2; // run at the very end: needs 2+
    // Find a closing run after some non-backtick chars.
    let m = j;
    while (m < to && src[m] !== '`') m++;
    if (m >= to) return false; // no closing run in the label
    let e = m;
    while (e < to && src[e] === '`') e++;
    k = e; // continue after the closing run
  }
  return true;
}

/**
 * End position (just past the closing `)`) of a `blockSkip` link starting
 * at src[i] == '[', or -1. marked's emStrong masking treats such a span
 * as a link and hides its delimiters from the emphasis scan, even when
 * the real link does not form: the masking label rule is more permissive
 * than the link regex's (a same-length code span in the label, then any
 * non-backtick chars), so `[at _node `` a ` b ``_](<...>)` is masked
 * whole and its `_` delimiters never form emphasis.
 */
function blockSkipLinkEnd(src, i) {
  const n = src.length;
  let j = i + 1;
  // Label: (?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*? then `]`
  while (j < n) {
    const c = src[j];
    if (c === ']') break;
    if (c === '[') return -1;
    if (c === '`') {
      // A code span: a backtick run, content (which may itself contain
      // backtick runs of other lengths — the anyPunctuationOutsideCode
      // pass replaces those with `+` before blockSkip runs), and the
      // first run of the same length.
      let k = j;
      while (k < n && src[k] === '`') k++;
      const len = k - j;
      const end = findCodeSpanEnd(src, k, len);
      if (end < 0 || end === k) return -1; // content must be non-empty
      j = end + len;
      continue;
    }
    j++;
  }
  if (j >= n || src[j] !== ']' || src[j + 1] !== '(') return -1;
  // Dest: escapes, non-paren chars, or balanced paren groups, then `)`.
  let k = j + 2;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '(') {
      let m = k + 1;
      while (m < n && src[m] !== ')' && src[m] !== '(') {
        if (src[m] === '\\') m++;
        m++;
      }
      if (m >= n || src[m] !== ')') return -1;
      k = m + 1;
      continue;
    }
    if (c === ')') return k + 1;
    k++;
  }
  return -1;
}

function swallowsLinkClose(src, from, to, st, defs) {
  if (st.stack.length === 0) return false;
  for (let k = from; k < to; k++) {
    if (src[k] === ']') {
      let bs = 0;
      for (let b = k - 1; b >= 0 && src[b] === '\\'; b--) bs++;
      if (bs % 2 !== 0) continue;
      const afterClose = src[k + 1];
      const br = st.stack[st.stack.length - 1];
      // An inactive bracket (deactivated when a nested link formed) can
      // no longer close into a link, so the `]` is literal and the
      // autolink/code span may swallow it.
      if (!br.active) return false;
      if (afterClose === '(' || afterClose === '[') {
        return labelBackticksOk(src, br.pos + 1, k);
      }
      const label = normalizeLabel(src.slice(br.pos + 1, k));
      if (label.length > 0 && defs.get(label) !== undefined) return labelBackticksOk(src, br.pos + 1, k);
      return false;
    }
  }
  return false;
}

function tryExtendedAutolink(src, i, emailOk, st) {
  const n = src.length;
  const prev = i === 0 ? null : src[i - 1];
  const c = src.charCodeAt(i);
  // www. — only after the start, whitespace, or one of * _ ~ (
  if (
    (prev === null || prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(') &&
    src.startsWith('www.', i)
  ) {
    const after = src.charCodeAt(i + 4);
    if (isWwwStartChar(after)) {
      const text = trimAutolink(src.slice(i, matchAutolinkRun(src, i)));
      if (text.length > 4) return { href: 'http://' + text, text, end: i + text.length };
    }
  }
  // http://, https://, ftp:// — no restriction on what precedes them.
  if (c === 104 || c === 72 || c === 102 || c === 70) {
    const head = src.slice(i, i + 8).toLowerCase();
    let plen = 0;
    if (head.startsWith('http://')) plen = 7;
    else if (head.startsWith('https://')) plen = 8;
    else if (head.startsWith('ftp://')) plen = 6;
    if (plen > 0) {
      const text = trimAutolink(src.slice(i, matchAutolinkRun(src, i)));
      if (text.length > plen) return { href: text, text, end: i + text.length };
      return null;
    }
  }
  // mailto: / xmpp: + email — lowercase only, and the previous character
  // must not be a letter or digit. xmpp: may add one '/segment' of
  // [A-Za-z0-9@.]; a trailing '.' is trimmed by trimAutolink.
  if (c === 109 || c === 120) {
    const prevCode = i === 0 ? -1 : src.charCodeAt(i - 1);
    const prevOk = i === 0 || (!isAsciiLetter(prevCode) && !isDigit(prevCode));
    if (prevOk) {
      if (src.startsWith('mailto:', i)) {
        const emEnd = matchEmail(src, i + 7, st);
        if (emEnd >= 0) {
          const text = src.slice(i, emEnd);
          return { href: text, text, end: emEnd };
        }
      } else if (src.startsWith('xmpp:', i)) {
        const emEnd = matchEmail(src, i + 5, st);
        if (emEnd >= 0) {
          let end = emEnd;
          if (src[end] === '/') {
            let j = end + 1;
            while (j < n) {
              const cc = src.charCodeAt(j);
              if (isAsciiLetter(cc) || isDigit(cc) || cc === 64 || cc === 46) j++;
              else break;
            }
            if (j > end + 1) end = j;
          }
          const text = trimAutolink(src.slice(i, end));
          if (text.length > 5) return { href: text, text, end: i + text.length };
        }
      }
    }
  }
  // Plain email.
  if (emailOk && isEmailLocalChar(c)) {
    const emEnd = matchEmail(src, i, st);
    if (emEnd >= 0) {
      const text = src.slice(i, emEnd);
      return { href: 'mailto:' + text, text, end: emEnd };
    }
  }
  return null;
}


// ---------------------------------------------------------------------------
// Link parsing (inline and reference forms)

function skipInlineSpace(src, j) {
  while (j < src.length) {
    const c = src[j];
    if (c === ' ' || c === '\t' || c === '\n') j++;
    else break;
  }
  return j;
}

/** Scan a reference label starting at src[j] ('['); returns the index just past the ']' or -1. */
/**
 * Scan a link label starting at src[j] ('['). A label ends with the first
 * right bracket that is not backslash-escaped, and unescaped '[' characters
 * are not allowed inside it — so `[ref[bar]]` is not a label at all.
 * Returns the index just past the closing ']', or -1 when there is none.
 */
function scanLabelEnd(src, j) {
  const n = src.length;
  let k = j + 1;
  while (k < n) {
    const c = src[k];
    if (c === '\\' && k + 1 < n && isAsciiPunctCode(src.charCodeAt(k + 1))) {
      k += 2;
      continue;
    }
    if (c === '[') return -1;
    if (c === ']') return k + 1;
    k++;
  }
  return -1;
}

/**
 * Parse the part after ']' of a link: an inline '(...)' link, a full
 * '[label]' reference, a collapsed '[]' reference, or a shortcut reference.
 * The forms are tried in that order; a failed inline link falls through to
 * the reference forms (e.g. `[foo](not a link)` is a shortcut reference
 * when `foo` is defined). Returns {href, title, end} or null. `end` is the
 * index just past the link.
 */
function parseLinkTail(src, j, defs, linkText) {
  if (src[j] === '(') {
    const inline = parseInlineLinkTail(src, j);
    if (inline) return inline;
    // A failed inline link falls through to the reference forms.
  }
  if (src[j] === '[') {
    const labelEnd = scanLabelEnd(src, j);
    if (labelEnd >= 0) {
      const label = labelEnd === j + 2 ? linkText : src.slice(j + 1, labelEnd - 1);
      const def = defs.get(normalizeLabel(label));
      if (def) return { href: def.href, title: def.title, end: labelEnd };
      // A well-formed [label] that is not defined is not a link at all:
      // the shortcut form is not tried after it.
      return null;
    }
    // No closing ']' for the label: fall through to the shortcut form.
  }
  const def = defs.get(normalizeLabel(linkText));
  if (!def) return null;
  return { href: def.href, title: def.title, end: j };
}

/** Parse an inline '(...)' link tail starting at src[j] ('('). Returns
 * {href, title, end} or null. An escaped '>' does not close an angle-bracket
 * destination, so `<foo\>` is not a valid destination. */
function parseInlineLinkTail(src, j) {
  const n = src.length;
  j = skipInlineSpace(src, j + 1);
  let dest = '';
  if (src[j] === '<') {
    let k = j + 1;
    while (k < n && src[k] !== '\n' && src[k] !== '<') {
      if (src[k] === '\\' && k + 1 < n && isAsciiPunctCode(src.charCodeAt(k + 1))) {
        k += 2;
        continue;
      }
      if (src[k] === '>') break;
      k++;
    }
    if (src[k] !== '>') return null;
    dest = src.slice(j + 1, k);
    j = k + 1;
  } else {
    let depth = 0;
    let k = j;
    while (k < n) {
      const c = src[k];
      if (c === '\\' && k + 1 < n && isAsciiPunctCode(src.charCodeAt(k + 1))) {
        k += 2;
        continue;
      }
      if (c === '(') {
        depth++;
        k++;
        continue;
      }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        k++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n') break;
      k++;
    }
    // An empty destination is allowed: `[link]()` is a link with href="".
    dest = src.slice(j, k);
    j = k;
  }
  j = skipInlineSpace(src, j);
  let title = null;
  if (src[j] === '"' || src[j] === "'" || src[j] === '(') {
    const open = src[j];
    const close = open === '(' ? ')' : open;
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = src[k];
      if (c === '\\' && k + 1 < n && isAsciiPunctCode(src.charCodeAt(k + 1))) {
        k += 2;
        continue;
      }
      if (c === close) {
        ok = true;
        break;
      }
      if (open === '(' && c === '(') return null;
      k++;
    }
    if (!ok) return null;
    title = src.slice(j + 1, k);
    j = k + 1;
    j = skipInlineSpace(src, j);
  }
  if (src[j] !== ')') return null;
  return { href: dest, title, end: j + 1 };
}

// ---------------------------------------------------------------------------
// The inline scanner

function isFlankChar(ch) {
  return ch !== null && ch !== undefined;
}

/** Flanking booleans for a delimiter run of `ch` at src[i..j). */
function flankFlagsChars(before, after, ch) {
  const beforeWS = before === null || isSpaceCh(before);
  const beforePunct = before !== null && isPunctCh(before);
  const afterWS = after === null || isSpaceCh(after);
  const afterPunct = after !== null && isPunctCh(after);
  const left = after !== null && !afterWS && (!afterPunct || before === null || beforeWS || beforePunct);
  const right = before !== null && !beforeWS && (!beforePunct || after === null || afterWS || afterPunct);
  if (ch === '_') {
    return [left && (!right || beforePunct), right && (!left || afterPunct)];
  }
  return [left, right];
}

function flankFlags(src, i, j, ch) {
  return flankFlagsChars(i > 0 ? src[i - 1] : null, j < src.length ? src[j] : null, ch);
}

/** Append a node to a state object's list. */
function appendNode(st, node) {
  node.n = null;
  node.p = st.tail;
  if (st.tail) st.tail.n = node;
  else st.head = node;
  st.tail = node;
}

/**
 * Try to close the nearest bracket at src[i] (']'), following the spec's
 * "look for link or image": the nearest bracket is used, whether active or
 * not — an inactive one is removed from the stack and the ']' is literal,
 * and an active one that forms no link is likewise removed (not merely
 * deactivated), so a later ']' can still match an earlier bracket. When a
 * link (not an image) forms, every '[' delimiter before its opener is set
 * inactive, so links cannot nest; '![...' openers stay active.
 */
function tryCloseBracket(src, i, st, defs, plain) {
  const bi = st.stack.length - 1;
  if (bi < 0) return null;
  const bracket = st.stack[bi];
  if (!bracket.active) {
    st.stack.length = bi;
    return null;
  }
  // The label must be valid per marked's link/reflink regex: a backtick
  // run inside it must be part of a complete "code span" unit or a 2+
  // run just before the `]`. Otherwise no link forms at all (doc-16:
  // `[at _node `` a ` b ``_](<...>)` has a trailing `` `` `` with no
  // closer, so the `[` stays literal and the URL autolinks instead).
  if (!labelBackticksOk(src, bracket.pos + 1, i)) {
    st.stack.length = bi;
    return null;
  }
  const linkText = src.slice(bracket.pos + 1, i);
  const tail = parseLinkTail(src, i + 1, defs, linkText);
  if (!tail) {
    st.stack.length = bi;
    return null;
  }
  const isImage = bracket.image;
  if (!isImage) {
    // A link (not an image) deactivates every '[' before its opener.
    for (let k = 0; k < bi; k++) {
      if (!st.stack[k].image) st.stack[k].active = false;
    }
  }
  // Remove every node from the bracket to the end of the list, dropping any
  // delimiters in that span from the delimiter list.
  let node = bracket;
  while (node) {
    const next = node.n;
    if (node.t === 4) delimRemove(st, node);
    node = next;
  }
  if (bracket.p) {
    bracket.p.n = null;
    st.tail = bracket.p;
  } else {
    st.head = null;
    st.tail = null;
  }
  st.stack.length = bi;
  let newNode;
  if (isImage) {
    newNode = {
      t: 7,
      href: hrefOf(tail.href),
      title: tail.title === null ? null : titleOf(tail.title),
      alt: escAttr(plainText(linkText, defs)),
    };
  } else {
    newNode = {
      t: 6,
      href: hrefOf(tail.href),
      title: tail.title === null ? null : titleOf(tail.title),
      html: parseInline(linkText, defs, true),
      plain: plain ? plainText(linkText, defs) : undefined,
    };
  }
  if (bracket.bang) {
    const bang = bracket.bang;
    if (bang.p) bang.p.n = bang.n;
    if (bang.n) bang.n.p = bang.p;
    if (st.head === bang) st.head = bang.n;
    if (st.tail === bang) st.tail = bang.p;
  }
  appendNode(st, newNode);
  return { end: tail.end };
}

/**
 * Scan one inline string into a node list, run emphasis processing, and
 * return the list head. `noExt` disables extended autolinks (inside link
 * text, where they never form).
 */
// Per-document inline state, as in marked's lexer: an unclosed `<a ...>`
// tag suppresses extended autolinks (www./http://, email) for the rest of
// the document, and an unclosed `<pre|code|kbd|script>` tag leaves text
// un-decoded (entities pass through verbatim). Both are set and cleared by
// inline HTML tags during the scan, in document order, and reset per parse.
let INLINK = false;
let INRAW = false;

function scanInline(src, defs, noExt, plain) {
  const st = { head: null, tail: null, dhead: null, dtail: null, stack: [] };
  const n = src.length;
  let i = 0;
  let ts = 0;
  // End of the current emStrong-mask region (marked's `#n` masking): a
  // code span that was suppressed by the link guard (so a link could form)
  // still hides the `*`/`_`/`~` runs inside it from the emphasis scan —
  // marked scans a masked source in which that span's content is replaced,
  // so a delimiter inside it can neither open nor close. The outermost
  // span wins, so this only ever grows.
  let maskUntil = 0;
  // The raw-block state in effect for the text run starting at ts. It only
  // changes at an HTML tag, which flushes the run before it, so a run is
  // always rendered with the state it was scanned under.
  let tsRaw = INRAW;
  const flush = (end) => {
    if (end > ts) appendNode(st, { t: 0, s: src.slice(ts, end), raw: tsRaw });
  };
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') {
        flush(i);
        appendNode(st, { t: 3 });
        i += 2;
        // A hard break strips the leading spaces/tabs of the next line.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        ts = i;
        continue;
      }
      if (nx !== undefined && isAsciiPunctCode(nx.charCodeAt(0))) {
        flush(i);
        appendNode(st, { t: 0, s: nx, raw: false });
        i += 2;
        ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const len = j - i;
      const end = findCodeSpanEnd(src, j, len);
      // A code span must not swallow the `]` that closes an open bracket
      // and forms a link (see swallowsLinkClose): marked matches the link
      // whole at its `[`, so the span is only evaluated inside the link
      // text, where it cannot reach past the `]`. But the span still
      // masks its range for emphasis (see maskUntil): the delimiters
      // inside it are hidden from marked's emStrong scan.
      if (end >= 0 && swallowsLinkClose(src, i, end + len, st, defs)) {
        if (end + len > maskUntil) maskUntil = end + len;
        i = j;
        continue;
      }
      if (end >= 0) {
        flush(i);
        let content = src.slice(j, end).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        appendNode(st, { t: 1, s: content });
        i = end + len;
        ts = i;
        continue;
      }
      i = j;
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i;
      while (j < n && src[j] === c) j++;
      // Inside an emStrong-mask region the run is literal text: marked's
      // emphasis scan never sees it (see maskUntil).
      if (i < maskUntil) {
        i = j;
        continue;
      }
      // A run of three or more tildes is not a strikethrough delimiter.
      if (c === '~' && j - i >= 3) {
        i = j;
        continue;
      }
      const [canOpen, canClose] = flankFlags(src, i, j, c);
      if (canOpen || canClose) {
        flush(i);
        // R (marked's emStrong flag): the opener is preceded by a
        // non-whitespace char and either followed by punctuation or, for
        // `*`, preceded by a non-punctuation char. When set, the odd-match
        // rule applies to any closer, not just "both" runs.
        const before = i > 0 ? src[i - 1] : null;
        const after = j < src.length ? src[j] : null;
        const R = before !== null && !isSpaceCh(before) &&
          ((after !== null && isPunctCh(after)) ||
            (c === '*' && before !== '*' && before !== '_' && !isPunctCh(before)));
        const node = { t: 4, ch: c, len: j - i, olen: j - i, canOpen, canClose, R, after, dn: null, dp: null };
        appendNode(st, node);
        delimAppend(st, node);
        i = j;
        ts = i;
        continue;
      }
      // A run that can neither open nor close stays ordinary text.
      i = j;
      continue;
    }
    if (c === '[') {
      flush(i);
      const node = { t: 9, pos: i, active: true, image: false, bang: null };
      appendNode(st, node);
      st.stack.push(node);
      // A `blockSkip` link starting here masks its span for emphasis
      // (see blockSkipLinkEnd), even when the real link does not form.
      const bsEnd = blockSkipLinkEnd(src, i);
      if (bsEnd > maskUntil) maskUntil = bsEnd;
      i++;
      ts = i;
      continue;
    }
    if (c === ']') {
      const res = tryCloseBracket(src, i, st, defs, plain);
      if (res) {
        i = res.end;
        ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '!') {
      if (src[i + 1] === '[') {
        flush(i);
        const bang = { t: 10 };
        const br = { t: 9, pos: i + 1, active: true, image: true, bang };
        appendNode(st, bang);
        appendNode(st, br);
        st.stack.push(br);
        // A `blockSkip` link starting at the `[` masks its span for
        // emphasis (see blockSkipLinkEnd), even when the image does not form.
        const bsEnd = blockSkipLinkEnd(src, i + 1);
        if (bsEnd > maskUntil) maskUntil = bsEnd;
        i += 2;
        ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '<') {
      const auto = matchAngleAutolink(src, i);
      if (auto) {
        flush(i);
        appendNode(st, { t: 8, href: hrefOfAuto(auto.href), s: auto.text });
        i = auto.end;
        ts = i;
        continue;
      }
      const htmlEnd = matchHtml(src, i);
      if (htmlEnd >= 0) {
        // Flush the run before this tag with the state it was scanned
        // under, then update the document state from the tag itself.
        const tag = src.slice(i, htmlEnd);
        flush(i);
        if (!INLINK && /^<a /i.test(tag)) INLINK = true;
        else if (INLINK && /^<\/a>/i.test(tag)) INLINK = false;
        if (!INRAW && /^<(pre|code|kbd|script)(\s|>)/i.test(tag)) INRAW = true;
        else if (INRAW && /^<\/(pre|code|kbd|script)(\s|>)/i.test(tag)) INRAW = false;
        tsRaw = INRAW;
        appendNode(st, { t: 2, s: src.slice(i, htmlEnd) });
        i = htmlEnd;
        ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '&') {
      // Inside a raw block, entities are not decoded: the `&` stays in the
      // text run, which flush() emits as a raw node.
      if (INRAW) {
        i++;
        continue;
      }
      const ent = tryEntity(src, i);
      if (ent) {
        flush(i);
        appendNode(st, { t: 0, s: ent.text, raw: ent.raw });
        i = ent.end;
        ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === '\n') {
      let sp = 0;
      let k = i - 1;
      while (k >= ts && src[k] === ' ') {
        sp++;
        k--;
      }
      if (sp >= 2) {
        flush(i - sp);
        appendNode(st, { t: 3 });
        i++;
        // A hard break strips the leading spaces/tabs of the next line.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        ts = i;
        continue;
      }
      i++;
      continue;
    }
    if (!noExt && !INLINK) {
      // Extended autolinks: www., http(s):// and ftp://, mailto:/xmpp: +
      // email, and plain email addresses. All forms are tried in order at
      // every position (a failed http:// attempt must not block the email
      // attempt — e.g. `foo@bar.baz` starts with 'f'). Suppressed inside
      // a link (an unclosed `<a ...>` tag sets INLINK for the document).
      const prevCode = i > 0 ? src.charCodeAt(i - 1) : -1;
      const emailOk =
        isEmailLocalChar(src.charCodeAt(i)) && (i === 0 || !isEmailLocalChar(prevCode) || ts === i);
      const auto = tryExtendedAutolink(src, i, emailOk, st);
      if (auto) {
        // An extended autolink inside brackets must not swallow the `]`
        // that closes the bracket (see swallowsLinkClose): marked forms
        // the link at the `[` (and parses its text with inLink set), so
        // the autolink never gets a chance there.
        const swallow = swallowsLinkClose(src, i, auto.end, st, defs);
        if (!swallow) {
          flush(i);
          appendNode(st, { t: 8, href: hrefOfAuto(auto.href), s: auto.text });
          i = auto.end;
          ts = i;
          continue;
        }
      }
    }
    i++;
  }
  flush(n);
  processEmphasis(st);
  return st.head;
}

/** Render one inline string as HTML. */
function parseInline(src, defs, noExt) {
  if (!src) return '';
  return renderList(scanInline(src, defs, !!noExt, false), false);
}

/** Render one inline string as plain text (for image alt text). */
function plainText(src, defs) {
  if (!src) return '';
  return renderList(scanInline(src, defs, true, true), true);
}


// ---------------------------------------------------------------------------
// Block parsing

/** Indentation of a line in columns (a tab advances to the next multiple of 4), and the index where it ends. */
function indentCols(line) {
  let col = 0;
  let pos = 0;
  while (pos < line.length) {
    const c = line[pos];
    if (c === ' ') {
      col++;
      pos++;
    } else if (c === '\t') {
      col += 4 - (col % 4);
      pos++;
    } else break;
  }
  return [col, pos];
}

/**
 * Remove `cols` columns of leading whitespace starting at (pos, col).
 * A tab that straddles the boundary leaves its remainder as spaces, and any
 * leading whitespace left over is expanded to spaces by its original column.
 */
function stripColsFrom(line, pos, col, cols) {
  let p = pos;
  let c = col;
  let out = '';
  const target = col + cols;
  while (p < line.length && c < target) {
    const ch = line[p];
    if (ch === ' ') {
      c++;
      p++;
    } else if (ch === '\t') {
      const next = c + 4 - (c % 4);
      if (next <= target) {
        c = next;
        p++;
      } else {
        out = ' '.repeat(next - target);
        p++;
        c = next;
        break;
      }
    } else break;
  }
  while (p < line.length) {
    const ch = line[p];
    if (ch === ' ') {
      out += ' ';
      c++;
      p++;
    } else if (ch === '\t') {
      const next = c + 4 - (c % 4);
      out += ' '.repeat(next - c);
      c = next;
      p++;
    } else break;
  }
  return out + line.slice(p);
}

function stripCols(line, cols) {
  return stripColsFrom(line, 0, 0, cols);
}

/** Remove up to `cols` columns of leading whitespace, keeping the rest
 * verbatim (tabs included). A tab straddling the boundary is replaced by
 * spaces for its remainder. Used for fenced/indented code content, where
 * tabs must survive: stripCols expands every leading tab to spaces, which
 * is only right when the result is re-measured in columns (list/quote
 * content), not when it is rendered as-is. */
function stripColsKeep(line, cols) {
  let p = 0;
  let c = 0;
  let out = '';
  while (p < line.length && c < cols) {
    const ch = line[p];
    if (ch === ' ') {
      c++;
      p++;
    } else if (ch === '\t') {
      const next = c + 4 - (c % 4);
      if (next <= cols) {
        c = next;
        p++;
      } else {
        out = ' '.repeat(next - cols);
        p++;
        break;
      }
    } else break;
  }
  return out + line.slice(p);
}

function isBlankStr(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function isTagEndChar(c) {
  return c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '>';
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption',
  'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe',
  'legend', 'li', 'link', 'main', 'menu', 'nav', 'noframes', 'ol', 'optgroup',
  'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul',
]);

/** HTML block start (types 1-6) at the start of a line, or null. */
function htmlStartInfo(line) {
  const [ind, pos] = indentCols(line);
  if (ind > 3 || line[pos] !== '<') return null;
  const rest = line.slice(pos + 1);
  const lower = rest.toLowerCase();
  if (lower.startsWith('script') && isTagEndChar(rest[6])) return { type: 1, end: '</script>' };
  if (lower.startsWith('pre') && isTagEndChar(rest[3])) return { type: 1, end: '</pre>' };
  if (lower.startsWith('style') && isTagEndChar(rest[5])) return { type: 1, end: '</style>' };
  if (lower.startsWith('textarea') && isTagEndChar(rest[8])) return { type: 1, end: '</textarea>' };
  if (line.startsWith('<!--', pos)) return { type: 2, end: '-->' };
  if (line.startsWith('<?', pos)) return { type: 3, end: '?>' };
  if (line[pos + 1] === '!' && pos + 2 < line.length && isAsciiLetter(line.charCodeAt(pos + 2))) return { type: 4, end: '>' };
  if (line.startsWith('<![CDATA[', pos)) return { type: 5, end: ']]>' };
  let p = pos + 1;
  if (line[p] === '/') p++;
  let e = p;
  while (e < line.length && isTagNameChar(line.charCodeAt(e))) e++;
  if (e > p) {
    const tag = line.slice(p, e).toLowerCase();
    if (BLOCK_TAGS.has(tag)) {
      const nx = line[e];
      if (nx === undefined || nx === ' ' || nx === '\t' || nx === '>' || (nx === '/' && line[e + 1] === '>')) {
        return { type: 6, end: null };
      }
    }
  }
  return null;
}

/** Match one open or closing tag at line[pos]; returns the index past it, or -1. */
function matchHtmlTag(line, pos) {
  const n = line.length;
  let p = pos + 1;
  const closing = line[p] === '/';
  if (closing) p++;
  let e = p;
  while (e < n && isTagNameChar(line.charCodeAt(e))) e++;
  if (e === p) return -1;
  // A closing tag takes no attributes: only whitespace, then '>'.
  if (closing) {
    let j = e;
    while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
    return line[j] === '>' ? j + 1 : -1;
  }
  let j = e;
  for (;;) {
    let k = j;
    while (k < n && (line[k] === ' ' || line[k] === '\t')) k++;
    if (k >= n) return -1;
    const c = line[k];
    if (c === '>') return k + 1;
    if (c === '/' && line[k + 1] === '>') return k + 2;
    if (k === j) return -1;
    if (!isAttrNameStart(line.charCodeAt(k))) return -1;
    k++;
    while (k < n && isAttrNameChar(line.charCodeAt(k))) k++;
    let k2 = k;
    while (k2 < n && (line[k2] === ' ' || line[k2] === '\t')) k2++;
    if (line[k2] === '=') {
      k2++;
      while (k2 < n && (line[k2] === ' ' || line[k2] === '\t')) k2++;
      if (line[k2] === '"') {
        const q = line.indexOf('"', k2 + 1);
        if (q < 0) return -1;
        k = q + 1;
      } else if (line[k2] === "'") {
        const q = line.indexOf("'", k2 + 1);
        if (q < 0) return -1;
        k = q + 1;
      } else {
        let q = k2;
        while (q < n) {
          const cc = line[q];
          if (cc === ' ' || cc === '\t' || cc === '"' || cc === "'" || cc === '=' || cc === '<' || cc === '>' || cc === '`') break;
          q++;
        }
        if (q === k2) return -1;
        k = q;
      }
    }
    // A boolean attribute (no '='): leave k just past the name, so the
    // whitespace before the next attribute is still there to be skipped.
    j = k;
  }
}

/** Type 7 HTML block: a line that is exactly one open or closing tag. */
function isHtml7Str(line) {
  const [ind, pos] = indentCols(line);
  if (ind > 3 || line[pos] !== '<') return false;
  const end = matchHtmlTag(line, pos);
  if (end < 0) return false;
  for (let k = end; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

/** ATX heading info, or null. */
function atxInfo(line) {
  const [ind, pos] = indentCols(line);
  if (ind > 3) return null;
  let p = pos;
  let level = 0;
  while (line[p] === '#') {
    level++;
    p++;
  }
  if (level === 0 || level > 6) return null;
  if (p < line.length && line[p] !== ' ' && line[p] !== '\t') return null;
  let start = p;
  while (line[start] === ' ' || line[start] === '\t') start++;
  let end = line.length;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (end > start) {
    let k = end;
    while (k > start && line[k - 1] === '#') k--;
    if (k < end) {
      const before = k === start ? line[start - 1] : line[k - 1];
      if (before === ' ' || before === '\t') {
        end = k;
        while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
      }
    }
  }
  return { level, text: line.slice(start, end) };
}

/** Fenced code start info, or null. */
function fenceInfo(line) {
  const [ind, pos] = indentCols(line);
  if (ind > 3) return null;
  const ch = line[pos];
  if (ch !== '`' && ch !== '~') return null;
  let p = pos;
  let len = 0;
  while (line[p] === ch) {
    len++;
    p++;
  }
  if (len < 3) return null;
  let s = p;
  while (line[s] === ' ' || line[s] === '\t') s++;
  if (ch === '`' && line.indexOf('`', s) >= 0) return null;
  let e = s;
  while (e < line.length && line[e] !== ' ' && line[e] !== '\t') e++;
  return { ch, len, indent: ind, indentChars: pos, lang: unescapeStr(line.slice(s, e)) };
}

// marked's `Dt` (indentCodeCompensation): for a backtick fence, each
// content line loses min(leading-whitespace-run, fence-indent) CHARACTERS
// (a straddling tab is removed whole, not expanded to spaces); for a
// tilde fence the content is kept verbatim (`Dt` only matches ```).
function stripFenceContent(line, fence) {
  if (fence.ch !== '`') return line;
  const ind = fence.indentChars;
  if (ind === 0) return line;
  let k = 0;
  while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k++;
  const cut = k < ind ? k : ind;
  return cut === 0 ? line : line.slice(cut);
}

function isFenceClose(line, ch, len) {
  const [ind, pos] = indentCols(line);
  if (ind > 3) return false;
  let p = pos;
  let n = 0;
  while (line[p] === ch) {
    n++;
    p++;
  }
  if (n < len) return false;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++;
  return p === line.length;
}

function isHrStr(line) {
  const [ind, pos] = indentCols(line);
  if (ind > 3) return false;
  const ch = line[pos];
  if (ch !== '-' && ch !== '*' && ch !== '_') return false;
  let p = pos;
  let count = 0;
  while (p < line.length) {
    const c = line[p];
    if (c === ch) {
      count++;
      p++;
    } else if (c === ' ' || c === '\t') p++;
    else return false;
  }
  return count >= 3;
}

function isSetextStr(line) {
  const [ind, pos] = indentCols(line);
  if (ind > 3) return false;
  const ch = line[pos];
  if (ch !== '=' && ch !== '-') return false;
  let p = pos;
  while (p < line.length && line[p] === ch) p++;
  if (p === pos) return false;
  while (p < line.length && (line[p] === ' ' || line[p] === '\t')) p++;
  return p === line.length;
}

function setextLevel(line) {
  return line[indentCols(line)[1]] === '=' ? 1 : 2;
}

function isQuoteStr(line) {
  const [ind, pos] = indentCols(line);
  return ind <= 3 && line[pos] === '>';
}

function quoteContent(line) {
  const [ind, pos] = indentCols(line);
  return stripColsFrom(line, pos + 1, ind + 1, 1);
}

/** Content after a list marker: indent in columns and the content text. */
function listContent(line, markerPos, markerCol) {
  let col = markerCol;
  let pos = markerPos;
  let wsCols = 0;
  let wsEnd = pos;
  let wsEndCol = col;
  while (wsEnd < line.length) {
    const c = line[wsEnd];
    if (c === ' ') {
      wsEnd++;
      wsEndCol++;
      wsCols++;
    } else if (c === '\t') {
      const nx = wsEndCol + 4 - (wsEndCol % 4);
      wsCols += nx - wsEndCol;
      wsEnd++;
      wsEndCol = nx;
    } else break;
  }
  if (wsEnd >= line.length) return { indent: markerCol + 1, text: '' };
  if (wsCols >= 1 && wsCols <= 4) return { indent: wsEndCol, text: line.slice(wsEnd) };
  return { indent: markerCol + 1, text: stripColsFrom(line, markerPos, markerCol, 1) };
}

function listStartInfo(line) {
  const [ind, pos] = indentCols(line);
  if (ind > 3) return null;
  const c = line[pos];
  if (c === '-' || c === '*' || c === '+') {
    const nx = line[pos + 1];
    if (nx !== undefined && nx !== ' ' && nx !== '\t') return null;
    const content = listContent(line, pos + 1, ind + 1);
    return { ordered: false, bullet: c, delim: null, start: 1, contentIndent: content.indent, content: content.text, empty: content.text.trim() === '' };
  }
  let p = pos;
  let digits = 0;
  while (p < line.length && isDigit(line.charCodeAt(p)) && digits < 9) {
    digits++;
    p++;
  }
  if (digits === 0) return null;
  if (digits === 9 && isDigit(line.charCodeAt(p))) return null;
  const delim = line[p];
  if (delim !== '.' && delim !== ')') return null;
  const nx = line[p + 1];
  if (nx !== undefined && nx !== ' ' && nx !== '\t') return null;
  const content = listContent(line, p + 1, ind + digits + 1);
  return { ordered: true, bullet: null, delim, start: parseInt(line.slice(pos, p), 10), contentIndent: content.indent, content: content.text, empty: content.text.trim() === '' };
}

/** Can a list whose first item is `info` interrupt a paragraph at lines[i]? */
function listCanInterrupt(lines, i, info) {
  if (!info.empty) {
    // An ordered list interrupts a paragraph only when it starts at 1.
    if (info.ordered && info.start !== 1) return false;
    return true;
  }
  const indent = info.contentIndent;
  for (let j = i + 1; j < lines.length; j++) {
    const s = lines[j].s;
    if (isBlankStr(s)) continue;
    if (indentCols(s)[0] >= indent) return true;
    return false;
  }
  return false;
}

/** Split a table row into cells, respecting backslash escapes and code spans. */
/**
 * Split a table row line into cells. A `|` inside a code span does not
 * split, and a backslash-escaped pipe `\|` becomes a literal `|` in the
 * cell — including inside a code span, where the inline parser would
 * otherwise keep the backslash. `\\` is left as-is (so a `\\|` still splits:
 * the backslash is escaped, the pipe is real).
 */
function splitCells(line) {
  // marked's `de`: split at every unescaped `|` — there is no code-span
  // awareness at all (a `|` inside a code span still splits, so the
  // header/delimiter cell counts can mismatch and kill the table). Only
  // backslash parity matters: `\|` is a literal pipe, `\\|` splits.
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\\' && i + 1 < n && line[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (c === '\\' && i + 1 < n && line[i + 1] === '\\') {
      cur += '\\\\';
      i += 2;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  for (let k = 0; k < cells.length; k++) cells[k] = cells[k].trim();
  const trimmed = line.trim();
  if (trimmed.startsWith('|') && cells.length > 0 && cells[0] === '') cells.shift();
  if (trimmed.endsWith('|') && cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** A table delimiter row's cells, or null when the line is not one. */
function tableDelimCells(line) {
  if (!line.includes('|')) return null;
  const cells = splitCells(line);
  if (cells.length === 0) return null;
  for (let k = 0; k < cells.length; k++) {
    if (!/^:?-+:?$/.test(cells[k])) return null;
  }
  return cells;
}

function cellAlign(cell) {
  if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
  if (cell.startsWith(':')) return 'left';
  if (cell.endsWith(':')) return 'right';
  return null;
}

// ---------------------------------------------------------------------------
// Link reference definitions

/** Parse a link reference definition starting at lines[i]. The label, the
 * destination and the title may each span lines (the destination may be on
 * the line after the label, the title on the line after the destination, and
 * a title may itself contain newlines). A title must be separated from the
 * destination by whitespace. A malformed title on the same line as the
 * destination invalidates the whole definition; a malformed title on a later
 * line is ignored and the definition stands without it. Returns the number
 * of lines consumed, or 0 when this is not a definition. */
function tryDef(lines, i, defs) {
  const first = lines[i].s;
  const [ind, pos] = indentCols(first);
  if (ind > 3 || first[pos] !== '[') return 0;
  // Join the following lines (up to a blank line) so a label, a destination
  // or a title may span lines.
  let text = first;
  let n = 1;
  while (i + n < lines.length && n < 20 && text.length < 4000) {
    const ns = lines[i + n].s;
    if (isBlankStr(ns)) break;
    text += '\n' + ns;
    n++;
  }
  const lineOf = (p) => {
    let c = 0;
    for (let k = 0; k < p; k++) if (text.charCodeAt(k) === 10) c++;
    return c;
  };
  const labelEnd = scanLabelEnd(text, pos);
  if (labelEnd < 0) return 0;
  const label = text.slice(pos + 1, labelEnd - 1);
  if (normalizeLabel(label) === '') return 0;
  let j = labelEnd;
  if (text[j] !== ':') return 0;
  j++;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
  if (j >= text.length) return 0;
  let dest = '';
  if (text[j] === '<') {
    let k = j + 1;
    while (k < text.length && text[k] !== '<' && text[k] !== '\n') {
      if (text[k] === '\\' && k + 1 < text.length && isAsciiPunctCode(text.charCodeAt(k + 1))) {
        k += 2;
        continue;
      }
      if (text[k] === '>') break;
      k++;
    }
    if (text[k] !== '>') return 0;
    dest = text.slice(j + 1, k);
    j = k + 1;
  } else {
    let depth = 0;
    let k = j;
    while (k < text.length) {
      const c = text[k];
      if (c === '\\' && k + 1 < text.length && isAsciiPunctCode(text.charCodeAt(k + 1))) {
        k += 2;
        continue;
      }
      if (c === '(') {
        depth++;
        k++;
        continue;
      }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        k++;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n') break;
      k++;
    }
    if (k === j || depth > 0) return 0;
    dest = text.slice(j, k);
    j = k;
  }
  const destLine = lineOf(j);
  let title = null;
  let consumed = destLine + 1;
  if (j < text.length) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n') {
      let p = j;
      while (p < text.length && (text[p] === ' ' || text[p] === '\t' || text[p] === '\n')) p++;
      if (p < text.length && (text[p] === '"' || text[p] === "'" || text[p] === '(')) {
        const titleLine = lineOf(p);
        const t = parseTitleMulti(text, p);
        if (t) {
          let k = t.end;
          while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
          if (k === text.length || text[k] === '\n') {
            title = t.title;
            consumed = lineOf(k) + 1;
          } else if (titleLine <= destLine) {
            return 0;
          }
          // A malformed title on a later line is ignored.
        } else if (titleLine <= destLine) {
          return 0;
        }
        // A malformed title on a later line is ignored.
      } else if (p < text.length && text[p] !== '\n' && lineOf(p) === destLine) {
        // Extra text on the same line after the destination: invalid.
        return 0;
      }
    } else {
      // No whitespace between the destination and what follows: invalid.
      return 0;
    }
  }
  const key = normalizeLabel(label);
  if (!defs.has(key)) defs.set(key, { href: dest, title });
  return consumed;
}

/** Parse a link title starting at str[p] ('"', "'", or '('); the title may
 * span lines. Returns {title, end} or null. */
function parseTitleMulti(str, p) {
  const open = str[p];
  const close = open === '(' ? ')' : open;
  let k = p + 1;
  while (k < str.length) {
    const c = str[k];
    if (c === '\\' && k + 1 < str.length && isAsciiPunctCode(str.charCodeAt(k + 1))) {
      k += 2;
      continue;
    }
    if (c === close) return { title: str.slice(p + 1, k), end: k + 1 };
    if (open === '(' && c === '(') return null;
    k++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lazy container lines: a line without a container marker may continue the
// container when the previous collected line was not blank and does not
// start a block (fence, heading, html, thematic break) and is not indented
// 4 or more columns. `prev` is the previous line's check content (null when
// there is no previous line); for a list item it is the raw line with the
// content indent removed, for a blockquote the stored content (or the
// original line for a setext-prepended line).

/** May a line without a container marker continue the container? */
/** Container state for lazy-line decisions: whether the current open block
 * inside a container is a fenced code block or an HTML block (types 1-5,
 * or type 6 until a blank line). A lazy line may only continue a paragraph,
 * so it is never collected while either is open. */
function contStateUpdate(st, content) {
  if (st.fence) {
    if (isFenceClose(content, st.fence.ch, st.fence.len)) st.fence = null;
    return st;
  }
  if (st.html) {
    if (st.html.type === 6) {
      if (isBlankStr(content)) st.html = null;
    } else if (content.toLowerCase().indexOf(st.html.end) >= 0) {
      st.html = null;
    }
    return st;
  }
  const fi = fenceInfo(content);
  if (fi) { st.fence = fi; return st; }
  const hi = htmlStartInfo(content);
  if (hi) st.html = hi;
  return st;
}

/** May a line without a container marker lazy-continue the container?
 * `textMode` is true when the collected lines will be parsed in text mode
 * (inside a list item): there each line is tokenized separately, so ANY
 * list start ends the paragraph. In paragraph mode only a list that can
 * interrupt a paragraph does (a bullet, or an ordered list starting at 1).
 * `skipPrev` is true when the previous line is a fenced-code content line:
 * a lazy line then continues the fence, so the previous-line checks (the
 * fence is open, a blank line is fence content) do not apply. */
function canLazy(s, prev, prevBlank, lines, idx, textMode, skipPrev) {
  if (!skipPrev) {
    if (prev === null || prevBlank) return false;
    if (fenceInfo(prev) || atxInfo(prev) || htmlStartInfo(prev) || isHrStr(prev)) return false;
    // A setext underline closes the paragraph: a lazy line after it is a
    // new block's line, not a paragraph continuation.
    if (isSetextStr(prev)) return false;
    if (indentCols(prev)[0] >= 4) return false;
  }
  if (isBlankStr(s)) return false;
  // A setext-underline-looking line lazy-continues: it is not an underline
  // when it lacks the marker (it gets 4 spaces prepended, or the paragraph's
  // setext check skips lazy lines).
  if (atxInfo(s) || fenceInfo(s) || isHrStr(s) || htmlStartInfo(s) || isQuoteStr(s)) return false;
  const li = listStartInfo(s);
  if (li && (textMode || listCanInterrupt(lines, idx, li))) return false;
  return true;
}

/** Is the previous collected line a plain paragraph line (so a lazy setext
 * line after it gets 4 spaces prepended)? */
function prevIsPara(prev, prevBlank) {
  if (prev === null || prevBlank) return false;
  if (fenceInfo(prev) || atxInfo(prev) || htmlStartInfo(prev) || isHrStr(prev)) return false;
  if (isQuoteStr(prev) || listStartInfo(prev)) return false;
  if (indentCols(prev)[0] >= 4) return false;
  return true;
}

/** Does this line start a block that interrupts a paragraph? In text mode
 * (inside a list item) each line is tokenized separately, so ANY list start
 * interrupts; in paragraph mode only a list that can interrupt one does. */
/** Does this line end a table's body? Marked's table regex excludes a line
 * that is empty or only spaces (` *\n`), and a line that is an indented
 * code line (`(?: {4}| {0,3}\t)[^\n]`): the leading whitespace reaches
 * column 4 and a character follows. A lone tab (or spaces + a tab) is
 * neither, so it is a body row with empty cells. */
function tableBodyEnds(s) {
  if (s === '') return true;
  let p = 0;
  while (p < s.length && s[p] === ' ') p++;
  if (p === s.length) return true;
  let col = 0;
  p = 0;
  while (p < s.length && (s[p] === ' ' || s[p] === '\t')) {
    if (s[p] === ' ') col++;
    else col += 4 - (col % 4);
    p++;
    if (col >= 4) break;
  }
  return col >= 4 && p < s.length;
}

/** Does this line start a block that interrupts a paragraph? In text mode
 * (inside a list item) each line is tokenized separately, so ANY list start
 * interrupts; in paragraph mode only a list that can interrupt one does. */
function interruptsPara(lines, j, tm) {
  const s = lines[j].s;
  if (atxInfo(s) || fenceInfo(s) || isHrStr(s) || htmlStartInfo(s) || isQuoteStr(s)) return true;
  const li = listStartInfo(s);
  if (li && (tm || listCanInterrupt(lines, j, li))) return true;
  return false;
}

/** A paragraph's inline source; in text mode (inside a list item, not
 * inside a nested blockquote) continuation lines with an indent of 4 or
 * more lose 4 columns (indented-code merge), and a line following such a
 * merged line is separated from it by a blank line. */
function paraText(lines, tm) {
  if (!tm) return lines.join('\n');
  const out = [lines[0]];
  let merged = false;
  for (let k = 1; k < lines.length; k++) {
    const s = lines[k];
    if (indentCols(s)[0] >= 4) {
      out.push(stripCols(s, 4));
      merged = true;
    } else {
      if (merged) out.push('');
      out.push(s);
      merged = false;
    }
  }
  return out.join('\n');
}

/** Case-insensitive search for `marker` in `line` from `from`; returns the index or -1. */
function indexOfCI(line, marker, from) {
  const m = marker.length;
  outer: for (let i = from; i + m <= line.length; i++) {
    for (let k = 0; k < m; k++) {
      const a = line.charCodeAt(i + k);
      const b = marker.charCodeAt(k);
      if (a !== b && a !== (b >= 97 && b <= 122 ? b - 32 : b + 32)) continue outer;
    }
    return i;
  }
  return -1;
}


// ---------------------------------------------------------------------------
// The block parser

/**
 * Parse an array of {s, lazy} lines into block nodes.
 * `top` is true only for the document's own lines (an HTML block there keeps
 * a trailing newline when it runs to the end of the document); `tm` (text
 * mode) is true inside a list item, where paragraph continuation lines lose
 * 4 columns of indentation when they have 4 or more; a blockquote resets it
 * to false for its own content. `docNL` is true when the document ends with
 * a newline (a whitespace-only last line is then a blank line, not a
 * paragraph continuation, at the top level).
 */
function parseBlocks(lines, defs, top, tm, docNL) {
  const blocks = [];
  // True when a blank line separates two blocks at this level (used to
  // decide whether a list is loose; blank lines inside a nested container
  // are consumed by that container's own parse and do not count).
  let blankBetween = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const s = line.s;
    if (isBlankStr(s)) {
      let k = i;
      while (k < lines.length && isBlankStr(lines[k].s)) k++;
      if (blocks.length > 0 && k < lines.length) blankBetween = true;
      i = k;
      continue;
    }
    const defConsumed = tryDef(lines, i, defs);
    if (defConsumed > 0) {
      i += defConsumed;
      continue;
    }
    const atx = atxInfo(s);
    if (atx) {
      blocks.push({ k: 'h', level: atx.level, text: atx.text });
      i++;
      continue;
    }
    const fence = fenceInfo(s);
    if (fence) {
      const content = [];
      let j = i + 1;
      while (j < lines.length) {
        if (isFenceClose(lines[j].s, fence.ch, fence.len)) break;
        content.push(stripFenceContent(lines[j].s, fence));
        j++;
      }
      blocks.push({ k: 'fence', lang: fence.lang, lines: content });
      i = j + 1;
      continue;
    }
    const html = htmlStartInfo(s);
    if (html) {
      const textLines = [s];
      let j = i + 1;
      let endIdx = -1;
      if (html.type >= 1 && html.type <= 5) {
        let found = -1;
        for (let k = i; k < lines.length; k++) {
          const p = indexOfCI(lines[k].s, html.end, k === i ? indentCols(s)[1] + 1 : 0);
          if (p >= 0) {
            found = k;
            break;
          }
        }
        if (found >= 0) {
          for (let m = i + 1; m <= found; m++) textLines.push(lines[m].s);
          endIdx = found;
        } else {
          for (let m = i + 1; m < lines.length; m++) textLines.push(lines[m].s);
          endIdx = lines.length - 1;
        }
        j = endIdx + 1;
      } else {
        while (j < lines.length && !isBlankStr(lines[j].s)) {
          textLines.push(lines[j].s);
          j++;
        }
        endIdx = j - 1;
      }
      let text = textLines.join('\n');
      // A trailing newline: for types 1-5 marked's raw ends with one
      // newline when the line after the end-marker line is not EMPTY
      // (a whitespace-only line still counts — the raw has exactly one
      // newline then, and `ge` keeps it; an empty line gives two, which
      // `ge` strips). Type 6 ends at a blank line, so it never gets one
      // from the next line. At the top level a block running to the end
      // of a document that ends with a newline keeps one.
      const nextNotEmpty = j < lines.length && lines[j].s.length > 0;
      if ((html.type <= 5 && nextNotEmpty) || (top && endIdx === lines.length - 1 && docNL)) text += '\n';
      blocks.push({ k: 'html', text });
      i = j;
      continue;
    }
    if (isHtml7Str(s)) {
      const textLines = [s];
      let j = i + 1;
      while (j < lines.length && !isBlankStr(lines[j].s)) {
        textLines.push(lines[j].s);
        j++;
      }
      let text = textLines.join('\n');
      if (top && j - 1 === lines.length - 1 && docNL) text += '\n';
      blocks.push({ k: 'html', text });
      i = j;
      continue;
    }
    if (isHrStr(s)) {
      blocks.push({ k: 'hr' });
      i++;
      continue;
    }
    if (isQuoteStr(s)) {
      const qlines = [];
      let j = i;
      let prev = null;
      let prevBlank = false;
      let lastLazy = false;
      // A chunk of lazy lines that starts with an indented line is lexed
      // as indented code and merged into the paragraph (4 columns stripped).
      let codeChunk = false;
      // Whether the current open block is a fence or an HTML block: a lazy
      // line may only continue a paragraph, never either of these.
      const cst = { fence: null, html: null };
      while (j < lines.length) {
        const ls = lines[j].s;
        if (isQuoteStr(ls)) {
          const content = quoteContent(ls);
          qlines.push({ s: content, lazy: false });
          contStateUpdate(cst, content);
          prev = content;
          prevBlank = isBlankStr(content);
          lastLazy = false;
          codeChunk = false;
          j++;
          continue;
        }
        if (!cst.fence && !cst.html && canLazy(ls, prev, prevBlank, lines, j, false)) {
          let stored = ls;
          let bl = false;
          let cm = false;
          const ind = indentCols(ls)[0];
          let prevForNext = ls;
          if (isSetextStr(ls)) {
            if (codeChunk) {
              // The 4-space prepend makes this line part of the code block,
              // which strips the 4 spaces back: the line stays as-is.
            } else if (lastLazy) {
              // A lazy setext line is not an underline: 4 spaces prepended.
              stored = '    ' + ls.replace(/^[ \t]+/, '');
            }
          } else if (ind >= 4 && (codeChunk || !lastLazy)) {
            // Chunk-starting indented lazy line: indented-code merge.
            stored = stripCols(ls, 4);
            codeChunk = true;
            cm = true;
            prevForNext = stored;
          } else if (codeChunk) {
            // The code chunk ends: a blank line is inserted before this line
            // when it joins the paragraph.
            bl = true;
            codeChunk = false;
          }
          const obj = { s: stored, lazy: true };
          if (bl) obj.bl = true;
          if (cm) obj.cm = true;
          qlines.push(obj);
          contStateUpdate(cst, stored);
          prev = prevForNext;
          prevBlank = false;
          lastLazy = true;
          j++;
          continue;
        }
        break;
      }
      blocks.push({ k: 'q', blocks: parseBlocks(qlines, defs, false, false, docNL) });
      i = j;
      continue;
    }
    const li = listStartInfo(s);
    if (li) {
      const ordered = li.ordered;
      const bullet = li.bullet;
      const delim = li.delim;
      const start = li.start;
      const items = [];
      let j = i;
      let curInfo = null;
      let curLines = null;
      let prev = null;
      let prevBlank = false;
      // Whether the current open block inside this item is a fence or an
      // HTML block: a lazy line may only continue a paragraph.
      let cst = { fence: null, html: null };
      while (j < lines.length) {
        const ls = lines[j].s;
        if (curInfo && !isBlankStr(ls) && indentCols(ls)[0] >= curInfo.contentIndent) {
          // A line indented to the item's content belongs to this item,
          // even when it looks like a list marker.
          const content = stripColsFrom(ls, 0, 0, curInfo.contentIndent);
          curLines.push({ s: content, lazy: false });
          contStateUpdate(cst, content);
          prev = content;
          prevBlank = isBlankStr(content);
          j++;
          continue;
        }
        // A thematic break ends the list, even when it looks like an item.
        if (isHrStr(ls)) break;
        const info = listStartInfo(ls);
        if (info && info.ordered === ordered && (ordered ? info.delim === delim : info.bullet === bullet)) {
          if (curInfo) items.push({ info: curInfo, lines: curLines });
          curInfo = info;
          curLines = [{ s: info.content, lazy: false }];
          cst = { fence: null, html: null };
          contStateUpdate(cst, info.content);
          prev = info.content;
          prevBlank = isBlankStr(info.content);
          j++;
          // An empty item followed by a blank line is empty: the blank line
          // is consumed and the following lines are not part of the item.
          // A blank line after an empty item still separates two items of
          // the same list, so it counts for looseness.
          if (isBlankStr(info.content) && j < lines.length && isBlankStr(lines[j].s)) {
            items.push({ info, lines: curLines, blankAfter: true });
            curInfo = null;
            curLines = null;
            cst = { fence: null, html: null };
            prev = null;
            prevBlank = false;
            j++;
          }
          continue;
        }
        if (!curInfo) break;
        // Any list marker ends the list (a new list follows), even one that
        // could not interrupt a paragraph.
        if (listStartInfo(ls)) break;
        if (isBlankStr(ls)) {
          // A blank line is collected only when the next non-blank line
          // still belongs to this list (a new item or a member line).
          // Otherwise the list ends before the blank line, so the outer
          // level still sees it as a separator between two blocks.
          let k = j + 1;
          while (k < lines.length && isBlankStr(lines[k].s)) k++;
          if (k < lines.length) {
            const ns = lines[k].s;
            const ninfo = listStartInfo(ns);
            const sameItem = ninfo && ninfo.ordered === ordered && (ordered ? ninfo.delim === delim : ninfo.bullet === bullet);
            if (!sameItem && indentCols(ns)[0] < curInfo.contentIndent) break;
          }
          curLines.push({ s: '', lazy: false });
          contStateUpdate(cst, '');
          prev = '';
          prevBlank = true;
          j++;
          continue;
        }
        // A lazy line continues a fenced code block inside a list item (it
        // is fence content) once past the fence's opening line, but never
        // an HTML block. In a blockquote it continues neither.
        const inFenceContent = !!cst.fence && prev !== null && !fenceInfo(prev);
        if (!cst.html && (inFenceContent ? canLazy(ls, prev, prevBlank, lines, j, true, true) : (!cst.fence && canLazy(ls, prev, prevBlank, lines, j, true)))) {
          let stored = ls;
          if (isSetextStr(ls) && prevIsPara(prev, prevBlank)) {
            // A lazy setext line is not an underline: 4 spaces prepended
            // (the text-mode render strips them back, and a following line
            // is separated by a blank line).
            stored = '    ' + ls.replace(/^[ \t]+/, '');
          }
          curLines.push({ s: stored, lazy: true });
          contStateUpdate(cst, stored);
          // The check content for the next line is the raw line with the
          // content indent removed (as in marked's list lexer).
          prev = stripColsFrom(ls, 0, 0, curInfo.contentIndent);
          prevBlank = false;
          j++;
          continue;
        }
        break;
      }
      if (curInfo) items.push({ info: curInfo, lines: curLines });
      // The whole list's trailing whitespace is dropped from its last line.
      const lastItem = items[items.length - 1];
      if (lastItem) {
        for (let m = lastItem.lines.length - 1; m >= 0; m--) {
          if (!isBlankStr(lastItem.lines[m].s)) {
            lastItem.lines[m].s = lastItem.lines[m].s.replace(/[ \t]+$/, '');
            break;
          }
        }
      }
      const outItems = [];
      for (const item of items) {
        const itemBlocks = parseBlocks(item.lines, defs, false, true, docNL);
        let task = null;
        if (itemBlocks.length > 0 && itemBlocks[0].k === 'p') {
          const first = itemBlocks[0];
          const text = paraText(first.lines, first.tm);
          const m = /^\[( |x|X)\][ \t]+\S/.exec(text);
          if (m) {
            task = m[1] === ' ' ? false : true;
            first.lines[0] = first.lines[0].replace(/^\[[ xX]\][ \t]+/, '');
          }
        }
        outItems.push({ blocks: itemBlocks, task });
      }
      // Loose when a blank line separates two blocks inside an item, or a
      // blank line follows an item's last block while more items follow.
      // The item's own first line (the marker's content) never counts.
      let loose = false;
      for (let k = 0; k < outItems.length; k++) {
        if (outItems[k].blocks.blankBetween) { loose = true; break; }
        if (k < outItems.length - 1) {
          if (items[k].blankAfter) { loose = true; break; }
          const ls2 = items[k].lines;
          let end = ls2.length;
          while (end > 1 && isBlankStr(ls2[end - 1].s)) end--;
          if (end < ls2.length) { loose = true; break; }
        }
      }
      blocks.push({ k: 'list', ordered, start, loose, items: outItems });
      i = j;
      continue;
    }
    if (indentCols(s)[0] >= 4) {
      const content = [];
      let j = i;
      while (j < lines.length) {
        const ls = lines[j].s;
        if (isBlankStr(ls)) {
          // A blank line keeps its stripped content (e.g. a 6-space blank
          // line becomes two spaces), it is not emptied.
          content.push(stripColsKeep(ls, 4));
          j++;
          continue;
        }
        if (indentCols(ls)[0] < 4) break;
        content.push(stripColsKeep(ls, 4));
        j++;
      }
      while (content.length > 0 && isBlankStr(content[content.length - 1])) content.pop();
      blocks.push({ k: 'code', lines: content });
      i = j;
      continue;
    }
    // Paragraph, with setext-heading and table checks on its second line.
    const paraLines = [s];
    let j = i + 1;
    let done = false;
    while (j < lines.length) {
      const ls = lines[j].s;
      if (isBlankStr(ls)) {
        // A whitespace-only line is a paragraph continuation when it is the
        // last line and is not followed by a newline: at the top level only
        // when the document does not end with one, inside a container always
        // (a container's text has no trailing newline).
        if (ls !== '' && j === lines.length - 1 && (!top || !docNL)) {
          paraLines.push(ls);
          j++;
          continue;
        }
        break;
      }
      // A code-merged line is paragraph text only: it cannot start a block
      // (a stripped `- bar` is not a list item, a stripped ` ===` is not a
      // setext underline).
      if (lines[j].cm) {
        paraLines.push(ls);
        j++;
        continue;
      }
      // A lazy line is never a setext underline.
      if (!lines[j].lazy && isSetextStr(ls)) {
        const first = paraLines[0].replace(/^[ \t]+/, '');
        const text = [first, ...paraLines.slice(1)].join('\n').replace(/[ \t]+$/, '');
        blocks.push({ k: 'h', level: setextLevel(ls), text });
        j++;
        done = true;
        break;
      }
      // A table delimiter line: in text mode (a list item) a lazy delimiter
      // still forms a table; inside a blockquote it does not (the header and
      // the delimiter fall in different chunks there).
      if (paraLines.length === 1 && (tm || !lines[j].lazy) && !line.lazy && indentCols(ls)[0] <= 3) {
        const dc = tableDelimCells(ls);
        if (dc && dc.length === splitCells(paraLines[0]).length) {
          const head = splitCells(paraLines[0]);
          const aligns = dc.map(cellAlign);
          const rows = [];
          j++;
          while (j < lines.length) {
            const rs = lines[j].s;
            // A table body row ends at a blank/indented-code line (see
            // tableBodyEnds); a list start ends it only in paragraph mode
            // (the table regex's list lookahead allows only a bullet or an
            // ordered list starting at 1), even inside a list item.
            if (tableBodyEnds(rs) || interruptsPara(lines, j, false)) break;
            let cells = splitCells(rs);
            while (cells.length < head.length) cells.push('');
            if (cells.length > head.length) cells.length = head.length;
            rows.push(cells);
            j++;
          }
          blocks.push({ k: 'table', aligns, head, rows });
          done = true;
          break;
        }
      }
      if (interruptsPara(lines, j, tm)) break;
      // A line ending an indented-code merge is separated by a blank line.
      if (lines[j].bl) paraLines.push('');
      paraLines.push(ls);
      j++;
    }
    if (!done) blocks.push({ k: 'p', lines: paraLines, tm });
    i = j;
  }
  blocks.blankBetween = blankBetween;
  return blocks;
}

// ---------------------------------------------------------------------------
// Rendering

/** A code block's content: the lines joined with newlines, with exactly one
 * trailing newline removed (if present) and one added; empty stays empty. */
function codeText(lines) {
  if (lines.length === 0) return '';
  const text = lines.join('\n');
  // marked's code renderer is `e ? e.replace(/\n$/, "") + "\n" : ""`: an
  // empty token text stays empty (a fence with one empty content line
  // renders `<code></code>`, not `<code>\n</code>`).
  if (text === '') return '';
  return escPlain((text.endsWith('\n') ? text.slice(0, -1) : text) + '\n');
}

function renderBlocks(blocks, defs) {
  const out = [];
  for (const b of blocks) {
    switch (b.k) {
      case 'p':
        out.push('<p>' + parseInline(paraText(b.lines, b.tm), defs, false) + '</p>\n');
        break;
      case 'h':
        out.push('<h' + b.level + '>' + parseInline(b.text, defs, false) + '</h' + b.level + '>\n');
        break;
      case 'fence': {
        const lang = b.lang ? ' class="language-' + escAttr(b.lang) + '"' : '';
        out.push('<pre><code' + lang + '>' + codeText(b.lines) + '</code></pre>\n');
        break;
      }
      case 'code': {
        out.push('<pre><code>' + codeText(b.lines) + '</code></pre>\n');
        break;
      }
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'html':
        out.push(b.text);
        break;
      case 'q':
        out.push('<blockquote>\n' + renderBlocks(b.blocks, defs) + '</blockquote>\n');
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const startAttr = b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '';
        out.push('<' + tag + startAttr + '>\n');
        for (const item of b.items) {
          const checkbox = item.task === null
            ? ''
            : item.task
              ? '<input checked="" disabled="" type="checkbox"> '
              : '<input disabled="" type="checkbox"> ';
          const blocks = item.blocks;
          if (blocks.length === 0) {
            out.push('<li></li>\n');
            continue;
          }
          if (b.loose) {
            if (blocks[0].k === 'p' && checkbox) {
              out.push('<li><p>' + checkbox + parseInline(paraText(blocks[0].lines, blocks[0].tm), defs, false) + '</p>\n' + renderBlocks(blocks.slice(1), defs) + '</li>\n');
            } else {
              out.push('<li>' + renderBlocks(blocks, defs) + '</li>\n');
            }
          } else {
            // Tight: every paragraph that is a direct child of the item
            // renders as inline content (no <p>); other blocks render as
            // usual. The checkbox goes before the first paragraph.
            let html = '';
            for (let bi = 0; bi < blocks.length; bi++) {
              const blk = blocks[bi];
              if (blk.k === 'p') {
                html += (bi === 0 ? checkbox : '') + parseInline(paraText(blk.lines, blk.tm), defs, false);
              } else {
                html += renderBlocks([blk], defs);
              }
            }
            out.push('<li>' + html + '</li>\n');
          }
        }
        out.push('</' + tag + '>\n');
        break;
      }
      case 'table': {
        out.push('<table>\n<thead>\n<tr>\n');
        for (let c = 0; c < b.head.length; c++) {
          const a = b.aligns[c];
          out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(b.head[c], defs, false) + '</th>\n');
        }
        out.push('</tr>\n</thead>\n');
        if (b.rows.length > 0) {
          out.push('<tbody>');
          for (const row of b.rows) {
            out.push('<tr>\n');
            for (let c = 0; c < row.length; c++) {
              const a = b.aligns[c];
              out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(row[c], defs, false) + '</td>\n');
            }
            out.push('</tr>\n');
          }
          out.push('</tbody>');
        }
        out.push('</table>\n');
        break;
      }
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// Entry point

export function parse(markdown) {
  INLINK = false;
  INRAW = false;
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const rawLines = normalized.split('\n');
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
  const lines = rawLines.map((s) => ({ s, lazy: false }));
  const defs = new Map();
  const blocks = parseBlocks(lines, defs, true, false, normalized.endsWith('\n'));
  return renderBlocks(blocks, defs);
}
