import { readFileSync } from 'node:fs';
const inputs = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const count = inputs.text.split(/\s+/).filter(Boolean).length;
process.stdout.write(JSON.stringify({ count }));
