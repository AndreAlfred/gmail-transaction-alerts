# Agent Instructions

Instructions for coding agents working in this repository. Read this before changing a parser or the sheet write path. Human-facing setup lives in [`README.md`](README.md).

> **This file exists twice, byte-identical: `AGENTS.md` and `CLAUDE.md`.**
> Different tools look for different filenames, so both must exist and both must say the same thing. **When you change one, copy it over the other in the same commit** — never edit them separately and never let them diverge:
>
> ```bash
> cp AGENTS.md CLAUDE.md    # or the reverse; they must be identical
> diff AGENTS.md CLAUDE.md  # must print nothing
> ```
>
> Because the two are identical, this file is written to read correctly under either name. Don't add wording that only makes sense in one of them.

## Branching

This repository has more than one contributor. **Do not commit to `main`.**

```bash
git checkout -b feature/<short-description>
# work, commit, then:
git push -u origin feature/<short-description>
gh pr create --fill
```

One branch per change, named for what it does. Run the full test suite before pushing, and say in the PR body what you verified and what you did not. If a change alters the shape of a sheet the user already has data in, describe the migration explicitly — someone else's live spreadsheet is downstream of it.

**Quick reference**

- Tests: `node --test tests/*.test.js` (run them all; several suites exist)
- Authoritative source: `gmail-transaction-alerts-Code.gs`; regenerate the `.txt` copy after every change (`cp gmail-transaction-alerts-Code.gs gmail-transaction-alerts-Code.txt`)
- Never commit real alert emails, real merchant/amount pairs, real card digits, live message IDs, or personal names — fixtures must be synthetic
- Never widen the trusted-sender allowlist to make a parser pass
- Never reintroduce a literal column index into the sheet write path

## Read `LESSONS.md` first

[`LESSONS.md`](LESSONS.md) records the non-obvious failures this project has already hit, and why the code is shaped the way it is. **Read it before changing the sheet write path, a parser, or a fixture.** Most of its entries describe bugs that fail *silently* — the import reports success while writing rows where nobody looks — so they are cheap to reintroduce and expensive to notice.

It is organized by area: Sheets, Parsing, Fixtures and privacy, Apps Script and testing, Repository hygiene.

**Keep it current.** When a bug, review, or debugging session turns up something that wasn't obvious from reading the code, add an entry in the same shape as the others:

- **the lesson**, as a specific claim in the heading — not a topic label
- **what happened**, concretely enough that someone can recognize the same situation
- **how to apply it**, as a rule that can actually be followed

Only record what is specific to this project or its environments (Apps Script, Gmail, Sheets). General programming advice does not belong there — it dilutes the file and makes it stop being read. If a lesson turns out to be wrong or is designed away, delete the entry rather than leaving it to mislead.

## What this project is

This is a minimal, self-contained Google Apps Script product that populates a Google Sheet from bank transaction-alert emails in Gmail. It is intended for two users, each with a completely private copy of the spreadsheet and script.

The active implementation deliberately avoids SimpleFIN, Plaid, external servers, AI, bank credentials, categorization, dashboards, and other budgeting features. Its purpose is narrowly defined: **detect a supported transaction-alert email, extract its transaction fields, and append one row to Google Sheets.**

## Current product behavior

The script searches Gmail for messages from these exact trusted senders:

- USAA: `USAA.customer.service@omem.usaa.com`
- Chase: `no.reply.alerts@chase.com`
- Venmo: `venmo@venmo.com`

Current parser coverage:

1. **USAA purchase authorizations** matching wording like:
 `Your credit card ...7484 was charged $7.56 at MERCHANT.`
 followed by Date and Cardholder name fields.
