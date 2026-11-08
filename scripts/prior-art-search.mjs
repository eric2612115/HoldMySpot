#!/usr/bin/env node
// The GitHub searches behind prior-art.md's second "first" (docs/DECISIONS.md D-147): one fixed list of
// code and repository searches for paid line-sitting among PayPal AI Hackathon entries, run with the
// GitHub CLI (`gh api`, your own login; read-only GET calls) and written with their date, totals and
// every repository each search returned, so anyone can run the same list again and compare.
//
//   node scripts/prior-art-search.mjs                 runs the searches and prints the hits
//   node scripts/prior-art-search.mjs --out <file>    also writes them as JSON (docs/evidence/prior-art-search-*.json)
//
// Code search sees only public default branches, and only files that use the words searched for; a
// repository search sees names, descriptions and topics. Neither sees the hackathon's own gallery.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const CODE = [
  '"PayPal AI Hackathon" "line sitting"',
  '"PayPal AI Hackathon" "line sitter"',
  '"PayPal AI Hackathon" "line-sitting"',
  '"PayPal AI Hackathon" "wait in line"',
  '"PayPal AI Hackathon" "stand in line"',
  '"PayPal AI Hackathon" "in line for you"',
  '"PayPal AI Hackathon" "queue sitter"',
  '"PayPal AI Hackathon" "queuer"',
  '"PayPal AI Hackathon" "hold my spot"',
  '"paypalaihackathon" "queue"',
];
const REPOS = [
  'line sitting paypal',
  'line sitter',
  'line-sitting',
  'linesitting',
  'wait in line paypal',
  'stand in line paypal',
  'queue errand paypal',
  'queue paypal hackathon',
  'queue market paypal',
  'paypal ai hackathon queue',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** This repository (from its git remote), left out of the hits: the search runs logged in, so it can see it while it is private. */
function ownRepo() {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?\s*$/.exec(r.stdout ?? '');
  return m ? m[1].toLowerCase() : null;
}

function gh(route) {
  const r = spawnSync('gh', ['api', '-X', 'GET', route], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`gh api ${route} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return JSON.parse(r.stdout);
}

async function main() {
  const { values: args } = parseArgs({ options: { out: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true });
  if (args.help) {
    console.log('node scripts/prior-art-search.mjs [--out <file.json>]   (needs the GitHub CLI, logged in)');
    return 0;
  }
  const ranAt = new Date().toISOString();
  const own = ownRepo();
  const notOwn = (name) => name.toLowerCase() !== own;
  const searches = [];
  for (const q of CODE) {
    const res = gh(`search/code?q=${encodeURIComponent(q)}&per_page=100`);
    const repos = [...new Set(res.items.map((i) => i.repository.full_name))].filter(notOwn).sort();
    searches.push({ kind: 'code', query: q, total: res.total_count - res.items.filter((i) => !notOwn(i.repository.full_name)).length, repositories: repos });
    console.log(`code  ${String(res.total_count).padStart(5)}  ${q}${repos.length ? `\n        ${repos.join(', ')}` : ''}`);
    // GitHub allows 10 code searches a minute.
    await sleep(7000);
  }
  for (const q of REPOS) {
    const res = gh(`search/repositories?q=${encodeURIComponent(q)}&per_page=100`);
    // Names and creation dates only: other people's descriptions are not copied into this repo.
    const repos = res.items.filter((i) => notOwn(i.full_name)).map((i) => ({ name: i.full_name, created: i.created_at.slice(0, 10) }));
    searches.push({ kind: 'repositories', query: q, total: res.total_count - (res.items.length - repos.length), repositories: repos });
    console.log(`repos ${String(res.total_count).padStart(5)}  ${q}`);
    await sleep(2500);
  }
  if (args.out) {
    const report = {
      tool: 'node scripts/prior-art-search.mjs',
      ranAt,
      note: 'GitHub code search (public default branches) and repository search (names, descriptions, topics) through gh api; the hackathon gallery is not searched. Every repository each search returned is listed by name (and, for repository search, creation date); descriptions are not copied. The searches run logged in, so this repository itself (private until submission) is left out of the hits and the totals.',
      searches,
    };
    fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
    fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote ${args.out}`);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
