/**
 * CI version-gate tests.
 *
 * The version-check workflow used to compare the PR's parserVersion against
 * main with string equality, which only catches "you forgot to bump". A branch
 * carrying an OLDER version passed, silently downgrading parserVersion on main
 * and mis-stamping every row imported afterwards. These tests pin the ordering
 * rules that replaced it.
 *
 * Run:  node --test tests/version-compare.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', '.github', 'scripts', 'compare-parser-versions.js');
const { compareParserVersions } = require(SCRIPT);

// Runs the script as CI does. Returns { status, stderr }.
function runCli(prVersion, mainVersion) {
  try {
    execFileSync(process.execPath, [SCRIPT, prVersion, mainVersion], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stderr: '' };
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr || '') };
  }
}

test('compareParserVersions orders by numeric precedence, not string order', () => {
  // The bug a string compare would introduce: '1.10.0' < '1.9.0' lexically.
  assert.strictEqual(compareParserVersions('1.10.0', '1.9.0'), 1);
  assert.strictEqual(compareParserVersions('1.9.0', '1.10.0'), -1);
  assert.strictEqual(compareParserVersions('2.0.0', '1.99.99'), 1);
  assert.strictEqual(compareParserVersions('1.6.0', '1.6.0'), 0);
  assert.strictEqual(compareParserVersions('1.6.1', '1.6.0'), 1);
  assert.strictEqual(compareParserVersions('1.5.1', '1.6.0'), -1);
});

test('compareParserVersions rejects a malformed version', () => {
  assert.throws(() => compareParserVersions('1.6', '1.6.0'), /1\.6/);
  assert.throws(() => compareParserVersions('1.6.0', 'v1.6.0'), /v1\.6\.0/);
  assert.throws(() => compareParserVersions('', '1.6.0'));
});

test('a higher version passes the gate', () => {
  assert.strictEqual(runCli('1.7.0', '1.6.0').status, 0);
});

test('an unchanged version fails the gate', () => {
  const { status, stderr } = runCli('1.6.0', '1.6.0');
  assert.strictEqual(status, 1);
  assert.match(stderr, /same as main/i);
});

// The hole this change closes. Before the fix the gate was `PR_VER = MAIN_VER`,
// so any different version passed -- including a lower one.
test('a LOWER version fails the gate instead of silently downgrading main', () => {
  const { status, stderr } = runCli('1.5.1', '1.6.0');
  assert.strictEqual(status, 1);
  assert.match(stderr, /lower than main/i);
});

test('a stale branch that skipped a release cannot merge backwards', () => {
  // AGENTS.md: a branch at 1.3.0 merging a main at 1.4.0 must resolve forward
  // to 1.5.0, not take either side. Taking its own side must fail.
  assert.strictEqual(runCli('1.3.0', '1.4.0').status, 1);
  assert.strictEqual(runCli('1.5.0', '1.4.0').status, 0);
});

test('a malformed version fails the gate rather than passing by accident', () => {
  const { status, stderr } = runCli('not-a-version', '1.6.0');
  assert.strictEqual(status, 1);
  assert.match(stderr, /not-a-version/);
});

test('the CLI requires both arguments', () => {
  assert.strictEqual(runCli('1.6.0', '').status, 1);
});
