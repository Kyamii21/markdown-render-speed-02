// parse.js — a fast, dependency-free CommonMark 0.31.2 + GFM renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (gfm on, breaks off, pedantic off, async off): the
// 680 CommonMark spec examples, the 28 GFM extension examples, and any
// generated document built from the same constructs. Where marked departs
// from the spec, marked's output is what this returns.
//
// Design: one pass over the block structure (the CommonMark reference
// algorithm, with container blocks matched line by line), then one pass
// over each leaf block's inline content with a single delimiter stack for
// emphasis, links and images. No dependencies, no model calls, no file or
// network access; output is deterministic.

/* ------------------------------------------------------------------ */
/* Character classes and escaping                                      */
/* ------------------------------------------------------------------ */

// ASCII punctuation, as CommonMark defines it.
const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

function isSpace(c) {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

function isDigit(c) {
  return c >= '0' && c <= '9';
}

function isAlphaNum(c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

// A Unicode punctuation or symbol character. ASCII is handled by the
// table above; anything else goes through a cached property test.
const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/u;
function isPunct(c) {
  if (c.length === 1 && c.charCodeAt(0) < 128) return PUNCT.has(c);
  return PUNCT_OR_SYMBOL.test(c);
}

function isWhitespace(c) {
  if (c.length === 1 && c.charCodeAt(0) < 128) return isSpace(c);
  return /\s/u.test(c);
}

// Marked's emStrong masking (its #n) and last-possible-closer index
// (its fe). Before deciding where an emphasis closer may lie, marked
// masks links, code spans and HTML tags out of the inline source.
// A code span in the masking regex may contain backticks of a
// different length (its content is [^`][\s\S]*?[^`]), so a `` opener
// in link text can mask everything up to a later `` closer —
// including a _..._ pair — and then fe reports no _ closer, so the
// em never forms (doc-09: _issue table_ after a ``url`` link). The
// replacements preserve length, so positions in the masked source
// line up with the original.
const MASK_PUNCT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCKSKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\)]|\((?:\\[\s\S]|[^\\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
function maskedEmStrongLimit(s) {
  let t = s;
  t = t.replace(MASK_PUNCT_RE, (n, g1, g2) => g2 ? '+'.repeat(n.length) : g1 ? g1 + n.slice(g1.length, -g1.length).replace(/`/g, '+') + g1 : n);
  // Record the spans the blockSkip step masks (links, code spans,
  // HTML tags): a * or _ run inside one is invisible to marked's
  // closer scan on the masked source, so it can never be a closer
  // (doc-23: the _ after a code span inside an invalid link label is
  // masked by the link match, so the _ opener before it never pairs).
  const masked = [];
  MASK_BLOCKSKIP_RE.lastIndex = 0;
  let m;
  while ((m = MASK_BLOCKSKIP_RE.exec(t)) !== null) masked.push([m.index, m.index + m[0].length]);
  t = t.replace(MASK_BLOCKSKIP_RE, (n, _a, r) => { const o = r ? r.length : 0; return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']'; });
  // fe: last run of * or _ not preceded by whitespace.
  let star = -1, under = -1;
  for (let i = 0; i < t.length; i++) {
    const r = t[i];
    if (r !== '*' && r !== '_') continue;
    const o = i === 0 ? '\n' : t[i - 1];
    let j = i + 1;
    while (j < t.length && t[j] === r) j++;
    if (o !== ' ' && o !== '\t' && o !== '\n' && o !== '\r' && o !== '\f') {
      if (r === '*') star = i; else under = i;
    }
    i = j - 1;
  }
  return { '*': star, '_': under, masked };
}


// Escape text content: &, <, >, " and ' all become entities.
const ESC_TEXT_RE = /[&<>"']/g;
const ESC_TEXT_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeText(s) {
  if (s.indexOf('&') === -1 && s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1) return s;
  return s.replace(ESC_TEXT_RE, (c) => ESC_TEXT_MAP[c]);
}

// Escape an attribute value or a URL the way marked does: <, > " and '
// are always escaped, while & is left alone when it starts a valid
// character reference (so &ouml; in a URL stays &ouml;).
const ESC_ATTR_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;
const ESC_ATTR_MAP = { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' };
function escapeAttr(s) {
  if (s.indexOf('<') === -1 && s.indexOf('>') === -1 && s.indexOf('"') === -1 && s.indexOf("'") === -1 && s.indexOf('&') === -1) return s;
  return s.replace(ESC_ATTR_RE, (c) => ESC_ATTR_MAP[c]);
}

// A numeric character reference, or a bare & that is not part of a
// valid-looking reference. Named references (&copy;, &MadeUp;) are not
// matched here: marked leaves them as literal text.
const NUMREF_OR_AMP_RE = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function decodeNumericRefs(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(NUMREF_OR_AMP_RE, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// Render plain text: decode numeric references and bare ampersands, then
// escape < > " ' (and any & that is not part of a valid-looking
// reference). Named references pass through unchanged.
function renderText(s) {
  return escapeAttr(decodeNumericRefs(s));
}

// Clean a link destination the way marked does: percent-encode it (spaces,
// backslashes, quotes, non-ASCII and the like), but leave a literal %
// alone so already-encoded sequences survive. Returns null when the
// destination cannot be encoded (a lone surrogate); the caller then
// renders the link text without an anchor.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Inline parsing                                                      */
/* ------------------------------------------------------------------ */

// Characters that can start inline markup. The main scan jumps from one
// of these to the next with a single regular expression. & is not one:
// entities are handled when plain text is rendered, so an & never needs
// to split a chunk.
const SPECIAL_RE = /[\\`*_[\]!<~\n]/g;

// Collapse the whitespace in a link label to single spaces, trim it and
// fold its case, the way link reference definitions are matched. The
// label is compared exactly as written otherwise: backslash escapes in a
// label are not resolved.
function normalizeLabel(s) {
  // Unicode case folding: the sharp s folds to "ss" (so ẞ and ß both
  // match SS), which toLowerCase alone does not do.
  return s.replace(/ß/g, 'ss').replace(/ẞ/g, 'ss').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Resolve backslash escapes in a raw string: a backslash before an ASCII
// punctuation character yields that character; any other backslash is
// left alone. Used for link destinations and titles.
function unescapeStr(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.has(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// Parse a link destination starting at s[i], where s[i] is '(' or the
// first character of the destination. Returns {dest, next} with next the
// index just past the destination, or null when there is no destination
// here. The destination is returned with backslash escapes resolved and
// not yet URL-encoded.
function parseDestination(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    // <...> destination: no line ending, no unescaped < or > inside.
    let j = i + 1;
    let dest = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: unescapeStr(dest), next: j + 1 };
      if (c === '\\' && j + 1 < n && PUNCT.has(s[j + 1])) {
        dest += s[j + 1];
        j += 2;
      } else {
        dest += c;
        j++;
      }
    }
    return null;
  }
  // Bare destination: no spaces or control characters, parentheses
  // balanced; a ) at depth zero ends it.
  let j = i;
  let depth = 0;
  let dest = '';
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c.charCodeAt(0) < 32) break;
    if (c === '(') {
      depth++;
      dest += c;
      j++;
    } else if (c === ')') {
      if (depth === 0) break;
      depth--;
      dest += c;
      j++;
    } else if (c === '\\' && j + 1 < n && PUNCT.has(s[j + 1])) {
      dest += s[j + 1];
      j += 2;
    } else {
      dest += c;
      j++;
    }
  }
  if (j === i) return { dest: '', next: j };
  return { dest, next: j };
}

// Parse a link title starting at s[i] (a ", ' or (). Returns
// {title, next} with next just past the closing quote, or null.
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  let close;
  if (q === '"') close = '"';
  else if (q === "'") close = "'";
  else if (q === '(') close = ')';
  else return null;
  let j = i + 1;
  let title = '';
  while (j < n) {
    const c = s[j];
    if (c === close) return { title: unescapeStr(title), next: j + 1 };
    if (c === '\\' && j + 1 < n && PUNCT.has(s[j + 1])) {
      title += s[j + 1];
      j += 2;
    } else {
      title += c;
      j++;
    }
  }
  return null;
}

// Skip spaces, tabs and newlines starting at i.
function skipWhitespace(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f') i++;
    else break;
  }
  return i;
}

// Parse an inline link's (destination title) starting at s[i] == '('.
// Returns {dest, title, next} with next just past the closing ')', or
// null when the text here is not a valid inline link.
function parseInlineLink(s, i) {
  const n = s.length;
  // An inline link's ( must immediately follow the ]. Without it
  // there is no inline link (a [label] after the ] is a reference
  // form, not a destination).
  if (i >= n || s[i] !== '(') return null;
  let j = skipWhitespace(s, i + 1);
  const d = parseDestination(s, j);
  if (!d) return null;
  j = d.next;
  j = skipWhitespace(s, j);
  let title = null;
  if (j < n && (s[j] === '"' || s[j] === "'" || s[j] === '(')) {
    const t = parseTitle(s, j);
    if (!t) return null;
    title = t.title;
    j = skipWhitespace(s, t.next);
  }
  if (j >= n || s[j] !== ')') return null;
  return { dest: d.dest, title, next: j + 1 };
}

// Parse a [label] starting at s[i] == '['. The label runs to the first
// unescaped ']'. Returns {label, next} with next just past ']', or null.
function parseLabel(s, i) {
  const n = s.length;
  if (i >= n || s[i] !== '[') return null;
  let j = i + 1;
  let label = '';
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && (s[j + 1] === '\\' || s[j + 1] === '[' || s[j + 1] === ']')) {
      // An escaped backslash, [ or ] stays in the label raw (labels
      // are matched without resolving escapes). A \\ pair is one
      // escaped backslash, so the ] after it still closes the label.
      label += s[j] + s[j + 1];
      j += 2;
    } else if (c === ']') {
      return { label, next: j + 1 };
    } else if (c === '[') {
      // A nested unescaped [ ends the label here: the label is the text
      // up to it, and the [ belongs to the text after.
      return { label, next: j, nested: true };
    } else {
      label += c;
      j++;
    }
  }
  return null;
}

// Block tag names for HTML blocks (condition 6) and inline HTML.
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Try to read an HTML tag (open or close) starting at s[i] == '<'.
// Returns the index just past the '>' or -1 when this is not a tag.
function scanHtmlTag(s, i) {
  const n = s.length;
  let j = i + 1;
  const closing = j < n && s[j] === '/';
  if (closing) j++;
  // Tag name: a letter followed by letters, digits or hyphens.
  if (j >= n || !/[A-Za-z]/.test(s[j])) return -1;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  // A closing tag takes no attributes: only whitespace and > may
  // follow its name.
  if (closing) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r' || s[j] === '\f')) j++;
    if (j < n && s[j] === '>') return j + 1;
    return -1;
  }
  // The tag name must be followed by >, / or whitespace: a character
  // directly after it (such as the : in <m:abc>) is not an attribute,
  // so the < is literal text.
  if (j < n && s[j] !== '>' && s[j] !== '/' && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '\r' && s[j] !== '\f') return -1;
  // Attributes. Each attribute must be preceded by whitespace: two
  // attributes (or a value and the next attribute) with nothing
  // between them, such as 'bar'title, are not a tag.
  for (;;) {
    // Skip whitespace. It must be present before an attribute name
    // (the tag name itself is checked above, and > or / end the tag).
    let skippedWs = false;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r' || s[j] === '\f')) { j++; skippedWs = true; }
    if (j >= n) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/') {
      // The / must be directly followed by > (no space between).
      if (j + 1 < n && s[j + 1] === '>') return j + 2;
      return -1;
    }
    if (!skippedWs) return -1;
    // Attribute name: an XML-like name (a letter, _ or : first, then
    // letters, digits, ., -, _ or :). Other punctuation (*, #, !)
    // cannot start or continue one, so the < is literal text.
    if (s[j] === '\\') return -1;
    if (!/[A-Za-z_:]/.test(s[j])) return -1;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    // Optional = value. Whitespace may surround the =. When there is
    // no =, rewind past the whitespace we skipped: it belongs to the
    // separator before the next attribute, not to this one.
    const afterName = j;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r' || s[j] === '\f')) j++;
    if (j < n && s[j] === '=') {
      j++;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r' || s[j] === '\f')) j++;
      if (j >= n) return -1;
      if (s[j] === '"') {
        j++;
        while (j < n && s[j] !== '"') j++;
        if (j >= n) return -1;
        j++;
      } else if (s[j] === "'") {
        j++;
        while (j < n && s[j] !== "'") j++;
        if (j >= n) return -1;
        j++;
      } else {
        if (s[j] === '\\') return -1;
        if (!/[^ \t\n\r\f=<>`"'']/.test(s[j])) return -1;
        while (j < n && /[^ \t\n\r\f=<>`"'']/.test(s[j])) j++;
      }
    } else {
      j = afterName;
    }
  }
}

// Scan a domain for a <...> email autolink starting at s[i]: one or more
// labels of letters, digits and hyphens, each starting and ending with a
// letter or digit, joined by dots. Returns {end, labels}, or null when
// the first label is empty. A trailing dot leaves end just past it, with
// the label count as it was.
function scanDomain(s, i) {
  const n = s.length;
  let d = i;
  let labels = 0;
  for (;;) {
    if (d >= n || !/[A-Za-z0-9]/.test(s[d])) return labels === 0 ? null : { end: d, labels };
    let e = d;
    while (e < n && /[A-Za-z0-9-]/.test(s[e])) e++;
    while (e > d && s[e - 1] === '-') e--;
    labels++;
    d = e;
    if (d < n && s[d] === '.') {
      d++;
      continue;
    }
    return { end: d, labels };
  }
}

