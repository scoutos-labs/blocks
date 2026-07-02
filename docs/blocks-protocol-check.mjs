// Consistency harness: PROTOCOL.md vs the reference implementation.
// The spec may not drift from the code it formalizes, nor rot away from its
// own examples. Run: node docs/blocks-protocol-check.mjs PROTOCOL.md
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = process.argv[2] ?? 'PROTOCOL.md';
const doc = readFileSync(file, 'utf8');
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const src = (p) => readFileSync(p, 'utf8');

// --- implementation constants the spec must state ---------------------------

// verbs from the CLI HELP text (informative Appendix A, but must be complete)
const help = src('cli/bin/blocks');
const helpText = help.slice(help.indexOf('usage: blocks'), help.indexOf('vocabulary:'));
const verbs = [...helpText.matchAll(/^  ([a-z-]+)/gm)].map((m) => m[1]);
check('CLI HELP verbs all appear in the doc', verbs.length >= 9 && verbs.every((v) => doc.includes(v)),
  verbs.join(', '));

// exit codes / outcome classes
check('outcome classes 0/1/2/3 specified',
  /0[^\n]*ok/i.test(doc) && doc.includes('exit code') &&
  ['0', '1', '2', '3'].every((c) => new RegExp(`\\b${c}\\b`).test(doc)));
check('bin/blocks exit-code comment matches (0 ok, 1 validation/contract, 2 usage, 3 permission)',
  help.includes('0 ok · 1 validation/contract failure · 2 usage error · 3 permission refusal'));

// skill frontmatter keys
const skillKeys = /SKILL_KEYS = new Set\(\[([^\]]+)\]/.exec(src('cli/src/loader.js'))[1]
  .split(',').map((s) => s.trim().replace(/'/g, ''));
check('frontmatter keys match loader SKILL_KEYS', skillKeys.join(',') === 'name,description' &&
  doc.includes('`name`') && doc.includes('`description`'));

// record attempts
const maxAttempts = Number(/MAX_ATTEMPTS = (\d+)/.exec(src('cli/src/run.js'))[1]);
check(`MAX_ATTEMPTS (${maxAttempts}) stated as the failure threshold`,
  maxAttempts === 3 && /attempts.{0,40}(≥|>=).{0,4}3|three (record )?submissions|3 submissions/i.test(doc));

// schema-lite keys and types
const schemaSrc = src('cli/src/schema.js');
const keys = /KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(schemaSrc)[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
const types = /TYPES = new Set\(\[([^\]]+)\]/.exec(schemaSrc)[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
check(`all ${keys.length} schema-lite keys named`, keys.every((k) => doc.includes(`\`${k}\``)), keys.join(' '));
check(`all ${types.length} schema-lite types named`, types.every((t) => doc.includes(`\`${t}\``)), types.join(' '));

// gate operators
const ops = /OPS = \[([^\]]+)\]/.exec(src('cli/src/when.js'))[1].match(/'([^']+)'/g).map((s) => s.replace(/'/g, ''));
check(`all ${ops.length} gate operators named`, ops.every((o) => doc.includes(`\`${o}\``)), ops.join(' '));

// identifier / pin patterns (literal regex bodies must appear in the doc)
check('node-id pattern stated', doc.includes('[a-z][a-z0-9-]*'));
check('pin form name@version stated', /`?name`?\s*@\s*`?version`?|<name>@<version>|name@version/.test(doc));

// run-document fields
for (const f of ['workflow', 'workflowFile', 'workflowHash', 'runId', 'startedAt', 'inputs', 'nodes']) {
  check(`run field \`${f}\` specified`, doc.includes(`\`${f}\``));
}
for (const f of ['status', 'blockHash', 'attempts', 'output', 'input', 'reason']) {
  check(`node-record field \`${f}\` specified`, doc.includes(`\`${f}\``));
}
for (const s of ['pending', 'done', 'skipped', 'failed']) {
  check(`status \`${s}\` specified`, doc.includes(`\`${s}\``));
}

// --- examples must byte-match the repo ------------------------------------

const run = JSON.parse(src('examples/runs/changelog-from-git-r-269b010f.run.json'));
const wf = src('workflows/changelog-from-git.workflow.json');
check('worked example: grants line verbatim',
  doc.includes('"grants": { "run": ["git"], "read": [], "write": ["CHANGELOG.md"] }'));
check('worked example: gate expression verbatim',
  doc.includes("nodes.judge.output.score >= 0.7 and nodes.judge.output.verdict == 'pass'"));
