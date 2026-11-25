'use strict';
// A failed assertion's expected and actual values, in the answer. They come
// from ch-step-error-patterns' `details` (screened there), never reach the
// failure signature, and pass ch-step-redact again here: the triaged job's
// under their verdicts in `errors` (without the lines `errors` has already),
// another job's whole on its entry in failed_jobs. One bound for the whole
// answer, spent in the jobs' order and charged for what is sent, the notes
// included; what it leaves out is said, so a partial diff never reads as the
// whole.
const BOUNDS = Object.freeze({LINES: 40, CHARS: 4000});
const LINE_MAX = 500;
const CUT = '\u2026';
const VALUES_CUT = "(the assertion's line or the values above may go on in the log)";
const omittedNote = (n) => `(${n} more failed assertion${n === 1 ? ' may not have all its' : 's may not have all their'} values shown: a limit was reached)`;
const firstOfNote = (n) => `(the values above are the first one's; this error is in the log ${n} times)`;
const NOTE_CHARS = omittedNote(1e6).length;

const newBudget = () => ({lines: BOUNDS.LINES, chars: BOUNDS.CHARS});
const size = (lines) => lines.reduce((n, l) => n + l.length, 0);
function take(budget, lines) {
  const chars = size(lines);
  if (lines.length > budget.lines || chars > budget.chars) return false;
  budget.lines -= lines.length;
  budget.chars -= chars;
  return true;
}
const notesOf = (b) => [...(b.cut ? [VALUES_CUT] : []), ...(b.repeats > 1 ? [firstOfNote(b.repeats)] : [])];
const whole = (b) => [b.verdict, ...b.values, ...notesOf(b)];

