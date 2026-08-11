# USAA Parser Cleanup Design

## Goal

Make the USAA parser’s internal structure match the alert types it actually
handles, remove the meaningful duplication between bank-account debit and
deposit parsing, and clean stale documentation without changing any
spreadsheet-visible behavior.

## Background

Two recent branches attempted to support the same USAA wording: `$X came out
of your account ending in NNNN.` The first correctly routed that bank-account
alert to `parseUsaaAccountDebit_`. The second described it as a debit-card
transaction and added another handler inside `parseUsaaPurchase_`. Because
`parseUsaa_` had already claimed the wording, the second handler was
unreachable and was subsequently removed.

USAA bank-account deposits are a distinct format. Repository history and a
fixture replay show that the current deposit fixture went to Needs Review in
releases before commit `c21e2a8`; that commit introduced the first parser in
this repository that imports it. A previously observed successful deposit
therefore does not establish that this codebase already supported the current
deposit format.

The current parser behavior is covered by 76 passing tests before this cleanup.

## Compatibility Boundary

This is a behavior-preserving refactor. The following values and outcomes must
remain unchanged:

- transaction field names and sheet headers
- `cardType`, including `bank debit` for a USAA bank-account debit and
  `deposit` for a USAA bank-account deposit
- `eventType`, including `account_debit` and `deposit`
- the fixed merchants `USAA Bank Debit` and `USAA Deposit`
- positive amount values, parsed dates, last-four values, and cardholder values
- all current Imported, Ignored, and Needs Review outcomes
- all existing reason strings
- Gmail labels, deduplication, sheet append behavior, and user-added columns

No spreadsheet migration is required.

## Parser Structure

`parseAlert` continues to enforce the exact sender allowlist and select USAA.
`parseUsaa_` remains the only router for USAA bodies and uses explicit wording
to select one of three semantically named functions:

```text
came out of your account ending in -> parseUsaaAccountDebit_
received a deposit of              -> parseUsaaAccountDeposit_
otherwise                          -> parseUsaaCardPurchase_
```

The fallback remains deliberate: unrecognized USAA messages reach the card
purchase parser and receive its existing unsupported/incomplete Needs Review
result. The router will not use a broad combined regular expression and will
not inspect or trust a less-specific sender.

`parseUsaaAccountDebit_` and `parseUsaaAccountDeposit_` each retain only:

- the activity-specific regular expression that extracts amount and last four
- fixed metadata for card type, merchant, and event type
- the alert-specific incomplete-format reason

Both call a private `parseUsaaAccountActivity_` helper. That helper owns only
the mechanics the two bank-account formats already share:

- extracting the `Date` field
- parsing and validating the date and amount
- reading the security-zone cardholder on a best-effort basis
- constructing the imported transaction with the supplied fixed metadata
- returning the supplied incomplete-format reason or the existing shared
  invalid-date-or-amount reason

The helper is USAA-specific. It will not be generalized across institutions;
Chase deposits have not been designed yet and should not inherit an abstraction
based only on USAA’s current format.

`parseUsaaPurchase_` becomes `parseUsaaCardPurchase_`. Its parsing logic stays
separate and unchanged because card purchases require a merchant and
cardholder, and derive card type from the message rather than fixed metadata.

## Error Handling

The refactor preserves the existing failure boundaries:

- an incomplete bank-account debit that retains its routing phrase returns
  `Unsupported or incomplete USAA account alert`
- an incomplete deposit that retains its routing phrase returns `Unsupported
  or incomplete USAA deposit alert`
- content that no longer contains a recognized account-alert routing phrase
  falls through to the card parser and returns `Unsupported or incomplete USAA
  alert`; notably, the existing missing-deposit-amount fixture mutation removes
  `received a deposit of` and takes this path
- an invalid account-activity date or amount returns `Invalid USAA date or
  amount`
- an incomplete or invalid card purchase retains its current reason
- a missing security-zone name leaves Cardholder blank without rejecting an
  otherwise complete bank-account alert
- unknown trusted USAA mail still goes to Needs Review

No parser will invent a merchant, account number, or cardholder. The existing
fixed merchant labels remain product conventions rather than extracted values.

## Tests

Implementation will keep observable behavior green throughout the refactor in
`tests/usaa.test.js`:

1. Add characterization coverage for shared account-alert behavior, including
   the deliberate non-requirement of the debit `To` row and deposit `From` row,
   and the best-effort blank cardholder behavior. Confirm those tests pass
   against the current implementation before restructuring it.
2. Rename the parsers and introduce the narrow helper while keeping all
   existing and new fixture assertions green.
3. Run `node --test tests/usaa.test.js` after each refactoring step.
4. Run `node --test tests/*.test.js` before completion.

The suite will not assert private function names or grep source text. Such a
test would reject an intentional redesign without proving any parsing behavior.
Semantic naming and removal of the old ambiguous name will instead be checked
in the implementation diff, while tests protect routing and returned values.

The existing synthetic plain-text and HTML fixtures remain authoritative. No
real email body, merchant/amount pair, account digits, message ID, or personal
name will be introduced.

## Documentation and Versioning

The cleanup will:

- correct the stale header comment in `tests/usaa.test.js` so it names deposits
- remove the obsolete README statement that the `.gs` file must match a deleted
  `.txt` copy
- clarify current documentation where needed that a bank-account debit is not
  a debit-card purchase
- leave historical design documents intact rather than rewriting history
- keep `AGENTS.md` and `CLAUDE.md` byte-identical if either requires an update

Because `gmail-transaction-alerts-Code.gs` changes without changing external
behavior, `APP_CONFIG.parserVersion` receives a patch bump from `1.8.0` to
`1.8.1`.

## Non-goals

- Chase deposit parsing
- new USAA alert formats or broader regular expressions
- changes to transaction values, sheet schemas, Gmail queries, or labels
- a cross-bank account-activity framework
- changes to trusted senders
