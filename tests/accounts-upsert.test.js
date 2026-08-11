/**
 * Accounts sheet upsert: current balances from daily summary alerts.
 *
 * Guards insert, newer/equal as-of updates, older as-of skips, Display Name
 * preservation, and missing-header failures. See LESSONS.md for why columns
 * are resolved by name.
 *
 * Run:  node --test tests/accounts-upsert.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FakeSheet } = require('./helpers/fake-sheet');

function loadWithAccounts(accountsGrid) {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'gmail-transaction-alerts-Code.gs'), 'utf8');
  const accounts = new FakeSheet(
    (accountsGrid || []).map((row) => row.slice()),
    'Accounts'
  );
  const context = vm.createContext({
    SpreadsheetApp: {
      getActive() {
        return {
          getSheetByName(name) {
            return name === 'Accounts' ? accounts : null;
          },
          insertSheet(name) {
            if (name === 'Accounts') return accounts;
            return new FakeSheet([[]], name);
          }
        };
      }
    }
  });
  vm.runInContext(src, context, { filename: 'appsscript-under-test.js' });
  return { ctx: context, accounts };
}

function accountRow(overrides) {
  const { ctx } = loadWithAccounts();
  const headers = ctx.ACCOUNT_HEADERS;
  const row = headers.map(() => '');
  const col = {};
  headers.forEach((h, i) => { col[h] = i; });
  row[col['Institution']] = 'Chase';
  row[col['Last 4']] = '4321';
  row[col['Display Name']] = '';
  row[col['Balance']] = 100;
  row[col['Balance As Of']] = '2026-08-09';
  row[col['Updated At']] = '2026-08-10T12:00:00.000Z';
  row[col['Gmail Message ID']] = 'msg-old';
  row[col['Parser Version']] = '1.10.0';
  Object.keys(overrides || {}).forEach((k) => { row[col[k]] = overrides[k]; });
  return { headers, row };
}

test('upsert inserts a new Accounts row and leaves Display Name blank', () => {
  const { headers } = accountRow();
  const { ctx, accounts } = loadWithAccounts([headers.slice()]);
  const wrote = ctx.upsertAccountBalance_(
    { institution: 'Chase', last4: '4321', balance: 1234.56, balanceAsOf: '2026-08-10' },
    { id: 'msg-new' }
  );
  assert.strictEqual(wrote, true);
  const map = ctx.getColumnMap_(accounts, headers);
  assert.strictEqual(accounts.cell(2, map['Institution']), 'Chase');
  assert.strictEqual(accounts.cell(2, map['Last 4']), '4321');
  assert.strictEqual(accounts.cell(2, map['Display Name']), '');
  assert.strictEqual(accounts.cell(2, map['Balance']), 1234.56);
  assert.strictEqual(accounts.cell(2, map['Balance As Of']), '2026-08-10');
  assert.strictEqual(accounts.cell(2, map['Gmail Message ID']), 'msg-new');
  assert.strictEqual(accounts.cell(2, map['Parser Version']), ctx.APP_CONFIG.parserVersion);
});

test('upsert updates when as-of is newer and preserves Display Name', () => {
  const { headers, row } = accountRow({
    'Display Name': 'Checking',
    Balance: 100,
    'Balance As Of': '2026-08-09'
  });
  const { ctx, accounts } = loadWithAccounts([headers.slice(), row]);
  const wrote = ctx.upsertAccountBalance_(
    { institution: 'Chase', last4: '4321', balance: 1234.56, balanceAsOf: '2026-08-10' },
    { id: 'msg-new' }
  );
  assert.strictEqual(wrote, true);
  const map = ctx.getColumnMap_(accounts, headers);
  assert.strictEqual(accounts.cell(2, map['Display Name']), 'Checking');
  assert.strictEqual(accounts.cell(2, map['Balance']), 1234.56);
  assert.strictEqual(accounts.cell(2, map['Balance As Of']), '2026-08-10');
  assert.strictEqual(accounts.cell(2, map['Gmail Message ID']), 'msg-new');
});

test('upsert updates when as-of is equal (same-day refresh)', () => {
  const { headers, row } = accountRow({
    Balance: 100,
    'Balance As Of': '2026-08-10'
  });
  const { ctx, accounts } = loadWithAccounts([headers.slice(), row]);
  const wrote = ctx.upsertAccountBalance_(
    { institution: 'Chase', last4: '4321', balance: 200, balanceAsOf: '2026-08-10' },
    { id: 'msg-same-day' }
  );
  assert.strictEqual(wrote, true);
  const map = ctx.getColumnMap_(accounts, headers);
  assert.strictEqual(accounts.cell(2, map['Balance']), 200);
  assert.strictEqual(accounts.cell(2, map['Gmail Message ID']), 'msg-same-day');
});

test('upsert skips when as-of is older than the row', () => {
  const { headers, row } = accountRow({
    'Display Name': 'Checking',
    Balance: 999,
    'Balance As Of': '2026-08-11',
    'Gmail Message ID': 'msg-newer'
  });
  const { ctx, accounts } = loadWithAccounts([headers.slice(), row]);
  const wrote = ctx.upsertAccountBalance_(
    { institution: 'Chase', last4: '4321', balance: 1, balanceAsOf: '2026-08-10' },
    { id: 'msg-older' }
  );
  assert.strictEqual(wrote, false);
  const map = ctx.getColumnMap_(accounts, headers);
  assert.strictEqual(accounts.cell(2, map['Balance']), 999);
  assert.strictEqual(accounts.cell(2, map['Balance As Of']), '2026-08-11');
  assert.strictEqual(accounts.cell(2, map['Display Name']), 'Checking');
  assert.strictEqual(accounts.cell(2, map['Gmail Message ID']), 'msg-newer');
});

test('upsert keys on Institution + Last 4, not Display Name', () => {
  const { headers, row } = accountRow({
    'Display Name': 'Primary',
    'Last 4': '4321',
    Balance: 10,
    'Balance As Of': '2026-08-01'
  });
  const other = row.slice();
  const col = {};
  headers.forEach((h, i) => { col[h] = i; });
  other[col['Last 4']] = '9999';
  other[col['Display Name']] = 'Secondary';
  other[col['Balance']] = 50;
  const { ctx, accounts } = loadWithAccounts([headers.slice(), row, other]);
  ctx.upsertAccountBalance_(
    { institution: 'Chase', last4: '9999', balance: 75, balanceAsOf: '2026-08-10' },
    { id: 'msg-second' }
  );
  const map = ctx.getColumnMap_(accounts, headers);
  assert.strictEqual(accounts.cell(2, map['Balance']), 10);
  assert.strictEqual(accounts.cell(3, map['Balance']), 75);
  assert.strictEqual(accounts.cell(3, map['Display Name']), 'Secondary');
});

test('missing Accounts headers throw a named error', () => {
  const { ctx, accounts } = loadWithAccounts([['Institution', 'Last 4', 'Balance']]);
  assert.throws(
    () => ctx.getColumnMap_(accounts, ctx.ACCOUNT_HEADERS),
    /missing required column/
  );
});

test('isUpdateAccountBalancesEnabled_ defaults true when Setup row is absent', () => {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'gmail-transaction-alerts-Code.gs'), 'utf8');
  const context = vm.createContext({
    SpreadsheetApp: {
      getActive() {
        return {
          getSheetByName() { return null; }
        };
      }
    }
  });
  vm.runInContext(src, context, { filename: 'appsscript-under-test.js' });
  assert.strictEqual(context.isUpdateAccountBalancesEnabled_(), true);
});

test('isUpdateAccountBalancesEnabled_ respects FALSE', () => {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'gmail-transaction-alerts-Code.gs'), 'utf8');
  const grid = [['Setting', 'Value'], ['Update Account Balances', false]];
  const context = vm.createContext({
    SpreadsheetApp: {
      getActive() {
        return {
          getSheetByName(name) {
            if (name !== 'Setup') return null;
            return {
              getDataRange() {
                return { getValues() { return grid.map((r) => r.slice()); } };
              }
            };
          }
        };
      }
    }
  });
  vm.runInContext(src, context, { filename: 'appsscript-under-test.js' });
  assert.strictEqual(context.isUpdateAccountBalancesEnabled_(), false);
});
