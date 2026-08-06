# GitHub Actions

Workflows for this repository live under [`workflows/`](workflows/).

| Workflow | Job name | Required on `main`? | Purpose |
|---|---|---|---|
| [`ci.yml`](workflows/ci.yml) | `tests` | **Yes** | `node --test tests/*.test.js` |
| [`version-check.yml`](workflows/version-check.yml) | `version-check` | **Yes** | Require `.gs` and `.txt` **byte-identical**; require `parserVersion` bump when those files change |
| [`pr-draft.yml`](workflows/pr-draft.yml) | `pr-draft` | No | AI PR title/body via `OPENAI_API_KEY` |
| [`release.yml`](workflows/release.yml) | `release` | No | Tag `{parserVersion}` (no `v` prefix) and create a GitHub Release on push to `main` |

Helper scripts: [`scripts/extract-parser-version.js`](scripts/extract-parser-version.js), [`scripts/draft-pr.js`](scripts/draft-pr.js).

Human-facing release and branch-protection steps are in the root [`README.md`](../README.md) (Releasing section).
