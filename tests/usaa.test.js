/**
 * USAA parser tests: bank-account debit alerts and purchase authorizations.
 *
 * Fixtures are synthetic. `usaa-account-debit-alert.txt` is the decoded
 * text/plain part of a real "Debit Alert for Your USAA Bank Account" message
 * and `usaa-account-debit-alert.html` is the text/html part of the same
 * message, with every value replaced. The .txt fixtures carry no header
 * comment on purpose: unlike HTML there is no syntax the parser ignores, so a
 * comment would become part of the body under test.
 *
 * Run:  node --test tests/usaa.test.js
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

const fixture = (name) =>
  fs.readFileSync(path.resolve(__dirname, '..', 'fixtures', name), 'utf8');

const BANK_SENDER = 'USAA <USAA.Customer.Service@mailcenter.usaa.com>';
const CARD_SENDER = 'USAA <USAA.customer.service@mailcenter.usaa.com>';

const DEBIT_SUBJECT = 'Debit Alert for Your USAA Bank Account';
const DEBIT_PLAIN = fixture('usaa-account-debit-alert.txt');
const DEBIT_HTML = fixture('usaa-account-debit-alert.html');
const PURCHASE_PLAIN = fixture('usaa-purchase-alert.txt');

const DEPOSIT_SUBJECT = 'Deposit to Your Bank Account';
const DEPOSIT_PLAIN = fixture('usaa-deposit-alert.txt');
const DEPOSIT_HTML = fixture('usaa-deposit-alert.html');

const EXPECTED_DEPOSIT = {
  transactionDate: '2026-08-10',
  institution: 'USAA',
  cardType: 'deposit',
  last4: '3344',
  cardholder: 'Casey Rivers',
  merchant: 'USAA Deposit',
  amount: 42.10,
  eventType: 'deposit'
};

const EXPECTED_DEBIT = {
  transactionDate: '2026-08-04',
  institution: 'USAA',
  cardType: 'bank debit',
  last4: '7788',
  cardholder: 'Jordan Sample',
  merchant: 'USAA Bank Debit',
  amount: 88.45,
  eventType: 'account_debit'
};

test('account debit is extracted from the plain-text body', () => {
  const result = parseAlert(BANK_SENDER, DEBIT_SUBJECT, '', DEBIT_PLAIN);
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, EXPECTED_DEBIT);
});

test('account debit is extracted from HTML when the plain part is empty', () => {
  // The HTML splits the holder's first and last name across <br />, so the
  // name arrives on two separate lines after htmlToText_.
  const result = parseAlert(BANK_SENDER, DEBIT_SUBJECT, DEBIT_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, EXPECTED_DEBIT);
});

test('deposit is extracted from the plain-text body', () => {
  const result = parseAlert(BANK_SENDER, DEPOSIT_SUBJECT, '', DEPOSIT_PLAIN);
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, EXPECTED_DEPOSIT);
});

test('deposit is extracted from HTML when the plain part is empty', () => {
  // The HTML splits the holder's first and last name across <br />, same as
  // the debit alert, and masks the account number with the &#x2026; entity
  // rather than the literal "..." the debit alert body uses.
  const result = parseAlert(BANK_SENDER, DEPOSIT_SUBJECT, DEPOSIT_HTML, '');
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, EXPECTED_DEPOSIT);
});

test('a deposit missing its Date field goes to review', () => {
  const withoutDate = DEPOSIT_PLAIN.replace(/Date:\n\t08\/10\/26\n/, '');
  assert.ok(!/08\/10\/26/.test(withoutDate), 'fixture edit must remove the date');
  const result = parseAlert(BANK_SENDER, DEPOSIT_SUBJECT, '', withoutDate);
  assert.strictEqual(result.outcome, 'needs_review');
});

test('a deposit missing its amount goes to review', () => {
  const withoutAmount = DEPOSIT_PLAIN.replace(
    'You received a deposit of $42.10 to your account …3344.',
    'You received a deposit to your account …3344.'
  );
  const result = parseAlert(BANK_SENDER, DEPOSIT_SUBJECT, '', withoutAmount);
  assert.strictEqual(result.outcome, 'needs_review');
});

test('a deposit does not get misrouted to the account-debit parser', () => {
  const result = parseAlert(BANK_SENDER, DEPOSIT_SUBJECT, '', DEPOSIT_PLAIN);
  assert.strictEqual(result.outcome, 'imported');
  assert.strictEqual(result.transaction.eventType, 'deposit');
  assert.notStrictEqual(result.transaction.merchant, 'USAA Bank Debit');
});

test('mailcenter.usaa.com is a trusted USAA sender', () => {
  const result = parseAlert(BANK_SENDER, DEBIT_SUBJECT, '', DEBIT_PLAIN);
  assert.notStrictEqual(result.reason, 'Untrusted sender');
  assert.strictEqual(result.transaction.institution, 'USAA');
});

test('an account debit missing its Date field goes to review', () => {
  const withoutDate = DEBIT_PLAIN.replace(/Date:\n\t08\/04\/26\n/, '');
  assert.ok(!/08\/04\/26/.test(withoutDate), 'fixture edit must remove the date');
  const result = parseAlert(BANK_SENDER, DEBIT_SUBJECT, '', withoutDate);
  assert.strictEqual(result.outcome, 'needs_review');
});

test('an account debit missing its amount goes to review', () => {
  const withoutAmount = DEBIT_PLAIN.replace(
    '$88.45 came out of your account ending in 7788.',
    'An amount came out of your account ending in 7788.'
  );
  const result = parseAlert(BANK_SENDER, DEBIT_SUBJECT, '', withoutAmount);
  assert.strictEqual(result.outcome, 'needs_review');
});

test('a lookalike of the bank sender is rejected', () => {
  const lookalikes = [
    'usaa.customer.service@mailcenter.usaa.com.example.net',
    'evil-usaa.customer.service@mailcenter.usaa.com',
    'mailcenter.usaa.com'
  ];
  lookalikes.forEach((sender) => {
    const result = parseAlert(sender, DEBIT_SUBJECT, '', DEBIT_PLAIN);
    assert.strictEqual(result.outcome, 'needs_review', sender);
    assert.strictEqual(result.reason, 'Untrusted sender', sender);
  });
});

// Regression guard: the debit support adds a router in front of the purchase
// parser, which had no test coverage before. This pins the pre-existing
// behavior so the routing change cannot silently break it.
test('purchase authorizations still parse through the router', () => {
  const result = parseAlert(CARD_SENDER, 'Purchase Alert', '', PURCHASE_PLAIN);
  assert.strictEqual(result.outcome, 'imported');
  assert.deepStrictEqual({ ...result.transaction }, {
    transactionDate: '2026-08-03',
    institution: 'USAA',
    cardType: 'credit card',
    last4: '3355',
    cardholder: 'Jordan Sample',
    merchant: 'SAMPLE HARDWARE STORE.',
    amount: 19.99,
    eventType: 'purchase_authorization'
  });
});

test('an unrecognized USAA format still goes to review', () => {
  const result = parseAlert(BANK_SENDER, 'Statement Ready', '', 'Your USAA statement is ready to view.');
  assert.strictEqual(result.outcome, 'needs_review');
});
