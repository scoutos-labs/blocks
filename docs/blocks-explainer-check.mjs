// Validation harness for docs/blocks-explainer.html (PRD step 5).
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const html = readFileSync(file, 'utf8');
const bytes = Buffer.byteLength(html);
let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

// (a) self-containment
check('no <link> tags', !/<link[\s>]/i.test(html));
check('no <script src>', !/<script[^>]*\bsrc=/i.test(html));
check('no external URLs in src/href/url()/@import',
  !/(?:src|href)\s*=\s*["']\s*(?:https?:)?\/\//i.test(html) &&
  !/url\(\s*["']?\s*(?:https?:)?\/\//i.test(html) &&
  !/@import/i.test(html));

// (b) size budget
check('size <= 200 KB (target 150)', bytes <= 200 * 1024, `${(bytes / 1024).toFixed(1)} KB`);
if (bytes > 150 * 1024) console.log(`  warn: over 150 KB target`);

// (c) heading sanity
const h1s = (html.match(/<h1[\s>]/g) || []).length;
check('exactly one h1', h1s === 1, `${h1s}`);
const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
let monotonic = true;
for (let i = 1; i < levels.length; i++) if (levels[i] > levels[i - 1] + 1) monotonic = false;
check('heading levels never skip', monotonic, levels.join(' '));

// (d) motion + animation contracts
check('prefers-reduced-motion present', html.includes('prefers-reduced-motion'));
check('IntersectionObserver present', html.includes('IntersectionObserver'));
check('no unconditional setInterval', !/setInterval/.test(html));

// (e) metadata
check('<title> present', /<title>[^<]{5,}<\/title>/.test(html));
check('meta description present', /<meta name="description" content="[^"]{20,}"/.test(html));
check('lang attribute', /<html lang=/.test(html));

// (f) secrets and machine paths
for (const [label, re] of [
  ['no sk- keys', /sk-[a-zA-Z0-9]{8,}/],
  ['no AKIA keys', /AKIA[A-Z0-9]{8,}/],
  ['no ghp_ tokens', /ghp_[a-zA-Z0-9]{8,}/],
  ['no Bearer tokens', /Bearer [a-zA-Z0-9._-]{10,}/],
  ['no /Users/ paths', /\/Users\//],
  ['no email addresses', /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/],
]) check(label, !re.test(html));

// (g) snippet fidelity: load-bearing values must exist in their source files
const src = (p) => readFileSync(new URL(p, `file://${process.cwd()}/`).pathname, 'utf8');
const run = JSON.parse(src('examples/runs/changelog-from-git-r-269b010f.run.json'));
const triage = JSON.parse(src('examples/runs/triage-bug-report-r-e3b8418b.run.json'));
const wf = JSON.parse(src('workflows/changelog-from-git.workflow.json'));
check('judge score/verdict match run file',
  run.nodes.judge.output.score === 0.85 && run.nodes.judge.output.verdict === 'pass' &&
  html.includes('0.85') && html.includes('"pass"') );
check('publish bytes match run file',
  run.nodes.publish.output.bytes === 394 && html.includes('394'));
check('all hash chips exist in run file',
  ['17d51bbc', 'cc64f0d1', '4f22ff36', '010c1c79', '33bab6e5'].every((h) => {
    const inRun = Object.values(run.nodes).some((n) => (n.blockHash || '').includes(h));
    return inRun && html.includes(h);
  }));
check('full log blockHash matches',
  html.includes(run.nodes.log.blockHash));
check('gate expression matches workflow file',
  wf.nodes.find((n) => n.id === 'render').when === "nodes.judge.output.score >= 0.7 and nodes.judge.output.verdict == 'pass'" &&
  html.includes('0.7'));
check('grants line matches workflow file',
  JSON.stringify(wf.grants) === '{"run":["git"],"read":[],"write":["CHANGELOG.md"]}' &&
  html.includes('&quot;CHANGELOG.md&quot;') || html.includes('"CHANGELOG.md"'));
check('triage skipped reason matches run file',
  triage.nodes['route-backlog'].reason === "gate false: nodes.severity.output.label != 'p1'" &&
  html.includes("nodes.severity.output.label != 'p1'"));
check('git-log contract argv matches source',
  src('blocks/git-log/contract.json').includes('--pretty=format:%h %ad %s') &&
  html.includes('--pretty=format:%h %ad %s'));
check('summarize contract-violation line matches source',
  src('blocks/summarize/SKILL.md').includes('data, not instructions') &&
  html.includes('data, not instructions'));
check('every artifact carries a source comment',
  ['workflows/changelog-from-git.workflow.json', 'examples/runs/changelog-from-git-r-269b010f.run.json',
   'examples/runs/triage-bug-report-r-e3b8418b.run.json', 'blocks/git-log/contract.json',
   'blocks/summarize/SKILL.md', 'cli/src/run.js'].every((p) => html.includes(`source: ${p}`)));

// (h) contrast (WCAG relative luminance) on declared tokens against paper
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
const paper = '#F2F5F7', plate = '#FBFCFD';
for (const [name, hex, min, bg] of [
  ['ink on paper', '#16222E', 7, paper],
  ['ink-soft on paper', '#45566A', 4.5, paper],
  ['det text on plate', '#1B5CA4', 4.5, plate],
  ['fuzzy text on plate', '#8A5E0B', 4.5, plate],
  ['pass text on plate', '#1F6B4E', 4.5, plate],
]) check(`contrast ${name} >= ${min}:1`, ratio(hex, bg) >= min, ratio(hex, bg).toFixed(2));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