2. **Chase credit-card merchant purchases**, e.g. subject `You made a $12.34 transaction with SAMPLE*COFFEE SHOP`. Field labels: Account / Date / Merchant / Amount. Merchant and amount fall back to the subject line if the body layout changes. Card Type is the Account product name (lowercased).
3. **Chase debit-card purchases**, e.g. subject `Your debit card transaction of $12.34 from account ending in (…1234)`. Field labels differ: Account ending in / Made on / Description / Amount. Merchant falls back to the body headline (`You made a debit card transaction of $… with MERCHANT`); amount can fall back to the subject. Card Type is `debit` because the account row carries only `(...last4)`.
4. **Chase outbound transfers** to another bank/account, e.g. subject `You sent $250.00 from account ending in (…5678)`. Field labels: Account ending in / Sent on / Recipient / Amount. Merchant is the recipient (headline fallback: `You sent $… to RECIPIENT`). Card Type is `transfer`; Event Type is `transfer_out`. Amount is positive.
5. **Chase scheduled credit-card payments**, which are recognized but intentionally ignored because they are not merchant purchases.
6. **Venmo P2P payments** you sent (`You paid NAME $X.XX`) and **payments received** (`NAME paid you $X.XX`). Merchant is the counterparty. Card Type is `payment` or `received`. Amount is always positive; Event Type distinguishes direction (`venmo_payment` / `venmo_payment_received`). Payment alerts may carry Last 4 from `Payment Method` (`account ending in ####`); received alerts leave Last 4 blank. Other Venmo mail goes to Needs Review.
7. Other trusted-sender formats are sent to **Import Issues** and labeled **Needs Review** rather than silently discarded.

Chase credit, debit, and transfer alerts all render fields as nested two-cell HTML table rows. After `htmlToText_`, the label and value often land on consecutive lines (source newlines between `</td>` and `<td>`), so parsers bridge with `\s*` rather than requiring `Label Value` on one line. **Chase and Venmo alerts carry no cardholder name**, so that column is left empty rather than fabricated.

The Transactions sheet contains:

- Imported At
- Transaction Date
- Institution
- Card Type
- Last 4
- Cardholder
- Merchant
- Amount

Hidden audit columns contain Gmail message ID, email received time, event type, parser version, and transaction fingerprint.

### User-added columns

End users may add their own columns (categorization, formulas) anywhere on the Transactions sheet. The script tolerates this as of the column-mapping fix:

- Columns are resolved **by header name**, never by fixed index. Row 1 header text for the thirteen script-owned columns must be preserved exactly; if any is missing the script throws a named error instead of writing to the wrong place.
- The append row is found by scanning **every script-owned column** for the last row in use (`lastUsedScriptRow_`), not `getLastRow()`. A user formula filled down to row 500 no longer pushes new transactions to row 501.
- Rows are written **cell by cell** into mapped columns, so user formulas in surrounding columns are never overwritten.
- Audit columns are hidden only when the sheet is first created, so a user who unhides them keeps them visible.

### Manually entered rows

Users may type rows directly onto the Transactions sheet — a cash purchase, for example. Such a row has no Gmail Message ID and no audit fields, but it does fill Transaction Date / Merchant / Amount, which **are** script-owned columns. `lastUsedScriptRow_` inspects every owned column precisely so a manual row counts as occupied and the next import lands below it.

Do not narrow that scan back to the `Gmail Message ID` column alone. That makes manual rows invisible to the anchor, and the next import silently overwrites the user's typed data. `tests/sheet-append.test.js` asserts this.

Manual rows are also skipped by dedup (no message ID to match) and by `Event Type`, so they coexist with imported rows without special handling.

Regression to watch for: any change that reintroduces a literal column index (`getRange(row, 9, …)`, a fixed-width `setValues`, or `getLastRow()` as an append anchor) will silently break these guarantees.

### Import Issues

Rows record `Gmail Message ID`, `Email Received At`, `Institution`, `Subject`, `From`, `Reason`, `Open in Gmail`, and `Parser Version` — enough for a reviewer to judge an alert without opening Gmail.

- **Subject and sender only. Never the body.** Subject lines are short and label the message; bodies are the thing the privacy constraints exist to keep out of the sheet.
- Text is passed through `safeCellText_`, which collapses newlines, caps length, and prefixes a leading `=`, `+`, `-`, or `@` with an apostrophe so a subject line cannot be evaluated as a formula.
- `ensureHeaders_` adds any missing header to the right of the existing ones, so sheets created by an earlier version keep their column positions and their old rows stay readable. Never reorder or rewrite existing headers as part of a migration.
- Issue rows are appended with the same column-map and last-used-row logic as transactions, so a reviewer's own notes columns are safe.

