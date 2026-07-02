import { readFileSync } from 'node:fs';

const { template, values } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const text = template.replace(/\{([a-zA-Z_][a-zA-Z0-9_-]*)\}/g, (m, key) => {
  const v = values[key];
  if (v === undefined) {
    process.stderr.write(`template slot {${key}} has no value (have: ${Object.keys(values).join(', ')})\n`);
    process.exit(1);
  }
  if (typeof v === 'object') {
    process.stderr.write(`template slot {${key}} got a non-scalar value\n`);
    process.exit(1);
  }
  return String(v);
});
process.stdout.write(JSON.stringify({ text }));