// Build an autolink anchor. Autolinks use the full escape for both the
// href and the text, unlike explicit links (which use the no-encode
// escape for the href). When the href cannot be encoded, marked renders
// just the text, so return that instead.
function autolinkHtml(url, href) {
  const text = escapeText(url);
  const cleaned = cleanUrl(href);
  if (cleaned === null) return text;
  return '<a href="' + escapeText(cleaned) + '">' + text + '</a>';
}

// Try to read an autolink <scheme:...> or <email> starting at s[i] ==
// '<', or a chunk of raw HTML starting there. Returns {html, next} or
// null when the '<' is literal text.
function tryAngle(s, i) {
  const n = s.length;
  // HTML comment. <!--> and <!---> are complete comments on their
  // own; otherwise the comment runs to the first -->.
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) {
      return { html: '<!-->', next: i + 5, plain: escapeAttr('<!-->') };
    }
    if (s.startsWith('<!--->', i)) {
      return { html: '<!--->', next: i + 6, plain: escapeAttr('<!--->') };
    }
    const end = s.indexOf('-->', i + 4);
    if (end !== -1) {
      const html = s.slice(i, end + 3);
      return { html, next: end + 3, plain: escapeAttr(html) };
    }
    return null;
  }
  // Processing instruction.
  if (s.startsWith('<?', i)) {
    const end = s.indexOf('?>', i + 2);
    if (end !== -1) {
      const html = s.slice(i, end + 2);
      return { html, next: end + 2, plain: escapeAttr(html) };
    }
    return null;
  }
  // Declaration <!A...>.
  if (s.startsWith('<!', i) && i + 2 < n && /[A-Za-z]/.test(s[i + 2])) {
    const end = s.indexOf('>', i + 2);
    if (end !== -1) {
      const html = s.slice(i, end + 1);
      return { html, next: end + 1, plain: escapeAttr(html) };
    }
    return null;
  }
  // CDATA section.
  if (s.startsWith('<![CDATA[', i)) {
    const end = s.indexOf(']]>', i + 9);
    if (end !== -1) {
      const html = s.slice(i, end + 3);
      return { html, next: end + 3, plain: escapeAttr(html) };
    }
    return null;
  }
  // Autolink <scheme:...> or <email>.
  if (i + 1 < n && /[A-Za-z]/.test(s[i + 1])) {
    let j = i + 1;
    // Scheme: a letter, then 1 to 31 letters, digits, +, - or ., then :.
    // The whole scheme is 2 to 32 characters.
    let k = j + 1;
    while (k < n && k < j + 32 && /[A-Za-z0-9+.-]/.test(s[k])) k++;
    if (k < n && s[k] === ':' && k - j >= 2) {
      // Scan the rest up to >: no whitespace, control character or
      // angle bracket.
      let m = k + 1;
      while (m < n) {
        const c = s[m];
        if (c === '>') {
          const url = s.slice(i + 1, m);
          return { html: autolinkHtml(url, url), next: m + 1, plain: escapeAttr(url) };
        }
        if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<' || c.charCodeAt(0) < 32) break;
        m++;
      }
    }
    // Email: local@domain, then >. The local part uses the full set of
    // characters allowed in an address; the domain labels must start and
    // end with a letter or digit, and there must be a dot.
    let a = s.indexOf('@', j);
    if (a !== -1) {
      let ls = a;
      while (ls > j && /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]/.test(s[ls - 1])) ls--;
      if (ls < a && ls === j) {
        const dom = scanDomain(s, a + 1);
        if (dom && dom.labels >= 2 && dom.end < n && s[dom.end] === '>') {
          const email = s.slice(j, dom.end);
          return { html: autolinkHtml(email, 'mailto:' + email), next: dom.end + 1, plain: escapeAttr(email) };
        }
      }
    }
  }
  // Raw HTML open or close tag.
  const tagEnd = scanHtmlTag(s, i);
  if (tagEnd !== -1) {
    const html = s.slice(i, tagEnd);
    return { html, next: tagEnd, plain: escapeAttr(html) };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* GFM extended autolinks (www., scheme://, mailto:, email)            */
/* ------------------------------------------------------------------ */

// The local part of a bare email address, as marked recognises it:
// letters, digits, dot, underscore, plus and hyphen.
const EMAIL_LOCAL_RE = /[A-Za-z0-9._+-]/;
// The characters a bare email domain label may hold.
const EMAIL_DOM_RE = /[A-Za-z0-9-_]/;

// Scan the domain of a bare email address starting at s[i]: the first
// label is one or more letters, digits, hyphens or underscores, then one
// or more dot groups, each a dot, any number of label characters and one
// final letter or digit. Returns the end of the domain, or -1 when there
// is no dot group. The caller checks the character after the domain is
// not a word character or a hyphen.
function scanExtEmailDomain(s, i) {
  const n = s.length;
  let d = i;
  if (d >= n || !EMAIL_DOM_RE.test(s[d])) return -1;
  while (d < n && EMAIL_DOM_RE.test(s[d])) d++;
  let groups = 0;
  while (d < n && s[d] === '.') {
    let e = d + 1;
    while (e < n && EMAIL_DOM_RE.test(s[e])) e++;
    // The group must end with a letter or digit; backtrack over any
    // trailing hyphens or underscores, which are not part of it. A
    // dot with no label after it (a trailing .) simply ends the
    // domain here; it does not invalidate the email.
    let f = e;
    while (f > d + 1 && !/[A-Za-z0-9]/.test(s[f - 1])) f--;
    if (f === d + 1) break;
    groups++;
    d = f;
  }
  return groups === 0 ? -1 : d;
}

// Trim the end of a www. or scheme:// autolink the way marked's
// backpedal does: a run of trailing punctuation (? ! . , : ; * _ ' " ~
// ) is dropped, a trailing entity-like &word; suffix is dropped, a
// balanced ( ... ) group is kept whole, and an unmatched ( is dropped.
const BACKPEDAL_PUNCT = '?!.,:;*_\'"~)';
function backpedalUrl(s, start, end) {
  let i = start;
  while (i < end) {
    const c = s[i];
    if (c === '(') {
      let j = i + 1;
      while (j < end && s[j] !== ')') j++;
      if (j >= end) break;
      i = j + 1;
      continue;
    }
    if (c === '&') {
      let j = i + 1;
      while (j < end && /[A-Za-z0-9]/.test(s[j])) j++;
      if (j < end && s[j] === ';' && j === end - 1) break;
      i++;
      continue;
    }
    if (BACKPEDAL_PUNCT.indexOf(c) !== -1) {
      let j = i;
      while (j < end && BACKPEDAL_PUNCT.indexOf(s[j]) !== -1) j++;
      if (j >= end) break;
      i = j;
      continue;
    }
    i++;
  }
  return i;
}

// Scan a www. or scheme:// URL from its start i to the first whitespace,
// < or end of input, then backpedal the end. Returns the end, or -1 when
// nothing follows the prefix. When limit >= 0 the scan stops there too:
// a URL inside link text must not swallow the ] that closes the bracket
// into a link (marked parses the link at the [ first, and inside link
// text no extended autolink forms).
function scanUrlEnd(s, i, limit) {
  const n = s.length;
  let e = i;
  while (e < n && (limit === undefined || limit < 0 || e < limit)) {
    const c = s[e];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '<') break;
    e++;
  }
  return backpedalUrl(s, i, e);
}

// The character before a www. autolink must be the start of the text, a
// space, *, _, ~ or (.
function isWwwBoundary(s, i) {
  if (i <= 0) return true;
  const c = s[i - 1];
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '*' || c === '_' || c === '~' || c === '(';
}

// Try to match a www. autolink at s[i]. The character after www. must be
// a letter, digit or hyphen.
function tryWww(s, i, limit) {
  if (!isWwwBoundary(s, i)) return null;
  if (i + 4 >= s.length || !/[A-Za-z0-9-]/.test(s[i + 4])) return null;
  const e = scanUrlEnd(s, i, limit);
  if (e <= i + 4) return null;
  const url = s.slice(i, e);
  return { html: autolinkHtml(url, 'http://' + url), next: e, raw: url };
}

// Try to match a http://, https:// or ftp:// autolink starting at s[i]
// (the scheme may be in any case). The character after :// must be a
// letter, digit or hyphen.
function tryScheme(s, i, limit) {
  const rest = s.slice(i, i + 8).toLowerCase();
  let after = -1;
  if (rest.startsWith('http://')) after = i + 7;
  else if (rest.startsWith('https://')) after = i + 8;
  else if (rest.startsWith('ftp://')) after = i + 6;
  else return null;
  if (after >= s.length || !/[A-Za-z0-9-]/.test(s[after])) return null;
  const e = scanUrlEnd(s, i, limit);
  if (e <= after) return null;
  const url = s.slice(i, e);
  return { html: autolinkHtml(url, url), next: e, raw: url };
}

// Scan the local part of a bare email backwards from the @ at s[a].
// Returns its start, or a when there is no local part.
function backtrackEmailLocal(s, a) {
  let ls = a;
  while (ls > 0 && EMAIL_LOCAL_RE.test(s[ls - 1])) ls--;
  return ls;
}

// Try to match a bare email address whose local part starts at s[i] and
// whose @ is at s[at].
function tryEmail(s, i, at) {
  if (at <= i) return null;
  const end = scanExtEmailDomain(s, at + 1);
  if (end === -1) return null;
  const after = s[end];
  if (after !== undefined && /[A-Za-z0-9_-]/.test(after)) {
    // A trailing _ is not fatal when it is the closing delimiter of
    // an emphasis span that contains the email: marked lexes the
    // span's inner text on its own, where the email has no trailing
    // character, so its (?![\w-]) lookahead passes. The _ run after
    // the domain must be able to close, and the nearest _ run before
    // the email that can open or close must be an opener (a run that
    // can do neither, a literal _ between word characters, is skipped).
    if (after !== '_') return null;
    let re = end;
    while (re < s.length && s[re] === '_') re++;
    const fl = flanking(s[end - 1], re < s.length ? s[re] : '');
    const canClose = fl.rightFlanking && (!fl.leftFlanking || re >= s.length || isPunct(s[re]));
    if (!canClose) return null;
    let j = i;
    for (;;) {
      let k = j - 1;
      while (k >= 0 && s[k] !== '_') {
        if (s[k] === '\n' && k > 0 && s[k - 1] === '\n') break;
        k--;
      }
      if (k < 0) return null;
      if (s[k] === '\n') return null; // a blank line separates them
      let ks = k;
      while (ks > 0 && s[ks - 1] === '_') ks--;
      const before = ks > 0 ? s[ks - 1] : '';
      const afterRun = k + 1 < s.length ? s[k + 1] : '';
      const fl2 = flanking(before, afterRun);
      const canOpen = fl2.leftFlanking && (!fl2.rightFlanking || before === '' || isPunct(before));
      const canClose2 = fl2.rightFlanking && (!fl2.leftFlanking || afterRun === '' || isPunct(afterRun));
      if (canOpen) break; // the opener of the span containing the email
      if (canClose2) return null; // a closer of an inner span
      j = ks; // a literal _ run: keep looking further back
    }
  }
  const email = s.slice(i, end);
  return { html: autolinkHtml(email, 'mailto:' + email), next: end, raw: email };
}

// Try to match a mailto: or xmpp: autolink at s[i] (lowercase only). It
// must be at the start of the text or follow a character that is not a
// letter or digit. The address after it must be a valid bare email;
// xmpp: may also carry a /resource suffix.
function tryMailto(s, i) {
  if (i > 0 && /[A-Za-z0-9]/.test(s[i - 1])) return null;
  let isXmpp = false;
  let after = -1;
  if (s.startsWith('mailto:', i)) after = i + 7;
  else if (s.startsWith('xmpp:', i)) { isXmpp = true; after = i + 5; }
  else return null;
  const at = s.indexOf('@', after);
  if (at === -1) return null;
  // The local part must start right after the prefix.
  let ls = at;
  while (ls > after && EMAIL_LOCAL_RE.test(s[ls - 1])) ls--;
  if (ls !== after || ls === at) return null;
  const end = scanExtEmailDomain(s, at + 1);
  if (end === -1) return null;
  const afterDom = s[end];
  if (afterDom !== undefined && /[A-Za-z0-9_-]/.test(afterDom)) return null;
  let e = end;
  if (isXmpp && e < s.length && s[e] === '/') {
    let j = e + 1;
    while (j < s.length && /[A-Za-z0-9@.]/.test(s[j])) j++;
    if (j > e + 1) e = j;
  }
  const full = s.slice(i, e);
  return { html: autolinkHtml(full, full), next: e, raw: full };
}

// Find the start of the next http://, https:// or ftp:// scheme at or
// after s[from]. Returns the scheme start, or -1. A :// whose scheme
// starts before `from` is skipped, so a rejected candidate is never
// returned again.
function findSchemeStart(s, from) {
  const n = s.length;
  let p = from;
  for (;;) {
    const c = s.indexOf('://', p);
    if (c === -1) return -1;
    const low = s.slice(Math.max(0, c - 5), c).toLowerCase();
    let start = -1;
    if (low.endsWith('https')) start = c - 5;
    else if (low.endsWith('http')) start = c - 4;
    else if (low.endsWith('ftp')) start = c - 3;
    if (start !== -1 && start >= from) return start;
    p = c + 3;
    if (p >= n) return -1;
  }
}

// Find the start of the next mailto: or xmpp: at or after s[from].
// Returns its start, or -1.
function findMailtoStart(s, from) {
  const m = s.indexOf('mailto:', from);
  const x = s.indexOf('xmpp:', from);
  if (m === -1) return x;
  if (x === -1) return m;
  return m < x ? m : x;
}

// A finder for the next extended autolink in a string. It remembers
// where each kind of trigger was last seen, so scanning ahead is
// amortised over the whole inline pass instead of repeated per chunk.
function autolinkFinder(s) {
  const n = s.length;
  let wPos = -2; // next 'www.', -2 unknown, -1 none
  let cPos = -2; // next scheme start
  let mPos = -2; // next mailto:/xmpp:
  let aPos = -2; // next '@'
  function refreshW(from) {
    if (wPos === -2 || (wPos !== -1 && wPos < from)) wPos = s.indexOf('www.', from);
    return wPos;
  }
  function refreshC(from) {
    if (cPos === -2 || (cPos !== -1 && cPos < from)) cPos = findSchemeStart(s, from);
    return cPos;
  }
  function refreshM(from) {
    if (mPos === -2 || (mPos !== -1 && mPos < from)) mPos = findMailtoStart(s, from);
    return mPos;
  }
  function refreshA(from) {
    if (aPos === -2 || (aPos !== -1 && aPos < from)) aPos = s.indexOf('@', from);
    return aPos;
  }
  // The next valid extended autolink starting at or after `from`, as
  // {start, html, next}, or null. When limit >= 0, a www./scheme URL
  // is capped there (see scanUrlEnd).
  function next(from, limit) {
    for (;;) {
      const w = refreshW(from);
      const c = refreshC(from);
      const m = refreshM(from);
      const a = refreshA(from);
      let best = -1;
      let kind = 0; // 1 www, 2 scheme, 3 mailto, 4 email
      if (w !== -1 && (best === -1 || w < best)) { best = w; kind = 1; }
      if (c !== -1 && (best === -1 || c < best)) { best = c; kind = 2; }
      if (m !== -1 && (best === -1 || m < best)) { best = m; kind = 3; }
      let emailStart = -1;
      if (a !== -1) {
        emailStart = backtrackEmailLocal(s, a);
        if (emailStart < from) {
          // This @ belongs to a word that started before `from`; it
          // cannot start an address here.
          aPos = s.indexOf('@', a + 1);
          continue;
        }
        if (best === -1 || emailStart < best) { best = emailStart; kind = 4; }
      }
      if (best === -1) return null;
      let r = null;
      if (kind === 1) r = tryWww(s, best, limit);
      else if (kind === 2) r = tryScheme(s, best, limit);
      else if (kind === 3) r = tryMailto(s, best);
      else r = tryEmail(s, best, a);
      if (r) return { start: best, html: r.html, next: r.next, raw: r.raw };
      // The candidate is not a link: move past it and look again.
      if (kind === 1) wPos = s.indexOf('www.', best + 1);
      else if (kind === 2) cPos = findSchemeStart(s, best + 1);
      else if (kind === 3) mPos = findMailtoStart(s, best + 1);
      else aPos = s.indexOf('@', a + 1);
    }
  }
  return { next };
}

/* ------------------------------------------------------------------ */
/* Inline parsing: the single pass                                     */
/* ------------------------------------------------------------------ */
// Flanking: whether a delimiter run at s[i..j) can open or close
// emphasis. before is the character before the run (or ''), after the
// character after it (or '').
function flanking(before, after) {
  const beforeWs = before === '' || isWhitespace(before);
  const afterWs = after === '' || isWhitespace(after);
  const beforePunct = before !== '' && isPunct(before);
  const afterPunct = after !== '' && isPunct(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return { leftFlanking, rightFlanking };
}

// Parse the inline content of a block into HTML. refs maps normalised
// link labels to {dest, title} for reference links.
function parseInline(s, refs) {
  const n = s.length;
  // Output entries. Every entry has a plain field: the plain-text
  // rendering used for image alt text. {t, plain} is a text or HTML
  // fragment (t may carry pre/post tags from emphasis resolution, plain
  // never does); {x, r, plain} is an extended autolink, whose raw text r
  // is kept so a link forming around it can turn it back into plain
  // text. Entries are only appended or edited in place, never inserted
  // or removed, so indices stay valid.
  const out = [];
  // Delimiter runs for emphasis and strikethrough.
  const delims = [];
  // [ and ![ brackets, in the order they were opened.
  const brackets = [];
  // Backtick runs consumed as a "loose closer" of a code span inside
  // link text (the label regex's `` `+...`+ ``): when the scan reaches
  // one it is literal text, never a code span opener.
  const deadBackticks = new Set();
  // Text spans of links and images that formed, as [textStart,
  // closePos]: an emphasis delimiter inside one cannot match a
  // delimiter outside it.
  const linkSpans = [];
  // Images whose alt text is computed after emphasis resolution.
  const pendingImages = [];
  const finder = autolinkFinder(s);
  let pos = 0;
  let cand; // undefined = not computed, null = none

  // The first ] in [from, to) that closes a bracket into a link:
  // followed by ( or [ , or by whitespace then [ (a reference link
  // allows the space). A ] that closes an inner bracket into plain
  // text is skipped, so the outer bracket's ] can still cap the URL.
  // Returns its index, or -1.
  function linkClosingBracket(from, to) {
    let j = s.indexOf(']', from);
    while (j !== -1 && j < to) {
      const after = s[j + 1];
      if (after === '(' || after === '[') return j;
      if (after === ' ' || after === '\t' || after === '\n' || after === '\r') {
        let k = j + 1;
        while (k < to && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
        if (s[k] === '[') return j;
      }
      j = s.indexOf(']', j + 1);
    }
    return -1;
  }
  function getCand() {
    if (inLink) return null;
    if (cand === undefined || (cand !== null && cand.start < pos)) {
      cand = finder.next(pos);
    }
    // The cap is (re)computed on every call, not just when the
    // candidate is first found: the candidate is cached before the [
    // that opens its bracket is scanned, so the bracket is only in
    // the stack on a later iteration. It applies only when the
    // innermost active bracket could actually close into a link or
    // image at that ]: a bracket whose text already holds a link
    // cannot form one (tryLink deactivates it), so its ] must not
    // cap the URL.
    if (cand !== null && brackets.some((b) => b.active)) {
      let innermost = -1;
      for (let i = brackets.length - 1; i >= 0; i--) {
        if (brackets[i].active) { innermost = i; break; }
      }
      const br = innermost === -1 ? null : brackets[innermost];
      if (br && (!br.hasLink || br.isImage)) {
        const j = linkClosingBracket(cand.start, cand.next);
        if (j !== -1 && cand.next > j) {
          const capped = finder.next(pos, j);
          if (capped) cand = capped;
        }
      }
    }
    return cand;
  }
  function pushText(raw) {
    if (raw !== '') {
      const t = renderText(raw);
      out.push({ t, plain: t });
    }
  }
  function pushHtml(html, plain) {
    if (html !== '') out.push({ t: html, plain: plain === undefined ? '' : plain });
  }
  function pushExt(html, raw) {
    out.push({ x: html, r: raw, plain: escapeAttr(raw) });
  }
  // Remove trailing spaces from the end of the output (a hard break
  // consumes them).
  function trimTrailingSpaces() {
    for (let i = out.length - 1; i >= 0; i--) {
      const e = out[i];
      if (!('t' in e)) break;
      const t = e.t;
      let j = t.length;
      while (j > 0 && t[j - 1] === ' ') j--;
      if (j === t.length) break;
      e.t = t.slice(0, j);
      if (e.plain !== undefined && e.plain.length > 0) {
        let k = e.plain.length;
        while (k > 0 && e.plain[k - 1] === ' ') k--;
        e.plain = e.plain.slice(0, k);
      }
      if (j > 0) break;
    }
  }

  // --- emphasis resolution (Appendix A) ---
  // Resolve the delimiter stack into <em>/<strong>/<del> tags. The
  // matches are found in two passes: same-length pairs first (a
  // two-delimiter closer pairs with a two-delimiter opener, a
  // one-delimiter closer with a one-delimiter opener), then the
  // remaining pairs of mixed length. A two-delimiter closer therefore
  // does not steal a one-delimiter opener that a later one-delimiter
  // closer will use (so *foo**bar* keeps its ** literal and the outer
  // * pair forms the <em>). Once a pair is formed, a delimiter inside
  // it cannot be matched by a closer outside it (proper nesting). For
  // _ the odd-match rule applies: when both runs can open and close
  // and their total length is odd, they cannot match. For ~ the two
  // runs must have the same length. The tags are attached only after
  // all pairs are decided, ordered by span: for an opener the farthest
  // closer's tag comes first (outermost), for a closer the nearest
  // opener's tag comes first (innermost closes first).
  function resolveEmphasis() {
    // Marked pairs emphasis from the OUTERMOST opener, scanning
    // forward with a running count — not Appendix A's innermost-first
    // closer scan. An opener whose forward scan finds no closer is
    // literal text in marked, even when Appendix A would pair it with
    // a later closer: e.g. *a **b**c* — the inner ** closer can both
    // open and close, so it is rule-of-3-blocked against the outer *
    // (1+2 is a multiple of 3) and the count never reaches zero, so
    // the outer * never pairs, while *a **b** c* (inner ** close-only)
    // does pair. Deactivate such * openers before the Appendix A
    // passes run, so the inner pair still forms but the outer one
    // does not. Only * is filtered (the observed cases), and only
    // openers at the start or after whitespace, where marked's extra
    // R condition is certainly false.
    // A * run inside a __...__ span is invisible to the outer *
    // scan: marked's * closer regex has a skip alternative for
    // __...*...__ (cm-470: *foo __bar *baz bim__ bam* — the * before
    // baz is skipped, so the outer * pairs with the final *). The
    // span's __s are the nearest _ runs on either side, each at
    // least 2 long, and the run must be a single * and the only
    // * or _ run between them.
    function insideUnderscoreStrong(di) {
      const d = delims[di];
      if (d.len !== 1) return false;
      let u1 = -1, u2 = -1;
      for (let j = di - 1; j >= 0; j--) { if (delims[j].ch === '_') { u1 = j; break; } }
      for (let j = di + 1; j < delims.length; j++) { if (delims[j].ch === '_') { u2 = j; break; } }
      if (u1 === -1 || u2 === -1) return false;
      if (delims[u1].len < 2 || delims[u2].len < 2) return false;
      // The two _ runs must actually form a span containing this run:
      // the one before it must be able to open and the one after it
      // able to close. A closer followed by a later opener (two
      // separate spans, with this run between them) does not contain
      // it.
      if (!delims[u1].canOpen || !delims[u2].canClose) return false;
      for (let j = u1 + 1; j < u2; j++) {
        if (j === di) continue;
        if (delims[j].ch === '*' || delims[j].ch === '_') return false;
      }
      return true;
    }
    // Marked's emStrong also refuses a closer past the last possible
    // closer index in its masked source (fe): if the closer is
    // swallowed by a masked code span or link and no later unmasked
    // run of the same char extends the limit, the pair never forms
    // (doc-09: _issue table_ masked by a `` span from link text).
    // The masking only changes fe when backticks or links are
    // present; otherwise every valid closer is within the limit.
    // Marked parses link text recursively, so fe inside a link is
    // computed on the link text alone: the full-string limit (links
    // masked) must not apply to an opener inside a link span.
    const needMask = s.includes('`') || s.includes('[');
    const feLim = needMask ? maskedEmStrongLimit(s) : { '*': Infinity, '_': Infinity, masked: [] };
    const inMasked = (p) => {
      const sp = feLim.masked;
      for (let k = 0; k < sp.length; k++) {
        if (p >= sp[k][0] && p < sp[k][1]) return true;
      }
      return false;
    };
    const inLinkSpan = (p) => {
      for (let k = 0; k < linkSpans.length; k++) {
        if (p >= linkSpans[k][0] && p <= linkSpans[k][1]) return true;
      }
      return false;
    };
    // Spans the filter has decided pair, as [char, openerPos,
    // closerPos, effUsed, f, m]. Marked lexes an outer strong/em
    // first and scans an inner opener only within that span's text:
    // the outer closer's delimiters are claimed by the outer opener
    // (doc-11: **a *b **c**d* e** — the trailing ** is fully claimed
    // by the outer **, so the * before b cannot use it). A closer
    // run can be shared when it has more delimiters than the outer
    // opener uses (*small release **same***: the *** serves the
    // inner ** with 2 and the outer * with 1), so the debt is
    // per-run, not a hard cap. f and m are the blocked sum and
    // running count at the match, used by the post-pass to apply
    // marked's b = min(closerLen, closerLen+m+f).
    const filterSpans = [];
    for (let oi = 0; oi < delims.length; oi++) {
      const o = delims[oi];
      if ((o.ch !== '*' && o.ch !== '_') || !o.canOpen) continue;
      if (o.pos > 0 && !isWhitespace(s[o.pos - 1])) continue;
      const lim = inLinkSpan(o.pos) ? Infinity : feLim[o.ch];
      // A run can pair with fewer delimiters than its length (marked
      // advances one character at a time when a run's scan fails, so
      // **foo* pairs one * of the ** with the closing *): try the
      // effective opener length from len down to 1.
      let found = false;
      let foundCloserPos = -1;
      let foundEff = 0;
      let foundF = 0;
      let foundM = 0;
      for (let eff = o.len; eff >= 1 && !found; eff--) {
        let m = eff;
        let f = 0;
        const y = eff;
        for (let di = oi + 1; di < delims.length; di++) {
          const d = delims[di];
          if (d.ch !== o.ch) continue;
          if (d.pos > lim) continue;
          // A run inside a masked link/code-span/HTML region is
          // invisible to marked's scan on the masked source.
          if (lim !== Infinity && inMasked(d.pos)) continue;
          if (o.ch === '*' && insideUnderscoreStrong(di)) continue;
          const both = d.canOpen && d.canClose;
          if (d.canOpen && !d.canClose) { m += d.len; continue; }
          if (both) {
            // Marked's emStrong breaks the scan at a "both" closer
            // when the opener is preceded by the same delimiter
            // (o = n === r). For a partial run (eff < len) the
            // effective opener is the tail of the run, so it IS
            // preceded by the same delimiter: a both-run ends the
            // scan (e.g. **ab *cd*ef**: the * after cd breaks the
            // tail *'s scan, so the outer ** never pairs).
            if (eff < o.len) break;
            if (y % 3 !== 0 && (y + d.len) % 3 === 0) { f += d.len; continue; }
          } else if (!d.canClose) {
            continue;
          }
          // Delimiters of this closer already claimed by an
          // enclosing opener of the same char are not available.
          let avail = d.len;
          for (let k = 0; k < filterSpans.length; k++) {
            const sp = filterSpans[k];
            if (sp[0] === o.ch && sp[1] < o.pos && o.pos < sp[2] && sp[2] === d.pos) {
              avail -= sp[3];
            }
          }
          if (avail <= 0) continue;
          m -= avail;
          if (m <= 0) { found = true; foundCloserPos = d.pos; foundEff = eff; foundF = f; foundM = m; break; }
        }
      }
      if (!found) o.canOpen = false;
      else filterSpans.push([o.ch, o.pos, foundCloserPos, foundEff, foundF, foundM]);
    }
    // Spans of formed pairs, as [openerIndex, closerIndex] into
    // delims, in the order they were formed.
    const spans = [];
    // Matches decided, as {oi, ci, use, openTag, closeTag}.
    const matches = [];
    function isEnclosed(di, closerIdx) {
      for (let k = 0; k < spans.length; k++) {
        const sp = spans[k];
        if (sp[0] < di && di < sp[1] && sp[1] < closerIdx) return true;
      }
      return false;
    }
    // True when the two delimiters lie on opposite sides of a link's
    // text span (one inside, one outside): they cannot pair.
    function splitByLink(oi, ci) {
      const op = delims[oi].pos;
      const cp = delims[ci].pos;
      for (let k = 0; k < linkSpans.length; k++) {
        const sp = linkSpans[k];
        const oIn = op >= sp[0] && op <= sp[1];
        const cIn = cp >= sp[0] && cp <= sp[1];
        if (oIn !== cIn) return true;
      }
      return false;
    }
    function tryMatch(ci, sameLength) {
      const closer = delims[ci];
      if (!closer.active || !closer.canClose) return false;
      for (let oi = ci - 1; oi >= 0; oi--) {
        const d = delims[oi];
        if (!d.active) continue;
        if (d.ch !== closer.ch) continue;
        if (!d.canOpen) continue;
        if (closer.ch === '~' && d.len !== closer.len) continue;
        if (closer.ch === '_' && d.canOpen && d.canClose && closer.canOpen && closer.canClose && (d.len + closer.len) % 2 === 1) continue;
        if (sameLength && d.len !== closer.len) continue;
        if (isEnclosed(oi, ci)) continue;
        if (splitByLink(oi, ci)) continue;
        if (sameLength) {
          // An earlier PURE closer (can close but not open) that needs
          // this opener for a mixed-length pair in pass 2 claims it
          // first: skip it here so the earlier closer can take it
          // later. A delimiter that can also open is not a claimer:
          // in *foo**bar* the ** before bar must not block the final
          // * from taking the opening *.
          let claimed = false;
          for (let cj = 0; cj < ci; cj++) {
            const ec = delims[cj];
            if (!ec.active || !ec.canClose || ec.canOpen) continue;
            if (ec.ch !== closer.ch) continue;
            if (ec.len === d.len) continue;
            // The opener is before the earlier closer, so that
            // closer could reach it in pass 2.
            if (oi < cj) { claimed = true; break; }
          }
          if (claimed) continue;
        }
        // Found the nearest eligible opener.
        const use = closer.ch === '~' ? closer.len : (d.len >= 2 && closer.len >= 2 ? 2 : 1);
        const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
        d.len -= use;
        closer.len -= use;
        d.entry.t = d.entry.t.slice(0, d.len);
        closer.entry.t = closer.entry.t.slice(closer.entry.t.length - closer.len);
        if (d.len === 0) d.active = false;
        if (closer.len === 0) closer.active = false;
        spans.push([oi, ci]);
        matches.push({ oi, ci, use, openTag: '<' + tag + '>', closeTag: '</' + tag + '>' });
        return true;
      }
      return false;
    }
    // Pass 1: same-length pairs. A closer must not steal an opener
    // that an earlier closer needs for a mixed-length pair in pass 2:
    // in *a **b*** c *d* e the * in *d* must leave the outer * alone
    // so the earlier *** can claim it for an em.
    for (let ci = 0; ci < delims.length; ci++) {
      const closer = delims[ci];
      if (!closer.active || !closer.canClose) continue;
      while (tryMatch(ci, true)) {
        if (!closer.active) break;
      }
    }
    // Pass 2: the remaining pairs of mixed length. The longest closers
    // go first, so a three-delimiter closer claims its opener for a
    // strong (and the remaining delimiter for an em) before a shorter
    // closer can steal that opener for a single em.
    const pass2 = [];
    for (let ci = 0; ci < delims.length; ci++) {
      const closer = delims[ci];
      if (closer.active && closer.canClose) pass2.push(ci);
    }
    pass2.sort((a, b) => delims[b].len - delims[a].len || a - b);
    for (const ci of pass2) {
      const closer = delims[ci];
      if (!closer.active || !closer.canClose) continue;
      while (tryMatch(ci, false)) {
        if (!closer.active) break;
      }
    }
    // Post-pass: marked's emStrong consumes b = min(closerLen,
    // closerLen+m+f) of a closer's delimiters. When b exceeds the
    // pair's use, the extra delimiters stay INSIDE the strong/em
    // (doc-11/doc-30: **return that *old*two*** — the blocked *
    // after old makes f=1, so b=3 and the * is inside; **foo*** has
    // f=0, b=2, and the * stays outside). Apply it only when the
    // closer is used by exactly this one pair (a shared closer is
    // split by the inner pair first) and the opener is not enclosed
    // by an earlier span of the same char.
    for (const mt of matches) {
      if (mt.use !== 2) continue;
      const closer = delims[mt.ci];
      const opener = delims[mt.oi];
      if (closer.ch === '~') continue;
      let shared = false;
      for (const mt2 of matches) {
        if (mt2 !== mt && mt2.ci === mt.ci) { shared = true; break; }
      }
      if (shared || closer.len === 0) continue;
      let enclosed = false;
      for (let k = 0; k < filterSpans.length; k++) {
        const sp = filterSpans[k];
        if (sp[0] === opener.ch && sp[1] < opener.pos && opener.pos < sp[2]) { enclosed = true; break; }
      }
      if (enclosed) continue;
      for (let k = 0; k < filterSpans.length; k++) {
        const sp = filterSpans[k];
        if (sp[0] === opener.ch && sp[1] === opener.pos && sp[2] === closer.pos) {
          const origLen = closer.len + mt.use;
          const b = Math.min(origLen, origLen + sp[5] + sp[4]);
          if (b > mt.use) {
            const insideCount = b - mt.use;
            closer.len = origLen - b;
            closer.entry.t = closer.entry.t.slice(closer.entry.t.length - closer.len);
            closer.entry.insideText = (closer.entry.insideText || '') + closer.ch.repeat(insideCount);
            if (closer.len === 0) closer.active = false;
          }
          break;
        }
      }
    }
    // Attach the tags, ordered by span. For an opener, the pair with
    // the farthest closer is outermost, so it comes first; for pairs
    // sharing a closer, the one-delimiter (em) pair is outermost. For
    // a closer, the pair with the nearest opener is innermost, so its
    // closing tag comes first; for pairs sharing an opener, the
    // two-delimiter (strong) pair closes first.
    const openByOpener = new Map();
    const closeByCloser = new Map();
    for (const m of matches) {
      if (!openByOpener.has(m.oi)) openByOpener.set(m.oi, []);
      openByOpener.get(m.oi).push(m);
      if (!closeByCloser.has(m.ci)) closeByCloser.set(m.ci, []);
      closeByCloser.get(m.ci).push(m);
    }
    for (const [oi, ms] of openByOpener) {
      ms.sort((a, b) => b.ci - a.ci || a.use - b.use);
      delims[oi].entry.post = ms.map(m => m.openTag).join('');
    }
    for (const [ci, ms] of closeByCloser) {
      ms.sort((a, b) => b.oi - a.oi || b.use - a.use);
      delims[ci].entry.pre = ms.map(m => m.closeTag).join('');
    }
    // A delimiter run's plain text is whatever literal characters are
    // left after resolution.
    for (let i = 0; i < delims.length; i++) {
      delims[i].entry.plain = delims[i].entry.t;
    }
  }

  // --- link formation ---
  // Try to form a link or image from the nearest active bracket when a
  // ] is found at closePos. Returns the index just past the link, or -1
  // when no link forms (the ] is then literal text).
  // Validate a link label the way marked's label regex does for
  // backticks: every backtick run must be part of a loose code span
  // (`+ ... `+, any lengths) or sit immediately before the closing ].
  // A run left over (e.g. the `` after ` b ` in [at _node `` a ` b ``_])
  // makes the label invalid, so no link forms. Nested [...] and \x
  // escapes are skipped over.
  function isValidLabel(label) {
    let i = 0;
    const n = label.length;
    while (i < n) {
      const c = label[i];
      if (c === '\\' && i + 1 < n) { i += 2; continue; }
      if (c === '[') {
        let depth = 1;
        i++;
        while (i < n && depth > 0) {
          if (label[i] === '\\' && i + 1 < n) { i += 2; continue; }
          if (label[i] === '[') depth++;
          else if (label[i] === ']') depth--;
          i++;
        }
        continue;
      }
      if (c === '`') {
        let runLen = 1;
        while (i + runLen < n && label[i + runLen] === '`') runLen++;
        // The loose closer is the next backtick run.
        let j = i + runLen;
        while (j < n && label[j] !== '`') j++;
        if (j < n) {
          let closeLen = 1;
          while (j + closeLen < n && label[j + closeLen] === '`') closeLen++;
          i = j + closeLen;
          continue;
        }
        // No closer: valid only at the very end (just before the ]).
        if (i + runLen === n) return true;
        return false;
      }
      i++;
    }
    return true;
  }

  function tryLink(closePos) {
    let bi = brackets.length - 1;
    while (bi >= 0 && !brackets[bi].active) bi--;
    if (bi < 0) return -1;
    const br = brackets[bi];
    // A label with an unmatched backtick is invalid: marked's link
    // rule fails at the [, so no link (inline or reference) forms.
    if (br.tainted || !isValidLabel(s.slice(br.textStart, closePos))) {
      br.active = false;
      return -1;
    }
    let dest = null;
    let title = null;
    let next = -1;
    const inl = parseInlineLink(s, closePos + 1);
    if (inl) {
      dest = inl.dest;
      title = inl.title;
      next = inl.next;
    } else {
      const lbl = parseLabel(s, closePos + 1);
      let key = null;
      if (lbl) {
        key = lbl.label === '' ? null : normalizeLabel(lbl.label);
        next = lbl.next;
      }
      if (key === null) {
        // Collapsed [] or shortcut: the link text itself is the label.
        key = normalizeLabel(s.slice(br.textStart, closePos));
        // A shortcut has no second label, so the link ends at the ].
        if (next === -1) next = closePos + 1;
      }
      if (key !== null && key !== '') {
        const ref = refs ? refs[key] : undefined;
        if (ref) {
          dest = ref.dest;
          title = ref.title;
        } else {
          next = -1;
        }
      } else {
        next = -1;
      }
    }
    if (dest === null || next === -1) {
      br.active = false;
      return -1;
    }
    if (br.hasLink && !br.isImage) {
      // A link already formed inside this text: the outer one cannot.
      br.active = false;
      return -1;
    }
    // Extended autolinks inside the link text are not links: turn them
    // back into plain text.
    for (let i = br.outIndex + 1; i < out.length; i++) {
      const e = out[i];
      if (e && 'x' in e) out[i] = { t: renderText(e.r), plain: renderText(e.r) };
    }
    const cleaned = cleanUrl(dest);
    if (cleaned === null) {
      // The destination cannot be encoded: the link renders as just
      // its text, with no anchor and no brackets.
      br.entry.t = '';
      br.entry.plain = '';
      br.active = false;
      return next;
    }
    const href = escapeAttr(cleaned);
    // The link's text span: emphasis delimiters inside it cannot
    // match delimiters outside it.
    linkSpans.push([br.textStart, closePos]);
    if (br.isImage) {
      // The alt text is computed after emphasis resolution, from the
      // entries the image consumed.
      const span = out.slice(br.outIndex + 1);
      pendingImages.push({ entry: br.entry, span, href, title });
      br.entry.t = '';
      br.entry.plain = '';
      out.length = br.outIndex + 1;
      br.active = false;
      for (let i = bi + 1; i < brackets.length; i++) brackets[i].active = false;
    } else {
      let a = '<a href="' + href + '"';
      if (title !== null && title !== undefined) a += ' title="' + escapeAttr(title) + '"';
      a += '>';
      br.entry.t = a;
      br.entry.plain = '';
      pushHtml('</a>', '');
      br.active = false;
      for (let i = bi + 1; i < brackets.length; i++) brackets[i].active = false;
      for (let i = 0; i < bi; i++) if (brackets[i].active) brackets[i].hasLink = true;
    }
    return next;
  }

  // --- main scan ---
  while (pos < n) {
    SPECIAL_RE.lastIndex = pos;
    const m = SPECIAL_RE.exec(s);
    const nextSpecial = m ? m.index : n;
    const c = getCand();
    if (c && c.start < nextSpecial) {
      pushText(s.slice(pos, c.start));
      pushExt(c.html, c.raw);
      // A ] swallowed by an autolink can no longer close a bracket:
      // deactivate the brackets it closed, innermost first, so a
      // later ]( cannot form a link from a bracket whose ] is gone
      // (in marked the [ is literal text once the link rule fails at
      // it, so no bracket state survives it either).
      let closes = 0;
      for (let k = c.start; k < c.next; k++) if (s[k] === ']') closes++;
      for (let bi = brackets.length - 1; bi >= 0 && closes > 0; bi--) {
        if (brackets[bi].active) { brackets[bi].active = false; closes--; }
      }
      pos = c.next;
      cand = undefined;
      continue;
    }
    pushText(s.slice(pos, nextSpecial));
    pos = nextSpecial;
    if (pos >= n) break;
    const ch = s[pos];
    if (ch === '\\') {
      if (pos + 1 < n && s[pos + 1] === '\n') {
        pushHtml('<br>', '');
        pos += 2;
        // A hard break strips the next line's leading whitespace.
        while (pos < n && (s[pos] === ' ' || s[pos] === '\t')) pos++;
      } else if (pos + 1 < n && PUNCT.has(s[pos + 1])) {
        pushText(s[pos + 1]);
        pos += 2;
      } else {
        pushText('\\');
        pos += 1;
      }
      continue;
    }
    if (ch === '`') {
      let runLen = 1;
      while (pos + runLen < n && s[pos + runLen] === '`') runLen++;
      if (deadBackticks.has(pos)) {
        // Consumed as the loose closer of an earlier backtick run in
        // this link text: literal, never an opener.
        pushText(s.slice(pos, pos + runLen));
        pos += runLen;
        continue;
      }
      let search = pos + runLen;
      let close = -1;
      while (search < n) {
        const b = s.indexOf('`', search);
        if (b === -1) break;
        let bl = 1;
        while (b + bl < n && s[b + bl] === '`') bl++;
        if (bl === runLen) { close = b; break; }
        search = b + bl;
      }
      if (close !== -1 || brackets.some((b) => b.active)) {
        // A code span inside link text interacts with the link's
        // label: marked's label regex accepts a backtick run closed
        // by a run of any length (`` `+...`+ ``), so a backtick
        // before the bracket's ] makes the label valid and the link
        // forms, with the backticks literal (the codespan rule itself
        // needs matching runs). With no backtick before the ], the
        // label is invalid: the code span (matching runs) swallows
        // the ] and the link never forms (cm-342). Find the ] that
        // closes the innermost active bracket, by counting brackets
        // from the opener.
        let bracketClose = -1;
        let looseFound = false;
        if (brackets.some((b) => b.active)) {
          let depth = 0;
          for (let k = pos; k < n; k++) {
            if (s[k] === '[') depth++;
            else if (s[k] === ']') {
              if (depth === 0) { bracketClose = k; break; }
              depth--;
            }
          }
        }
        if (bracketClose !== -1 && (close === -1 || close > bracketClose)) {
          // The matching closer is not before the ]: if any backtick
          // run lies between the opener and the ], the label is valid
          // and this span must not form (its backticks stay literal
          // so the link can). Otherwise the span swallows the ].
          // The first such run is the loose closer: mark it consumed
          // so it is not itself treated as a code span opener later.
          let loose = -1;
          for (let k = pos + runLen; k < bracketClose; k++) {
            if (s[k] === '`') { loose = k; break; }
          }
          if (loose !== -1) { deadBackticks.add(loose); close = -1; looseFound = true; }
        }
        // A backtick run left literal with no closer of any length
        // before the ] (and not immediately before the ], where the
        // label regex allows literal backticks) makes the label
        // invalid: marked's link rule fails at the [, so no link
        // forms (doc-16/18/20/22). Taint the innermost bracket.
        if (close === -1 && !looseFound && bracketClose !== -1 && pos + runLen < bracketClose) {
          for (let bi = brackets.length - 1; bi >= 0; bi--) {
            if (brackets[bi].active) { brackets[bi].tainted = true; break; }
          }
        }
      }
      if (close === -1) {
        // No closing run (or it would swallow the bracket's ]): the
        // whole run is literal text (marked's codespan rule does not
        // retry a shorter run).
        pushText(s.slice(pos, pos + runLen));
        pos += runLen;
      } else {
        let content = s.slice(pos + runLen, close);
        if (content.indexOf('\n') !== -1) content = content.replace(/\n/g, ' ');
        if (content.length > 0 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        out.push({ t: '<code>' + escapeText(content) + '</code>', plain: escapeAttr(content) });
        pos = close + runLen;
        cand = undefined;
      }
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      let runLen = 1;
      while (pos + runLen < n && s[pos + runLen] === ch) runLen++;
      if (ch === '~' && runLen > 2) {
        // Three or more tildes are never a delimiter.
        pushText(s.slice(pos, pos + runLen));
        pos += runLen;
        continue;
      }
      const before = pos > 0 ? s[pos - 1] : '';
      const after = pos + runLen < n ? s[pos + runLen] : '';
      const fl = flanking(before, after);
      let canOpen = fl.leftFlanking;
      let canClose = fl.rightFlanking;
      if (ch === '_') {
        canOpen = fl.leftFlanking && (!fl.rightFlanking || before === '' || isPunct(before));
        canClose = fl.rightFlanking && (!fl.leftFlanking || after === '' || isPunct(after));
      }
      const entry = { t: s.slice(pos, pos + runLen), plain: '' };
      out.push(entry);
      delims.push({ ch, len: runLen, entry, canOpen, canClose, active: true, pos });
      pos += runLen;
      continue;
    }
    if (ch === '[') {
      const entry = { t: '[', plain: '[' };
      out.push(entry);
      brackets.push({ entry, outIndex: out.length - 1, textStart: pos + 1, isImage: false, active: true, hasLink: false });
      pos += 1;
      continue;
    }
    if (ch === '!') {
      if (pos + 1 < n && s[pos + 1] === '[') {
        const entry = { t: '![', plain: '![' };
        out.push(entry);
        brackets.push({ entry, outIndex: out.length - 1, textStart: pos + 2, isImage: true, active: true, hasLink: false });
        pos += 2;
      } else {
        pushText('!');
        pos += 1;
      }
      continue;
    }
    if (ch === ']') {
      const next = tryLink(pos);
      if (next === -1) {
        pushText(']');
        pos += 1;
      } else {
        pos = next;
        cand = undefined;
      }
      continue;
    }
    if (ch === '<') {
      const r = tryAngle(s, pos);
      if (r) {
        out.push({ t: r.html, plain: r.plain });
        // A raw inline <a> open tag sets inLink (extended autolinks
        // stop forming) until an inline </a> clears it. Marked's
        // startATag is /^<a /i: a bare <a> or a self-closing <a/>
        // does not count, only <a followed by a space. A complete
        // <a>...</a> autolink element does not count either: it is a
        // link that already formed, not a bare tag.
        const lower = r.html.toLowerCase();
        if (lower.startsWith('</a>')) {
          inLink = false;
        } else if (lower.startsWith('<a ') && !lower.includes('</a>')) {
          inLink = true;
        }
        pos = r.next;
        cand = undefined;
      } else {
        pushText('<');
        pos += 1;
      }
      continue;
    }
    if (ch === '\n') {
      // A hard break is two or more spaces before the newline; the
      // spaces are consumed with it. Otherwise it is a soft break.
      let k = pos - 1;
      let spaces = 0;
      while (k >= 0 && s[k] === ' ') { spaces++; k--; }
      if (spaces >= 2) {
        trimTrailingSpaces();
        pushHtml('<br>', '');
        pos += 1;
        // A hard break strips the next line's leading whitespace.
        while (pos < n && (s[pos] === ' ' || s[pos] === '\t')) pos++;
      } else {
        pushHtml('\n', '\n');
        pos += 1;
      }
      continue;
    }
    // Unreachable: every special character is handled above.
    pos += 1;
  }

  resolveEmphasis();

  // Image alt text, now that emphasis is resolved: the plain text of the
  // entries each image consumed, in the order the images formed (so a
  // nested image's alt is ready when an outer one needs it).
  for (let i = 0; i < pendingImages.length; i++) {
    const img = pendingImages[i];
    let alt = '';
    for (let j = 0; j < img.span.length; j++) {
      const e = img.span[j];
      if (!e) continue;
      if ('x' in e) alt += escapeAttr(e.r);
      else alt += e.plain || '';
    }
    let tag = '<img src="' + img.href + '" alt="' + alt + '"';
    if (img.title !== null && img.title !== undefined) tag += ' title="' + escapeAttr(img.title) + '"';
    tag += '>';
    img.entry.t = tag;
    img.entry.plain = alt;
  }

  // Join the entries: insideText (leftover delimiters that stay
  // inside a strong/em), pre tags, the fragment, post tags.
  let html = '';
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if ('x' in e) {
      html += e.x;
    } else {
      if (e.insideText) html += e.insideText;
      if (e.pre) html += e.pre;
      html += e.t;
      if (e.post) html += e.post;
    }
  }
  return html;
}

/* ------------------------------------------------------------------ */
/* Block parsing                                                       */
/* ------------------------------------------------------------------ */

// A block node. Containers (document, blockquote, list, item) hold
// children; leaves hold their source lines or content.
function newBlock(type) {
  return { type, children: [], lines: null, content: '', parent: null };
}
function addChild(parent, child) {
  child.parent = parent;
  parent.children.push(child);
  return child;
}

// Expand a leading tab to spaces, for indentation measurement. A tab
// advances to the next multiple of 4 columns.
function expandTab(line, col) {
  return ' '.repeat(4 - (col % 4));
}

// Count the indent of a line (spaces, with tabs expanded to the next
// multiple of 4), and return [indent, rest] where rest is the line
// after that many columns of indent. Only the leading whitespace is
// considered.
function measureIndent(line) {
  let col = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  return { indent: col, rest: line.slice(i), index: i };
}

// Expand the leading run of spaces/tabs of s to spaces, where the run
// starts at absolute column startCol (a tab advances to the next
// multiple of 4). Returns s unchanged when the run holds no tab.
// This is marked's J() applied to leading whitespace: container
// markers consume columns, and the whitespace that remains is measured
// in true columns, never re-expanded from the stripped string's start.
function expandWsRun(s, startCol) {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  if (i === 0) return s;
  let t = s.indexOf('\t', 0);
  if (t < 0 || t >= i) return s;
  let col = startCol;
  let out = '';
  for (let j = 0; j < i; j++) {
    if (s[j] === ' ') { out += ' '; col++; }
    else { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; }
  }
  return out + s.slice(i);
}

// The block-level HTML tags are in BLOCK_TAGS (defined with the inline
// helpers above).

// Is this line a thematic break? Three or more -, _ or * (one kind),
// with only spaces between them.
function isThematicBreak(line) {
  const t = line.trim();
  if (t.length < 3) return false;
  const c = t[0];
  if (c !== '-' && c !== '_' && c !== '*') return false;
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== c && t[i] !== ' ' && t[i] !== '\t') return false;
  }
  return true;
}

// Try to read an ATX heading from a line (already stripped of up to 3
// leading spaces by the caller). Returns {level, content} or null.
function parseAtx(line) {
  let i = 0;
  while (i < line.length && line[i] === '#') i++;
  if (i === 0 || i > 6) return null;
  if (i < line.length && line[i] !== ' ' && line[i] !== '\t') return null;
  let content = line.slice(i);
  // A closing sequence of #s, preceded by a space and followed only by
  // spaces, is removed -- before the leading space is stripped, so a
  // content that is only #s is recognised as a closing sequence.
  content = content.replace(/[ \t]+#+[ \t]*$/, '');
  content = content.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level: i, content };
}

// Try to read a fenced code opening from a line. Returns
// {char, len, info} or null.
function parseFence(line) {
  let i = 0;
  const c = line[0];
  if (c !== '`' && c !== '~') return null;
  while (i < line.length && line[i] === c) i++;
  if (i < 3) return null;
  if (c === '`' && line.slice(i).indexOf('`') !== -1) return null;
  return { char: c, len: i, info: line.slice(i).trim() };
}

// Is this line a setext heading underline? Returns 1 for =, 2 for -,
// or 0.
function setextLevel(line) {
  const t = line.trim();
  if (t === '') return 0;
  const c = t[0];
  if (c !== '=' && c !== '-') return 0;
  for (let i = 0; i < t.length; i++) if (t[i] !== c) return 0;
  return c === '=' ? 1 : 2;
}

// Try to read a list marker from a line. Returns
// {ordered, delim, num, markerLen} or null. The marker must be followed
// by a space, a tab, or the end of the line.
function parseListMarker(line) {
  let i = 0;
  const c = line[0];
  if (c === '-' || c === '+' || c === '*') {
    if (line.length > 1 && line[1] !== ' ' && line[1] !== '\t') return null;
    return { ordered: false, delim: c, num: 0, markerLen: 1, empty: line.slice(1).trim() === '' };
  }
  if (c >= '0' && c <= '9') {
    while (i < line.length && line[i] >= '0' && line[i] <= '9') i++;
    if (i === 0 || i > 9) return null;
    if (i >= line.length) return null;
    const d = line[i];
    if (d !== '.' && d !== ')') return null;
    if (i + 1 < line.length && line[i + 1] !== ' ' && line[i + 1] !== '\t') return null;
    return { ordered: true, delim: d, num: parseInt(line.slice(0, i), 10), markerLen: i + 1, empty: line.slice(i + 1).trim() === '' };
  }
  return null;
}

// What kind of HTML block (1-7) starts on this line, or 0 if none.
// The line is already stripped of up to 3 leading spaces.
function htmlBlockStart(line) {
  if (/^<(script|pre|style|textarea)(\s|>|$)/i.test(line)) return 1;
  if (line.startsWith('<!--')) return 2;
  if (line.startsWith('<?')) return 3;
  if (line.startsWith('<!') && line.length > 2 && /[A-Za-z]/.test(line[2])) return 4;
  if (line.startsWith('<![CDATA[')) return 5;
  const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/.exec(line);
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  const te = scanHtmlTag(line, 0);
  if (te === line.length) return 7;
  return 0;
}

// Split a table row into cells. A leading or trailing | is a border,
// not a cell; \| is a literal | inside a cell.
function splitTableRow(line) {
  const t = line.trim();
  let cells = [];
  let cur = '';
  let i = t.charAt(0) === '|' ? 1 : 0;
  for (; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && i + 1 < t.length) {
      if (t[i + 1] === '|') {
        // \| is a literal | inside the cell: it does not split, and
        // the escape is resolved here so inline parsing (including
        // code spans, which keep their content literal) sees |.
        cur += '|';
        i++;
      } else if (t[i + 1] === '\\') {
        // \\ is an escaped backslash; the | after it still splits.
        cur += '\\\\';
        i++;
      } else {
        cur += c;
      }
    } else if (c === '|') {
      cells.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur);
  if (cells.length > 1 && cells[cells.length - 1].trim() === '' && t.charAt(t.length - 1) === '|') {
    cells.pop();
  }
  return cells.map((c) => c.trim());
}

// Try to interpret `line` as a GFM table delimiter row for the current
// paragraph tip. Returns the new table block when one was formed (the
// tip is consumed), or null. The setext check runs first, so a plain
// --- line never reaches here. The header is the paragraph's lines,
// which have not been finalised into content yet.
function tryTableDelimiter(tip, line) {
  const headerCells = splitTableRow(tip.lines.join('\n'));
  if (headerCells.length === 0) return null;
  const delCells = splitTableRow(line);
  if (delCells.length !== headerCells.length) return null;
  const aligns = [];
  for (let i = 0; i < delCells.length; i++) {
    const c = delCells[i];
    if (!/^:?-+:?$/.test(c)) return null;
    const left = c.charAt(0) === ':';
    const right = c.charAt(c.length - 1) === ':';
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null);
  }
  const tbl = newBlock('table');
  tbl.header = headerCells;
  tbl.aligns = aligns;
  tbl.rows = [];
  const parent = tip.parent;
  parent.children[parent.children.indexOf(tip)] = tbl;
  tbl.parent = parent;
  return tbl;
}

