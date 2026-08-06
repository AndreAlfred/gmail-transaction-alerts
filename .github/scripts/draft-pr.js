#!/usr/bin/env node
'use strict';

/**
 * Draft a PR title and body from a diff via OpenAI, then update the PR via gh.
 *
 * Env:
 *   OPENAI_API_KEY   required
 *   OPENAI_MODEL     optional (default gpt-4o-mini)
 *   PR_NUMBER        required
 *   REPO             owner/name
 *   GH_TOKEN         required (for gh)
 *   DIFF_PATH        path to diff file
 *   COMMITS_PATH     path to commit subjects file
 *   MAX_DIFF_CHARS   optional truncate (default 60000)
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const prNumber = process.env.PR_NUMBER;
const repo = process.env.REPO;
const diffPath = process.env.DIFF_PATH;
const commitsPath = process.env.COMMITS_PATH;
const maxDiff = Number(process.env.MAX_DIFF_CHARS || 60000);

if (!apiKey) {
  console.error('OPENAI_API_KEY is not set; skipping AI PR draft.');
  process.exit(0);
}
if (!prNumber || !repo || !diffPath || !commitsPath) {
  console.error('Missing PR_NUMBER, REPO, DIFF_PATH, or COMMITS_PATH');
  process.exit(1);
}

let diff = fs.readFileSync(diffPath, 'utf8');
const commits = fs.readFileSync(commitsPath, 'utf8').trim();
if (diff.length > maxDiff) {
  diff = diff.slice(0, maxDiff) + '\n\n[diff truncated]\n';
}

const system = `You write GitHub pull request titles and descriptions for a small Google Apps Script repo (gmail-transaction-alerts).

Rules:
- Output valid JSON only: {"title":"...","body":"..."}
- Title: concise, imperative or descriptive, under ~90 characters. No ticket prefixes unless already present in commits.
- Body markdown with exactly these sections:
  ## Summary
  1-3 bullets of what changed and why.
  ## Test plan
  Checklist of concrete verification steps (- [ ] items).
- Never invent real card numbers, emails, message IDs, merchant/amount pairs, or credentials.
- Do not claim tests were run unless the commits/diff clearly include test changes implying coverage.
- Match a practical engineering tone; no fluff.`;

const user = `Commits:\n${commits || '(none)'}\n\nDiff:\n${diff || '(empty)'}`;

async function main() {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    })
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`OpenAI API error ${res.status}: ${text}`);
    process.exit(1);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    console.error('Empty OpenAI response');
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.error('Failed to parse model JSON:', content);
    process.exit(1);
  }

  const title = String(parsed.title || '').trim();
  const body = String(parsed.body || '').trim();
  if (!title || !body) {
    console.error('Model returned empty title or body');
    process.exit(1);
  }

  const bodyWithMarker = `${body}\n\n<!-- ai-pr-draft -->\n`;

  fs.writeFileSync('/tmp/pr-title.txt', title);
  fs.writeFileSync('/tmp/pr-body.md', bodyWithMarker);

  execFileSync(
    'gh',
    ['pr', 'edit', prNumber, '--repo', repo, '--title', title, '--body-file', '/tmp/pr-body.md'],
    { stdio: 'inherit', env: process.env }
  );

  console.log(`Updated PR #${prNumber}: ${title}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