### Setup sheet configuration

The Setup sheet holds both script-written status (`Last Checked`, `Last Result`, `Last Error`, `Last Imported Transaction`) and **user-editable config**: `Import USAA` / `Import Chase` / `Import Venmo`, seeded `TRUE` once and never overwritten by `initializeWorkbook`. Setting one to `FALSE` drops that institution from the Gmail search, so its mail stays unlabeled and resumes on re-enable within the 30-day window.

This is the established home for user-editable config. Add new settings here as `Setting` / `Value` rows following the same seed-once-never-overwrite rule, rather than introducing a second config location.

Config that lives in `APP_CONFIG` inside the script is **destroyed on every update**, because updating means pasting a new copy of the file over the old one. Anything a user is expected to change belongs on the Setup sheet, not in the source.

## Architecture

**The whole product is one file: `gmail-transaction-alerts-Code.gs`.** Users install it by pasting the entire file into `Code.gs` in a container-bound Apps Script project, so it cannot be split into modules — there is no build step and no `clasp` push in this repo.

The file keeps the original module boundaries as `// ===== appsscript/X.gs =====` section banners. They are organizational comments only; no such files exist. Respect the boundaries when adding code:

| Section | Holds |
|---|---|
| `Config.gs` | `APP_CONFIG`: parser version, trusted senders, import toggles, intervals, label names |
| `Text.gs` | HTML/entity/whitespace normalization, date and amount parsing |
| `Parsers.gs` | `trustedInstitution_`, `parseAlert` routing, per-institution parsers |
| `Workbook.gs` | Sheet creation, column mapping, append paths, status rows |
| `GmailIntake.gs` | Gmail search, allowlist enforcement, labels, locking, dedup |
| `Triggers.gs` | Time-driven trigger install/remove |
| `Menu.gs` | Menu, Diagnostics, and user-invoked commands |

`gmail-transaction-alerts-Code.txt` is a **byte-identical** copy for devices that won't open a `.gs`. CI enforces this. Regenerate it in the same commit as any script change:

```bash
cp gmail-transaction-alerts-Code.gs gmail-transaction-alerts-Code.txt
```

**Runtime:** the script requires the **V8** Apps Script runtime — it uses `padStart` and `Number.isFinite`, neither of which exists under legacy Rhino. New Apps Script projects default to V8.

## Gmail disposition labels

The script creates and uses:

- `Bank Transactions/Imported`
- `Bank Transactions/Ignored`
- `Bank Transactions/Needs Review`

A valid purchase is appended before its message/thread is labeled Imported. Runtime failures remain without a terminal label so they can be retried. Gmail message ID is the primary deduplication key.

## Scheduling and latency

Apps Script has no native Gmail-arrival trigger. The implementation polls using a time-driven trigger. It supports 1, 5, 10, 15, 30, or 60 minutes plus manual **Import Now**.

- Five minutes is the recommended default.
- One minute is the closest free near-real-time mode.
- Exact execution time is not guaranteed by Google.

## Privacy and safety constraints

Preserve these boundaries when revising:

- Enforce the exact trusted-sender allowlist even when a Gmail source label is configured.
- Never store complete email bodies in the spreadsheet or logs.
- Never commit live message IDs, credentials, personal names, original emails, or real full card numbers.
- Do not label a message Imported until its row append succeeds.
- Do not fabricate missing parser fields; send incomplete/unknown formats to review.
- Treat this as an authorization-alert log, not an authoritative posted bank ledger. Tips, reversals, refunds, and final posted amounts can differ.
- Keep each end user’s workbook, authorization, labels, triggers, and data independent.

## How to modify parsers

Parser changes should be fixture-driven and test-first:

