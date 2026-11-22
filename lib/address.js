'use strict';
// ch-step-report's address check, copied verbatim from its 0.4.4
// (handlers/reportService/assemble.js, mchen6/ch-step-report@4a370ff8): the
// pack's own no-failed-run answer carries lastSuccess past no report, so it
// screens those fields the same way (the reviewer's high on #18, round 2).
// test/address.test.js holds the two copies to one answer.
// Whether `text` holds an e-mail address: a run of non-space, non-@
// characters, an @, and a run holding a dot with a character on either side
// of it -- broad on purpose: ch-step-redact masks addresses upstream, so one
// reaching here is withheld, and a line that only looks like one (a version
// pin, a MySQL 'user'@'host') costs just its field, never the report (the
// reviewer's pre-work high on pack 1, P3, 2026-11-21, and the four mediums
// on its fix). Three exact shapes are not addresses, so common git errors
// keep their text:
// - an @ right after a redaction tag (://<basicAuth>@, <githubToken>@): the
//   user part is already masked;
// - the @ ending a URL's userinfo: right after "<scheme>://" (a scheme where
//   a user name is normal, starting its run) and only userinfo characters
//   or a whole tag (ssh://git@github.com/o/r.git, postgres://app@db.internal);
// - git's own user before a path or its password prompt: "git" starting its
//   run, then a host and a colon or 's (git@github.com:o/r.git,
//   git@github.com's password).
// Scanned out from each @, each look back bounded by the characters it
// takes, so it is linear in the text's length; the regular expression it
// replaced (/[^\s@]+@[^\s@]+\.[^\s@]+/) was quadratic (a 40 KB string took
// about 3 s; the reviewer, 2026-11-13).
const USER_SCHEMES = new Set(['ssh', 'git', 'git+ssh', 'ssh+git', 'http', 'https', 'ftp', 'ftps', 'sftp', 'postgres', 'postgresql',
  'mysql', 'mariadb', 'mongodb', 'mongodb+srv', 'redis', 'rediss', 'amqp', 'amqps', 'ldap', 'ldaps', 'smtp', 'smtps', 'imap', 'imaps']);
