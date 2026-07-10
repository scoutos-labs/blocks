import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, existsSync, readdirSync, realpathSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'root');
const REPO_ROOT = join(dirname(ROOT), '..', '..', '..');
const BIN = join(HERE, '..', 'bin', 'blocks');

function blocks(args, { root = ROOT, expectFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8', env: { ...process.env, BLOCKS_ROOT: root },
    });
    assert.ok(!expectFail, `expected failure but got:\n${stdout}`);
    return { stdout, code: 0 };
  } catch (e) {
    assert.ok(expectFail, `unexpected failure (exit ${e.status}):\n${e.stderr}\n${e.stdout}`);
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.status };
  }
}

function blocksRaw(args, { root = ROOT } = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8', env: { ...process.env, BLOCKS_ROOT: root },
  });
}

const wf = (name) => join(ROOT, 'workflows', `${name}.workflow.json`);
const tmp = () => mkdtempSync(join(tmpdir(), 'blocks-test-'));
const repoBlock = (name) => join(REPO_ROOT, 'blocks', name);

function countFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(join(dir, entry.name));
    else count += 1;
  }
  return count;
}

function listRunFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRunFiles(p));
    else if (entry.name.endsWith('.run.json')) out.push(p);
  }
  return out;
}

test('det-only workflow: double run produces identical .nodes (determinism check)', () => {
  const dir = tmp();
  const a = join(dir, 'a.run.json');
  const b = join(dir, 'b.run.json');
  blocks(['exec', wf('det-only'), '--out', a]);
  blocks(['exec', wf('det-only'), '--out', b]);
  const nodesA = JSON.parse(readFileSync(a, 'utf8'));
  const nodesB = JSON.parse(readFileSync(b, 'utf8'));
  assert.notEqual(nodesA.runId, nodesB.runId, 'runIds differ');
  assert.equal(JSON.stringify(nodesA.nodes), JSON.stringify(nodesB.nodes), 'node sections are byte-identical');
  assert.equal(nodesA.nodes.count.output.count, 3);
  assert.equal(nodesA.nodes.shout.output.text, 'alpha beta gamma!!');
});

test('injection safety: a hostile binding arrives as one literal argument', () => {
  const dir = tmp();
  const out = join(dir, 'inj.run.json');
  const hostile = '"; rm -rf . #x $(whoami) `id`';
  blocks(['exec', wf('det-only'), '--out', out, '--input', `text=${hostile}`]);
  const state = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(state.nodes.echo.output.text, hostile, 'echoed verbatim, never shell-interpreted');
});

test('validation refuses a workflow whose grants exceed block declarations (exit 1)', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  const wfFile = join(root, 'workflows', 'det-only.workflow.json');
  const wfJson = JSON.parse(readFileSync(wfFile, 'utf8'));
  wfJson.grants.run.push('rm');
  writeFileSync(wfFile, JSON.stringify(wfJson));
  const { stderr, code } = blocks(['exec', wfFile, '--out', join(root, 'x.run.json')], { root, expectFail: true });
  assert.equal(code, 1);
  assert.ok(stderr.includes('"rm"'), stderr);
});

