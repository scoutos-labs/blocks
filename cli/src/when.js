// Gates: the deliberately tiny `when` grammar from SPEC.md §5 / PROTOCOL §8.
// expr = clause { ("and"|"or") clause } ; clause = operand op literal ;
// operand = ["#"] ref. Not an expression language, and it must never become one.

import { parseRef, digPath } from './bindings.js';

const OPS = ['==', '!=', '>=', '<=', '>', '<'];
const ORDERING = new Set(['>=', '<=', '>', '<']);

function tokenize(text) {
  const tokens = [];
  let rest = text.trim();
  while (rest.length > 0) {
    const ws = rest.match(/^\s+/);
    if (ws) { rest = rest.slice(ws[0].length); continue; }
    const op = OPS.find((o) => rest.startsWith(o));
    if (op) { tokens.push({ op }); rest = rest.slice(op.length); continue; }
    if (rest[0] === '#') {
      // the length modifier hugs its ref: "# ref" is a parse error (PROTOCOL [GAT-9])
      const hugged = rest.slice(1).match(/^[a-zA-Z_][a-zA-Z0-9_.-]*/);
      if (!hugged) throw new Error('"#" must be immediately followed by a ref (no whitespace)');
      tokens.push({ ref: hugged[0], length: true });
      rest = rest.slice(1 + hugged[0].length);
      continue;
    }
    const str = rest.match(/^'([^']*)'/);
    if (str) { tokens.push({ literal: str[1] }); rest = rest.slice(str[0].length); continue; }
    const num = rest.match(/^-?\d+(\.\d+)?/);
    if (num) { tokens.push({ literal: Number(num[0]) }); rest = rest.slice(num[0].length); continue; }
    const word = rest.match(/^[a-zA-Z_][a-zA-Z0-9_.-]*/);
    if (word) {
      const w = word[0];
      if (w === 'and' || w === 'or') tokens.push({ join: w });
      else if (w === 'contains') tokens.push({ op: 'contains' });
      else if (w === 'true' || w === 'false') tokens.push({ literal: w === 'true' });
      else tokens.push({ ref: w });
      rest = rest.slice(w.length);
      continue;
    }
    throw new Error(`unexpected character "${rest[0]}" in gate`);
  }
  return tokens;
}

// Parse to { clauses: [{ref, op, literal}], joins: ['and'|'or', ...] }.
export function parseWhen(text) {
  const tokens = tokenize(text);
  const clauses = [];
  const joins = [];
  let i = 0;
  const expectClause = () => {
    const refTok = tokens[i++];
    if (!refTok?.ref) throw new Error('gate clause must start with a ref like nodes.<id>.output.<field>');
    const ref = parseRef(refTok.ref);
    if (!ref) throw new Error(`invalid gate ref "${refTok.ref}" — use inputs.<key> or nodes.<id>.output.<field>`);
    const opTok = tokens[i++];
    if (!opTok?.op) throw new Error(`expected comparison operator after "${refTok.ref}" (one of ${OPS.join(' ')} contains)`);
    const litTok = tokens[i++];
    if (!litTok || litTok.literal === undefined) {
      throw new Error(`expected a literal (number, 'string', true, false) after "${opTok.op}"`);
    }
    if (ORDERING.has(opTok.op) && typeof litTok.literal !== 'number') {
      throw new Error(`ordering comparison "${opTok.op}" requires a number literal`);
    }
    if (opTok.op === 'contains' && refTok.length) {
      throw new Error('"#ref contains ..." is invalid — the length modifier yields a number (PROTOCOL [GAT-10])');
    }
    clauses.push({
      ref, op: opTok.op, literal: litTok.literal,
      ordering: ORDERING.has(opTok.op),
      length: refTok.length === true,
    });
  };
  expectClause();
  while (i < tokens.length) {
    const j = tokens[i++];
    if (!j?.join) throw new Error('clauses must be joined with "and" or "or"');
    joins.push(j.join);
    expectClause();
  }
  return { clauses, joins };
}

// Evaluate with left-associative, equal-precedence joins (SPEC §5).
// A ref into a skipped/missing node output makes the clause false.
export function evalWhen(ast, ctx) {
  const clauseValue = (clause) => {
    let left;
    if (clause.ref.kind === 'input') {
      if (!(clause.ref.key in ctx.inputs)) return false;
      left = ctx.inputs[clause.ref.key];
    } else {
      const output = ctx.nodeOutputs[clause.ref.node];
      if (output === undefined) return false;
      const dug = digPath(output, clause.ref.path);
      if ('missing' in dug) return false;
      left = dug.value;
    }
    if (clause.length) {
      // PROTOCOL [GAT-9]: strings measure in Unicode code points; arrays in
      // elements; anything else makes the clause false.
      if (typeof left === 'string') left = [...left].length;
      else if (Array.isArray(left)) left = left.length;
      else return false;
    }
    if (clause.op === 'contains') {
      // PROTOCOL [GAT-8]: substring for strings (string literals only),
      // strict scalar membership for arrays, false for every other shape.
      if (typeof left === 'string') {
        return typeof clause.literal === 'string' && left.includes(clause.literal);
      }
      if (Array.isArray(left)) return left.some((el) => el === clause.literal);
      return false;
    }
    if (clause.ordering) {
      if (typeof left !== 'number') return false;
      switch (clause.op) {
        case '>=': return left >= clause.literal;
        case '<=': return left <= clause.literal;
        case '>': return left > clause.literal;
        case '<': return left < clause.literal;
      }
    }
    return clause.op === '==' ? left === clause.literal : left !== clause.literal;
  };
  let acc = clauseValue(ast.clauses[0]);
  for (let k = 0; k < ast.joins.length; k++) {
    const next = clauseValue(ast.clauses[k + 1]);
    acc = ast.joins[k] === 'and' ? (acc && next) : (acc || next);
  }
  return acc;
}