// Whether the inline parser is inside a raw <a> element. An inline
// <a> open tag sets this for the rest of the document (it persists
// across paragraphs) until an inline </a> clears it, and while it is
// set no extended autolink (www., scheme://, mailto:, bare email) is
// formed. <...> autolinks and explicit markdown links are unaffected.
// HTML blocks do not touch it: only inline <a> tags do.
let inLink = false;

// Parse a document into HTML. Normalises line endings and NULs, builds
// the block tree with the container algorithm, then renders it.
function parse(src) {
  inLink = false;
  const text = src.replace(/\r\n?/g, '\n').replace(/\0/g, '\uFFFD');
  const lines = text.split('\n');
  // A trailing newline makes split() produce a final empty string
  // that is not a line; drop it so it is not read as a blank line.
  if (text.endsWith('\n')) lines.pop();
  const root = newBlock('document');
  const refs = Object.create(null);
  const open = [root];
  let tip = null;

  function itemContentIndent(markerIndent, markerLen, rest) {
    let col = markerIndent + markerLen;
    let i = 0;
    let spaces = 0;
    while (i < rest.length) {
      const c = rest[i];
      if (c === ' ') { spaces++; col++; i++; }
      else if (c === '\t') { col += 4 - (col % 4); spaces = col - (markerIndent + markerLen); i++; }
      else break;
    }
    if (i >= rest.length || spaces >= 5) return markerIndent + markerLen + 1;
    return col;
  }

  // Expand tabs in the leading whitespace of s to spaces, where s
  // starts at column startCol. A tab advances to the next multiple
  // of four. A tab that is the very first character of the line, at
  // Strip n columns of indent. A tab that straddles the boundary is
  // expanded to the spaces past it. When expandTab is set, a tab
  // that starts the remaining content is also expanded to the next
  // tab stop: indented code content expands its leading tabs to
  // spaces, while fenced code content keeps them literal. startCol
  // is the column in the original line where this string starts, so
  // the tab stop is computed against the true column.
  function stripIndent(line, n, expandTab, startCol) {
    let col = startCol || 0;
    let i = 0;
    while (i < line.length && col - (startCol || 0) < n) {
      const c = line[i];
      if (c === ' ') { col++; i++; }
      else if (c === '\t') {
        const next = col + (4 - (col % 4));
        if (next - (startCol || 0) > n) return ' '.repeat(next - (startCol || 0) - n) + line.slice(i + 1);
        col = next;
        i++;
      } else break;
    }
    if (expandTab && i < line.length && line[i] === '\t' && (col % 4) !== 0) {
      return ' '.repeat(4 - (col % 4)) + line.slice(i + 1);
    }
    return line.slice(i);
  }

  // Remove up to n leading whitespace characters from a fenced code
  // content line, the way marked's Dt does: each leading space or tab
  // counts as one character, and a tab is never expanded (a tab that
  // straddles the fence indent is removed whole, not replaced by
  // spaces).
  function stripFenceIndent(line, n) {
    let i = 0;
    while (i < line.length && i < n && (line[i] === ' ' || line[i] === '\t')) i++;
    return line.slice(i);
  }

  function matchContainers(line) {
    let rest = line;
    let depth = 1;
    // col is the column in the original line where rest starts: the
    // columns consumed by the container markers stripped so far.
    // Tabs are counted to the next multiple of four, so a tab later
    // in the line can be expanded against its true column.
    let col = 0;
    for (let i = 1; i < open.length; i++) {
      const b = open[i];
      if (b.type === 'blockquote') {
        const m = measureIndent(rest);
        if (m.indent <= 3 && m.rest.charAt(0) === '>') {
          // The marker's column is col + m.indent; the > itself is
          // one column, and one space or tab may follow it. The
          // whitespace after '>' is tab-expanded against the column
          // where it starts in this level's text (marked's J uses
          // b.length, the marker group's length, so the column
          // restarts at each nesting level), then exactly one space
          // is consumed (marked's blockquoteMarkerWhitespace +
          // blockquoteSetextReplace2), so a tab after '>' leaves its
          // remaining width as spaces.
          col += m.indent + 1;
          rest = m.rest.slice(1);
          if (rest.charAt(0) === ' ' || rest.charAt(0) === '\t') {
            rest = expandWsRun(rest, m.indent + 1);
            rest = rest.slice(1);
            col += 1;
          }
          depth = i + 1;
        } else {
          break;
        }
      } else if (b.type === 'list') {
        depth = i + 1;
      } else if (b.type === 'item') {
        if (rest.trim() === '') {
          depth = i + 1;
        } else {
          const m = measureIndent(rest);
          if (m.indent >= b.contentIndent) {
            // Strip the item's content indent, then expand any leading
            // tabs that remain against their true columns, so later
            // indent measurements see spaces, not tabs re-expanded
            // from the stripped string's start.
            rest = expandWsRun(stripIndent(rest, b.contentIndent, false, col), col + b.contentIndent);
            col += b.contentIndent;
            depth = i + 1;
          } else {
            break;
          }
        }
      } else {
        break;
      }
    }
    return { depth, rest, col };
  }

  function closeTip() {
    if (tip) {
      if (tip.type === 'paragraph') finalizeParagraph(tip);
      tip = null;
    }
  }

  // Close open containers down to depth (exclusive). The tip is only
  // closed when its container is actually popped; when every container
  // matches, the tip stays open and keeps consuming lines. A list's
  // tightness is settled here: it is loose when any item ends with a
  // blank line (other than the last item) or has a blank line between
  // two of its block children.
  function closeTo(depth) {
    if (open.length > depth && tip) closeTip();
    while (open.length > depth) {
      const b = open.pop();
      if (b.type === 'list') {
        let loose = false;
        for (let i = 0; i < b.children.length; i++) {
          const item = b.children[i];
          if (i < b.children.length - 1 && item.lastLineBlank) loose = true;
          for (let j = 0; j < item.children.length - 1; j++) {
            if (item.children[j].lastLineBlank) loose = true;
          }
        }
        b.tight = !loose;
      }
    }
  }

  function finalizeParagraph(p) {
    const kept = [];
    let i = 0;
    const ls = p.lines;
    // Link reference definitions are only recognised at the start of
    // a paragraph (or after another definition). Once a line is not
    // a definition, the rest is paragraph text.
    let inDefs = true;
    while (i < ls.length) {
      if (inDefs) {
        const def = tryLinkReferenceDefinition(ls, i);
        if (def) {
          const key = normalizeLabel(def.label);
          if (key !== '' && !(key in refs)) {
            refs[key] = { dest: def.dest, title: def.title };
          }
          i = def.nextLine;
          continue;
        }
        inDefs = false;
      }
      kept.push(ls[i]);
      i++;
    }
    p.content = kept.join('\n');
    p.lines = null;
  }

  // Try to read a link reference definition starting at line i of the
  // paragraph's lines. The definition may span lines (a multi-line
  // label, a destination or title on the next line). Returns
  // {label, dest, title, nextLine} or null. A title that starts on a
  // new line is optional: if it does not parse, or has extra content
  // after it on its line, the definition still holds without it and
  // the new line is separate. A title on the same line as the
  // destination must parse cleanly or the definition fails.
  // Does this paragraph have any content after its leading link
  // reference definitions are stripped? A paragraph of only
  // definitions has none, so it cannot become a setext heading.
  function paragraphHasContent(ls) {
    let i = 0;
    while (i < ls.length) {
      const def = tryLinkReferenceDefinition(ls, i);
      if (def) { i = def.nextLine; continue; }
      return true;
    }
    return false;
  }

  function tryLinkReferenceDefinition(ls, i) {
    const first = ls[i];
    const m = measureIndent(first);
    if (m.indent >= 4) return null;
    const rest0 = m.rest;
    if (rest0.charAt(0) !== '[') return null;
    const s = rest0 + (i + 1 < ls.length ? '\n' + ls.slice(i + 1).join('\n') : '');
    const n = s.length;
    const countNL = (upto) => {
      let c = 0;
      for (let k = 0; k < upto && k < n; k++) if (s[k] === '\n') c++;
      return c;
    };
    const skipWs = (p) => {
      let crossed = false;
      while (p < n) {
        const c = s[p];
        if (c === ' ' || c === '\t') p++;
        else if (c === '\n') { p++; crossed = true; }
        else break;
      }
      return { p, crossed };
    };
    const lbl = parseLabel(s, 0);
    if (!lbl || lbl.label === '' || normalizeLabel(lbl.label) === '') return null;
    let p = lbl.next;
    let r = skipWs(p);
    p = r.p;
    if (p >= n || s[p] !== ':') return null;
    p++;
    r = skipWs(p);
    p = r.p;
    const d = parseDestination(s, p);
    if (!d) return null;
    // An empty bare destination is no destination; an empty <> one is.
    if (d.dest === '' && s[p] !== '<') return null;
    const dest = d.dest;
    const destEnd = d.next;
    p = destEnd;
    // A title must be separated from the destination by whitespace.
    const wsStart = p;
    r = skipWs(p);
    p = r.p;
    const titleOnNewLine = r.crossed;
    if (p < n && p === wsStart) return null;
    let title = null;
    let endPos = destEnd;
    if (p < n) {
      const t = parseTitle(s, p);
      if (t) {
        // After the title, only whitespace may follow on its line.
        const after = skipWs(t.next);
        if (after.p >= n || after.crossed) {
          title = t.title;
          endPos = t.next;
        } else if (titleOnNewLine) {
          // The title is on a new line and has junk after it: the
          // definition holds without the title.
          endPos = destEnd;
        } else {
          return null;
        }
      } else if (titleOnNewLine) {
        // Not a title, and it is on a new line: the definition holds
        // without it.
        endPos = destEnd;
      } else {
        return null;
      }
    }
    return { label: lbl.label, dest, title, nextLine: i + 1 + countNL(endPos) };
  }

  function openLeaf(container, type) {
    closeTip();
    const b = newBlock(type);
    b.lines = [];
    addChild(container, b);
    tip = b;
    return b;
  }

  function openContainer(container, type) {
    closeTip();
    const b = newBlock(type);
    addChild(container, b);
    open.push(b);
    return b;
  }

  // Mark every open block (and the tip) as ending or not ending with a
  // blank line, for list tightness.
  function setLastLineBlank(v) {
    for (let i = 0; i < open.length; i++) open[i].lastLineBlank = v;
    if (tip) tip.lastLineBlank = v;
  }

  // --- the line loop ---
  for (let li = 0; li < lines.length; li++) {
    const rawLine = lines[li];
    const isBlank = rawLine.trim() === '';
    const mc = matchContainers(rawLine);
    let container = open[mc.depth - 1];
    let line = mc.rest;

    // A blank line: either the raw line is blank, or it is blank once
    // the container markers are stripped (a lone > is a blank line
    // inside a blockquote). A line whose rest is only spaces (such as
    // ">  ") is NOT blank: the spaces are paragraph content. Either
    // way a blank line ends the current paragraph; only a truly blank
    // line (no marker) ends a blockquote.
    if (isBlank || mc.rest === '') {
      // A blank line ends the current paragraph; only a truly blank
      // line (no marker) ends a blockquote. A line of only spaces
      // ends a table too (marked's table body excludes a line that
      // is only spaces before its newline), so it is NOT a row of
      // empty cells.
      // Mark the blocks this blank line follows, BEFORE closing
      // anything. A truly blank line marks every open block (the
      // original behaviour): a blank line directly in a list marks
      // the item it follows, so the list goes loose. A lone marker
      // line (a ">" with nothing after it) is more precise: it marks
      // the tip and the containers from the tip's parent up to (but
      // not including) the deepest container it matched, so a blank
      // line nested inside a blockquote marks the quote's paragraph
      // but not the enclosing list item (the list stays tight), while
      // still separating two paragraphs in one item (the list goes
      // loose).
      if (isBlank) {
        setLastLineBlank(true);
        // With no current leaf, the blank line follows the last child
        // of the deepest open container (a fenced block that just
        // closed, say), so that child is marked too: a blank line
        // after it, inside the same item, makes the list loose.
        if (!tip) {
          const deepest = open[open.length - 1];
          if (deepest && deepest.children.length > 0) {
            deepest.children[deepest.children.length - 1].lastLineBlank = true;
          }
        }
      } else if (tip) {
        // Mark the tip and its ancestors up to and including the
        // deepest container the blank line matched. The deepest
        // container is the item when the blank line sits directly in
        // it (a blank line between two items makes the list loose,
        // doc-15/doc-22); it is a nested blockquote when the blank
        // line sits inside that child, and marking the child alone
        // does not mark the item (cm-320 stays tight).
        tip.lastLineBlank = true;
        let p = tip.parent;
        const stop = open[mc.depth - 1];
        while (p && p !== stop) {
          p.lastLineBlank = true;
          p = p.parent;
        }
        if (stop) stop.lastLineBlank = true;
      } else {
        const deepest = open[mc.depth - 1];
        if (deepest && deepest.children.length > 0) {
          deepest.children[deepest.children.length - 1].lastLineBlank = true;
        }
      }
      if (tip && tip.type === 'table') {
        // Marked's table body excludes only a line that is spaces
        // before its newline (the ` *\n` lookahead); a line holding
        // a tab — even a tab-only line — is a row of empty cells.
        // That holds only while the line is inside every open
        // container: a tab-only line with no marker ends an enclosing
        // blockquote (and the table with it) before any row is added.
        // It still falls through to the blank-line logic below: a
        // tab-only line with no marker ends an enclosing blockquote,
        // so the table (and its new row) closes with it.
        if (mc.depth === open.length && line.indexOf('\t') !== -1) {
          tip.rows.push(splitTableRow(line));
          setLastLineBlank(false);
        } else {
          closeTip();
        }
      } else if (tip && tip.type === 'fenced') {
        // A blank line is content for a fenced block only while the
        // line is inside every open container; its text (after the
        // fence indent) is kept, so a line of spaces is not lost.
        if (mc.depth === open.length) {
          tip.lines.push(stripFenceIndent(line, tip.fenceIndent));
          tip.lastWasBlank = true;
        } else {
          closeTip();
          // The line does not belong to the containers it did not
          // match: close them too, so a following > > starts a new
          // inner blockquote instead of continuing this one (doc-06).
          if (!isBlank) closeTo(mc.depth);
        }
      } else if (tip && tip.type === 'code') {
        // A blank line inside indented code keeps its content past the
        // four-column code indent (usually spaces).
        tip.lines.push(stripIndent(line, 4));
      } else if (tip && tip.type === 'html') {
        if (tip.htmlType === 6 || tip.htmlType === 7) {
          tip.followedByBlank = true;
          closeTip();
        } else {
          tip.lines.push('');
        }
      } else {
        closeTip();
        if (!isBlank) {
          // A lone marker line is blank only inside the containers it
          // matched; containers it did not match end here.
          closeTo(mc.depth);
        }
      }
      // A truly blank line (no marker) cannot be inside a blockquote,
      // so any open blockquote (and everything inside it) ends here.
      // This runs for every tip type: the blank line ends the
      // blockquote even when it is also content for a code or HTML
      // block (its trailing blank is stripped at render).
      if (isBlank) {
        let bqDepth = -1;
        for (let i = 1; i < open.length; i++) {
          if (open[i].type === 'blockquote') { bqDepth = i; break; }
        }
        if (bqDepth !== -1) closeTo(bqDepth);
        // A blank line after an empty list item closes the item: the
        // item has no content, so nothing after the blank line can
        // belong to it. The list itself stays open, so a following
        // item marker still continues the same list.
        const deepest = open[open.length - 1];
        if (deepest && deepest.type === 'item' && deepest.children.length === 0) {
          closeTo(open.length - 1);
        }
      }
      continue;
    }

    // A fenced code block consumes lines until its closing fence, but
    // only while the line is inside every open container — with one
    // exception, marked's list lazy line: inside a list item, a line
    // that does not match the item is still fence content once the
    // fence already has a content line (and the previous line was
    // not blank), because marked adds such a line to the item's text
    // verbatim. A line that does not match a blockquote always ends
    // the fence, and a non-matching line ends a fence that has no
    // content yet (the fence is left unclosed and empty, as when the
    // line right after the opening fence fails to match).
    if (tip && tip.type === 'fenced') {
      if (mc.depth === open.length) {
        const ind = measureIndent(line);
        if (ind.indent <= 3) {
          const f = parseFence(ind.rest);
          // A closing fence has no info string.
          if (f && f.char === tip.fenceChar && f.len >= tip.fenceLen && f.info === '') {
            closeTip();
            setLastLineBlank(false);
            continue;
          }
        }
        // Up to the opening fence's indent is removed from each line,
        // counting leading whitespace characters (a tab counts as one
        // and is kept literal, never expanded).
        tip.lines.push(stripFenceIndent(line, tip.fenceIndent));
        tip.lastWasBlank = false;
        setLastLineBlank(false);
        continue;
      }
      const unmatched = open.slice(mc.depth);
      const inBlockquote = unmatched.some((b) => b.type === 'blockquote');
      if (!inBlockquote && tip.lines.length > 0 && !tip.lastWasBlank) {
        // Lazy list line: fence content, verbatim (no indent is
        // stripped — the line did not match the item's content
        // indent). A closing fence still closes it.
        const ind = measureIndent(line);
        if (ind.indent <= 3) {
          const f = parseFence(ind.rest);
          if (f && f.char === tip.fenceChar && f.len >= tip.fenceLen && f.info === '') {
            closeTip();
            setLastLineBlank(false);
            continue;
          }
        }
        tip.lines.push(line);
        tip.lastWasBlank = false;
        setLastLineBlank(false);
        continue;
      }
      closeTip();
      // Fall through: the line is processed as a new block outside
      // the containers it did not match.
    }

    // An HTML block consumes lines until its end condition, but only
    // while the line is inside every open container: a line outside
    // the list item or blockquote that holds it ends the block.
    if (tip && tip.type === 'html' && mc.depth === open.length) {
      const end = htmlBlockEnd(tip, line);
      tip.lines.push(line);
      if (end) {
        // Only a truly empty next line suppresses the trailing
        // newline: a line of only spaces/tabs still leaves one
        // (marked's html raw keeps the \n after the end line).
        if (li + 1 < lines.length && lines[li + 1] === '') tip.followedByBlank = true;
        closeTip();
      }
      setLastLineBlank(false);
      continue;
    }

    // Setext heading underline, or a table delimiter row: these convert
    // the current paragraph. They are checked before the containers
    // are closed, using the line after container matching. The line
    // must be inside every open container: a --- outside a blockquote
    // or list item is a thematic break, not a setext underline for a
    // paragraph inside it.
    if (tip && tip.type === 'paragraph' && mc.depth === open.length) {
      const ind = measureIndent(line);
      if (ind.indent < 4) {
        const sl = setextLevel(ind.rest);
        if (sl !== 0 && paragraphHasContent(tip.lines)) {
          finalizeParagraph(tip);
          const h = newBlock('heading');
          h.level = sl;
          // A setext heading's content is the paragraph text with
          // leading and trailing whitespace stripped.
          h.content = tip.content.trim();
          const parent = tip.parent;
          parent.children[parent.children.indexOf(tip)] = h;
          h.parent = parent;
          tip = null;
          closeTo(mc.depth);
          setLastLineBlank(false);
          continue;
        }
        const tbl = tryTableDelimiter(tip, ind.rest);
        if (tbl) {
          tip = null;
          closeTo(mc.depth);
          tip = tbl;
          setLastLineBlank(false);
          continue;
        }
      }
    }

    // A table consumes non-blank lines as rows, but a line that
    // starts a block ends the table instead (marked's table body
    // excludes a line starting a heading, thematic break, blockquote,
    // indented code, fence, list, or HTML block; an ordered list
    // only ends it when it starts with 1).
    if (tip && tip.type === 'table') {
      const ind = measureIndent(line);
      const t = ind.rest;
      let endsTable = false;
      if (ind.indent >= 4) endsTable = true;
      else if (t.charAt(0) === '>') endsTable = true;
      else if (parseAtx(t) !== null) endsTable = true;
      else if (parseFence(t) !== null) endsTable = true;
      else if (isThematicBreak(t)) endsTable = true;
      else {
        const lm = parseListMarker(t);
        if (lm && t.charAt(lm.markerLen) !== '' && (t.charAt(lm.markerLen) === ' ' || t.charAt(lm.markerLen) === '\t') && (!lm.ordered || lm.num === 1)) endsTable = true;
        else {
          const hb = htmlBlockStart(t);
          if (hb !== 0 && hb !== 7) endsTable = true;
        }
      }
      if (endsTable) {
        closeTip();
      } else {
        tip.rows.push(splitTableRow(line));
        setLastLineBlank(false);
        continue;
      }
    }

    // A lazy continuation: the tip is a paragraph, the containers did
    // not all match, and the line does not start a block that can
    // interrupt a paragraph. The paragraph continues; the containers
    // stay open. The line is taken after the matched containers are
    // removed; if it is indented four or more columns there, a
    // four-column code indent is stripped from it.
    if (tip && tip.type === 'paragraph' && mc.depth < open.length) {
      const r = mc.rest;
      const ind = measureIndent(r);
      const t = ind.rest;
      let startsBlock = false;
      if (ind.indent < 4) {
        startsBlock = parseAtx(t) !== null ||
          parseFence(t) !== null ||
          isThematicBreak(t) ||
          t.charAt(0) === '>' ||
          htmlBlockStart(t) !== 0;
        if (!startsBlock) {
          const lm = parseListMarker(t);
          if (lm) {
            // A list marker starts a block unless it is an empty item
            // or an ordered list not starting with 1 that would have
            // to interrupt a paragraph. But when the paragraph is
            // inside a list item, any marker starts a block: it is the
            // next item of that list or the start of a new list (a
            // different delimiter ends the old list), so the paragraph
            // is not being interrupted.
            if (open[mc.depth] && open[mc.depth].type === 'item') {
              startsBlock = true;
            } else {
              startsBlock = !lm.empty && (!lm.ordered || lm.num === 1);
            }
          }
        }
      }
      if (!startsBlock) {
        // A lazy setext-like line (===) inside a blockquote, following
        // a lazy line, is paragraph text with four spaces prepended:
        // it cannot be a setext underline there (it is outside the
        // quote), and the four spaces mark where the quote's content
        // would have been.
        let content = ind.indent >= 4 ? stripIndent(r, 4) : r;
        if (setextLevel(t) === 1 && tip.lastLazy) {
          let inBq = false;
          for (let p = tip.parent; p; p = p.parent) {
            if (p.type === 'blockquote') { inBq = true; break; }
          }
          if (inBq) content = '    ' + t;
        }
        tip.lines.push(content);
        tip.lastLazy = true;
        setLastLineBlank(false);
        continue;
      }
    }

    closeTo(mc.depth);
    container = open[open.length - 1];
    line = mc.rest;

    // If the deepest open container is a list but this line does not
    // start a new item of it, the list ends here (a thematic break, a
    // heading, or a different kind of list does not belong inside it).
    if (container.type === 'list') {
      const ind0 = measureIndent(line);
      let continues = false;
      if (ind0.indent < 4 && !isThematicBreak(ind0.rest)) {
        const lm0 = parseListMarker(ind0.rest);
        continues = !!lm0 && lm0.ordered === container.ordered && lm0.delim === container.delim;
      }
      if (!continues) {
        closeTo(open.length - 1);
        container = open[open.length - 1];
      }
    }

    // Open containers (block quotes and list items) as deeply as the
    // line allows, then start one leaf block. col is the absolute
    // column where line starts in the source line; every strip below
    // keeps it exact, and every stripped string keeps its leading
    // whitespace as spaces (tabs expanded against true columns), so
    // later indent measurements are in true columns.
    let col = mc.col;
    for (;;) {
      const ind = measureIndent(line);
      if (ind.indent > 3) break;
      const t = ind.rest;
      if (t.charAt(0) === '>') {
        const bq = openContainer(container, 'blockquote');
        container = bq;
        // The '>' is one column; the whitespace after it is
        // tab-expanded against the column where it starts in this
        // level's text (marked's J uses b.length, so the column
        // restarts at each nesting level), then exactly one space
        // is consumed.
        col = col + ind.indent + 1;
        line = t.slice(1);
        if (line.charAt(0) === ' ' || line.charAt(0) === '\t') {
          line = expandWsRun(line, ind.indent + 1);
          line = line.slice(1);
          col += 1;
        }
        continue;
      }
      // A thematic break takes precedence over a list marker: a line
      // of - * _ is a break, not a list.
      if (isThematicBreak(t)) break;
      const lm = parseListMarker(t);
      if (lm) {
        // A list interrupts a paragraph only when its first item is not
        // empty and (for ordered lists) it starts with 1 -- unless the
        // marker continues the list the line is already inside, or the
        // paragraph is inside a list item (any marker then starts a
        // block: the next item or a new nested list).
        const sameList = container.type === 'list' && container.ordered === lm.ordered && container.delim === lm.delim;
        const canInterrupt = !tip || tip.type !== 'paragraph' || sameList || container.type === 'item' || (!lm.empty && (!lm.ordered || lm.num === 1));
        if (!canInterrupt) break;
        const ci = itemContentIndent(ind.indent, lm.markerLen, t.slice(lm.markerLen));
        let list = null;
        if (container.type === 'list' && container.ordered === lm.ordered && container.delim === lm.delim) {
          list = container;
        } else {
          const kids = container.children;
          if (kids.length > 0) {
            const last = kids[kids.length - 1];
            if (last.type === 'list' && last.ordered === lm.ordered && last.delim === lm.delim) {
              list = last;
            }
          }
        }
        if (!list) {
          list = openContainer(container, 'list');
          list.ordered = lm.ordered;
          list.delim = lm.delim;
          list.start = lm.num;
        }
        const item = openContainer(list, 'item');
        item.contentIndent = ci;
        container = item;
        // Strip only up to the content indent: the text after the
        // marker starts at ind.indent + markerLen, so the amount to
        // remove is ci minus that column. (Stripping ci - ind.indent
        // would eat into the content when five or more spaces follow
        // the marker, hiding an indented code block.) The whitespace
        // after the marker is tab-expanded against its true column
        // first, so a tab straddling the content indent leaves its
        // remaining width as spaces.
        const afterMarkerCol = col + ind.indent + lm.markerLen;
        line = expandWsRun(t.slice(lm.markerLen), afterMarkerCol).slice(ci - ind.indent - lm.markerLen);
        col = col + ci;
        continue;
      }
      break;
    }

    // The containers are settled now: every block the line does not
    // belong to has been closed, so clearing the blank-line flag here
    // only touches the blocks the new line actually lives in. (Clearing
    // it earlier would wipe the flag off a list that this line ends,
    // hiding a blank line that makes the list loose.)
    setLastLineBlank(false);

    const ind = measureIndent(line);
    const content = ind.rest;
    const indent = ind.indent;

    // An empty line after the container markers (a lone >) is a blank
    // line inside the containers; it does not start a paragraph. It is
    // content for an indented code block or a continuing HTML block.
    // A line of only spaces after a marker (such as ">  ") is content
    // for a paragraph: the spaces become one of its lines.
    if (content.trim() === '') {
      if (tip && tip.type === 'code') tip.lines.push('');
      else if (tip && tip.type === 'html' && tip.htmlType !== 6 && tip.htmlType !== 7) tip.lines.push('');
      else if (tip && tip.type === 'paragraph') { tip.lines.push(line); tip.lastLazy = false; }
      else closeTip();
      continue;
    }

    if (indent < 4) {
      const atx = parseAtx(content);
      if (atx) {
        closeTip();
        const h = newBlock('heading');
        h.level = atx.level;
        h.content = atx.content;
        addChild(container, h);
        continue;
      }
      const fence = parseFence(content);
      if (fence) {
        const b = openLeaf(container, 'fenced');
        b.fenceChar = fence.char;
        b.fenceLen = fence.len;
        b.info = fence.info;
        // The opening fence's indent: up to this much is stripped
        // from each content line — but only for backtick fences:
        // marked's Dt compensates with /^(\s+)(?:```)/, which never
        // matches a ~~~ fence, so tilde fences keep their content
        // indent untouched (doc-22).
        b.fenceIndent = fence.char === '`' ? indent : 0;
        b.lastWasBlank = false;
        continue;
      }
      const hb = htmlBlockStart(content);
      if (hb !== 0) {
        if (hb !== 7 || !tip || tip.type !== 'paragraph') {
          const b = openLeaf(container, 'html');
          b.htmlType = hb;
          b.isTopLevel = container === root;
          if (hb === 1) {
            b.htmlEndTag = /^<(script|pre|style|textarea)/i.exec(content)[1].toLowerCase();
          }
          b.lines.push(line);
          // The block may end on its own opening line (a one-line
          // comment or a <style>..</style> on one line).
          if (htmlBlockEnd(b, line)) {
            if (li + 1 < lines.length && lines[li + 1] === '') b.followedByBlank = true;
            closeTip();
          }
          continue;
        }
      }
      if (isThematicBreak(content)) {
        closeTip();
        addChild(container, newBlock('hr'));
        continue;
      }
    }

    // Indented code (cannot interrupt a paragraph).
    if (indent >= 4 && (!tip || tip.type !== 'paragraph')) {
      if (!tip || tip.type !== 'code') {
        const b = openLeaf(container, 'code');
        b.lines.push(stripIndent(line, 4));
      } else {
        tip.lines.push(stripIndent(line, 4));
      }
      continue;
    }

    // Otherwise, the line belongs to a paragraph (or starts one).
    if (!tip || tip.type !== 'paragraph') {
      const b = openLeaf(container, 'paragraph');
      b.lines.push(line);
      b.lastLazy = false;
    } else {
      tip.lines.push(line);
      tip.lastLazy = false;
    }
  }

  // End of input: finalise the open tip, then close the containers.
  closeTip();
  closeTo(1);
  // Mark the last top-level block, for the HTML trailing-newline rule.
  if (root.children.length > 0) {
    root.children[root.children.length - 1].isLastTopLevel = true;
  }
  return renderBlocks(root, refs, text.endsWith('\n'));
}

