# USAA Parser Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clarify and deduplicate USAA debit, deposit, and card-purchase parsing without changing any parser output or spreadsheet-visible behavior.

**Architecture:** Keep `parseUsaa_` as the single explicit router. Rename its card-purchase and account-deposit destinations semantically, and have the two bank-account parsers delegate their shared date/amount validation and result construction to one USAA-only helper. Preserve the card-purchase parser as a separate format.

**Tech Stack:** Google Apps Script JavaScript (V8), Node.js built-in test runner, `node:vm` parser harness, Markdown documentation.

## Global Constraints

- Preserve every current transaction field, Imported/Needs Review outcome, and reason string exactly.
- Preserve `bank debit` / `account_debit` / `USAA Bank Debit` for account debits and `deposit` / `deposit` / `USAA Deposit` for deposits.
- Keep amounts positive and preserve current date, last-four, and best-effort cardholder behavior.
- Do not change sheet headers, Gmail labels, sender allowlists, append logic, fixtures, or Gmail search behavior.
- Keep the product as one pasteable file: `gmail-transaction-alerts-Code.gs`; do not create source modules or a build step.
- Keep the helper USAA-specific; do not design Chase deposit parsing or a cross-bank abstraction.
- Do not add real email content, merchant/amount pairs, account digits, message IDs, or personal names.
- Set `APP_CONFIG.parserVersion` to `1.8.1` because the `.gs` file changes while external behavior remains stable.
- Run the full suite with `node --test tests/*.test.js` before completion.
- Do not rewrite historical design documents.

---

### Task 1: Strengthen the USAA behavior safety net

**Files:**
- Modify: `tests/usaa.test.js:1-179`

**Interfaces:**
- Consumes: `parseAlert(sender, subject, htmlBody, plainBody)` from the Apps Script bundle and the existing synthetic USAA fixtures.
- Produces: Sixteen USAA tests that pin routing, fixed output values, unused-row tolerance, blank-cardholder behavior, and exact account-alert failure reasons.

- [ ] **Step 1: Correct the suite description**

Change the opening line to include all supported USAA formats:

```js
/**
 * USAA parser tests: bank-account debit and deposit alerts, plus card-purchase
 * authorizations.
```

- [ ] **Step 2: Pin the existing account-alert reason strings**

Extend the existing missing-field tests with literal reason assertions:

```js
test('a deposit missing its Date field goes to review', () => {
  const withoutDate = DEPOSIT_PLAIN.replace(/Date:\n\t08\/10\/26\n/, '');
  assert.ok(!/08\/10\/26/.test(withoutDate), 'fixture edit must remove the date');
  const result = parseAlert(BANK_SENDER, DEPOSIT_SUBJECT, '', withoutDate);
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Unsupported or incomplete USAA deposit alert');
});

test('a deposit missing its amount goes to review', () => {
  const withoutAmount = DEPOSIT_PLAIN.replace(
    'You received a deposit of $42.10 to your account …3344.',
    'You received a deposit to your account …3344.'
  );
  const result = parseAlert(BANK_SENDER, DEPOSIT_SUBJECT, '', withoutAmount);
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Unsupported or incomplete USAA deposit alert');
});

test('an account debit missing its Date field goes to review', () => {
  const withoutDate = DEBIT_PLAIN.replace(/Date:\n\t08\/04\/26\n/, '');
  assert.ok(!/08\/04\/26/.test(withoutDate), 'fixture edit must remove the date');
  const result = parseAlert(BANK_SENDER, DEBIT_SUBJECT, '', withoutDate);
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Unsupported or incomplete USAA account alert');
});

test('an account debit missing its amount goes to review', () => {
  const withoutAmount = DEBIT_PLAIN.replace(
    '$88.45 came out of your account ending in 7788.',
    'An amount came out of your account ending in 7788.'
  );
  const result = parseAlert(BANK_SENDER, DEBIT_SUBJECT, '', withoutAmount);
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Unsupported or incomplete USAA account alert');
});
```

- [ ] **Step 3: Add behavior characterizations for the shared helper boundary**

Place these tests near the other debit/deposit success cases. Each assertion is
on `parseAlert` output, not on private function names or source text:

