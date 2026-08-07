/**
 * Venmo P2P payment / payment-received parser tests.
 *
 * Run:  node --test tests/venmo.test.js
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

const VENMO_SENDER = 'Venmo <venmo@venmo.com>';
const PAYMENT_HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'venmo-payment-alert.html'),
  'utf8'
);
const PAYMENT_SUBJECT = 'You paid Alex Sample $12.34';
const INCOME_HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'venmo-income-alert.html'),
  'utf8'
);
const INCOME_SUBJECT = 'Jordan Example paid you $41.00';

test('Venmo payment (you paid) is extracted from the alert body', () => {
  const result = parseAlert(VENMO_SENDER, PAYMENT_SUBJECT, PAYMENT_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, {
    transactionDate: '2026-06-05',
    institution: 'Venmo',
    cardType: 'payment',
    last4: '4321',
    cardholder: '',
    merchant: 'Alex Sample',
    amount: 12.34,
    eventType: 'venmo_payment'
  });
});

test('Venmo income (paid you) is extracted from the alert body', () => {
  const result = parseAlert(VENMO_SENDER, INCOME_SUBJECT, INCOME_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, {
    transactionDate: '2026-08-02',
    institution: 'Venmo',
    cardType: 'received',
    last4: '',
    cardholder: '',
    merchant: 'Jordan Example',
    amount: 41,
    eventType: 'venmo_payment_received'
  });
});

test('Venmo counterparty and amount fall back to the subject line', () => {
  // Body retains only Date, as if the hero card changed shape.
  const body = [
    '<html><body>',
    '<h3>Date</h3><p class="transaction-value">Jun 05, 2026</p>',
    '</body></html>'
  ].join('');
  const result = parseAlert(VENMO_SENDER, PAYMENT_SUBJECT, body, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.merchant, 'Alex Sample');
  assert.strictEqual(result.transaction.amount, 12.34);
  assert.strictEqual(result.transaction.eventType, 'venmo_payment');
  assert.strictEqual(result.transaction.last4, '');
  assert.strictEqual(result.transaction.cardholder, '');
});

test('Venmo income subject fallback recovers payer and amount', () => {
  const body = [
    '<html><body>',
    '<h3>Date</h3><p class="transaction-value">Aug 02, 2026</p>',
    '</body></html>'
  ].join('');
  const result = parseAlert(VENMO_SENDER, INCOME_SUBJECT, body, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.merchant, 'Jordan Example');
  assert.strictEqual(result.transaction.amount, 41);
  assert.strictEqual(result.transaction.eventType, 'venmo_payment_received');
  assert.strictEqual(result.transaction.cardType, 'received');
});

test('Venmo alert with no recoverable date goes to review', () => {
  const body = '<html><body><p class="title">You paid Alex Sample</p></body></html>';
  const result = parseAlert(VENMO_SENDER, PAYMENT_SUBJECT, body, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.institution, 'Venmo');
});

test('a Venmo-shaped alert from an untrusted sender is rejected', () => {
  const result = parseAlert('alerts@venmo.com.example.net', PAYMENT_SUBJECT, PAYMENT_HTML, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Untrusted sender');
});

test('unknown Venmo format from the trusted sender goes to review', () => {
  const result = parseAlert(
    VENMO_SENDER,
    'Your Venmo weekly summary',
    '<html><body><p>Here is your weekly activity.</p></body></html>',
    ''
  );
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.institution, 'Venmo');
});