// Does this line end an HTML block of the given type?
function htmlBlockEnd(b, line) {
  if (b.htmlType === 1) {
    const tag = b.htmlEndTag;
    return line.toLowerCase().indexOf('</' + tag + '>') !== -1;
  }
  if (b.htmlType === 2) return line.indexOf('-->') !== -1;
  if (b.htmlType === 3) return line.indexOf('?>') !== -1;
  if (b.htmlType === 4) return line.indexOf('>') !== -1;
  if (b.htmlType === 5) return line.indexOf(']]>') !== -1;
  return false;
}

// Render a block (and its children) to HTML. In a tight list, a
// paragraph child of an item is rendered as bare inline content.
function renderBlocks(b, refs, srcEndsWithNewline) {
  switch (b.type) {
    case 'document': {
      let s = '';
      for (const c of b.children) s += renderBlocks(c, refs, srcEndsWithNewline);
      return s;
    }
    case 'paragraph':
      // A paragraph that was only link reference definitions has no
      // content and renders nothing.
      if (b.content === '') return '';
      return '<p>' + (b.taskCheckbox || '') + parseInline(b.content, refs) + '</p>\n';
    case 'heading':
      return '<h' + b.level + '>' + parseInline(b.content, refs) + '</h' + b.level + '>\n';
    case 'code': {
      const lines = b.lines;
      let end = lines.length;
      while (end > 0 && lines[end - 1] === '') end--;
      const content = end === 0 ? '' : lines.slice(0, end).join('\n') + '\n';
      return '<pre><code>' + escapeText(content) + '</code></pre>\n';
    }
    case 'fenced': {
      const lines = b.lines;
      // Only the single blank line just before the closing fence is
      // dropped; any earlier trailing blanks are content.
      let end = lines.length;
      if (end > 0 && lines[end - 1] === '') end--;
      const content = end === 0 ? '' : lines.slice(0, end).join('\n') + '\n';
      let cls = '';
      const info = b.info ? b.info.trim() : '';
      if (info !== '') {
        // The info string's first word, with backslash escapes resolved.
        cls = ' class="language-' + escapeAttr(unescapeStr(info.split(/\s/, 1)[0])) + '"';
      }
      return '<pre><code' + cls + '>' + escapeText(content) + '</code></pre>\n';
    }
    case 'html': {
      const lines = b.lines;
      let end = lines.length;
      while (end > 0 && lines[end - 1] === '') end--;
      if (end === 0) return '';
      // An HTML block's lines are joined with newlines. A trailing
      // newline is kept when the block is not followed by a blank line
      // and another block follows it in the same parent (top-level:
      // when it is the last block, only if the source ends with a
      // newline). A nested block that is the last child never has one.
      let hasTrailing;
      if (b.isTopLevel) {
        hasTrailing = !b.followedByBlank && (!b.isLastTopLevel || srcEndsWithNewline);
      } else {
        const sibs = b.parent ? b.parent.children : null;
        hasTrailing = !b.followedByBlank && !!sibs && sibs[sibs.length - 1] !== b;
      }
      return lines.slice(0, end).join('\n') + (hasTrailing ? '\n' : '');
    }
    case 'blockquote': {
      let s = '<blockquote>\n';
      for (const c of b.children) s += renderBlocks(c, refs, srcEndsWithNewline);
      return s + '</blockquote>\n';
    }
    case 'list': {
      let s;
      if (b.ordered && b.start !== 1) {
        s = '<ol start="' + b.start + '">\n';
      } else if (b.ordered) {
        s = '<ol>\n';
      } else {
        s = '<ul>\n';
      }
      for (const c of b.children) s += renderItem(c, refs, b.tight, srcEndsWithNewline);
      return s + (b.ordered ? '</ol>\n' : '</ul>\n');
    }
    case 'hr':
      return '<hr>\n';
    case 'table': {
      let s = '<table>\n<thead>\n<tr>\n';
      for (let i = 0; i < b.header.length; i++) {
        s += '<th' + (b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '') + '>' +
          parseInline(b.header[i], refs) + '</th>\n';
      }
      s += '</tr>\n</thead>\n';
      if (b.rows.length > 0) {
        s += '<tbody>';
        for (const row of b.rows) {
          s += '<tr>\n';
          for (let i = 0; i < b.header.length; i++) {
            const cell = i < row.length ? row[i] : '';
            s += '<td' + (b.aligns[i] ? ' align="' + b.aligns[i] + '"' : '') + '>' +
              parseInline(cell, refs) + '</td>\n';
          }
          s += '</tr>\n';
        }
        s += '</tbody>';
      }
      return s + '</table>\n';
    }
    default:
      return '';
  }
}

function renderItem(item, refs, tight, srcEndsWithNewline) {
  let s = '<li>';
  // A task list item: its first paragraph starts with [ ] or [x]
  // followed by a space. The marker is stripped and a checkbox is
  // rendered in its place.
  const first = item.children[0];
  if (first && first.type === 'paragraph') {
    const m = /^\[([ xX])\] /.exec(first.content);
    if (m) {
      first.taskCheckbox = m[1] === ' '
        ? '<input disabled="" type="checkbox"> '
        : '<input checked="" disabled="" type="checkbox"> ';
      first.content = first.content.slice(m[0].length);
    }
  }
  for (const c of item.children) {
    if (c.type === 'paragraph' && tight) {
      s += (c.taskCheckbox || '') + parseInline(c.content, refs);
    } else {
      s += renderBlocks(c, refs, srcEndsWithNewline);
    }
  }
  return s + '</li>\n';
}

export { parse };
