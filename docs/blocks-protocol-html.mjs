// Generate a self-contained HTML rendering of PROTOCOL.md for publication.
// PROTOCOL.md is the single source of truth; this output is never hand-edited.
// Usage: node docs/blocks-protocol-html.mjs PROTOCOL.md > out.html
import { readFileSync } from 'node:fs';

const md = readFileSync(process.argv[2] ?? 'PROTOCOL.md', 'utf8');
const draftMeta = /^\*\*Draft (\d+) · (\d{4}-\d{2}-\d{2}) ·/m.exec(md);
if (!draftMeta) throw new Error('PROTOCOL.md is missing its Draft NN · YYYY-MM-DD banner');
const [, draft, draftDate] = draftMeta;

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// GitHub-style anchor slugs (same algorithm as the consistency harness)
const slug = (t) => t.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/ /g, '-');

// inline: code spans first (their content is literal), then bold, then links
function inline(s) {
  const parts = s.split(/(`[^`]*`)/);
  return parts.map((p) => {
    if (p.startsWith('`') && p.endsWith('`') && p.length > 1) return `<code>${esc(p.slice(1, -1))}</code>`;
    let t = esc(p);
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\[([^\]]+)\]\((#[^)]+|https?:[^)]+)\)/g, '<a href="$2">$1</a>');
    t = t.replace(/\[([A-Z]{3}-\d+)\]/g, '<span class="rid">[$1]</span>');
    return t;
  }).join('');
}

const lines = md.split('\n');
const out = [];
let i = 0;
let para = [];
const flush = () => {
  if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
};

while (i < lines.length) {
  const line = lines[i];

  if (line.startsWith('```')) {
    flush();
    const buf = [];
    i++;
    while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
    i++;
    out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
    continue;
  }
  if (/^#{1,3} /.test(line)) {
    flush();
    const level = line.match(/^#+/)[0].length;
    const text = line.replace(/^#+ /, '');
    out.push(`<h${level} id="${slug(text)}">${inline(text)}</h${level}>`);
    i++;
    continue;
  }
  if (/^---+$/.test(line.trim())) { flush(); out.push('<hr>'); i++; continue; }
  if (line.startsWith('> ')) {
    flush();
    const buf = [];
    while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^> ?/, ''));
    out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
    continue;
  }
  if (/^\|/.test(line)) {
    flush();
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
    const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    out.push('<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
      + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
      + '</tbody></table>');
    continue;
  }
  if (/^- /.test(line)) {
    flush();
    const items = [];
    while (i < lines.length && (/^- /.test(lines[i]) || /^  \S/.test(lines[i]))) {
      if (/^- /.test(lines[i])) items.push(lines[i].slice(2));
      else items[items.length - 1] += ' ' + lines[i].trim();
      i++;
    }
    out.push('<ul>' + items.map((x) => `<li>${inline(x)}</li>`).join('') + '</ul>');
    continue;
  }
  if (/^\d+\. /.test(line)) {
    flush();
    const items = [];
    while (i < lines.length && (/^\d+\. /.test(lines[i]) || /^   \S/.test(lines[i]))) {
      if (/^\d+\. /.test(lines[i])) items.push(lines[i].replace(/^\d+\. /, ''));
      else items[items.length - 1] += ' ' + lines[i].trim();
      i++;
    }
    out.push('<ol>' + items.map((x) => `<li>${inline(x)}</li>`).join('') + '</ol>');
    continue;
  }
  if (line.trim() === '') { flush(); i++; continue; }
  para.push(line.trim());
  i++;
}
flush();

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Blocks Skill Protocol — Draft ${draft}</title>
<meta name="description" content="Interoperability specification for the Blocks skill protocol: skill-shaped blocks, deterministic DAG workflows, runners, oracles, and composers. Draft ${draft}.">
<style>
  :root { --paper:#F2F5F7; --ink:#16222E; --soft:#45566A; --det:#1B5CA4; --rule:#C2CEDA; --plate:#FBFCFD;
          --mono: ui-monospace,"SF Mono",Menlo,Consolas,monospace;
          --body: "Seravek","Avenir Next","Segoe UI",system-ui,-apple-system,sans-serif; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font:16px/1.65 var(--body); }
  main { max-width:820px; margin:0 auto; padding:24px 20px 96px; }
  .draft-banner { border:1.5px solid var(--ink); background:var(--plate); font-family:var(--mono);
    font-size:12px; letter-spacing:.14em; padding:10px 14px; margin:8px 0 30px; }
  h1 { font-family:var(--mono); font-size:clamp(22px,4vw,30px); letter-spacing:.04em; line-height:1.25; }
  h2 { font-family:var(--mono); font-size:15px; letter-spacing:.12em; border-top:1.5px solid var(--ink);
       padding-top:10px; margin-top:56px; text-transform:uppercase; }
  h3 { font-family:var(--mono); font-size:13.5px; letter-spacing:.08em; margin-top:32px; }
  p, li { max-width:70ch; }
  code { font-family:var(--mono); font-size:.84em; background:#E3ECF6; padding:.08em .35em; border-radius:3px; }
  pre { font-family:var(--mono); font-size:12.5px; line-height:1.6; background:var(--plate);
        border:1px solid var(--ink); padding:14px 16px; overflow-x:auto; }
  pre code { background:none; padding:0; }
  blockquote { margin:24px 0; border-left:3px solid var(--ink); padding:4px 0 4px 20px; font-family:var(--mono); font-size:14.5px; }
  table { border-collapse:collapse; width:100%; margin:18px 0; background:var(--plate); font-size:.9em; }
  th, td { border:1px solid var(--rule); padding:.45rem .6rem; text-align:left; vertical-align:top; }
  th { background:#E9EEF3; font-family:var(--mono); font-size:.82em; letter-spacing:.08em; }
  .rid { font-family:var(--mono); font-size:.85em; color:var(--det); font-weight:600; white-space:nowrap; }
  a { color:var(--det); }
  hr { border:none; border-top:1px solid var(--rule); margin:40px 0; }
  :focus-visible { outline:2px solid var(--det); outline-offset:2px; }
</style>
</head>
<body>
<main>
<div class="draft-banner">DRAFT ${draft} · ${draftDate} · THE BLOCKS SKILL PROTOCOL · EXPECT BREAKING CHANGES · SOURCE OF TRUTH: PROTOCOL.md</div>
${out.join('\n')}
</main>
</body>
</html>
`;
process.stdout.write(html);
