/**
 * Chase outbound-transfer parser tests.
 *
 * Run:  node --test tests/chase-transfer.test.js
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

const CHASE_SENDER = 'Chase <no.reply.alerts@chase.com>';
const FIXTURE_HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'chase-transfer-out-alert.html'),
  'utf8'
);
const FIXTURE_SUBJECT = 'You sent $250.00 from account ending in (\u20265678)';

test('Chase transfer out is extracted from the alert body', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, {
    transactionDate: '2026-08-06',
    institution: 'Chase',
    cardType: 'transfer',
    last4: '5678',
    cardholder: '',
    merchant: 'SAMPLE CREDIT UNION',
    amount: 250,
    eventType: 'transfer_out'
  });
});

test('Chase transfer recipient and amount fall back to subject/headline', () => {
  // Body retains only Sent on, as if the field table changed shape.
  const body = '<html><body><tr><td>Sent on</td><td>Aug 6, 2026 at 4:01 AM ET</td></tr></body></html>';
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, body, '');
  // Subject has amount but not recipient; without the headline, recipient is missing.
  assert.strictEqual(result.outcome, 'needs_review');

  const withHeadline = [
    '<html><body>',
    '<tr><td>You sent $250.00 to SAMPLE CREDIT UNION</td></tr>',
    '<tr><td>Sent on</td><td>Aug 6, 2026 at 4:01 AM ET</td></tr>',
    '</body></html>'
  ].join('');
  const fallback = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, withHeadline, '');
  assert.strictEqual(fallback.outcome, 'imported');
  assert.strictEqual(fallback.transaction.merchant, 'SAMPLE CREDIT UNION');
  assert.strictEqual(fallback.transaction.amount, 250);
  assert.strictEqual(fallback.transaction.cardType, 'transfer');
  assert.strictEqual(fallback.transaction.eventType, 'transfer_out');
  assert.strictEqual(fallback.transaction.last4, '5678');
});

test('Chase transfer with no recoverable date goes to review', () => {
  const body = '<html><body><tr><td>Recipient</td><td>SAMPLE CREDIT UNION</td></tr></body></html>';
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, body, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.institution, 'Chase');
});

test('a transfer-shaped alert from an untrusted sender is rejected', () => {
  const result = parseAlert('alerts@chase.com.example.net', FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Untrusted sender');
});

test('Chase scheduled card payment is still ignored when transfer support exists', () => {
  const result = parseAlert(
    CHASE_SENDER,
    'Payment scheduled',
    '',
    'Your credit card payment has been scheduled.'
  );
  assert.strictEqual(result.outcome, 'ignored');
  assert.strictEqual(result.eventType, 'card_payment_scheduled');
});
