# ci/

No workflow in this repository runs a script from `ci/`, so this file is
the directory's only content.

The workflows themselves live in `.github/workflows/`. To change CI, edit
them there in a reviewed pull request: session credentials can push
workflow changes (admin `DECISIONS.md` ADR-8, as amended on 2026-09-24),
so staging a workflow here for a maintainer to promote is optional.
Sessions still cannot push tags. Library releases therefore go through
`workflow_dispatch`, and the web component, which `release.yml` publishes
only on a `web/v*` tag push, needs a maintainer to push that tag.

Four of this repository's workflows also have a template in admin
`rollout/workflows/`: `ci.yml`, `crates-release.yml`, `pages.yml` and
`release.yml`. ADR-8 as amended says a workflow changed here is
mirrored in its template, so change the template too, in admin.
Otherwise admin `scripts/verify.sh` reports the drift, and the next
`rollout/apply-workflows.sh --apply` pushes the old text back.
`clib.yml` and `clib-release.yml` are stamped (each carries a
`tabnas-clib-template` marker): they change only through admin
`tasks/clib-template/` and a re-stamp with `tasks/adopt-clib.sh`, never
by hand. The others have no template and change here alone.

## Promoted

- **`docs.yml`** — the prose gate: Vale over the reader-facing pages at
  the levels set in `.vale.ini`, on the file list
  `ts/scripts/gated-docs.cjs` produces. See `docs/STYLE-GUIDE.md`. It
  was staged here and now runs from `.github/workflows/docs.yml`;
  `make prose` runs the same check locally.