// Each block's lines as they are sent: cleaned (redacted and withheld) together
// when that keeps every line its place, else block by block (a key block over
// several lines becomes one). Never over the line bound, and a block with
// a line cut here says it is cut.
const fit = (line) => (line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 1).replace(/[\ud800-\udbff]$/, '')}\u2026`);
// The screened copy of a line that `lines` cut (JSON to 200 characters): no longer
// than the line is there, and never cut through a placeholder.
const asLong = (text, line) => (!line.includes(CUT) || text.length <= line.length ? text
  : `${text.slice(0, line.length - 1).replace(/<[a-z ]*$/, '').replace(/[\ud800-\udbff]$/, '')}${CUT}`);
const fitted = (lines) => {
  const out = lines.map(fit);
  return out.every((l, k) => l === lines[k]) || out.includes(VALUES_CUT) ? out : [...out, VALUES_CUT];
};
async function cleaned(blocks, clean) {
  const all = blocks.flat();
  if (all.length === 0) return blocks;
  const done = await clean(all);
  if (done.length !== all.length) {
    const each = [];
    for (const b of blocks) each.push(b.length === 0 ? b : fitted(await clean(b)));   // (one at a time, as the log's steps)
    return each;
  }
  let at = 0;
  return blocks.map((b) => fitted(done.slice(at, at += b.length)));
}

// Two jobs of a matrix fail alike with their stacks under different checkouts
// (GitHub's: <work>/<repo>/<repo>/): the checkout is set aside, and only in a
// stack frame. Everything else is compared as it is, and a job with a
// placeholder is never another's same: what differs may be what it hides.
const LOCATION = /^\s*at\s.*:\d+:\d+\)?\s*(?:\{\s*)?$|^\s*File ".*", line \d+/;
const PLACEHOLDER = /<(?:withheld|value line withheld|jwt|basicAuth|githubToken|awsKey|token|apiKey|privateKey|secret|email|phone|card|ipv4)>|\(withheld: |\(a line of \d+ characters, omitted\)/;
const CHECKOUT = /(?:file:\/\/\/?)?(?:\/home\/runner\/work|\/Users\/runner\/work|\/?[A-Za-z]:[\\/]a)[\\/]([^\\/\s()"]+)[\\/]\1[\\/]/;
const comparable = (line) => (LOCATION.test(line) && CHECKOUT.test(line) ? line.replace(CHECKOUT, '').replace(/\\/g, '/') : line);
const canCompare = (details) => !details.blocks.some((b) => [b.verdict, ...b.values].some((l) => PLACEHOLDER.test(l)));
const sameKey = (details) => JSON.stringify([details.omittedBlocks, details.blocks.map((b) => [b.verdict, b.values.map(comparable), b.cut, b.repeats || 1])]);

// The triaged job's lines with each block's own among them (places: each shown
// line's place in the part's `lines`; a block names its verdict's, and its
// values'; where: each shown line's step and index there, and how many its
// record stands for). A verdict or a value that is in `lines` is shown there as
// the part screened it (a value after its runner's tag, which the part gives
// apart), and not added again (a verdict of JSON that `lines` cut short is no
// longer there than it was; such a value has no place, and stays as it is). One
// that is not comes after the block's line before it, so they read in the log's
// order, the notes last. A block whose verdict the line cap left out brings that
// verdict, before its first line, or, with none there, where it was in its step.
// All of it is redacted once more as one list (a key can be split across an
// error line and a value); when that merges or drops lines, what it answers is
// shown, and no block is counted as shown.
// -> {errors, whole}: whole when every block it was given is shown.
async function errorsWithValues(lines, places, details, budget, clean, redact, where) {
  if (details == null) return {errors: await redact(lines), whole: false};
  const at = new Map(places.map((place, i) => [place, i]));
  const shownAt = (place) => (place !== undefined && at.has(place) ? at.get(place) : -1);
  // (the place a block with no line here follows: the line before the next one of
  // its step, else its step's last. A step is known by its name only, so with two
  // of one name the place can be off.)
  const followed = (b) => {
    const mine = where.map((w, i) => i).filter((i) => where[i].step === b.step);
    const next = mine.find((i) => where[i].index > b.index);
    if (next !== undefined) return next - 1;
    return mine.length > 0 ? mine[mine.length - 1] : lines.length - 1;
  };
  const screened = new Map(); // a shown line's place -> its text, as the part screened it
  const screen = (i, text) => screened.set(i, where[i].repeats > 1 ? fit(`${text} (${where[i].repeats} times)`) : text);
  const blocks = details.blocks.map((b) => {
    const kept = b.places.map(shownAt);
    const first = kept.find((i) => i >= 0);
    const verdictAt = shownAt(b.line);
    const added = []; // {text, after: the place it follows, -1 for before them all}
    let after = verdictAt >= 0 ? verdictAt : first !== undefined ? first - 1 : followed(b);
    const start = after;
    if (verdictAt < 0) added.push({text: b.verdict, after});
    else screen(verdictAt, asLong(b.verdict, lines[verdictAt]));
    b.values.forEach((text, k) => {
      if (kept[k] >= 0) {
        after = Math.max(after, kept[k]);
        screen(kept[k], `${b.tag || ''}${text}`);
      }
      else added.push({text, after});
    });
    const notes = notesOf(b).map((text) => ({text, after}));
    // (a verdict with nothing to add to it stays out)
    const own = verdictAt < 0 ? 1 : 0;
    return {start, added: added.length > own || notes.length > 0 ? [...added, ...notes] : []};
  });
  // (room for the note, given back when nothing was left out)
  budget.lines -= 1;
  budget.chars -= NOTE_CHARS;
  const sent = await cleaned(blocks.map((b) => b.added.map((x) => x.text)), clean);
  const inserted = new Map();
  const insert = (after, text) => inserted.set(after, [...(inserted.get(after) || []), text]);
  let skipped = 0;
  // (in the order they are read)
  for (const k of blocks.map((b, n) => n).sort((x, y) => blocks[x].start - blocks[y].start || x - y)) {
    if (!take(budget, sent[k])) { skipped++; continue; }
    const {start, added} = blocks[k];
    const last = added.length > 0 ? added[added.length - 1].after : start;
    // (merged by redaction: all of it together, where the block starts)
    const asTheyAre = sent[k].length >= added.length;
    sent[k].forEach((text, n) => insert(!asTheyAre ? start : n < added.length ? added[n].after : last, text));
  }
  const joint = [...(inserted.get(-1) || []), ...lines.flatMap((text, i) => [screened.has(i) ? screened.get(i) : text, ...(inserted.get(i) || [])])];
  const errors = await redact(joint);
  if (errors.length !== joint.length) skipped = blocks.length;
  const omitted = details.omittedBlocks + skipped;
  const note = omitted > 0 ? [omittedNote(omitted)] : [];
  budget.lines += 1 - note.length;
  budget.chars += NOTE_CHARS - size(note);
  return {errors: [...errors, ...note], whole: skipped === 0};
}

// The other listed jobs' fields, by place: {values} and how many of its failed
// assertions are not shown, or {values_same_as: place} when an earlier job shows
// the same ones.
async function valuesOfJobs(jobs, firstWhole, budget, clean) {
  const out = new Map();
  const shownAt = new Map();
  if (jobs.length > 0 && jobs[0].details != null && firstWhole && canCompare(jobs[0].details)) shownAt.set(sameKey(jobs[0].details), 0);
  for (let n = 1; n < jobs.length; n++) {
    const details = jobs[n].details;
    if (details == null) continue;
    const key = sameKey(details);
    if (shownAt.has(key)) {
      out.set(n, {values_same_as: shownAt.get(key)});
      continue;
    }
    // (a block is two lines or more: no call when fewer are left)
    const sent = budget.lines < 2 ? null : await cleaned(details.blocks.map(whole), clean);
    const lines = [];
    let skipped = 0;
    details.blocks.forEach((b, k) => {
      if (sent !== null && take(budget, sent[k])) lines.push(...sent[k]);
      else skipped++;
    });
    const omitted = details.omittedBlocks + skipped;
    if (lines.length > 0 || omitted > 0) out.set(n, {...(lines.length > 0 ? {values: lines} : {}), ...(omitted > 0 ? {values_omitted: omitted} : {})});
    if (skipped === 0 && canCompare(details)) shownAt.set(key, n);
  }
  return out;
}

module.exports = {BOUNDS, VALUES_CUT, omittedNote, firstOfNote, newBudget, errorsWithValues, valuesOfJobs};