check('worked example: judge output values', doc.includes('0.85') && doc.includes('"pass"'));
check('worked example: full log blockHash', doc.includes(run.nodes.log.blockHash));

// --- hash preimages: recompute from the spec's stated formulas -------------

const sha = (...bufs) => {
  const h = createHash('sha256');
  for (const b of bufs) h.update(b);
  return `sha256:${h.digest('hex')}`;
};
check('workflowHash preimage formula reproduces the run document',
  sha(readFileSync('workflows/changelog-from-git.workflow.json')) === run.workflowHash);
check('blockHash preimage formula (SKILL.md ‖ contract.json ‖ entry) reproduces log node',
  sha(readFileSync('blocks/git-log/SKILL.md'), readFileSync('blocks/git-log/contract.json')) === run.nodes.log.blockHash);

// --- requirement IDs --------------------------------------------------------

const ids = [...doc.matchAll(/\[([A-Z]{3}-\d+)\]/g)].map((m) => m[1]);
const unique = new Set(ids);
check('requirement IDs present (>= 40)', unique.size >= 40, `${unique.size} unique`);
// per prefix, IDs form a gapless 1..N sequence (catches renumbering slips)
const byPrefix = new Map();
for (const id of unique) {
  const [p, n] = id.split('-');
  (byPrefix.get(p) ?? byPrefix.set(p, new Set()).get(p)).add(Number(n));
}
const gappy = [...byPrefix].filter(([, ns]) => Math.max(...ns) !== ns.size)
  .map(([p, ns]) => `${p}: max ${Math.max(...ns)} vs ${ns.size} ids`);
check('requirement IDs gapless per prefix', gappy.length === 0, gappy.join(' | '));

// checklist coverage: every ID defined in the body appears in Appendix C, and vice versa
const cIdx = doc.indexOf('## Appendix C');
check('Appendix C exists', cIdx !== -1);
if (cIdx !== -1) {
  const body = doc.slice(0, cIdx);
  const checklist = doc.slice(cIdx, doc.indexOf('## Appendix D') === -1 ? undefined : doc.indexOf('## Appendix D'));
  const bodyIds = new Set([...body.matchAll(/^\s*\[([A-Z]{3}-\d+)\]\s/gm)].map((m) => m[1]));
  const listIds = new Set([...checklist.matchAll(/\[([A-Z]{3}-\d+)\]/g)].map((m) => m[1]));
  const missing = [...bodyIds].filter((id) => !listIds.has(id));
  const phantom = [...listIds].filter((id) => !bodyIds.has(id));
  check(`checklist covers all ${bodyIds.size} body requirements`, missing.length === 0, missing.slice(0, 6).join(', '));
  check('checklist has no phantom IDs', phantom.length === 0, phantom.slice(0, 6).join(', '));
}

// --- RFC keyword lint in normative sections ---------------------------------

check('RFC 2119/8174 boilerplate present', /RFC\s*2119/.test(doc) && /RFC\s*8174/.test(doc));
const sections = doc.split(/^## /m).slice(1);
let lintHits = [];
for (const sec of sections) {
  const title = sec.split('\n')[0];
  if (!/\(normative\)/i.test(title)) continue;
  const prose = sec
    .replace(/```[\s\S]*?```/g, '')      // code fences
    .replace(/`[^`]*`/g, '')             // inline code
    .replace(/\[[A-Z]{3}-\d+\]/g, '');
  for (const m of prose.matchAll(/\b(must not|must|shall)\b/g)) {
    lintHits.push(`${title.trim()}: lowercase "${m[1]}"`);
  }
}
check('no lowercase must/shall in normative prose', lintHits.length === 0, lintHits.slice(0, 5).join(' | '));

// --- anchors ----------------------------------------------------------------

// GitHub-style: strip punctuation, each space becomes a hyphen (no collapsing)
const slug = (t) => t.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/ /g, '-');
const headers = new Set([...doc.matchAll(/^#{1,3} (.+)$/gm)].map((m) => slug(m[1])));
const broken = [...doc.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]).filter((a) => !headers.has(a));
check('internal anchors resolve', broken.length === 0, broken.slice(0, 6).join(', '));

// --- hygiene ----------------------------------------------------------------

check('no /Users/ paths', !doc.includes('/Users/'));
check('draft banner present', /Draft 01/.test(doc) && /2026-07-02/.test(doc));
check('no secrets patterns', !/sk-[a-zA-Z0-9]{8,}|AKIA[A-Z0-9]{8,}|ghp_[a-zA-Z0-9]{8,}/.test(doc));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
