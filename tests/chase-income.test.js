/**
 * Chase deposit (income) alert parser tests.
 *
 * Run:  node --test tests/chase-income.test.js
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
const FIXTURE_SUBJECT = 'Your $2,450.00 direct deposit posted to account ending in (...4321)';
const FIXTURE_HTML = fs.readFileSync(
  path.resolve(__dirname, '..', 'fixtures', 'chase-direct-deposit-alert.html'),
  'utf8'
);

const EXPECTED = {
  transactionDate: '2026-08-21',
  institution: 'Chase',
  cardType: 'deposit',
  last4: '4321',
  cardholder: '',
  merchant: 'direct deposit',
  amount: 2450,
  eventType: 'deposit'
};

test('a Chase direct deposit is extracted from the HTML body', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, EXPECTED);
});

// Income is money arriving. Amount stays positive and direction is carried by
// Event Type, matching USAA deposits, Chase transfers, and Venmo receipts.
test('deposit amount is positive and direction lives in the event type', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.ok(result.transaction.amount > 0);
  assert.strictEqual(result.transaction.eventType, 'deposit');
});

// The purchase parser is the fallthrough for every unrecognized Chase alert.
// A deposit routed there would be logged as money spent at a merchant.
test('a deposit is not routed to the purchase parser', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.notStrictEqual(result.transaction.eventType, 'purchase_authorization');
  assert.notStrictEqual(result.transaction.eventType, 'transfer_out');
});

// "Posted" values carry a time and timezone the anchored date parser rejects.
test('the trailing time and timezone on the Posted row are ignored', () => {
  assert.ok(/Aug 21, 2026 at 4:02 AM ET/.test(FIXTURE_HTML),
    'fixture must keep the trailing time, or this test proves nothing');
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.transaction.transactionDate, '2026-08-21');
});

// This alert names no payer, so Merchant is the deposit type read from the
// headline -- not a hardcoded string. A different deposit type must show
// through rather than being flattened to "direct deposit".
test('the deposit type is read from the headline, not hardcoded', () => {
  const html = FIXTURE_HTML.replace(
    'You have a direct deposit of $2,450.00',
    'You have a mobile deposit of $2,450.00'
  );
  const subject = 'Your $2,450.00 mobile deposit posted to account ending in (...4321)';
  const result = parseAlert(CHASE_SENDER, subject, html, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.merchant, 'mobile deposit');
});

// Last 4 comes from the body's account row; the subject is the fallback for a
// body layout change, exactly as the transfer parser treats it.
test('last 4 falls back to the subject when the account row is missing', () => {
  const html = FIXTURE_HTML.replace(/Account ending in/g, 'Account');
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, html, '');
  assert.strictEqual(result.transaction.last4, '4321');
});

// Do not fabricate: an alert missing its amount goes to review rather than
// importing a row with a zero or guessed value.
test('a deposit alert with no readable amount goes to review', () => {
  const html = FIXTURE_HTML
    .replace('You have a direct deposit of $2,450.00', 'You have a direct deposit')
    .replace(/\$2,450\.00/g, 'pending');
  const result = parseAlert(CHASE_SENDER, 'Your direct deposit posted to account ending in (...4321)', html, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.institution, 'Chase');
});

// The allowlist is enforced regardless of how convincing the body looks.
test('a deposit alert from an untrusted sender is rejected', () => {
  const result = parseAlert('Chase <alerts@chase-secure.example>', FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.notStrictEqual(result.outcome, 'imported');
});
