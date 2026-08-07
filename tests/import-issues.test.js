/**
 * Import Issues tab: the extra review context, and the migration for sheets
 * created by an older version with only the original five headers.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeSheet } = require('./helpers/fake-sheet');

function loadWorkbook() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'gmail-transaction-alerts-Code.gs'), 'utf8'
  );
  const context = vm.createContext({});
  vm.runInContext(src, context, { filename: 'appsscript-under-test.js' });
  return context;
}

const wb = loadWorkbook();
const ISSUE_HEADERS = wb.ISSUE_HEADERS;
const LEGACY_HEADERS = ['Gmail Message ID', 'Email Received At', 'Institution', 'Parser Version', 'Reason'];

test('issue rows carry the subject, sender, and a Gmail link', () => {
  const sheet = new FakeSheet([ISSUE_HEADERS.slice()]);
  const map = wb.getColumnMap_(sheet, ISSUE_HEADERS);
  const row = wb.lastUsedRowIn_(sheet, ISSUE_HEADERS, map) + 1;

  const message = {
    id: 'abc123',
    receivedAt: '2026-03-07T14:00:00.000Z',
    subject: 'Your statement is ready',
    from: 'no.reply.alerts@chase.com'
  };
  ISSUE_HEADERS.forEach((h) => {
    const values = {
      'Gmail Message ID': message.id,
      'Email Received At': message.receivedAt,
      'Institution': 'Chase',
      'Subject': wb.safeCellText_(message.subject, 250),
      'From': wb.safeCellText_(message.from, 120),
      'Reason': wb.safeCellText_('Unsupported Chase alert format', 300),
      'Open in Gmail': 'https://mail.google.com/mail/u/0/#all/' + message.id,
      'Parser Version': wb.APP_CONFIG.parserVersion
    };
    sheet.getRange(row, map[h]).setValue(values[h]);
  });

  assert.strictEqual(sheet.cell(row, map['Subject']), 'Your statement is ready');
  assert.strictEqual(sheet.cell(row, map['From']), 'no.reply.alerts@chase.com');
  assert.match(String(sheet.cell(row, map['Open in Gmail'])), /#all\/abc123$/);
});

test('a legacy 5-column Import Issues sheet gains the new headers without reordering', () => {
  const sheet = new FakeSheet([
    LEGACY_HEADERS.slice(),
    ['old-id', '2026-01-01T00:00:00.000Z', 'USAA', '1.0.0', 'Unsupported format']
  ]);

  const added = wb.ensureHeaders_(sheet, ISSUE_HEADERS);
  assert.ok(added > 0, 'migration should add the missing headers');

  const map = wb.getColumnMap_(sheet, ISSUE_HEADERS);
  // Original columns keep their positions, so existing rows stay readable.
  LEGACY_HEADERS.forEach((h, i) => assert.strictEqual(map[h], i + 1, `${h} should not move`));
  assert.strictEqual(sheet.cell(2, map['Gmail Message ID']), 'old-id');
  assert.strictEqual(sheet.cell(2, map['Reason']), 'Unsupported format');
  // New columns land to the right and are blank on the legacy row.
  assert.ok(map['Subject'] > LEGACY_HEADERS.length);
  assert.strictEqual(sheet.cell(2, map['Subject']), '');
});

test('migration is idempotent', () => {
  const sheet = new FakeSheet([ISSUE_HEADERS.slice()]);
  assert.strictEqual(wb.ensureHeaders_(sheet, ISSUE_HEADERS), 0);
  assert.strictEqual(sheet.getLastColumn(), ISSUE_HEADERS.length);
});

test('new issue rows land below a legacy row rather than on top of it', () => {
  const sheet = new FakeSheet([
    LEGACY_HEADERS.slice(),
    ['old-id', '2026-01-01T00:00:00.000Z', 'USAA', '1.0.0', 'Unsupported format']
  ]);
  wb.ensureHeaders_(sheet, ISSUE_HEADERS);
  const map = wb.getColumnMap_(sheet, ISSUE_HEADERS);
  // The legacy row has no Subject/From, but it does have a message ID, so it
  // must still count as occupied.
  assert.strictEqual(wb.lastUsedRowIn_(sheet, ISSUE_HEADERS, map), 2);
});

test('a subject that looks like a formula is neutralized', () => {
  assert.strictEqual(wb.safeCellText_('=SUM(A1:A9)', 250), "'=SUM(A1:A9)");
  assert.strictEqual(wb.safeCellText_('+1 charge', 250), "'+1 charge");
  assert.strictEqual(wb.safeCellText_('-5.00 refund', 250), "'-5.00 refund");
  assert.strictEqual(wb.safeCellText_('@merchant', 250), "'@merchant");
  assert.strictEqual(wb.safeCellText_('You made a $1.00 transaction', 250), 'You made a $1.00 transaction');
});

test('issue text is single-line and length-capped', () => {
  assert.strictEqual(wb.safeCellText_('line one\nline two\ttabbed', 300), 'line one line two tabbed');
  assert.strictEqual(wb.safeCellText_('x'.repeat(500), 250).length, 250);
  assert.strictEqual(wb.safeCellText_(null, 250), '');
  assert.strictEqual(wb.safeCellText_(undefined, 250), '');
});
