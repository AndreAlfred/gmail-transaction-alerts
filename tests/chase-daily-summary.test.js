/**
 * Chase daily account-summary parser tests.
 *
 * These alerts carry End of Day Balance / Total Withdrawals / Total Deposits
 * rather than a merchant purchase, so they are recognized and ignored — the
 * same disposition as scheduled card payments — instead of landing in Needs
 * Review.
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

test('Chase daily account summary is ignored, not imported or reviewed', () => {
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'ignored');
  assert.strictEqual(result.institution, 'Chase');
  assert.strictEqual(result.eventType, 'account_daily_summary');
  assert.ok(/daily|summary/i.test(result.reason));
});

test('Chase daily summary is recognized from subject alone', () => {
  // Body layout may change; the subject wording is stable enough to ignore.
  const result = parseAlert(CHASE_SENDER, FIXTURE_SUBJECT, '<html><body></body></html>', '');
  assert.strictEqual(result.outcome, 'ignored');
  assert.strictEqual(result.eventType, 'account_daily_summary');
});

test('Chase daily summary body markers ignore without the subject wording', () => {
  // Badge + End of Day Balance is distinctive even if the subject changes.
  const result = parseAlert(
    CHASE_SENDER,
    'Account alert',
    FIXTURE_HTML,
    ''
  );
  assert.strictEqual(result.outcome, 'ignored');
  assert.strictEqual(result.eventType, 'account_daily_summary');
});

test('a daily-summary-shaped alert from an untrusted sender is rejected', () => {
  const result = parseAlert('alerts@chase.com.example.net', FIXTURE_SUBJECT, FIXTURE_HTML, '');
  assert.strictEqual(result.outcome, 'needs_review');
  assert.strictEqual(result.reason, 'Untrusted sender');
});

// Regression: the ignore branch sits ahead of purchase/transfer parsing and
// must not swallow real transaction alerts that merely mention "summary".
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
