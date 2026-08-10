/**
 * Chase Zelle received-money parser tests.
 *
 * Run:  node --test tests/chase-zelle.test.js
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
const FIXTURE_SUBJECT = 'You received money with Zelle®';
const FIXTURE_HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'chase-zelle-received-alert.html'),
  'utf8'
);

const EXPECTED = {
  transactionDate: '2026-08-06',
  institution: 'Chase',
  cardType: 'zelle',
  last4: '',
  cardholder: '',
  merchant: 'SAMPLE SENDER',
  amount: 20,
  eventType: 'zelle_received'
};

test('Zelle received money is extracted from the HTML body', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, EXPECTED);
});

// "Sent on" is also the Chase outbound-transfer date label. A Zelle receipt
// must not be routed there, or an incoming payment would be recorded as money
// leaving the account.
test('Zelle received is not routed to the outbound-transfer parser', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.transaction.eventType, 'zelle_received');
  assert.notStrictEqual(result.transaction.eventType, 'transfer_out');
  assert.notStrictEqual(result.transaction.cardType, 'transfer');
});

test('Zelle sender name is taken from the headline, not the body copy', () => {
  // The name appears twice: the headline and the "is registered with a Zelle
  // member bank" sentence. Only the headline is a reliable field.
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.transaction.merchant, 'SAMPLE SENDER');
});

test('Zelle alert carries no last 4 and no cardholder', () => {
  // There is no account row anywhere in this alert, and Chase alerts never
  // carry a cardholder. Both are left blank rather than invented.
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.transaction.last4, '');
  assert.strictEqual(result.transaction.cardholder, '');
});

test('Zelle amount is positive, with direction carried by event type', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.transaction.amount, 20);
  assert.ok(result.transaction.amount > 0);
});

test('a Zelle alert with no recoverable date goes to review', () => {
  const body = '<html><body><tr><td>Amount</td><td>$20.00</td></tr>'
    + '<tr><td>SAMPLE SENDER sent you money</td></tr></body></html>';
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, body, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.institution, 'Chase');
});

test('a Zelle alert with no recoverable amount goes to review', () => {
  const withoutAmount = FIXTURE_HTML.replace('$20.00', '');
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, withoutAmount, '');
  assert.strictEqual(result.outcome, 'needs_review');
});

test('a Zelle-shaped alert from an untrusted sender is rejected', () => {
  const result = parseAlert('alerts@chase.com.example.net', FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Untrusted sender');
});

// Regression guard: the Zelle branch sits in front of the transfer branch in
// parseChase_, so both of the pre-existing Chase paths are pinned here.
test('Chase outbound transfers still parse with Zelle support present', () => {
  const transferHtml = fs.readFileSync(
    path.resolve(__dirname, '..', 'fixtures', 'chase-transfer-out-alert.html'),
    'utf8'
  );
  const result = parseAlert(
    CHASE_SENDER,
    'You sent $250.00 from account ending in (…5678)',
    transferHtml,
    ''
  );
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.eventType, 'transfer_out');
});

test('Chase purchases still parse with Zelle support present', () => {
  const purchaseHtml = fs.readFileSync(
    path.resolve(__dirname, '..', 'fixtures', 'chase-purchase-alert.html'),
    'utf8'
  );
  const result = parseAlert(
    CHASE_SENDER,
    'You made a $12.34 transaction with SAMPLE*COFFEE SHOP',
    purchaseHtml,
    ''
  );
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.eventType, 'purchase_authorization');
});
