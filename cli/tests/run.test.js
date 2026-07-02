import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
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

test('record fails the node after 3 schema-invalid attempts', () => {
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