1. Obtain a real email’s **Show original** source or plain-text body.
2. Redact personal data while preserving labels, wording, and whitespace structure. Replace values with obviously fictitious ones — a real merchant and amount are personal data too, not just card digits.
3. Save the synthetic fixture under `fixtures/`.
4. Add a failing test in the matching `tests/<institution>.test.js` (create one if the institution is new).
5. Run it and confirm it fails for the expected reason:
   ```bash
   node --test tests/*.test.js
   ```
   There is no `package.json` and no `npm test` — Node's built-in runner is the whole harness. Pass explicit paths or a glob; a bare directory argument is treated as a module and throws.
6. Change only the relevant parser in the `Parsers.gs` section.
7. Re-run the full suite.
8. `cp gmail-transaction-alerts-Code.gs gmail-transaction-alerts-Code.txt`
9. Bump `parserVersion` — see **Releasing and versioning** below.
10. Test against the real Gmail message in a disposable private spreadsheet.

Do not loosen sender checks or write one broad regex that mixes banks and message types.

## Releasing and versioning

`APP_CONFIG.parserVersion` **is** the release version. Tags and GitHub Releases use it verbatim, with no `v` prefix.

Two CI checks gate every PR to `main`, and both must pass:

| Check | Requires |
|---|---|
| `tests` | `node --test tests/*.test.js` passes |
| `version-check` | `.gs` and `.txt` **byte-identical**, and `parserVersion` bumped whenever either changes |

| Change | Bump |
|---|---|
| Parser behavior, new alert type, sheet write semantics | minor (major if the sheet column contract breaks) |
| Bug fix preserving behavior | patch |
| Docs, CI, or tests only — no `.gs` / `.txt` change | none |

If you branched before someone else merged, **resolve the version forward** rather than taking either side: a branch at `1.3.0` merging a `main` at `1.4.0` becomes `1.5.0`, not one of the two. Taking either side silently discards a release.

After merge, the release workflow tags the version and publishes a release whose notes are the PR description. Write the PR body as the changelog entry it will become.

## Verification

Test suites live in `tests/`, one per institution plus two for sheet behavior:

| Suite | Covers |
|---|---|
| `chase-purchase.test.js` | Chase credit and debit purchases, subject fallbacks, sender allowlist |
| `chase-transfer.test.js` | Chase outbound transfers |
| `venmo.test.js` | Venmo sent/received, HTML-over-plain body selection |
| `import-issues.test.js` | Issue row contents, header migration, formula neutralization |
| `import-toggles.test.js` | Per-institution Setup toggles and query filtering |
| `sheet-append.test.js` | Append anchor, manual rows, column mapping |

Do not maintain a list of individual test names here — it rots faster than anyone updates it. Read the suite.

`tests/helpers/fake-sheet.js` is a Sheets test double implementing only the API surface the workbook code touches. Extend it when you need another method; objects it returns live in a `vm` realm, so compare with a spread (`{ ...result }`) or `deepStrictEqual` fails on the prototype alone.

**Not covered by tests, and still worth doing by hand** in a disposable private spreadsheet:

1. Run `initializeWorkbook()` twice and confirm idempotence.
2. Import Now against a real alert; confirm exactly one row and the Imported label.
3. Run again; confirm no duplicate.
4. Confirm a scheduled Chase payment gets Ignored and no transaction row.
5. Install, replace, and disable time triggers.
6. Confirm no email body or credentials appear in Setup or Import Issues.

## Scope guidance

Optimize for a working, understandable product quickly. Avoid reintroducing categories, budgets, dashboards, transfer matching, AI, or financial aggregation unless the end user explicitly asks for a new scope.

End users do their own categorization in extra columns on the Transactions sheet, and type occasional cash rows by hand. Support that by keeping the sheet write path column-name-driven and content-anchored — not by building categorization into the product.

Known gap, deliberately unaddressed: **the trusted-sender list still lives in `APP_CONFIG`**, so a user who edits it loses that edit on the next update. Moving it to the Setup sheet is the obvious fix and has been discussed; check with the other contributor before starting, since the Setup toggles work landed in this area.
