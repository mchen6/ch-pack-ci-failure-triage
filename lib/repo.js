'use strict';
// The repository to triage (#413 rev 3, P1 and P3): the tool's `repo`; else
// the module's own setting defaultRepo (ctx.settings, which the user sets at
// a terminal); else none, and the handler asks for the
// setting (ctx.settingRequired). Nothing else is read: no path that only this
// pack has (the launcher's device config went in P3).
// GitHub's grammar, as the runtime's `repo` setting format checks it
// (countinghouse lib/module-settings.js), so the input and the setting take
// the same repositories: an owner of letters, digits and single inner
// hyphens, at most 39; a name of at most 100, not . or ..
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const isRepo = (v) => {
  if (typeof v !== 'string') return false;
  const parts = v.split('/');
  return parts.length === 2 && OWNER.test(parts[0]) && NAME.test(parts[1]) && parts[1] !== '.' && parts[1] !== '..';
};

function resolveRepo(input, settings) {
  if (input != null && input.repo !== undefined) return isRepo(input.repo) ? input.repo : null;
  if (settings != null && isRepo(settings.defaultRepo)) return settings.defaultRepo;
  return null;
}

module.exports = {resolveRepo, isRepo};