```js
test('account debit does not require the unused To row', () => {
  const withoutTo = DEBIT_PLAIN.replace(/To:\n\tUSAA DEBIT\n/, '');
  assert.ok(!/USAA DEBIT/.test(withoutTo), 'fixture edit must remove the To row');
  const result = parseAlert(BANK_SENDER, DEBIT_SUBJECT, '', withoutTo);
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, EXPECTED_DEBIT);
});

test('deposit does not require the unused From row', () => {
  const withoutFrom = DEPOSIT_PLAIN.replace(/From:\n\tUSAA CREDIT\n/, '');
  assert.ok(!/USAA CREDIT/.test(withoutFrom), 'fixture edit must remove the From row');
  const result = parseAlert(BANK_SENDER, DEPOSIT_SUBJECT, '', withoutFrom);
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, EXPECTED_DEPOSIT);
});

test('an account alert without a security-zone name imports a blank cardholder', () => {
  const withoutSecurityZone = DEBIT_PLAIN.replace(
    /USAA SECURITY ZONE\s+Jordan\s+Sample\s+USAA # ending in: 4321\s*/,
    ''
  );
  assert.ok(!/USAA SECURITY ZONE/.test(withoutSecurityZone),
    'fixture edit must remove the security-zone header');
  const result = parseAlert(BANK_SENDER, DEBIT_SUBJECT, '', withoutSecurityZone);
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, {
    ...EXPECTED_DEBIT,
    cardholder: ''
  });
});
```

- [ ] **Step 4: Run the characterization suite before changing production code**

Run:

```bash
node --test tests/usaa.test.js
```

Expected: PASS, 16 tests. These characterize approved existing behavior, so a
pre-refactor pass is required; a failure means the fixture edit or expectation
is wrong and must be corrected before production code changes.

- [ ] **Step 5: Commit the safety net**

```bash
git add tests/usaa.test.js
git commit -m "test: characterize USAA account alert behavior"
```

---

### Task 2: Rename and deduplicate the USAA parsers

**Files:**
- Modify: `gmail-transaction-alerts-Code.gs:40-241`
- Test: `tests/usaa.test.js`

**Interfaces:**
- Consumes: normalized USAA body text from `parseAlert` and the existing `parseUsDate_`, `parseAmount_`, and `usaaSecurityZoneName_` helpers.
- Produces: `parseUsaaCardPurchase_(text)`, `parseUsaaAccountDebit_(text)`, `parseUsaaAccountDeposit_(text)`, and private `parseUsaaAccountActivity_(text, activityPattern, details)` with unchanged `parseAlert` results.

- [ ] **Step 1: Apply the patch version bump**

Change the config line to:

```js
parserVersion: '1.8.1',
```

- [ ] **Step 2: Make the USAA router’s destinations semantic**

Replace the router with:

```js
function parseUsaa_(text) {
  if (/came out of your account ending in/i.test(text)) return parseUsaaAccountDebit_(text);
  if (/received a deposit of/i.test(text)) return parseUsaaAccountDeposit_(text);
  return parseUsaaCardPurchase_(text);
}
```

- [ ] **Step 3: Add the narrow account-activity helper**

Place this after `usaaSecurityZoneName_`:

```js
function parseUsaaAccountActivity_(text, activityPattern, details) {
  var activity = text.match(activityPattern);
  var date = text.match(/Date\s*:\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (!activity || !date) {
    return { outcome: 'needs_review', institution: 'USAA', reason: details.incompleteReason };
  }
  var parsedDate = parseUsDate_(date[1]);
  var amount = parseAmount_(activity[1]);
  if (!parsedDate || !Number.isFinite(amount)) {
    return { outcome: 'needs_review', institution: 'USAA', reason: 'Invalid USAA date or amount' };
  }
  return { outcome: 'imported', transaction: {
    transactionDate: parsedDate, institution: 'USAA', cardType: details.cardType,
    last4: activity[2], cardholder: usaaSecurityZoneName_(text), merchant: details.merchant,
    amount: amount, eventType: details.eventType
  }};
}
```

The match contract is intentionally small: capture group 1 is the amount and
capture group 2 is the account’s last four. Do not add sender, subject, sheet,
or institution-generic responsibilities.

- [ ] **Step 4: Reduce each account parser to its format and metadata**

Replace the debit implementation with:

```js
function parseUsaaAccountDebit_(text) {
  return parseUsaaAccountActivity_(
    text,
    /(\$[\d,]+(?:\.\d{2})?)\s+came out of your account ending in\s+(\d{4})/i,
    {
      cardType: 'bank debit',
      merchant: 'USAA Bank Debit',
      eventType: 'account_debit',
      incompleteReason: 'Unsupported or incomplete USAA account alert'
    }
  );
}
```

Rename and replace the deposit implementation with:

```js
function parseUsaaAccountDeposit_(text) {
  return parseUsaaAccountActivity_(
    text,
    /received a deposit of\s+(\$[\d,]+(?:\.\d{2})?)\s+to your account\s+(?:…|\.{3})\s*(\d{4})/i,
    {
      cardType: 'deposit',
      merchant: 'USAA Deposit',
      eventType: 'deposit',
      incompleteReason: 'Unsupported or incomplete USAA deposit alert'
    }
  );
}
```

