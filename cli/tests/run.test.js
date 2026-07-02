import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'root');
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

const wf = (name) => join(ROOT, 'workflows', `${name}.workflow.json`);
const tmp = () => mkdtempSync(join(tmpdir(), 'blocks-test-'));

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

test('plan reports topo order, statuses, and the next pending node', () => {
  const dir = tmp();
  const state = join(dir, 'run.json');
  blocks(['exec', wf('valid'), '--out', state]);
  const { stdout } = blocks(['plan', wf('valid'), '--state', state]);
  assert.ok(/✓ echo/.test(stdout));
  assert.ok(/next: judge \(fuzzy\)/.test(stdout), stdout);
  assert.ok(stdout.includes('blocks record'), 'fuzzy next-step instructions included');
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
  cpSync(join(dirname(ROOT), '..', '..', '..', 'blocks', 'write-file'), join(root, 'blocks', 'write-file'), { recursive: true });
  const wfFile = join(root, 'workflows', 'escape.workflow.json');
  writeFileSync(wfFile, JSON.stringify({
    name: 'fixture-escape', version: 1,
    grants: { run: [], read: [], write: ['**'] },
    nodes: [{ id: 'w', block: 'write-file@1', in: { path: '../nope.md', content: 'x' } }],
  }));
  blocks(['exec', wfFile, '--out', join(root, 'e.run.json')], { root, expectFail: true });
  const leftovers = readdirSync(join(realpathSync(root), 'runs')).filter((f) => f.startsWith('.in-'));
  assert.deepEqual(leftovers, [], 'no .in-* temp files left behind');
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
