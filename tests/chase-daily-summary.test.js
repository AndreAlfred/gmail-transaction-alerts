/**
 * Chase daily account-summary parser tests.
 *
 * These alerts carry End of Day Balance / Total Withdrawals / Total Deposits
 * rather than a merchant purchase. The parser returns account_balance so the
 * intake path can upsert the Accounts sheet — never Transactions.
 *
 * Run:  node --test tests/chase-daily-summary.test.js
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
  path.resolve(__dirname, '..', 'fixtures', 'chase-daily-summary-alert.html'),
  'utf8'
);
const FIXTURE_SUBJECT = 'Your daily summary for account ending in (...4321)';

test('Chase daily account summary yields account_balance for Accounts upsert', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'account_balance');
  assert.deepStrictEqual({ ...result.account }, {
    institution: 'Chase',
    last4: '4321',
    balance: 1234.56,
    balanceAsOf: '2026-08-10',
    eventType: 'account_daily_summary'
  });
});

test('Chase daily summary with subject only (no body fields) goes to review', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, '<html><body></body></html>', '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.institution, 'Chase');
  assert.match(result.reason, /incomplete/i);
});

test('Chase daily summary body markers parse without the subject wording', () => {
  const result = parseAlert(CHASE_SENDER, 'Account alert', FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'account_balance');
  assert.strictEqual(result.account.last4, '4321');
  assert.strictEqual(result.account.balance, 1234.56);
  assert.strictEqual(result.account.balanceAsOf, '2026-08-10');
});

test('Chase daily summary missing End of Day Balance goes to review', () => {
  const withoutBalance = FIXTURE_HTML.replace(/End of Day Balance[\s\S]*?\$1,234\.56/, 'Total Withdrawals');
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, withoutBalance, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.match(result.reason, /incomplete/i);
});

test('a daily-summary-shaped alert from an untrusted sender is rejected', () => {
  const result = parseAlert('alerts@chase.com.example.net', FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Untrusted sender');
});

// Regression: the daily-summary branch sits ahead of purchase/transfer parsing
// and must not swallow real transaction alerts that merely mention "summary".
test('Chase purchases still parse with daily-summary support present', () => {
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
