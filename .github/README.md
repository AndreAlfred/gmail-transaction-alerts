# GitHub Actions

Workflows for this repository live under [`workflows/`](workflows/).

| Workflow | Job name | Required on `main`? | Purpose |
|---|---|---|---|
| [`ci.yml`](workflows/ci.yml) | `tests` | **Yes** | `node --test tests/*.test.js` |
| [`version-check.yml`](workflows/version-check.yml) | `version-check` | **Yes** | Require `.gs` and `.txt` **byte-identical**; require `parserVersion` bump when those files change |
| [`release.yml`](workflows/release.yml) | `release` | No | Tag `{parserVersion}` (no `v` prefix) and create a GitHub Release on merged PR to `main`, push to `main`, or manual `workflow_dispatch` |

Helper script: [`scripts/extract-parser-version.js`](scripts/extract-parser-version.js).

Human-facing release and branch-protection steps are in the root [`README.md`](../README.md) (Releasing section).
