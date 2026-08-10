#!/usr/bin/env node
'use strict';

/**
 * Gate a PR's APP_CONFIG.parserVersion against main's.
 * Usage: node compare-parser-versions.js <prVersion> <mainVersion>
 *
 * Exits 0 only when the PR version is strictly greater than main's. Exits 1
 * with a GitHub ::error:: annotation when it is equal, lower, or malformed.
 *
 * "Strictly greater" rather than "different" is deliberate. The original gate
 * compared the two strings for equality, which catches a forgotten bump but
 * lets a branch carrying an OLDER version through -- silently downgrading
 * parserVersion on main and mis-stamping the Parser Version audit column on
 * every row imported afterwards. It also enforces the AGENTS.md rule that a
 * branch behind a release resolves the version forward rather than taking
 * either side.
 */

const SEMVER = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;

function parse(version, label) {
  const match = SEMVER.exec(String(version));
  if (!match) {
    throw new Error(`${label} is not a MAJOR.MINOR.PATCH version: "${version}"`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Returns 1 if a > b, -1 if a < b, 0 if equal. Throws on a malformed version.
 * Compares each field numerically: "1.10.0" is newer than "1.9.0", which a
 * string comparison gets backwards.
 */
function compareParserVersions(a, b) {
  const left = parse(a, 'version');
  const right = parse(b, 'version');
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

function main(argv) {
  const [prVersion, mainVersion] = argv;
  if (!prVersion || !mainVersion) {
    console.error('Usage: compare-parser-versions.js <prVersion> <mainVersion>');
    return 1;
  }

  let ordering;
  try {
    ordering = compareParserVersions(prVersion, mainVersion);
  } catch (err) {
    console.error(`::error::${err.message}`);
    return 1;
  }

  if (ordering === 0) {
    console.error(`::error::APP_CONFIG.parserVersion is still ${mainVersion} (same as main).`);
    console.error('This PR changes gmail-transaction-alerts-Code.gs, so you must bump parserVersion.');
    console.error('Edit parserVersion in gmail-transaction-alerts-Code.gs.');
    console.error('Bump guide: patch for bugfixes, minor for new parsers/behavior, major for breaking sheet contracts.');
    return 1;
  }

  if (ordering < 0) {
    console.error(`::error::APP_CONFIG.parserVersion ${prVersion} is lower than main (${mainVersion}).`);
    console.error('Merging would downgrade the released version and mis-stamp the Parser Version audit column.');
    console.error(`If you branched before ${mainVersion} was released, resolve the version forward -- pick a version above ${mainVersion} rather than keeping either side.`);
    return 1;
  }

  console.log(`Version bumped: ${mainVersion} -> ${prVersion}`);
  return 0;
}

module.exports = { compareParserVersions };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
