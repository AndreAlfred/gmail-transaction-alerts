# USAA bank-account debit alerts

Date: 2026-08-08
Status: approved

## Problem

USAA sends a "Debit Alert for Your USAA Bank Account" email when money leaves a
bank account by an amount over the user's configured threshold. The script does
not import it today, for two independent reasons:

1. **The sender is not on the allowlist.** These alerts come from
   `USAA.Customer.Service@mailcenter.usaa.com`. The allowlist has only
   `usaa.customer.service@omem.usaa.com` — a different subdomain — so
   `trustedInstitution_` returns null and the message is recorded as
   "Untrusted sender" before any parser runs.
2. **No parser matches the format.** `parseUsaa_` requires the purchase
   wording (`Your credit card ...7484 was charged $X at MERCHANT`) plus a
   `Cardholder name:` field. A bank-account debit has none of those.

The alert is genuinely from USAA: DKIM `d=usaa.com` passes, SPF passes, and
DMARC passes under `p=REJECT`.

## Format

The message ships a real, non-empty `text/plain` part, so `parseAlert` parses
that rather than the HTML. After quoted-printable decoding and `normalizeText_`
(which turns the `=09` tabs into spaces and collapses them), the body reads:

```
USAA SECURITY ZONE Firstname Lastname USAA # ending in: 0000 Hi, Firstname.

$35.00 came out of your account ending in 1234.

To:
USAA DEBIT
Date:
08/07/26
Check My Account
```

Two structural notes:

- `To:` / `Date:` land label-then-value on **consecutive lines**, the same shape
  the Chase parsers already bridge with `\s*`. Do not require `Label Value` on
  one line.
- The date is `MM/DD/YY` with a two-digit year. `parseUsDate_` already handles
  that and maps it to `20YY`.

In the HTML part the same fields appear inside `<SPAN class="DLSVAR">`
elements, and the account holder's first and last name are separated by `<br>`,
so after `htmlToText_` they arrive on **separate lines**. Any name pattern must
tolerate a newline between them.

## Scope

**Debits only.** The deposit side of this alert type is deliberately out of
scope: no sample of that wording exists, and the project's rule is that parser
changes are fixture-driven. Deposit alerts continue to go to Needs Review.

## Design

### 1. Sender (`Config.gs`)

Add a second exact address mapping to the same institution:

```js
'usaa.customer.service@omem.usaa.com':       'USAA',
'usaa.customer.service@mailcenter.usaa.com': 'USAA',
```

This is a second entry, **not a looser match** — the check stays exact-address.
`LESSONS.md` ("Never widen the sender allowlist to make a parser work")
prescribes exactly this: fix the sender entry rather than relax the comparison.

`trustedInstitution_` lowercases both sides, so the capitalized real-world
spelling matches. `enabledTrustedSenders_` maps per address but gates on the
institution, so both addresses ride the existing `Import USAA` toggle and no
new Setup row is needed.

### 2. Routing (`Parsers.gs`)

`parseUsaa_` becomes a router; its current body moves unchanged to
`parseUsaaPurchase_`:

```js
function parseUsaa_(text) {
  if (/came out of your account ending in/i.test(text)) return parseUsaaAccountDebit_(text);
  return parseUsaaPurchase_(text);
}
```

Routing is on the body phrase, not the subject, because `parseUsaa_` receives
only `text`. Unrecognized USAA mail still falls through to the purchase parser
and then to Needs Review, so existing behavior for unknown formats is unchanged.

### 3. `parseUsaaAccountDebit_`

| Field | Source |
|---|---|
| Amount, Last 4 | `(\$[\d,]+(?:\.\d{2})?)\s+came out of your account ending in\s+(\d{4})` |
| Transaction Date | `Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})` → `parseUsDate_` |
| Cardholder | text between `USAA SECURITY ZONE` and `USAA # ending in`, whitespace-collapsed |
| Merchant | constant `'USAA Bank Debit'` |
| Card Type | `'bank debit'` |
| Event Type | `'account_debit'` |
| Amount sign | positive |

**Required for import:** amount, last 4, and a valid date. Missing any of those
returns `needs_review`.

**Cardholder is best-effort.** If USAA reshapes the security-zone header the
name comes back empty rather than failing the import — refusing an otherwise
complete $35.00 debit over a cosmetic header would lose real data. This is not
fabrication: the field is left blank, never guessed.

**The `To:` row is not required.** Its value (`USAA DEBIT`) is discarded in
favor of the constant Merchant, so requiring it would add a failure mode
without adding data. `$X came out of your account ending in NNNN` plus a
`Date:` is already a tight signature.

`Card Type` is `bank debit` rather than `debit` because Chase debit-*card*
purchases already use `debit`; the two would be indistinguishable when sorting
or filtering the sheet. Direction stays visible in `Card Type` because
`Event Type` is a hidden audit column.

Amount stays positive, matching Chase transfers and Venmo receipts, where
direction is carried by `Event Type` rather than by sign.

### 4. Fixtures

All synthetic. No real name, email address, account digits, amount, or message
ID from the sample.

| Fixture | Purpose |
|---|---|
| `usaa-account-debit-alert.txt` | the decoded `text/plain` part — the path production actually takes |
| `usaa-account-debit-alert.html` | the HTML part; exercises the first/last name split across `<br>` |
| `usaa-purchase-alert.txt` | regression guard for the pre-existing purchase parser |

The purchase fixture exists because there is currently **no `tests/usaa.test.js`
at all** — the purchase parser has zero coverage, and this change inserts a
router in front of it. Pinning that behavior before adding the router is the
point.

### 5. Tests (`tests/usaa.test.js`)

- plain-body path imports with all fields correct
- HTML-only path (empty plain part) imports, including the newline-split name
- missing `Date:` → `needs_review`
- lookalike sender (`...@mailcenter.usaa.com.example.net`) rejected
- the existing purchase format still imports through the new router

`tests/import-toggles.test.js` asserts the full enabled-sender key set with
`deepStrictEqual`; that expected set gains the new address.

### 6. Version and docs

- `parserVersion` `1.5.0` → `1.6.0` (new alert type is a minor bump)
- regenerate `gmail-transaction-alerts-Code.txt` in the same commit
- `README.md`: both USAA addresses; note that deposits go to Needs Review
- `AGENTS.md` and `CLAUDE.md` (byte-identical): parser coverage list, test table
- `LESSONS.md`: USAA sends from more than one subdomain; the fix is a second
  exact entry, not a looser match

## Not doing

- Deposit alerts (no sample)
- A separate Setup toggle for bank-account alerts vs card alerts
- Preserving the `To:` value anywhere
