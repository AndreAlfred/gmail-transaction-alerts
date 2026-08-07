# Gmail Transaction Alerts → Google Sheets

A small Google Apps Script that reads bank transaction-alert emails from Gmail and appends one row per purchase to a Google Sheet.

It deliberately does one thing: **detect a supported transaction-alert email, extract its fields, and append a row.** No bank credentials, no third-party aggregator, no server, no categorization built in. Each user runs a private copy of the spreadsheet and script; nothing is shared between installs.

## Supported alerts

| Institution | Sender | Handling |
|---|---|---|
| USAA | `USAA.customer.service@omem.usaa.com` | Purchase authorizations imported |
| Chase | `no.reply.alerts@chase.com` | Credit and debit merchant purchases and outbound transfers imported; scheduled card payments ignored |
| Venmo | `venmo@venmo.com` | P2P payments you sent and payments you received imported; other Venmo mail goes to Needs Review |

Anything else from a trusted sender is routed to an **Import Issues** sheet and labeled **Needs Review** rather than silently dropped. Mail from any other sender is rejected outright.

## Install

1. Open your spreadsheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with [`gmail-transaction-alerts-Code.gs`](gmail-transaction-alerts-Code.gs).
3. Save, reload the spreadsheet tab.
4. **Transaction Alerts → Setup / Initialize** (authorize when prompted).
5. **Transaction Alerts → Import Now**, then **Automatic Import → Every 5 minutes**.

On the **Setup** sheet, `Import USAA`, `Import Chase`, and `Import Venmo` default to `TRUE`. Set any to `FALSE` to pause that institution without labeling its mail; turning it back on resumes import within the usual 30-day search window.

`gmail-transaction-alerts-Code.txt` is a byte-identical copy of the `.gs`, for devices that won't open a `.gs` file. Regenerate it after any change:

```bash
cp gmail-transaction-alerts-Code.gs gmail-transaction-alerts-Code.txt
```

Apps Script has no Gmail-arrival trigger, so this polls on a time-driven trigger (1/5/10/15/30/60 minutes). Google does not guarantee exact execution times.

## Adding your own columns

You can add category or formula columns anywhere on the Transactions sheet. The script resolves its own columns **by header text in row 1**, so keep these thirteen headers intact:

```
Imported At, Transaction Date, Institution, Card Type, Last 4, Cardholder,
Merchant, Amount, Gmail Message ID, Email Received At, Event Type,
Parser Version, Fingerprint
```

The last five are hidden audit columns. If one is missing, the import stops with an error naming it instead of writing to the wrong place.

Two details that make this safe: the append row is located by scanning every script-owned column for the last row in use, rather than `getLastRow()` (so formulas filled far down the sheet don't push new rows below the data), and rows are written cell-by-cell into mapped columns (so neighboring formulas are never overwritten).

**You can also type rows by hand** — a cash purchase, say. Fill in Transaction Date, Merchant, Amount, and whatever else is useful; leave the hidden audit columns blank. The importer treats a manual row as occupied and appends below it, and dedup ignores it (there's no message ID to match).

## Tests

```bash
node --test tests/*.test.js
```

Fixtures are synthetic. **Never commit a real alert email, real merchant/amount pairs, or real card digits** — redact to fictitious values that preserve the original wording and whitespace structure. Parser changes should be fixture-driven and test-first; see [`AGENTS.md`](AGENTS.md).

## Releasing

The release version is `APP_CONFIG.parserVersion` in `gmail-transaction-alerts-Code.gs` (must match the `.txt` copy). Tags and GitHub Releases use `{parserVersion}` with no `v` prefix (e.g. `1.1.0`).

**When you change the script** (`.gs` / `.txt`):

1. Bump `parserVersion` in the `.gs` file.
2. `cp gmail-transaction-alerts-Code.gs gmail-transaction-alerts-Code.txt` (CI requires the two files to be **byte-identical**, not merely the same version string).
3. Open a PR to `main`. CI fails if the version is still the same as `main`, or if the two files differ in any byte.
4. After merge, the release workflow creates tag `X.Y.Z` (if new) and a GitHub Release whose **Changes** section is the PR description (falls back to GitHub-generated notes if the body is empty). It runs on merged PR close (primary), push to `main`, or manual **Run workflow** (`workflow_dispatch`). Duplicate runs are safe: an existing tag is skipped.

| Change | Bump |
|---|---|
| Parser behavior / new alert type / sheet write semantics | minor (major if the sheet column contract breaks) |
| Bug fix preserving behavior | patch |
| Docs / CI / tests only (no `.gs` / `.txt`) | no bump |

CI does not edit the version for you. An advisory PR comment may suggest patch/minor/major when script files change.

Use GitHub Copilot’s built-in PR title/description helper when opening a pull request (no custom Action).

### Branch protection on `main`

After the workflows have run at least once (so check names appear in the UI), configure a **ruleset** (Settings → Rules → Rulesets) or classic branch protection:

1. Target branch: `main`
2. Block force pushes and deletions
3. Require a pull request before merging
4. **Require status checks to pass:**
   - `tests` (job from `.github/workflows/ci.yml`)
   - `version-check` (job from `.github/workflows/version-check.yml`)
5. Do **not** require `release`
6. Optional: require conversation resolution; require linear history

Exact check names must match the workflow job `name:` fields above. If a check is missing from the dropdown, merge or open a PR that runs the workflow once, then re-open the ruleset editor.

## Caveats

- This is an **authorization-alert log, not a posted bank ledger.** Tips, refunds, reversals, and final posted amounts can differ from the alert.
- Chase and Venmo alerts contain no cardholder name, so that column is blank on those rows. It is left empty rather than inferred.
- Chase outbound transfers use **Card Type** `transfer` and **Event Type** `transfer_out`; **Merchant** is the recipient. Amount is positive.
- Venmo amounts are always positive. **Event Type** is `venmo_payment` (you paid) or `venmo_payment_received` (someone paid you); **Card Type** is `payment` or `received`. **Merchant** is the counterparty name.
- Only alerts that arrive as email are captured. If an alert doesn't fire, there's no row.

## Contributing

- [`AGENTS.md`](AGENTS.md) — working instructions and constraints. Duplicated byte-identically as `CLAUDE.md`; change both together.
- [`LESSONS.md`](LESSONS.md) — the non-obvious failures this project has already hit, and why the code is shaped the way it is. Worth reading before touching the sheet write path or a parser.

## License

[MIT](LICENSE) © 2026 Andrew Trimble. Provided as is, without warranty — see the license text, and the caveats above, before relying on it for anything financial.
