#!/usr/bin/env node
'use strict';

/**
 * Extract APP_CONFIG.parserVersion from a Code.gs file.
 * Usage: node extract-parser-version.js <path>
 * Prints the semver string to stdout, or exits 1 with a message on stderr.
 */

const fs = require('fs');

const path = process.argv[2];
if (!path) {
  console.error('Usage: extract-parser-version.js <path>');
  process.exit(1);
}

let source;
try {
  source = fs.readFileSync(path, 'utf8');
} catch (err) {
  console.error(`Could not read ${path}: ${err.message}`);
  process.exit(1);
}

const match = source.match(/parserVersion:\s*['"]([0-9]+\.[0-9]+\.[0-9]+)['"]/);
if (!match) {
  console.error(`No parserVersion semver found in ${path}`);
  process.exit(1);
}

process.stdout.write(match[1]);
