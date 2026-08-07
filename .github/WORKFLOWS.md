# GitHub Actions

<!-- Named WORKFLOWS.md, not README.md: GitHub renders .github/README.md as the
     repository landing page in place of the root README. -->

Workflows for this repository live under [`workflows/`](workflows/).

| Workflow | Job name | Required on `main`? | Purpose |
|---|---|---|---|
| [`ci.yml`](workflows/ci.yml) | `tests` | **Yes** | `node --test tests/*.test.js` |
| [`version-check.yml`](workflows/version-check.yml) | `version-check` | **Yes** | Require `.gs` and `.txt` **byte-identical**; require `parserVersion` bump when those files change |
| [`release.yml`](workflows/release.yml) | `release` | No | Tag `{parserVersion}` (no `v` prefix) and create a GitHub Release on **merged PR to `main`**, or manual `workflow_dispatch` |

Helper script: [`scripts/extract-parser-version.js`](scripts/extract-parser-version.js).

**Release fires exactly once per merge.** `release.yml` deliberately has no `push: branches: [main]` trigger. With both triggers, a merge started two runs that raced to push the same tag; the loser failed with `tag already exists`, leaving a red run on every merge. The tag-exists guard cannot prevent that, because both runs check before either pushes.

The race also decided the release notes. Notes come from the pull request body, which only the `pull_request` run has — so whenever the `push` run won, the release silently fell back to generated notes. Releases `1.4.0` and `1.5.0` were published that way.

Consequence: a direct push to `main` no longer releases. That matches the branching rule in [`AGENTS.md`](../AGENTS.md) — `main` takes pull requests only. Use **Run workflow** for a release without a PR.

Human-facing release and branch-protection steps are in the root [`README.md`](../README.md) (Releasing section).