const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const USERINFO_CHAR = /[A-Za-z0-9._~%:-]/;
const USER_CHAR = /[A-Za-z0-9._-]/;
const SCHEME_START = /[\s"'`(<\[{=,;:>]/;
const GIT_START = /[\s"'`(\[]/;
// ch-step-redact's own tags (the reviewer's high on #7, L7): no other
// <letters> stands for a masked user part
// (every tag ch-step-redact 0.2.3 writes, lib/rules.js; the medium on the
// high round: kept in step with it by hand -- this part takes no dependency
// on redact)
const REDACT_TAGS = new Set(['jwt', 'basicAuth', 'githubToken', 'awsKey', 'token', 'apiKey', 'privateKey', 'secret', 'email', 'phone', 'card', 'ipv4']);
// The text as an address is read (the fifth and sixth mediums on the P3
// fix): one pass over a fixed map, never NFKC (whose expansions cost 60
// times as much on hostile input). A dot's lookalikes (\uff0e \u3002 \uff61 \u2024 \ufe52, and the
// cut's own … and ‥ as one dot) and %2E read as a dot; an @ written any
// other way (\uff20 \ufe6b %40, or %2540 encoded twice) reads as ENC_AT, which is
// always an address's @: never a URL's userinfo, a tag's or git's.
const ENC_AT = '\uE000';
const LOOKALIKE = /%25(?:40|2e)|%40|%2e|[\uFF20\uFE6B\uFF0E\u3002\uFF61\u2024\uFE52\u2025\u2026]/gi;
const AS = {'%2540': ENC_AT, '%40': ENC_AT, '\uFF20': ENC_AT, '\uFE6B': ENC_AT};
const plain = (text) => String(text).replace(LOOKALIKE, (m) => AS[m.toLowerCase()] || '.');
const isAt = (c) => c === '@' || c === ENC_AT;
const isPart = (c) => !isAt(c) && !/\s/.test(c);
// A redaction tag of redact's own ending right before `at`, starting its
// run -> true. By character codes, no slice.
const isLetter = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
const TAG_START = /[\s"'`(\[:/=,;]/;
function tagBefore(text, at) {
  if (text[at - 1] !== '>') return false;
  let k = at - 2;
  while (k >= 0 && at - 2 - k < 24 && isLetter(text.charCodeAt(k))) k--;
  if (k < 0 || text[k] !== '<' || k === at - 2) return false;
  if (!REDACT_TAGS.has(text.slice(k + 1, at - 1))) return false;
  return k === 0 || TAG_START.test(text[k - 1]);
}
// The host right after the @ at `at` -> whether it is an address's: a run up
// to the first delimiter, @ or space (after an optional quote), trailing
// dots trimmed, with a dot inside and a last label of letters, two or more
// (any script), or an IDN's xn-- (the reviewer's high on #7, L8: a version
// pin, react@16.8.0, is none). A forward scan, so linear in the host.
const HOST_END = /[\s/?#:,;"'()<>[\]`=&!*+|\\{}^]/;
// (the last label is read up to its first character no label takes -- a
// colour code, a quote, a dash, _, $ or a further %XX hides nothing -- and
// is letters with their marks, two or more, in any script, or an IDN's
// xn--: the medium on the high round)
const LABEL_CHAR = /[\p{L}\p{M}\p{N}-]/u;
const LAST_LABEL = /^(?:[\p{L}\p{M}]{2,}|xn--[A-Za-z0-9-]+)$/iu;
// (-> whether it is an address's; with hostEnd, also where the host ended,
// for the password rule below)
function addressHost(text, at, out = null) {
  let i = at + 1;
  if (text[i] === "'" || text[i] === '"') i++;
  const start = i;
  while (i < text.length && !isAt(text[i]) && !HOST_END.test(text[i])) i++;
  if (out != null) out.hostEnd = i;
  let end = i;
  while (end > start && text[end - 1] === '.') end--;
  const host = text.slice(start, end);
  const dot = host.lastIndexOf('.');
  if (dot <= 0) return false;
  let stop = dot + 1;
  while (stop < host.length && LABEL_CHAR.test(host[stop])) stop++;
  return LAST_LABEL.test(host.slice(dot + 1, stop));
}
// One pass. `authority` holds from just after a known scheme's "://" while
// only userinfo characters (or a whole redact tag) follow; the @ ending it is
// a URL's user name, and from there `host` holds to the end of the
// authority, where a second @ is an address's (the reviewer's high on #7,
// H1: postgres://svc@corp.com:pw@db). Each look back (the scheme, the user,
// a tag of at most 24 letters) stops at a character the other does not
// take, and each host scan at the next @ or delimiter, so the whole is
// linear in the text.
const DIGEST = /^sha(?:256:[0-9a-f]{64}|512:[0-9a-f]{128})(?![0-9a-z])/i;
// (plain() has made the cut's … a dot)
const DIGEST_CUT = /^sha(?:256:[0-9a-f]{0,63}|512:[0-9a-f]{0,127})\.$/i;
function hasAddress(input) {
  const text = plain(input);
  let authority = false;
  let host = false;
  // (a redact <email> tag earlier in this run of non-space characters: the
  // user part was an address, so an @ after it is one's too -- the
  // reviewer's follow-up on #7: <email>:hunter2@db)
  let emailInRun = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/\s/.test(c)) emailInRun = false;
    else if (c === '<' && text.startsWith('<email>', i)) emailInRun = true;
    if (c === ':' && text[i + 1] === '/' && text[i + 2] === '/') {
      let start = i;
      while (start > 0 && SCHEME_CHAR.test(text[start - 1])) start--;
      const scheme = text.slice(start, i).toLowerCase();
      authority = /^[a-z]/.test(scheme) && USER_SCHEMES.has(scheme) && (start === 0 || SCHEME_START.test(text[start - 1]));
      host = false;
      i += 2;
      continue;
    }
    if (!isAt(c)) {
      if (host && (/\s/.test(c) || c === '/' || c === '?' || c === '#')) host = false;
      if (!authority) continue;
      if (c === '<') {
        let k = i + 1;
        while (k < text.length && k - i <= 24 && isLetter(text.charCodeAt(k))) k++;
        if (text[k] === '>' && k > i + 1 && REDACT_TAGS.has(text.slice(i + 1, k))) { i = k; continue; }
      }
      if (!USERINFO_CHAR.test(c)) authority = false;
      continue;
    }
    // an @ in the host part, after the user name's, or after a masked
    // address in its run: an address
    if (host || emailInRun) return true;
    if (c === ENC_AT) {
      // (an encoded @ is an address's, wherever it is)
      authority = false;
      if (addressHost(text, i)) return true;
      continue;
    }
    const userinfo = authority;
    authority = false;
    if (userinfo) { host = true; continue; }
    if (i === 0 || !isPart(text[i - 1])) continue;
    if (tagBefore(text, i)) continue;
    let u = i;
    while (u > 0 && USER_CHAR.test(text[u - 1])) u--;
    if (text.slice(u, i) === 'git' && (u === 0 || GIT_START.test(text[u - 1])) && /^[A-Za-z0-9.-]+(?::|'s(?![A-Za-z]))/.test(text.slice(i + 1, i + 260))) continue;
    // an image digest, image@sha256:<64 hex> or @sha512:<128 hex>: an image
    // reference, never an address (the reviewer's final pass on the packs,
    // A3: `node:20-slim@sha256:a39f…: not found` withheld every error line)
    // (the medium: a password written after a whole digest is still one,
    // and a digest the cut split -- hex up to the … that ends the text -- is
    // still a digest)
    if (text[i + 1] === 's' || text[i + 1] === 'S') {
      const digest = DIGEST.exec(text.slice(i + 1, i + 140));
      if (digest != null) {
        const end = i + 1 + digest[0].length;
        const next = text[end + 1];
        if (text[end] === ':' && next != null && !/[\d\s]/.test(next)) return true;
        continue;
      }
      if (text.length - i <= 140 && DIGEST_CUT.test(text.slice(i + 1))) continue;
    }
    const at = {};
    if (addressHost(text, i, at)) return true;
    // a host followed by ':' and a non-digit: a password, not a port
    // (svc@db:hunter2@x), never a port (svc@db:5432)
    const next = text[at.hostEnd + 1];
    if (text[at.hostEnd] === ':' && next != null && !/[\d\s]/.test(next)) return true;
  }
  return false;
}

const WITHHELD = '(withheld: it holds an e-mail address)';
const withheld = (t) => (typeof t === 'string' && hasAddress(t) ? WITHHELD : t);

module.exports = {hasAddress, withheld, WITHHELD};
