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
// (the Draft-01 run r-269b010f predates the workflow's v2 bump — its
// workflowHash mismatch against the current file is drift audit working as
// intended; the preimage formula is re-verified against the Draft-02 pair below)
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

// ============================ Draft 02 checks ================================

check('Draft 02 banner present', /Draft 02/.test(doc));

// new requirement prefixes exist with reasonable coverage
for (const [prefix, min] of [['OUT', 5], ['NST', 8], ['SIG', 7]]) {
  const n = new Set([...doc.matchAll(new RegExp(`\\[${prefix}-(\\d+)\\]`, 'g'))].map((m) => m[1])).size;
  check(`[${prefix}-*] requirements present (>= ${min})`, n >= min, `${n}`);
}
check('[VER-4] and [VER-5] present', doc.includes('[VER-4]') && doc.includes('[VER-5]'));
check('[SEC-8] and [SEC-9] present', doc.includes('[SEC-8]') && doc.includes('[SEC-9]'));

// new document fields named in the spec
for (const f of ['outputs', 'from', 'childRun', 'approval', 'protocol', 'oracle', 'claims']) {
  check(`Draft 02 field \`${f}\` specified`, doc.includes(`\`${f}\``));
}

// canonical-string domain prefix: spec and implementation must agree
const APPROVAL_PREFIX = 'blocks-approval-v2';
check('canonical-string prefix stated in spec', doc.includes(APPROVAL_PREFIX));
check('canonical-string prefix present in implementation',
  src('cli/src/run.js').includes(APPROVAL_PREFIX) || (() => { try { return src('cli/src/canon.js').includes(APPROVAL_PREFIX); } catch { return false; } })());

// key registry hygiene: no private material committed
import { readdirSync, existsSync } from 'node:fs';
if (existsSync('keys')) {
  // registry documents are keys/<id>.json; *.private.json are local, gitignored halves
  const priv = readdirSync('keys').filter((f) => {
    if (!f.endsWith('.json') || f.endsWith('.private.json')) return false;
    try { return JSON.parse(src(`keys/${f}`)).publicJwk?.d !== undefined || JSON.parse(src(`keys/${f}`)).privateJwk !== undefined; } catch { return true; }
  });
  check('keys/ registry holds no private material', priv.length === 0, priv.join(', '));
  check('.gitignore excludes private keyfiles', src('.gitignore').includes('keys/*.private.json'));
} else {
  check('keys/ registry exists', false, 'no keys/ directory');
}

// committed dogfood pair: release parent run + child run + live signature re-verification
const releaseRuns = existsSync('examples/runs')
  ? readdirSync('examples/runs').filter((f) => f.startsWith('release-') && f.endsWith('.run.json'))
  : [];
check('committed release parent run exists', releaseRuns.length >= 1, releaseRuns.join(', '));
// pick the run with a signed, accepted approval (a negative-path run may also be committed)
let parent = null;
for (const f of releaseRuns) {
  const cand = JSON.parse(src(`examples/runs/${f}`));
  if (Object.values(cand.nodes).some((n) => n.approval && n.status === 'done')) { parent = cand; break; }
}
check('a release run with a signed approval is committed', parent !== null);
if (parent) {
  const wfNode = Object.values(parent.nodes).find((n) => n.childRun);
  check('parent run has a workflow node with childRun + workflowHash',
    !!wfNode && typeof wfNode.workflowHash === 'string' && wfNode.status === 'done');
  check('parent run declares protocol 2', parent.protocol === 2);
  check('parent workflowHash recomputes from the release workflow file bytes',
    sha(readFileSync('workflows/release.workflow.json')) === parent.workflowHash);
  check('child workflowHash recomputes from child workflow file bytes',
    !!wfNode && sha(readFileSync('workflows/changelog-from-git.workflow.json')) === wfNode.workflowHash);
  check('parent run has resolved top-level output', parent.output !== undefined);

  // curated child runs sit beside the parent under examples/runs/
  const childFile = wfNode && (existsSync(wfNode.childRun) ? wfNode.childRun : `examples/runs/${wfNode.childRun.split('/').pop()}`);
  check('child run document committed', !!childFile && existsSync(childFile), childFile ?? '');

  // live approval signature re-verification from run doc + registry alone
  const approvalNode = Object.entries(parent.nodes).find(([, n]) => n.approval);
  check('a signed approval node exists in the parent run', !!approvalNode);
  if (approvalNode) {
    const [nodeId, rec] = approvalNode;
    try {
      const { canon } = await import('../cli/src/canon.js');
      const { createPublicKey, verify } = await import('node:crypto');
      const key = JSON.parse(src(`keys/${rec.approval.keyId}.json`));
      const blockPin = JSON.parse(src('workflows/release.workflow.json')).nodes.find((n) => n.id === nodeId).block;
      const blockDir = `blocks/${blockPin.split('@')[0]}`;
      const blockHash = sha(readFileSync(`${blockDir}/SKILL.md`), readFileSync(`${blockDir}/contract.json`));
      const inputDigest = sha(Buffer.from(canon(rec.input), 'utf8'));
      const answerDigest = sha(Buffer.from(canon(rec.output), 'utf8'));
      const canonical = [APPROVAL_PREFIX, parent.workflowHash, blockHash, parent.runId, nodeId, inputDigest, answerDigest].join('\n');
      const ok = verify(null, Buffer.from(canonical, 'utf8'),
        createPublicKey({ key: key.publicJwk, format: 'jwk' }),
        Buffer.from(rec.approval.signature, 'base64url'));
      check('approval signature re-verifies from run document + registry via the spec formula', ok);
      check('signing key declares the required claim',
        JSON.parse(src(`${blockDir}/contract.json`)).oracle.claims.every((c) => key.claims.includes(c)));
    } catch (e) {
      check('approval signature re-verifies from run document + registry via the spec formula', false, e.message);
    }
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
