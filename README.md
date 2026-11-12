# @countinghouse/ch-pack-ci-failure-triage

countinghouse scenario: one call answers "why did CI fail?" with the failing step, the error lines, the cross-run history and a measured receipt of what was read and what reached the model.

**Status: name reserved (2026-11-11).** The implementation lands here per
the pack family's plan (Task 9 of `docs/superpowers/plans/2026-11-11-ch-packs-v1.md`
in [ch-packs](https://github.com/mchen6/ch-packs)). Nothing to install yet.

Part of the countinghouse client packs. The design, the plan and the
acceptance tests live in [ch-packs](https://github.com/mchen6/ch-packs);
each package has its own repository (maintainer's decision, 2026-11-11).

## Development

```
npm ci
npm test
```

Pure JavaScript, Node 22.16 or later, no native module. CI runs on
Linux, macOS and Windows.

## Publishing

Releases are published by `.github/workflows/publish.yml` under npm
trusted publishing: a `v<version>` tag on a `main` commit whose
package.json carries that version. No npm token exists anywhere and no 2FA
code is typed for a release. One-time setup on npmjs.com, by the
maintainer: the package's first version is published by hand (`npm publish
--access public`, with 2FA); then **Settings → Trusted publishing → GitHub
Actions** with owner `mchen6`, repository `ch-pack-ci-failure-triage`, workflow
`publish.yml`, allowing `npm publish` as well as `npm stage publish`;
then **Settings → Publishing access → Require two-factor authentication
and disallow tokens**. A new trusted-publisher configuration must publish
once within two days or it expires.

## License

Apache-2.0.
