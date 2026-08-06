/**
 * Append-anchor tests: where does the next imported row land?
 *
 * These guard the two ways the sheet write path has silently corrupted data:
 * appending far below the data (user formulas inflating the anchor), and
 * appending on top of a manually entered row (manual rows carrying no Gmail
 * Message ID). See LESSONS.md.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
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

/** A sheet row for a script-imported transaction. */
function importedRow(id, date, merchant, amount) {
  const row = new Array(HEADERS.length).fill('');
  row[COL['Imported At'] - 1] = '2026-03-07T12:00:00.000Z';
  row[COL['Transaction Date'] - 1] = date;
  row[COL['Institution'] - 1] = 'Chase';
  row[COL['Merchant'] - 1] = merchant;
  row[COL['Amount'] - 1] = amount;
  row[COL['Gmail Message ID'] - 1] = id;
  return row;
}

/** A row the user typed by hand: no Gmail Message ID, no audit fields. */
function manualCashRow(date, merchant, amount) {
  const row = new Array(HEADERS.length).fill('');
  row[COL['Transaction Date'] - 1] = date;
  row[COL['Institution'] - 1] = 'Cash';
  row[COL['Merchant'] - 1] = merchant;
  row[COL['Amount'] - 1] = amount;
  return row;
}

function sheetWith(...rows) {
  return new FakeSheet([HEADERS.slice(), ...rows]);
}

test('anchor sits below a manually entered cash row', () => {
  const sheet = sheetWith(
    importedRow('msg-1', '2026-03-05', 'SAMPLE*COFFEE SHOP', 12.34),
    manualCashRow('2026-03-06', 'FARMERS MARKET', 20.00)
  );
  const map = wb.getColumnMap_(sheet, HEADERS);
  // Row 3 is the manual row; the next import must go to row 4, not over it.
  assert.strictEqual(wb.lastUsedScriptRow_(sheet, map), 3);
});

test('a manual cash row is never overwritten by the next import', () => {
  const sheet = sheetWith(
    importedRow('msg-1', '2026-03-05', 'SAMPLE*COFFEE SHOP', 12.34),
    manualCashRow('2026-03-06', 'FARMERS MARKET', 20.00)
  );
  const map = wb.getColumnMap_(sheet, HEADERS);
  const row = wb.lastUsedScriptRow_(sheet, map) + 1;
  HEADERS.forEach((h) => sheet.getRange(row, map[h]).setValue('WRITTEN'));

  assert.strictEqual(sheet.cell(3, COL['Merchant']), 'FARMERS MARKET');
  assert.strictEqual(sheet.cell(3, COL['Amount']), 20.00);
  assert.strictEqual(sheet.cell(3, COL['Institution']), 'Cash');
});

test('user formulas filled far down do not push the anchor below the data', () => {
  const sheet = sheetWith(importedRow('msg-1', '2026-03-05', 'SAMPLE*COFFEE SHOP', 12.34));
  // A category column to the right, dragged down to row 200.
  const categoryCol = HEADERS.length + 1;
  for (let r = 2; r <= 200; r++) sheet.write(r, categoryCol, 'Uncategorized');

  const map = wb.getColumnMap_(sheet, HEADERS);
  assert.strictEqual(sheet.getLastRow(), 200, 'precondition: whole-sheet last row is inflated');
  assert.strictEqual(wb.lastUsedScriptRow_(sheet, map), 2, 'anchor ignores user columns');
});

test('anchor is the header row on an empty sheet', () => {
  const sheet = sheetWith();
  const map = wb.getColumnMap_(sheet, HEADERS);
  assert.strictEqual(wb.lastUsedScriptRow_(sheet, map), 1);
});

test('columns are resolved by header name after a column is inserted mid-block', () => {
  const headers = HEADERS.slice();
  headers.splice(8, 0, 'Category'); // user inserts between Amount and Gmail Message ID
  const sheet = new FakeSheet([headers]);
  const map = wb.getColumnMap_(sheet, HEADERS);
  assert.strictEqual(map['Amount'], 8);
  assert.strictEqual(map['Gmail Message ID'], 10, 'shifted right by the inserted column');
});

test('a missing required header fails loudly and names the column', () => {
  const headers = HEADERS.filter((h) => h !== 'Fingerprint');
  const sheet = new FakeSheet([headers]);
  assert.throws(() => wb.getColumnMap_(sheet, HEADERS), /Fingerprint/);
});
