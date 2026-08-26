/**
 * Amex large-purchase alert parser tests.
 *
 * Run:  node --test tests/amex.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadParser() {
  const root = path.resolve(__dirname, '..');
  const modular = ['Config.gs', 'Text.gs', 'Parsers.gs']
    .map((f) => path.join(root, 'appsscript', f));

  const sources = modular.every((f) => fs.existsSync(f))
    ? modular
    : [path.join(root, 'gmail-transaction-alerts-Code.gs')];

  const src = sources.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const context = vm.createContext({});
  vm.runInContext(src, context, { filename: 'appsscript-under-test.js' });
  return context;
}

const { parseAlert } = loadParser();

const AMEX_SENDER = 'American Express <AmericanExpress@welcome.americanexpress.com>';
const FIXTURE_HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'amex-purchase-alert.html'),
  'utf8'
);
const FIXTURE_SUBJECT = 'Large Purchase Approved';

const EXPECTED = {
  transactionDate: '2026-03-07',
  institution: 'Amex',
  cardType: 'credit',
  last4: '54321',
  cardholder: 'Sample Cardholder',
  merchant: 'SAMPLE*GROCERY',
  amount: 12.34,
  eventType: 'purchase_authorization'
};

test('Amex large purchase is extracted from the alert body', () => {
  const result = parseAlert(AMEX_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, EXPECTED);
});

test('Amex uses the starred amount, not the alert-threshold dollar figure', () => {
  const result = parseAlert(AMEX_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.amount, 12.34);
});

test('Amex keeps a five-digit Account Ending as shown', () => {
  const result = parseAlert(AMEX_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.transaction.last4, '54321');
});

test('Amex date ignores the weekday prefix', () => {
  const result = parseAlert(AMEX_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.transaction.transactionDate, '2026-03-07');
});

test('Amex cardholder comes from the Dear greeting', () => {
  const result = parseAlert(AMEX_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.transaction.cardholder, 'Sample Cardholder');
});

test('Amex preserves spaced merchant letters', () => {
  const body = [
    '<html><body>',
    '<p>Account Ending: 54321</p>',
    '<p>There was a large purchase on your Card</p>',
    '<p>Dear Sample Cardholder,</p>',
    '<p>SAMPLE MART</p>',
    '<p>$9.00*</p>',
    '<p>Fri, Aug 1, 2026</p>',
    '</body></html>'
  ].join('');
  const result = parseAlert(AMEX_SENDER, FIXTURE_SUBJECT, body, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.merchant, 'SAMPLE MART');
  assert.strictEqual(result.transaction.amount, 9);
  assert.strictEqual(result.transaction.transactionDate, '2026-08-01');
});

test('Amex leaves last4 and cardholder blank when those lines are missing', () => {
  const body = [
    '<html><body>',
    '<p>There was a large purchase on your Card</p>',
    '<p>SAMPLE*GROCERY</p>',
    '<p>$12.34*</p>',
    '<p>Wed, Mar 7, 2026</p>',
    '</body></html>'
  ].join('');
  const result = parseAlert(AMEX_SENDER, FIXTURE_SUBJECT, body, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.last4, '');
  assert.strictEqual(result.transaction.cardholder, '');
  assert.strictEqual(result.transaction.merchant, 'SAMPLE*GROCERY');
});

test('Amex prefers HTML when plain body is empty', () => {
  const result = parseAlert(AMEX_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '\n\n  \n');
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.merchant, 'SAMPLE*GROCERY');
  assert.strictEqual(result.transaction.amount, 12.34);
});

test('Amex purchase with no recoverable merchant/amount/date goes to review', () => {
  const result = parseAlert(
    AMEX_SENDER,
    FIXTURE_SUBJECT,
    '<html><body><p>There was a large purchase on your Card</p></body></html>',
    ''
  );
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.institution, 'Amex');
});

test('a purchase-shaped alert from an untrusted Amex lookalike is rejected', () => {
  [
    'alerts@americanexpress.com',
    'AmericanExpress@welcome.americanexpress.com.example.net',
    'welcome.americanexpress.com',
    'amex@welcome.americanexpress.com'
  ].forEach((sender) => {
    const result = parseAlert(sender, FIXTURE_SUBJECT, FIXTURE_HTML, '');
    assert.strictEqual(result.outcome, 'needs_review');
    assert.strictEqual(result.reason, 'Untrusted sender');
  });
});

test('unknown Amex format from the trusted sender goes to review', () => {
  const result = parseAlert(
    AMEX_SENDER,
    'Your statement is ready',
    '<html><body><p>View your latest statement online.</p></body></html>',
    ''
  );
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.institution, 'Amex');
});
