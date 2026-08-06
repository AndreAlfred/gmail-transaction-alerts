# Gmail Transaction Alerts → Google Sheets

A small Google Apps Script that reads bank transaction-alert emails from Gmail and appends one row per purchase to a Google Sheet.

It deliberately does one thing: **detect a supported transaction-alert email, extract its fields, and append a row.** No bank credentials, no third-party aggregator, no server, no categorization built in. Each user runs a private copy of the spreadsheet and script; nothing is shared between installs.

## Supported alerts

| Institution | Sender | Handling |
|---|---|---|
| USAA | `USAA.customer.service@omem.usaa.com` | Purchase authorizations imported |
| Chase | `no.reply.alerts@chase.com` | Merchant purchases imported; scheduled card payments ignored |

Anything else from a trusted sender is routed to an **Import Issues** sheet and labeled **Needs Review** rather than silently dropped. Mail from any other sender is rejected outright.

## Install

1. Open your spreadsheet → **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with [`gmail-transaction-alerts-Code.gs`](gmail-transaction-alerts-Code.gs).
3. Save, reload the spreadsheet tab.
4. **Transaction Alerts → Setup / Initialize** (authorize when prompted).
5. **Transaction Alerts → Import Now**, then **Automatic Import → Every 5 minutes**.

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

Two details that make this safe: the append row is located by scanning the *Gmail Message ID* column rather than `getLastRow()` (so formulas filled far down the sheet don't push new rows below the data), and rows are written cell-by-cell into mapped columns (so neighboring formulas are never overwritten).

## Tests

```bash
node --test tests/chase-purchase.test.js
```

Fixtures are synthetic. **Never commit a real alert email, real merchant/amount pairs, or real card digits** — redact to fictitious values that preserve the original wording and whitespace structure. Parser changes should be fixture-driven and test-first; see [`AGENT_HANDOFF.md`](AGENT_HANDOFF.md).

## Caveats

- This is an **authorization-alert log, not a posted bank ledger.** Tips, refunds, reversals, and final posted amounts can differ from the alert.
- Chase alerts contain no cardholder name, so that column is blank on Chase rows. It is left empty rather than inferred.
- Only alerts that arrive as email are captured. If an alert doesn't fire, there's no row.