test('exec-time defense in depth: a binary outside the effective run set exits 3', () => {
  // Unreachable through the CLI (the validator always runs first) — exercised
  // directly to prove the second fence exists (SPEC §7).
  const script = `
    import { execDeterministic } from '${join(HERE, '..', 'src', 'run.js')}';
    const block = {
      name: 'evil', version: 1, kind: 'deterministic', dir: '.',
      exec: { argv: ['rm', '-rf', 'x'], capture: 'text' },
      permissions: { run: ['rm'] },
      outputs: { text: { type: 'string' } },
    };
    execDeterministic({ id: 'n' }, block, {}, { grants: { run: ['printf'] } }, process.cwd());
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 3, `expected exit 3, got ${r.status}: ${r.stderr}`);
  assert.ok(r.stderr.includes('effective run set'), r.stderr);
});

test('fuzzy pause, check-output, record with repair loop, gate skip, resume', () => {
  const dir = tmp();
  const state = join(dir, 'run.json');
  const answer = join(dir, 'answer.json');

  // exec runs det nodes, pauses at the fuzzy judge
  const first = blocks(['exec', wf('valid'), '--out', state]);
  assert.ok(first.stdout.includes('paused at fuzzy node "judge"'), first.stdout);
  assert.ok(first.stdout.includes('blocks record'), 'tells the agent the exact next command');
  const paused = JSON.parse(readFileSync(state, 'utf8'));
  assert.equal(paused.nodes.judge.status, 'pending');
  assert.deepEqual(Object.keys(paused.nodes.judge.input), ['candidate'], 'resolved fuzzy input persisted');

  // check-output: bad candidate rejected, exact field named
  writeFileSync(answer, JSON.stringify({ score: 2, verdict: 'pass' }));
  const bad = blocks(['check-output', 'fx-judge', answer], { expectFail: true });
  assert.ok(bad.stderr.includes('/score'), bad.stderr);
  assert.ok(bad.stderr.includes('above maximum 1'), bad.stderr);

  // record: invalid attempt 1 → repair guidance; then valid low score
  const attempt1 = blocks(['record', '--state', state, '--node', 'judge', '--output', answer], { expectFail: true });
  assert.ok(attempt1.stderr.includes('attempt 1/3'), attempt1.stderr);
  writeFileSync(answer, JSON.stringify({ score: 0.2, verdict: 'revise' }));
  blocks(['record', '--state', state, '--node', 'judge', '--output', answer]);
  const recorded = JSON.parse(readFileSync(state, 'utf8'));
  assert.equal(recorded.nodes.judge.status, 'done');
  assert.equal(recorded.nodes.judge.attempts, 2);

  // resume: gate (score >= 0.5 and verdict == 'pass') is false → final skipped
  const resumed = blocks(['exec', wf('valid'), '--state', state]);
  assert.ok(resumed.stdout.includes('run complete'), resumed.stdout);
  const done = JSON.parse(readFileSync(state, 'utf8'));
  assert.equal(done.nodes.final.status, 'skipped');
  assert.ok(done.nodes.final.reason.includes('gate false'));

  // record refuses to overwrite a done node
  const overwrite = blocks(['record', '--state', state, '--node', 'judge', '--output', answer], { expectFail: true });
  assert.ok(overwrite.stderr.includes('refuses to overwrite'), overwrite.stderr);
});

test('record fails the node after 3 schema-invalid attempts, and failed is terminal', () => {
  const dir = tmp();
  const state = join(dir, 'run.json');
  const answer = join(dir, 'answer.json');
  blocks(['exec', wf('valid'), '--out', state]);
  writeFileSync(answer, JSON.stringify({ score: 9, verdict: 'nope' }));
  for (let i = 1; i <= 3; i++) {
    const r = blocks(['record', '--state', state, '--node', 'judge', '--output', answer], { expectFail: true });
    if (i < 3) assert.ok(r.stderr.includes(`attempt ${i}/3`), r.stderr);
    else assert.ok(r.stderr.includes('FAILED after 3 attempts'), r.stderr);
  }
  const failed = JSON.parse(readFileSync(state, 'utf8'));
  assert.equal(failed.nodes.judge.status, 'failed');

  // a 4th, VALID submission must be refused — no resurrection ([RNR-12])
  writeFileSync(answer, JSON.stringify({ score: 0.9, verdict: 'pass' }));
  const resurrect = blocks(['record', '--state', state, '--node', 'judge', '--output', answer], { expectFail: true });
  assert.equal(resurrect.code, 2, resurrect.stderr);
  assert.ok(resurrect.stderr.includes('terminal'), resurrect.stderr);
  const after = JSON.parse(readFileSync(state, 'utf8'));
  assert.equal(after.nodes.judge.status, 'failed', 'status unchanged');
  assert.equal(after.nodes.judge.attempts, 3, 'attempts unchanged');
});

test('plan reports topo order, statuses, and exact record guidance only after a fuzzy node is reached', () => {
  const dir = tmp();
  const state = join(dir, 'run.json');
  blocks(['exec', wf('valid'), '--out', state]);
  const before = readFileSync(state, 'utf8');
  const { stdout } = blocks(['plan', wf('valid'), '--state', state]);
  assert.ok(/✓ echo/.test(stdout));
  assert.ok(/next: judge \(fuzzy\)/.test(stdout), stdout);
  assert.ok(stdout.includes('blocks record'), 'reached fuzzy next-step instructions included');
  assert.equal(readFileSync(state, 'utf8'), before, 'plan --state left run-state byte-identical');
});

test('static plan is validation/topology-only for a required-input triage workflow', () => {
  const root = tmp();
  mkdirSync(join(root, 'workflows'), { recursive: true });
  cpSync(join(REPO_ROOT, 'blocks'), join(root, 'blocks'), { recursive: true });
  cpSync(join(REPO_ROOT, 'workflows', 'triage-bug-report.workflow.json'), join(root, 'workflows', 'triage-bug-report.workflow.json'));
  const beforeFiles = countFiles(root);
  const runsDir = join(root, 'runs');

  const { stdout } = blocks(['plan', join(root, 'workflows', 'triage-bug-report.workflow.json')], { root });

  assert.ok(stdout.includes('triage-bug-report  run order:'), stdout);
  assert.ok(stdout.includes('start a run: blocks exec'), stdout);
  assert.ok(!stdout.includes('blocks record'), 'static plan does not suggest recording an unreached fuzzy node');
  assert.equal(existsSync(runsDir), false, 'static plan did not create runs/');
  assert.equal(countFiles(root), beforeFiles, 'static plan did not create or remove files');
});

test('plan --state does not require secret re-supply or mutate run-state', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  const wfFile = writeSecretResumeFixture(root);
  const state = join(root, 'secret.run.json');
  blocks(['exec', wfFile, '--out', state, '--input', 'pin=42'], { root });
  recordGatePass(state, root);
  const before = readFileSync(state, 'utf8');

  const { stdout } = blocks(['plan', wfFile, '--state', state], { root });

  assert.ok(stdout.includes('fixture-secret-resume  run order:'), stdout);
  assert.ok(/✓ gate/.test(stdout), stdout);
  assert.ok(/next: check \(deterministic\)/.test(stdout), stdout);
  assert.ok(!stdout.includes('must be re-supplied'), stdout);
  assert.equal(readFileSync(state, 'utf8'), before, 'plan --state did not rewrite secret run-state');
});

test('state plan does not suggest record for an unreached fuzzy node', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  const wfFile = join(root, 'workflows', 'unreached-fuzzy.workflow.json');
  writeFileSync(wfFile, JSON.stringify({
    name: 'fixture-unreached-fuzzy', version: 1,
    grants: { run: [], read: [], write: [] },
    nodes: [{ id: 'judge', block: 'fx-judge@1', in: { candidate: 'not reached yet' } }],
  }));
  const state = join(root, 'unreached.run.json');
  writeFileSync(state, JSON.stringify({
    workflow: 'fixture-unreached-fuzzy',
    workflowFile: 'workflows/unreached-fuzzy.workflow.json',
    workflowHash: `sha256:${createHash('sha256').update(readFileSync(wfFile)).digest('hex')}`,
    runId: 'r-unreached',
    startedAt: new Date(0).toISOString(),
    inputs: {},
    nodes: { judge: { status: 'pending' } },
    protocol: 4,
    secretSalt: 'AAAAAAAAAAAAAAAAAAAAAA',
  }, null, 2) + '\n');
  const before = readFileSync(state, 'utf8');

  const { stdout } = blocks(['plan', wfFile, '--state', state], { root });

  assert.ok(/next: judge \(fuzzy\)/.test(stdout), stdout);
  assert.ok(stdout.includes('continue the run: blocks exec'), stdout);
  assert.ok(!stdout.includes('blocks record'), 'unreached fuzzy node has no record guidance');
  assert.equal(readFileSync(state, 'utf8'), before, 'unreached fuzzy state was not mutated');
});

test('run-state carries no node-level timestamps and hashes every executed block', () => {
  const dir = tmp();
  const state = join(dir, 'run.json');
  blocks(['exec', wf('det-only'), '--out', state]);
  const s = JSON.parse(readFileSync(state, 'utf8'));
  assert.ok(s.startedAt && s.runId && s.workflowHash.startsWith('sha256:'));
  for (const rec of Object.values(s.nodes)) {
    assert.equal(rec.status, 'done');
    assert.ok(rec.blockHash.startsWith('sha256:'));
    assert.ok(!('finishedAt' in rec) && !('startedAt' in rec), 'no timestamps inside nodes');
  }
});

test('path escape is refused at exec: ../ and absolute paths write nothing, exit 3', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  cpSync(join(dirname(ROOT), '..', '..', '..', 'blocks', 'write-file'), join(root, 'blocks', 'write-file'), { recursive: true });
  const wfFile = join(root, 'workflows', 'escape.workflow.json');
  writeFileSync(wfFile, JSON.stringify({
    name: 'fixture-escape', version: 1,
    inputs: { path: { type: 'string' } },
    grants: { run: [], read: [], write: ['**'] },
    nodes: [{ id: 'w', block: 'write-file@1', in: { path: '{{inputs.path}}', content: 'pwned' } }],
  }));
  for (const evil of ['../ESCAPED.md', '/tmp/ESCAPED.md']) {
    const r = blocks(['exec', wfFile, '--out', join(root, 'e.run.json'), '--input', `path=${evil}`], { root, expectFail: true });
    assert.equal(r.code, 3, `exit 3 for ${evil}: ${r.stderr}`);
    assert.ok(r.stderr.includes('escapes the workspace'), r.stderr);
  }
  assert.ok(!existsSync(join(dirname(root), 'ESCAPED.md')) && !existsSync('/tmp/ESCAPED.md'), 'nothing was written outside');
});

test('a write:["**"] grant is honored (workspace root is inside the workspace)', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  cpSync(join(dirname(ROOT), '..', '..', '..', 'blocks', 'write-file'), join(root, 'blocks', 'write-file'), { recursive: true });
  const wfFile = join(root, 'workflows', 'star.workflow.json');
  writeFileSync(wfFile, JSON.stringify({
    name: 'fixture-star', version: 1,
    grants: { run: [], read: [], write: ['**'] },
    nodes: [{ id: 'w', block: 'write-file@1', in: { path: 'STAR_OK.md', content: 'ok' } }],
  }));
  blocks(['exec', wfFile, '--out', join(root, 's.run.json')], { root });
  assert.ok(existsSync(join(realpathSync(root), 'STAR_OK.md')), 'file written at workspace root');
});

test('exec cleans up its temp inputs file even when the entry script fails', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  cpSync(repoBlock('write-file'), join(root, 'blocks', 'write-file'), { recursive: true });
  const wfFile = join(root, 'workflows', 'escape.workflow.json');
  writeFileSync(wfFile, JSON.stringify({
    name: 'fixture-escape', version: 1,
    grants: { run: [], read: [], write: ['**'] },
    nodes: [{ id: 'w', block: 'write-file@1', in: { path: '../nope.md', content: 'x' } }],
  }));
  blocks(['exec', wfFile, '--out', join(root, 'e.run.json')], { root, expectFail: true });
  const leftovers = existsSync(join(realpathSync(root), 'runs'))
    ? readdirSync(join(realpathSync(root), 'runs')).filter((f) => f.startsWith('.in-'))
    : [];
  assert.deepEqual(leftovers, [], 'no .in-* temp files left behind');
});

test('read-file enforces effective read grants without blanket workspace read', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  cpSync(repoBlock('read-file'), join(root, 'blocks', 'read-file'), { recursive: true });
  mkdirSync(join(root, 'allowed'), { recursive: true });
  writeFileSync(join(root, 'allowed', 'ok.txt'), 'covered');
  writeFileSync(join(root, 'secret.txt'), 'secret');
  const wfFile = join(root, 'workflows', 'read.workflow.json');
  writeFileSync(wfFile, JSON.stringify({
    name: 'fixture-read', version: 1,
    inputs: { path: { type: 'string' } },
    grants: { run: [], read: ['allowed/**'], write: [] },
    nodes: [{ id: 'r', block: 'read-file@1', in: { path: '{{inputs.path}}' } }],
  }));

  blocks(['exec', wfFile, '--out', join(root, 'ok.run.json'), '--input', 'path=allowed/ok.txt'], { root });
  const ok = JSON.parse(readFileSync(join(root, 'ok.run.json'), 'utf8'));
  assert.equal(ok.nodes.r.output.text, 'covered');

  const missing = blocks(['exec', wfFile, '--out', join(root, 'missing.run.json'), '--input', 'path=secret.txt'], { root, expectFail: true });
  assert.equal(missing.code, 3, missing.stderr);
  assert.ok(missing.stderr.includes('effective read grants') || missing.stderr.includes('permission'), missing.stderr);
});

test('read-file and write-file refuse symlink escapes without touching outside targets', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  cpSync(repoBlock('read-file'), join(root, 'blocks', 'read-file'), { recursive: true });
  cpSync(repoBlock('write-file'), join(root, 'blocks', 'write-file'), { recursive: true });
  const outside = tmp();
  writeFileSync(join(outside, 'outside.txt'), 'original');
  symlinkSync(join(outside, 'outside.txt'), join(root, 'link-file'));
  symlinkSync(outside, join(root, 'link-dir'));

  const readWf = join(root, 'workflows', 'read-link.workflow.json');
  writeFileSync(readWf, JSON.stringify({
    name: 'fixture-read-link', version: 1,
    grants: { run: [], read: ['**'], write: [] },
    nodes: [{ id: 'r', block: 'read-file@1', in: { path: 'link-file' } }],
  }));
  const readEscape = blocks(['exec', readWf, '--out', join(root, 'read-link.run.json')], { root, expectFail: true });
  assert.equal(readEscape.code, 3, readEscape.stderr);
  assert.ok(readEscape.stderr.includes('symlink') || readEscape.stderr.includes('permission') || readEscape.stderr.includes('escapes the workspace'), readEscape.stderr);

  const writeFileWf = join(root, 'workflows', 'write-link-file.workflow.json');
  writeFileSync(writeFileWf, JSON.stringify({
    name: 'fixture-write-link-file', version: 1,
    grants: { run: [], read: [], write: ['**'] },
    nodes: [{ id: 'w', block: 'write-file@1', in: { path: 'link-file', content: 'pwned' } }],
  }));
  const writeExisting = blocks(['exec', writeFileWf, '--out', join(root, 'write-link-file.run.json')], { root, expectFail: true });
  assert.equal(writeExisting.code, 3, writeExisting.stderr);
  assert.equal(readFileSync(join(outside, 'outside.txt'), 'utf8'), 'original');

  const writeDirWf = join(root, 'workflows', 'write-link-dir.workflow.json');
  writeFileSync(writeDirWf, JSON.stringify({
    name: 'fixture-write-link-dir', version: 1,
    grants: { run: [], read: [], write: ['**'] },
    nodes: [{ id: 'w', block: 'write-file@1', in: { path: 'link-dir/new.txt', content: 'pwned' } }],
  }));
  const writeNew = blocks(['exec', writeDirWf, '--out', join(root, 'write-link-dir.run.json')], { root, expectFail: true });
  assert.equal(writeNew.code, 3, writeNew.stderr);
  assert.ok(!existsSync(join(outside, 'new.txt')), 'non-existent outside target was not created');

  const directReadInput = join(root, 'direct-read-input.json');
  writeFileSync(directReadInput, JSON.stringify({ path: 'link-file' }));
  const directRead = spawnSync(process.execPath, [join(root, 'blocks', 'read-file', 'run.mjs'), directReadInput], {
    cwd: realpathSync(root), encoding: 'utf8', env: { ...process.env, BLOCKS_EFFECTIVE_READ: '["**"]' },
  });
  assert.equal(directRead.status, 3, directRead.stderr);

  const directWriteInput = join(root, 'direct-write-input.json');
  writeFileSync(directWriteInput, JSON.stringify({ path: 'link-dir/direct-new.txt', content: 'pwned' }));
  const directWrite = spawnSync(process.execPath, [join(root, 'blocks', 'write-file', 'run.mjs'), directWriteInput], {
    cwd: realpathSync(root), encoding: 'utf8', env: { ...process.env, BLOCKS_EFFECTIVE_WRITE: '["**"]' },
  });
  assert.equal(directWrite.status, 3, directWrite.stderr);
  assert.ok(!existsSync(join(outside, 'direct-new.txt')), 'direct block check did not create outside target');
});

test('loader rejects exec.entry traversal, absolute paths, and symlink escapes', () => {
  for (const [name, entry, makeEntry] of [
    ['bad-entry-traversal', '../outside-entry.mjs', (root) => writeFileSync(join(root, 'blocks', 'outside-entry.mjs'), 'console.log(JSON.stringify({ ok: true }))')],
    ['bad-entry-absolute', '/tmp/blocks-bad-entry.mjs', () => writeFileSync('/tmp/blocks-bad-entry.mjs', 'console.log(JSON.stringify({ ok: true }))')],
    ['bad-entry-symlink', 'run.mjs', (root) => {
      const outside = join(tmp(), 'outside-entry.mjs');
      writeFileSync(outside, 'console.log(JSON.stringify({ ok: true }))');
      symlinkSync(outside, join(root, 'blocks', 'bad-entry-symlink', 'run.mjs'));
    }],
  ]) {
    const root = tmp();
    cpSync(ROOT, root, { recursive: true });
    const blockDir = join(root, 'blocks', name);
    mkdirSync(blockDir, { recursive: true });
    writeFileSync(join(blockDir, 'SKILL.md'), `---\nname: ${name}\ndescription: bad entry\n---\n`);
    writeFileSync(join(blockDir, 'contract.json'), JSON.stringify({
      name, version: 1, kind: 'deterministic',
      inputs: {}, outputs: { ok: { type: 'boolean' } },
      exec: { entry }, permissions: { run: [], read: [], write: [], network: false },
    }));
    makeEntry(root);
    const wfFile = join(root, 'workflows', `${name}.workflow.json`);
    writeFileSync(wfFile, JSON.stringify({
      name: `fixture-${name}`, version: 1,
      grants: { run: [], read: [], write: [] },
      nodes: [{ id: 'n', block: `${name}@1`, in: {} }],
    }));
    const r = blocks(['validate', wfFile], { root, expectFail: true });
    assert.equal(r.code, 1, r.stderr);
    assert.ok(r.stderr.includes('/exec/entry'), r.stderr);
  }
});

test('entry temp inputs are private, outside tracked runs, and cleaned after success', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  const blockDir = join(root, 'blocks', 'inspect-temp');
  mkdirSync(blockDir, { recursive: true });
  writeFileSync(join(blockDir, 'SKILL.md'), `---\nname: inspect-temp\ndescription: inspect runtime input temp file\n---\n`);
  writeFileSync(join(blockDir, 'contract.json'), JSON.stringify({
    name: 'inspect-temp', version: 1, kind: 'deterministic',
    inputs: {}, outputs: { path: { type: 'string' }, mode: { type: 'string' }, parent: { type: 'string' } },
    exec: { entry: 'run.mjs' }, permissions: { run: [], read: [], write: [], network: false },
  }));
  writeFileSync(join(blockDir, 'run.mjs'), `import { statSync } from 'node:fs';\nimport { dirname } from 'node:path';\nconst p = process.argv[2];\nconst st = statSync(p);\nconsole.log(JSON.stringify({ path: p, mode: (st.mode & 0o777).toString(8), parent: dirname(p) }));\n`);
  const wfFile = join(root, 'workflows', 'inspect-temp.workflow.json');
  writeFileSync(wfFile, JSON.stringify({
    name: 'fixture-inspect-temp', version: 1,
    grants: { run: [], read: [], write: [] },
    nodes: [{ id: 't', block: 'inspect-temp@1', in: {} }],
  }));
  blocks(['exec', wfFile, '--out', join(root, 'temp.run.json')], { root });
  const out = JSON.parse(readFileSync(join(root, 'temp.run.json'), 'utf8')).nodes.t.output;
  assert.equal(out.mode, '600');
  assert.match(basename(out.path), /^input-[0-9a-f-]{36}\.json$/, 'temp input file name includes an unpredictable UUID');
  assert.ok(!existsSync(out.path), 'temp input file was cleaned after success');
  assert.ok(!existsSync(out.parent), 'private temp directory was removed after success');
  const rel = relative(join(realpathSync(root), 'runs'), out.path);
  assert.ok(rel.startsWith('..') || isAbsolute(rel), `temp file was outside tracked runs: ${out.path}`);
});

test('secret workflow inputs are digested in run-state', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  const wfFile = join(root, 'workflows', 'det-only.workflow.json');
  const wfJson = JSON.parse(readFileSync(wfFile, 'utf8'));
  wfJson.inputs.text.secret = true;
  delete wfJson.inputs.text.default;
  writeFileSync(wfFile, JSON.stringify(wfJson));
  const state = join(root, 'run.json');
  blocks(['exec', wfFile, '--out', state, '--input', 'text=hunter2 hunter2'], { root });
  const s = JSON.parse(readFileSync(state, 'utf8'));
  assert.ok(s.inputs.text.startsWith('sha256:'), 'secret stored as digest');
  assert.ok(!JSON.stringify(s.inputs).includes('hunter2'));
});

function assertSecretFuzzyWorkflowRejectedBeforeRun({ nodes, grants }) {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  const wfFile = join(root, 'workflows', 'secret-fuzzy.workflow.json');
  writeFileSync(wfFile, JSON.stringify({
    name: 'fixture-secret-fuzzy', version: 1,
    inputs: { token: { type: 'string', secret: true } },
    grants,
    nodes,
  }));
  const out = join(root, 'blocked.run.json');
  const marker = `secret-${randomUUID()}`;
  const beforeRunFiles = listRunFiles(join(root, 'runs'));

  const r = blocksRaw(['exec', wfFile, '--out', out, '--input', `token=${marker}`], { root });

  assert.notEqual(r.status, 0, 'workflow was statically rejected');
  assert.ok(r.stderr.includes('secret-derived data cannot be wired into fuzzy nodes'), 'privacy validation error was reported');
  assert.equal(r.stdout.includes(marker), false, 'stdout did not include the secret marker');
  assert.equal(r.stderr.includes(marker), false, 'stderr did not include the secret marker');
  assert.equal(existsSync(out), false, 'no requested run file was created');
  assert.deepEqual(listRunFiles(join(root, 'runs')), beforeRunFiles, 'no run file was created under runs/');
}

test('CLI rejects direct secret input to fuzzy before run creation without leaking the marker', () => {
  assertSecretFuzzyWorkflowRejectedBeforeRun({
    grants: { run: [], read: [], write: [] },
    nodes: [{ id: 'judge', block: 'fx-judge@1', in: { candidate: '{{inputs.token}}' } }],
  });
});

test('CLI rejects transitive secret-derived deterministic output to fuzzy before run creation without leaking the marker', () => {
  assertSecretFuzzyWorkflowRejectedBeforeRun({
    grants: { run: ['printf'], read: [], write: [] },
    nodes: [
      { id: 'echo', block: 'echo-text@1', in: { text: '{{inputs.token}}' } },
      { id: 'judge', block: 'fx-judge@1', in: { candidate: '{{nodes.echo.output.text}}' } },
    ],
  });
});

function writeSecretResumeFixture(root) {
  const blockDir = join(root, 'blocks', 'secret-ok');
  mkdirSync(blockDir, { recursive: true });
  writeFileSync(join(blockDir, 'SKILL.md'), `---\nname: secret-ok\ndescription: Check a typed secret without printing it.\n---\n\nReturn whether the supplied numeric pin is accepted.\n`);
  writeFileSync(join(blockDir, 'contract.json'), JSON.stringify({
    name: 'secret-ok', version: 1, kind: 'deterministic',
    inputs: { pin: { type: 'number' } },
    outputs: { ok: { type: 'boolean' } },
    exec: { entry: 'run.mjs' },
    permissions: { run: [], read: [], write: [], network: false },
  }));
  writeFileSync(join(blockDir, 'run.mjs'), `import { readFileSync } from 'node:fs';\nconst input = JSON.parse(readFileSync(process.argv[2], 'utf8'));\nconsole.log(JSON.stringify({ ok: typeof input.pin === 'number' && input.pin === 42 }));\n`);
  const wfFile = join(root, 'workflows', 'secret-resume.workflow.json');
  writeFileSync(wfFile, JSON.stringify({
    name: 'fixture-secret-resume', version: 1,
    inputs: { pin: { type: 'number', secret: true } },
    grants: { run: [], read: [], write: [] },
    nodes: [
      { id: 'gate', block: 'fx-judge@1', in: { candidate: 'secret check is ready' } },
      { id: 'check', block: 'secret-ok@1', after: ['gate'], in: { pin: '{{inputs.pin}}' } },
    ],
  }));
  return wfFile;
}

function recordGatePass(state, root) {
  const answer = join(root, 'answer.json');
  writeFileSync(answer, JSON.stringify({ score: 0.9, verdict: 'pass' }));
  blocks(['record', '--state', state, '--node', 'gate', '--output', answer], { root });
}

test('resume rejects unknown and non-secret input overrides without mutating state', () => {
  const dir = tmp();
  const state = join(dir, 'run.json');
  blocks(['exec', wf('valid'), '--out', state]);
  const before = readFileSync(state, 'utf8');

  const nonSecret = blocks(['exec', wf('valid'), '--state', state, '--input', 'text=hacked'], { expectFail: true });
  assert.equal(nonSecret.code, 2, nonSecret.stderr);
  assert.ok(nonSecret.stderr.includes('cannot override non-secret workflow input "text"'), nonSecret.stderr);
  assert.equal(readFileSync(state, 'utf8'), before, 'non-secret override left run-state byte-identical');

  const unknown = blocks(['exec', wf('valid'), '--state', state, '--input', 'bogus=value'], { expectFail: true });
  assert.equal(unknown.code, 2, unknown.stderr);
  assert.ok(unknown.stderr.includes('unknown workflow input "bogus"'), unknown.stderr);
  assert.equal(readFileSync(state, 'utf8'), before, 'unknown input left run-state byte-identical');
});

test('resume parses, validates, and digest-checks secret inputs before use', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  const wfFile = writeSecretResumeFixture(root);
  const state = join(root, 'secret.run.json');

  blocks(['exec', wfFile, '--out', state, '--input', 'pin=42'], { root });
  let s = JSON.parse(readFileSync(state, 'utf8'));
  assert.ok(s.inputs.pin.startsWith('sha256:'), 'secret input stored as digest');
  assert.equal(JSON.stringify(s).includes('"pin":42'), false, 'numeric secret is not persisted as plaintext');

  recordGatePass(state, root);
  const beforeResume = readFileSync(state, 'utf8');

  const missing = blocks(['exec', wfFile, '--state', state], { root, expectFail: true });
  assert.equal(missing.code, 2, missing.stderr);
  assert.ok(missing.stderr.includes('must be re-supplied'), missing.stderr);
  assert.equal(readFileSync(state, 'utf8'), beforeResume, 'missing secret left run-state byte-identical');

  const invalidJson = blocks(['exec', wfFile, '--state', state, '--input', 'pin=not-json'], { root, expectFail: true });
  assert.equal(invalidJson.code, 2, invalidJson.stderr);
  assert.ok(invalidJson.stderr.includes('wants number'), invalidJson.stderr);
  assert.equal(readFileSync(state, 'utf8'), beforeResume, 'unparseable secret left run-state byte-identical');

  const wrongType = blocks(['exec', wfFile, '--state', state, '--input', 'pin="forty-two"'], { root, expectFail: true });
  assert.equal(wrongType.code, 2, wrongType.stderr);
  assert.ok(wrongType.stderr.includes('expected number, got string'), wrongType.stderr);
  assert.equal(readFileSync(state, 'utf8'), beforeResume, 'schema-invalid secret left run-state byte-identical');

  const mismatched = blocks(['exec', wfFile, '--state', state, '--input', 'pin=43'], { root, expectFail: true });
  assert.equal(mismatched.code, 2, mismatched.stderr);
  assert.ok(mismatched.stderr.includes('does not match the digest'), mismatched.stderr);
  assert.equal(readFileSync(state, 'utf8'), beforeResume, 'digest-mismatched secret left run-state byte-identical');

  const resumed = blocks(['exec', wfFile, '--state', state, '--input', 'pin=42'], { root });
  assert.ok(resumed.stdout.includes('run complete'), resumed.stdout);
  s = JSON.parse(readFileSync(state, 'utf8'));
  assert.equal(s.nodes.check.output.ok, true, 'matching resumed secret was parsed as a number and used');
  assert.equal(JSON.stringify(s).includes('"pin":42'), false, 'matching secret remains absent from persisted plaintext');
});

test('repeating an unchanged fuzzy pause is idempotent', () => {
  const dir = tmp();
  const state = join(dir, 'run.json');
  blocks(['exec', wf('valid'), '--out', state]);
  const before = readFileSync(state, 'utf8');
  const repeated = blocks(['exec', wf('valid'), '--state', state]);
  assert.ok(repeated.stdout.includes('paused at fuzzy node "judge"'), repeated.stdout);
  assert.equal(readFileSync(state, 'utf8'), before, 'unchanged repeated pause left run-state byte-identical');
});

test('fuzzy pause refuses blockHash drift without restamping state', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  const wfFile = join(root, 'workflows', 'valid.workflow.json');
  const state = join(root, 'run.json');
  blocks(['exec', wfFile, '--out', state], { root });
  const before = readFileSync(state, 'utf8');
  writeFileSync(join(root, 'blocks', 'fx-judge', 'SKILL.md'), `${readFileSync(join(root, 'blocks', 'fx-judge', 'SKILL.md'), 'utf8')}\nDrift.\n`);

  const drift = blocks(['exec', wfFile, '--state', state], { root, expectFail: true });
  assert.ok(drift.stderr.includes('blockHash mismatch'), drift.stderr);
  assert.equal(readFileSync(state, 'utf8'), before, 'block drift left run-state byte-identical');
});

test('fuzzy pause refuses resolved input drift without overwriting paused input', () => {
  const root = tmp();
  cpSync(ROOT, root, { recursive: true });
  const wfFile = join(root, 'workflows', 'valid.workflow.json');
  const state = join(root, 'run.json');
  blocks(['exec', wfFile, '--out', state], { root });
  const tampered = JSON.parse(readFileSync(state, 'utf8'));
  const pausedInput = tampered.nodes.judge.input;
  tampered.nodes.echo.output.text = 'tampered candidate';
  writeFileSync(state, JSON.stringify(tampered, null, 2) + '\n');
  const before = readFileSync(state, 'utf8');

  const drift = blocks(['exec', wfFile, '--state', state], { root, expectFail: true });
  assert.ok(drift.stderr.includes('input mismatch'), drift.stderr);
  assert.equal(readFileSync(state, 'utf8'), before, 'input drift left run-state byte-identical');
  assert.deepEqual(JSON.parse(readFileSync(state, 'utf8')).nodes.judge.input, pausedInput, 'paused fuzzy input was not overwritten');
});