Retain the existing format comments, shortening only wording made redundant by
the helper. Keep the explicit explanation that a bank-account debit is not a
debit-card purchase.

- [ ] **Step 5: Rename the distinct card parser**

Change only the function declaration:

```js
function parseUsaaCardPurchase_(text) {
```

Do not alter its regular expressions, validation, return values, or reason
strings.

- [ ] **Step 6: Verify USAA behavior after the refactor**

Run:

```bash
node --test tests/usaa.test.js
```

Expected: PASS, 16 tests.

- [ ] **Step 7: Review the semantic boundary and removed ambiguity**

Run:

```bash
rg -n "parseUsaa(Purchase|Deposit)_" gmail-transaction-alerts-Code.gs tests/usaa.test.js
rg -n "parseUsaa(CardPurchase|AccountDebit|AccountDeposit|AccountActivity)_" gmail-transaction-alerts-Code.gs
```

Expected: the first command prints nothing. The second shows the router plus
the four intended function declarations/calls. This is a review aid, not a
behavioral test.

- [ ] **Step 8: Run the full suite**

Run:

```bash
node --test tests/*.test.js
```

Expected: PASS, 79 tests, with zero failures, skips, or warnings.

- [ ] **Step 9: Commit the parser refactor**

```bash
git add gmail-transaction-alerts-Code.gs
git commit -m "refactor: clarify USAA account activity parsing"
```

The characterization test file was committed in Task 1 and should be clean at
this point.

---

### Task 3: Remove stale current documentation

**Files:**
- Modify: `README.md:53-60`

**Interfaces:**
- Consumes: the repository’s single-file delivery and `APP_CONFIG.parserVersion` release contract.
- Produces: release instructions that refer only to the existing `.gs` bundle.

- [ ] **Step 1: Remove the deleted-copy requirement**

Replace the release paragraph with:

```markdown
The release version is `APP_CONFIG.parserVersion` in `gmail-transaction-alerts-Code.gs`. Tags and GitHub Releases use `{parserVersion}` with no `v` prefix (e.g. `1.1.0`).
```

Do not edit the historical account-debit design. Current README caveats and
`AGENTS.md` already distinguish USAA bank-account debits from Chase debit-card
purchases, so no duplicate prose is needed.

- [ ] **Step 2: Check current guidance for stale bundle references**

Run:

```bash
rg -n "must match the \.txt|gmail-transaction-alerts-Code\.txt" README.md AGENTS.md CLAUDE.md
```

Expected: no output.

- [ ] **Step 3: Commit the documentation cleanup**

```bash
git add README.md
git commit -m "docs: remove stale bundle copy guidance"
```

---

### Task 4: Final verification and handoff

**Files:**
- Verify: `gmail-transaction-alerts-Code.gs`
- Verify: `tests/usaa.test.js`
- Verify: `README.md`
- Verify: `AGENTS.md`
- Verify: `CLAUDE.md`

**Interfaces:**
- Consumes: the completed cleanup commits.
- Produces: fresh evidence that behavior, versioning, duplicated instructions, and worktree state satisfy the repository contract.

- [ ] **Step 1: Run the complete automated suite from the repository root**

```bash
node --test tests/*.test.js
```

Expected: PASS, 79 tests, zero failures.

- [ ] **Step 2: Verify the version moves forward from current main**

```bash
node .github/scripts/compare-parser-versions.js 1.8.1 1.8.0
```

Expected: exit 0 with `Version bumped: 1.8.0 -> 1.8.1`.

- [ ] **Step 3: Verify repository invariants and diff hygiene**

```bash
diff AGENTS.md CLAUDE.md
git diff origin/main...HEAD --check
git status --short --branch
git diff --stat origin/main...HEAD
```

Expected:

- `diff AGENTS.md CLAUDE.md` prints nothing.
- `git diff ... --check` prints nothing.
- status reports `refactor/usaa-parser-cleanup` with a clean worktree.
- the diff contains only the design/plan documents, USAA tests/parser, version bump, and README cleanup.

- [ ] **Step 4: Review the final diff against the compatibility boundary**

```bash
git diff origin/main...HEAD -- gmail-transaction-alerts-Code.gs tests/usaa.test.js README.md
```

Confirm manually that:

- every existing literal transaction value and reason string is preserved
- the account patterns are unchanged
- only the common date/amount/result mechanics moved into the helper
- no trusted sender, sheet path, Gmail label, or fixture changed
- `parseUsaaCardPurchase_` retains the original card-purchase body

- [ ] **Step 5: Prepare the handoff**

Report the test counts, version bump, commits, files changed, and the deliberate
absence of live Gmail/Sheets verification. Do not push or create a PR unless the
user explicitly asks for those external actions.
