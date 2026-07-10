import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { deriveRunStatus } from './run-status.js';

function runFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...runFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.run.json')) out.push(path);
  }
  return out.sort();
}

export async function runsVerb(args, { root, boolFlag, usage }) {
  const json = boolFlag('--json');
  if (args.length) usage(`runs does not recognize: ${args.join(' ')}`);
  const runs = runFiles(join(root, 'runs')).map((file) => deriveRunStatus(root, file));
  const findings = [];
  const seen = new Map();
  for (const run of runs) {
    if (typeof run.runId !== 'string') {
      findings.push({ code: 'missing-run-id', runFile: run.runFile });
      continue;
    }
    const prior = seen.get(run.runId);
    if (prior) findings.push({ code: 'duplicate-run-id', runId: run.runId, runFiles: [prior, run.runFile] });
    else seen.set(run.runId, run.runFile);
  }
  const result = { ok: findings.length === 0, root: relative(process.cwd(), join(root, 'runs')) || 'runs', runs, findings };
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (runs.length === 0) console.log('no run ledgers under runs/');
  else {
    for (const run of runs) {
      const target = run.pause?.submissionTarget ? ` → record ${run.pause.submissionTarget}#${run.pause.nodeId}` : '';
      console.log(`${run.status.padEnd(8)} ${run.runId ?? '(no id)'}  ${run.workflow ?? '(unknown)'}  ${run.runFile}${target}`);
    }
    for (const finding of findings) console.error(`finding: ${finding.code} ${finding.runId ?? finding.runFile}`);
  }
  if (!result.ok) process.exit(1);
}
