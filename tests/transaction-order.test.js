/**
 * Transaction Order: after append, whole-row sort by Transaction Date keeps
 * user columns (Category) glued to their rows under oldest/newest first.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('path');
const vm = require('node:vm');
const { FakeSheet } = require('./helpers/fake-sheet');

function loadWorkbook() {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'gmail-transaction-alerts-Code.gs'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(src, context, { filename: 'appsscript-under-test.js' });
  return context;
}

const wb = loadWorkbook();
const HEADERS = wb.TRANSACTION_HEADERS;
const COL = {};
HEADERS.forEach((h, i) => { COL[h] = i + 1; });
const CATEGORY_COL = HEADERS.length + 1;

function importedRow(id, date, merchant, amount, importedAt) {
  const row = new Array(HEADERS.length).fill('');
  row[COL['Imported At'] - 1] = importedAt || '2026-03-07T12:00:00.000Z';
  row[COL['Transaction Date'] - 1] = date;
  row[COL['Institution'] - 1] = 'Chase';
  row[COL['Merchant'] - 1] = merchant;
  row[COL['Amount'] - 1] = amount;
  row[COL['Gmail Message ID'] - 1] = id;
  return row;
}

function sheetWithCategory(...entries) {
  const grid = [HEADERS.slice()];
  // Widen header row so Category is a real user column to the right of audit cols.
  while (grid[0].length < CATEGORY_COL) grid[0].push('');
  grid[0][CATEGORY_COL - 1] = 'Category';

  entries.forEach(({ row, category }) => {
    const line = row.slice();
    while (line.length < CATEGORY_COL) line.push('');
    line[CATEGORY_COL - 1] = category;
    grid.push(line);
  });
  return new FakeSheet(grid);
}

test('normalizeTransactionOrder_ defaults unknown and empty to oldest first', () => {
  assert.strictEqual(wb.normalizeTransactionOrder_(''), 'oldest first');
  assert.strictEqual(wb.normalizeTransactionOrder_('OLDEST FIRST'), 'oldest first');
  assert.strictEqual(wb.normalizeTransactionOrder_('newest first'), 'newest first');
  assert.strictEqual(wb.normalizeTransactionOrder_('newest'), 'newest first');
  assert.strictEqual(wb.normalizeTransactionOrder_('sideways'), 'oldest first');
});

test('oldest-first sort puts earlier dates first and keeps Category with the row', () => {
  const sheet = sheetWithCategory(
    { row: importedRow('msg-a', '2026-08-06', 'LATER MERCHANT', 10, '2026-08-06T18:00:00.000Z'), category: 'Dining' },
    { row: importedRow('msg-b', '2026-08-05', 'EARLIER MERCHANT', 20, '2026-08-05T18:00:00.000Z'), category: 'Coffee' }
  );

  wb.sortSheetByTransactionOrder_(sheet, 'oldest first');

  assert.strictEqual(sheet.cell(2, COL['Transaction Date']), '2026-08-05');
  assert.strictEqual(sheet.cell(2, COL['Merchant']), 'EARLIER MERCHANT');
  assert.strictEqual(sheet.cell(2, CATEGORY_COL), 'Coffee');
  assert.strictEqual(sheet.cell(3, COL['Transaction Date']), '2026-08-06');
  assert.strictEqual(sheet.cell(3, COL['Merchant']), 'LATER MERCHANT');
  assert.strictEqual(sheet.cell(3, CATEGORY_COL), 'Dining');
});

test('newest-first sort puts later dates first and keeps Category with the row', () => {
  const sheet = sheetWithCategory(
    { row: importedRow('msg-a', '2026-08-05', 'EARLIER MERCHANT', 20, '2026-08-05T18:00:00.000Z'), category: 'Coffee' },
    { row: importedRow('msg-b', '2026-08-06', 'LATER MERCHANT', 10, '2026-08-06T18:00:00.000Z'), category: 'Dining' }
  );

  wb.sortSheetByTransactionOrder_(sheet, 'newest first');

  assert.strictEqual(sheet.cell(2, COL['Transaction Date']), '2026-08-06');
  assert.strictEqual(sheet.cell(2, COL['Merchant']), 'LATER MERCHANT');
  assert.strictEqual(sheet.cell(2, CATEGORY_COL), 'Dining');
  assert.strictEqual(sheet.cell(3, COL['Transaction Date']), '2026-08-05');
  assert.strictEqual(sheet.cell(3, COL['Merchant']), 'EARLIER MERCHANT');
  assert.strictEqual(sheet.cell(3, CATEGORY_COL), 'Coffee');
});

test('same-day rows use Imported At as the tie-break in the same direction', () => {
  const sheet = sheetWithCategory(
    { row: importedRow('msg-late', '2026-08-06', 'SECOND', 1, '2026-08-06T20:00:00.000Z'), category: 'B' },
    { row: importedRow('msg-early', '2026-08-06', 'FIRST', 2, '2026-08-06T10:00:00.000Z'), category: 'A' }
  );

  wb.sortSheetByTransactionOrder_(sheet, 'oldest first');

  assert.strictEqual(sheet.cell(2, COL['Merchant']), 'FIRST');
  assert.strictEqual(sheet.cell(2, CATEGORY_COL), 'A');
  assert.strictEqual(sheet.cell(3, COL['Merchant']), 'SECOND');
  assert.strictEqual(sheet.cell(3, CATEGORY_COL), 'B');
});

test('append after a manual cash row still targets the next empty row (anchor unchanged)', () => {
  const cash = new Array(HEADERS.length).fill('');
  cash[COL['Transaction Date'] - 1] = '2026-08-04';
  cash[COL['Institution'] - 1] = 'Cash';
  cash[COL['Merchant'] - 1] = 'FARMERS MARKET';
  cash[COL['Amount'] - 1] = 20;

  const sheet = new FakeSheet([
    HEADERS.slice(),
    importedRow('msg-1', '2026-08-05', 'SAMPLE*COFFEE', 12.34),
    cash
  ]);
  const map = wb.getColumnMap_(sheet, HEADERS);
  assert.strictEqual(wb.lastUsedScriptRow_(sheet, map), 3);
  assert.strictEqual(wb.lastUsedScriptRow_(sheet, map) + 1, 4);
});
