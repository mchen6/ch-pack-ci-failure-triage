'use strict';
// The repository to triage (reviewer, 2026-11-11): the tool's `repo`, else the
// launcher's default (DeviceConfig.defaultRepo, from the origin remote of the
// directory the client started it in), else none.
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const isRepo = (v) => typeof v === 'string' && REPO.test(v) && !/\/\.{1,2}$/.test(v);

function resolveRepo(input, deviceConfig) {
  if (input != null && input.repo !== undefined) return isRepo(input.repo) ? input.repo : null;
  if (deviceConfig != null && isRepo(deviceConfig.defaultRepo)) return deviceConfig.defaultRepo;
  return null;
}

module.exports = {resolveRepo, isRepo};
