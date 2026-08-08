/**
 * Setup Import USAA / Chase / Venmo toggles: truthy parse, sender filter, Gmail query.
 *
 * Run:  node --test tests/import-toggles.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBundle(setupRows) {
  const root = path.resolve(__dirname, '..');
  const src = fs.readFileSync(path.join(root, 'gmail-transaction-alerts-Code.gs'), 'utf8');
  const grid = [['Setting', 'Value']].concat(setupRows || []);
  const context = vm.createContext({
    SpreadsheetApp: {
      getActive() {
        return {
          getSheetByName(name) {
            if (name !== 'Setup') return null;
            return {
              getDataRange() {
                return {
                  getValues() {
                    return grid.map((row) => row.slice());
                  }
                };
              }
            };
          }
        };
      }
    },
    PropertiesService: {
      getUserProperties() {
        return { getProperty() { return null; } };
      }
    }
  });
  vm.runInContext(src, context, { filename: 'appsscript-under-test.js' });
  return context;
}

test('isEnabledSetting_ accepts TRUE / true / 1 / boolean true', () => {
  const { isEnabledSetting_ } = loadBundle();
  assert.strictEqual(isEnabledSetting_(true), true);
  assert.strictEqual(isEnabledSetting_(1), true);
  assert.strictEqual(isEnabledSetting_('TRUE'), true);
  assert.strictEqual(isEnabledSetting_('true'), true);
  assert.strictEqual(isEnabledSetting_('1'), true);
});

test('isEnabledSetting_ rejects FALSE / blank / other', () => {
  const { isEnabledSetting_ } = loadBundle();
  assert.strictEqual(isEnabledSetting_(false), false);
  assert.strictEqual(isEnabledSetting_(0), false);
  assert.strictEqual(isEnabledSetting_('FALSE'), false);
  assert.strictEqual(isEnabledSetting_(''), false);
  assert.strictEqual(isEnabledSetting_(null), false);
  assert.strictEqual(isEnabledSetting_('no'), false);
});

test('missing Import rows default each institution to enabled', () => {
  const ctx = loadBundle([]);
  assert.strictEqual(ctx.isInstitutionEnabled_('USAA'), true);
  assert.strictEqual(ctx.isInstitutionEnabled_('Chase'), true);
  assert.strictEqual(ctx.isInstitutionEnabled_('Venmo'), true);
  const senders = ctx.enabledTrustedSenders_();
  // USAA has two addresses; both ride the single Import USAA toggle.
  assert.deepStrictEqual(Object.keys(senders).sort(), [
    'no.reply.alerts@chase.com',
    'usaa.customer.service@omem.usaa.com',
    'usaa.customer.service@mailcenter.usaa.com',
    'venmo@venmo.com'
  ].sort());
});

test('enabledTrustedSenders_ drops Chase when Import Chase is FALSE', () => {
  const ctx = loadBundle([
    ['Import USAA', true],
    ['Import Chase', false],
    ['Import Venmo', 'TRUE']
  ]);
  const senders = ctx.enabledTrustedSenders_();
  assert.strictEqual(senders['no.reply.alerts@chase.com'], undefined);
  assert.strictEqual(senders['usaa.customer.service@omem.usaa.com'], 'USAA');
  assert.strictEqual(senders['usaa.customer.service@mailcenter.usaa.com'], 'USAA');
  assert.strictEqual(senders['venmo@venmo.com'], 'Venmo');
  assert.strictEqual(ctx.isInstitutionEnabled_('Chase'), false);
});

test('blank Import value counts as disabled', () => {
  const ctx = loadBundle([['Import Chase', '']]);
  assert.strictEqual(ctx.isInstitutionEnabled_('Chase'), false);
  assert.strictEqual(ctx.isInstitutionEnabled_('USAA'), true);
});

test('buildGmailQuery_ excludes disabled senders', () => {
  const ctx = loadBundle([
    ['Import USAA', true],
    ['Import Chase', false],
    ['Import Venmo', false]
  ]);
  const q = ctx.buildGmailQuery_();
  assert.match(q, /from:usaa\.customer\.service@omem\.usaa\.com/);
  assert.match(q, /from:usaa\.customer\.service@mailcenter\.usaa\.com/);
  assert.doesNotMatch(q, /from:no\.reply\.alerts@chase\.com/);
  assert.doesNotMatch(q, /from:venmo@venmo\.com/);
  assert.match(q, /newer_than:30d/);
});

test('buildGmailQuery_ uses no-match query when all institutions are off', () => {
  const ctx = loadBundle([
    ['Import USAA', false],
    ['Import Chase', false],
    ['Import Venmo', false]
  ]);
  assert.strictEqual(ctx.buildGmailQuery_(), 'label:"__gmail_transaction_alerts_none__"');
});
