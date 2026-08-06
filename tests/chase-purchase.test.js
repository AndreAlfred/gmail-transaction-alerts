/**
 * Chase merchant-purchase parser tests.
 *
 * These cases are meant to be merged into the repo's existing
 * `tests/parser.test.js` in whatever style that file already uses. They are
 * written standalone here (node:test + node:assert) because this machine only
 * has the concatenated bundle, not the modular `appsscript/` sources.
 *
 * Run:  node --test tests/
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the parser under test. Prefer the modular sources (authoritative for
// development); fall back to the concatenated bundle.
function loadParser() {
  const root = path.resolve(__dirname, '..');
  const modular = ['Config.gs', 'Text.gs', 'Parsers.gs']
    .map((f) => path.join(root, 'appsscript', f));

  const sources = modular.every((f) => fs.existsSync(f))
    ? modular
    : [path.join(root, 'gmail-transaction-alerts-Code.gs')];

  const src = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  // Apps Script files are plain scripts with no module system, so they are
  // evaluated in a throwaway context to collect their top-level declarations.
  // Only Config/Text/Parsers are exercised; the Workbook/Gmail/Trigger
  // functions in the bundle reference Apps Script globals but are never called.
  const context = vm.createContext({});
  vm.runInContext(src, context, { filename: 'appsscript-under-test.js' });
  return context;
}

const { parseAlert, parseMonthNameDate_ } = loadParser();

const CHASE_SENDER = 'Chase <no.reply.alerts@chase.com>';
const FIXTURE_HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'chase-purchase-alert.html'),
  'utf8'
);
const FIXTURE_SUBJECT = 'You made a $12.34 transaction with SAMPLE*COFFEE SHOP';
const DEBIT_FIXTURE_HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'chase-debit-purchase-alert.html'),
  'utf8'
);
const DEBIT_FIXTURE_SUBJECT =
  'Your debit card transaction of $45.67 from account ending in (\u20261234)';

test('Chase credit merchant purchase is extracted from the alert body', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  // Spread copies the value into this realm; objects built inside the vm
  // context carry that context's Object.prototype and would fail an identity
  // check on the prototype alone.
  assert.deepStrictEqual({ ...result.transaction }, {
    transactionDate: '2026-03-07',
    institution: 'Chase',
    cardType: 'sample card',
    last4: '4321',
    cardholder: '',
    merchant: 'SAMPLE*COFFEE SHOP',
    amount: 12.34,
    eventType: 'purchase_authorization'
  });
});

test('Chase credit Account row keeps the product name as cardType', () => {
  // Mirrors live credit alerts: label and value on consecutive lines after
  // htmlToText_, with a named product before (...last4).
  const body = [
    '<html><body>',
    '<tr><td>Account</td><td>Sample Freedom Unlimited Visa (...4321)</td></tr>',
    '<tr><td>Date</td><td>Aug 6, 2026 at 12:05 AM ET</td></tr>',
    '<tr><td>Merchant</td><td>SAMPLE*SOFTWARE INC</td></tr>',
    '<tr><td>Amount</td><td>$80.00</td></tr>',
    '</body></html>'
  ].join('');
  const subject = 'You made a $80.00 transaction with SAMPLE*SOFTWARE INC';
  const result = parseAlert(CHASE_SENDER, subject, body, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, {
    transactionDate: '2026-08-06',
    institution: 'Chase',
    cardType: 'sample freedom unlimited visa',
    last4: '4321',
    cardholder: '',
    merchant: 'SAMPLE*SOFTWARE INC',
    amount: 80,
    eventType: 'purchase_authorization'
  });
});

test('Chase debit purchase is extracted from debit field labels', () => {
  const result = parseAlert(CHASE_SENDER, DEBIT_FIXTURE_SUBJECT, DEBIT_FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, {
    transactionDate: '2026-08-05',
    institution: 'Chase',
    cardType: 'debit',
    last4: '1234',
    cardholder: '',
    merchant: 'SAMPLE*WATER UTILITY',
    amount: 45.67,
    eventType: 'purchase_authorization'
  });
});

test('Chase debit merchant and amount fall back to subject/headline', () => {
  // Body retains only Made on, as if the field table changed shape.
  const body = '<html><body><tr><td>Made on</td><td>Aug 5, 2026 at 7:18 AM ET</td></tr></body></html>';
  const result = parseAlert(CHASE_SENDER, DEBIT_FIXTURE_SUBJECT, body, '');
  // Subject has amount but not merchant; without the headline, merchant is missing.
  assert.strictEqual(result.outcome, 'needs_review');

  const withHeadline = [
    '<html><body>',
    '<tr><td>You made a debit card transaction of $45.67 with SAMPLE*WATER UTILITY</td></tr>',
    '<tr><td>Made on</td><td>Aug 5, 2026 at 7:18 AM ET</td></tr>',
    '</body></html>'
  ].join('');
  const fallback = parseAlert(CHASE_SENDER, DEBIT_FIXTURE_SUBJECT, withHeadline, '');
  assert.strictEqual(fallback.outcome, 'imported');
  assert.strictEqual(fallback.transaction.merchant, 'SAMPLE*WATER UTILITY');
  assert.strictEqual(fallback.transaction.amount, 45.67);
  assert.strictEqual(fallback.transaction.cardType, 'debit');
  assert.strictEqual(fallback.transaction.last4, '');
});

test('Chase merchant and amount fall back to the subject line', () => {
  // Body retains only the Date row, as if the field table changed shape.
  const body = '<html><body><tr><td>Date</td><td>Mar 7, 2026 at 9:14 AM ET</td></tr></body></html>';
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, body, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.merchant, 'SAMPLE*COFFEE SHOP');
  assert.strictEqual(result.transaction.amount, 12.34);
  // Absent fields are left empty, never fabricated.
  assert.strictEqual(result.transaction.last4, '');
  assert.strictEqual(result.transaction.cardholder, '');
});

test('Chase purchase with no recoverable date goes to review', () => {
  const body = '<html><body><tr><td>Merchant</td><td>SAMPLE*COFFEE SHOP</td></tr></body></html>';
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, body, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.institution, 'Chase');
});

test('Chase scheduled card payment is still ignored, not imported', () => {
  const result = parseAlert(
    CHASE_SENDER,
    'Payment scheduled',
    '',
    'Your credit card payment has been scheduled.'
  );
  assert.strictEqual(result.outcome, 'ignored');
  assert.strictEqual(result.eventType, 'card_payment_scheduled');
});

test('a purchase-shaped alert from an untrusted sender is rejected', () => {
  const result = parseAlert('alerts@chase.com.example.net', FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Untrusted sender');
});

test('month-name dates parse across abbreviations', () => {
  assert.strictEqual(parseMonthNameDate_('Aug 4, 2026'), '2026-08-04');
  assert.strictEqual(parseMonthNameDate_('September 12, 2026'), '2026-09-12');
  assert.strictEqual(parseMonthNameDate_('Sept. 3, 2026'), '2026-09-03');
  assert.strictEqual(parseMonthNameDate_('Foo 3, 2026'), null);
  assert.strictEqual(parseMonthNameDate_('3/7/2026'), null);
});

test('trusted sender matching is case-insensitive on both sides', () => {
  // A user editing the config is likely to paste the capitalized spelling used
  // in the docs. That must still match the lowercased incoming From header.
  const upper = 'USAA.Customer.Service@OMEM.USAA.COM';
  const usaaBody = [
    'Your credit card ...4321 was charged $7.56 at SAMPLE*COFFEE SHOP.',
    'Date: 3/7/2026',
    'Cardholder name: Sample Name'
  ].join('\n');
  const result = parseAlert(upper, 'Purchase', '', usaaBody);
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.institution, 'USAA');
});

test('case-insensitivity does not weaken the allowlist', () => {
  // Still an exact-address check: no substring or domain matching.
  ['usaa.customer.service@omem.usaa.com.example.net',
   'evil-usaa.customer.service@omem.usaa.com',
   'omem.usaa.com',
   'someone@usaa.com'].forEach((sender) => {
    assert.strictEqual(parseAlert(sender, 'Purchase', '', '').outcome, 'needs_review');
    assert.strictEqual(parseAlert(sender, 'Purchase', '', '').reason, 'Untrusted sender');
  });
});
