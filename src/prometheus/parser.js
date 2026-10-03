// -----------------------------------------------------------------------------
// Parser of the PromQL subset understood by the Gladys data source.
//
// Supported:
//   - selectors          gladys_temperature_sensor_decimal{room="Salon", device=~"Th.*"}
//   - number literals    42, 1.5e3
//   - aggregations       sum | avg | min | max | count  [by|without (labels)] (expr)
//   - functions          abs, ceil, floor, round, clamp_min, clamp_max
//   - arithmetic         + - * / %  (vector/scalar and one-to-one vector/vector)
//   - parentheses, unary minus, # comments
//
// Anything else (range vectors [5m], offset, rate(), comparisons…) is
// rejected with an explicit message, shown by Grafana under the query.
// -----------------------------------------------------------------------------

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ParseError';
  }
}

export const AGGREGATIONS = new Set(['sum', 'avg', 'min', 'max', 'count']);
export const FUNCTIONS = {
  abs: 1,
  ceil: 1,
  floor: 1,
  round: [1, 2],
  clamp_min: 2,
  clamp_max: 2,
};

const IDENT_START = /[a-zA-Z_:]/;
const IDENT_PART = /[a-zA-Z0-9_:]/;
const NUMBER =
  /^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[nN][aA][nN]|[iI][nN][fF])/;

function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
    } else if (c === '"' || c === "'" || c === '`') {
      let value = '';
      let j = i + 1;
      while (j < input.length && input[j] !== c) {
        if (input[j] === '\\' && c !== '`') {
          const next = input[j + 1];
          value +=
            { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', "'": "'" }[next] ?? `\\${next}`;
          j += 2;
        } else {
          value += input[j];
          j += 1;
        }
      }
      if (j >= input.length) throw new ParseError('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
    } else if (/[0-9.]/.test(c) && NUMBER.test(input.slice(i))) {
      const [raw] = input.slice(i).match(NUMBER);
      tokens.push({ kind: 'number', value: Number(raw) });
      i += raw.length;
    } else if (IDENT_START.test(c)) {
      let j = i + 1;
      while (j < input.length && IDENT_PART.test(input[j])) j += 1;
      const word = input.slice(i, j);
      // NaN / Inf are number literals, not identifiers.
      if (/^(nan|inf)$/i.test(word))
        tokens.push({
          kind: 'number',
          value: Number(word.replace(/inf/i, 'Infinity').replace(/nan/i, 'NaN')),
        });
      else tokens.push({ kind: 'ident', value: word });
      i = j;
    } else {
      const two = input.slice(i, i + 2);
      if (['!=', '=~', '!~', '==', '>=', '<='].includes(two)) {
        tokens.push({ kind: 'op', value: two });
        i += 2;
      } else if ('{}(),[]=+-*/%^<>@'.includes(c)) {
        tokens.push({ kind: 'op', value: c });
        i += 1;
      } else {
        throw new ParseError(`unexpected character "${c}"`);
      }
    }
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

class Parser {
  constructor(input) {
    this.tokens = tokenize(input);
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  isOp(value) {
    const t = this.peek();
    return t.kind === 'op' && t.value === value;
  }

  expectOp(value) {
    const t = this.next();
    if (t.kind !== 'op' || t.value !== value) {
      throw new ParseError(`expected "${value}" but found ${describe(t)}`);
    }
  }

  parse() {
    const expr = this.parseAdditive();
    const t = this.peek();
    if (t.kind !== 'eof') throw unsupportedAfter(t);
    return expr;
  }

  parseAdditive() {
    let lhs = this.parseMultiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().value;
      lhs = { type: 'binary', op, lhs, rhs: this.parseMultiplicative() };
    }
    return lhs;
  }

  parseMultiplicative() {
    let lhs = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().value;
      lhs = { type: 'binary', op, lhs, rhs: this.parseUnary() };
    }
    return lhs;
  }

  parseUnary() {
    if (this.isOp('-') || this.isOp('+')) {
      const op = this.next().value;
      const expr = this.parseUnary();
      if (op === '+') return expr;
      if (expr.type === 'number') return { type: 'number', value: -expr.value };
      return { type: 'binary', op: '*', lhs: { type: 'number', value: -1 }, rhs: expr };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parsePostfix(expr) {
    if (this.isOp('[')) {
      throw new ParseError(
        'range vectors ([5m]) are not supported: Gladys already aggregates the history to the panel resolution',
      );
    }
    const t = this.peek();
    if (t.kind === 'ident' && t.value === 'offset') {
      throw new ParseError('"offset" is not supported: use the panel time shift instead');
    }
    return expr;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.kind === 'number') {
      this.next();
      return { type: 'number', value: t.value };
    }
    if (t.kind === 'string') {
      throw new ParseError('string literals are not supported as a query');
    }
    if (this.isOp('(')) {
      this.next();
      const expr = this.parseAdditive();
      this.expectOp(')');
      return expr;
    }
    if (this.isOp('{')) {
      return { type: 'selector', matchers: this.parseMatchers() };
    }
    if (t.kind === 'ident') {
      this.next();
      if (AGGREGATIONS.has(t.value) && (this.isOp('(') || isGroupingKeyword(this.peek()))) {
        return this.parseAggregation(t.value);
      }
      if (this.isOp('(')) {
        return this.parseCall(t.value);
      }
      const matchers = [{ name: '__name__', op: '=', value: t.value }];
      if (this.isOp('{')) matchers.push(...this.parseMatchers());
      return { type: 'selector', matchers };
    }
    throw new ParseError(`unexpected ${describe(t)}`);
  }

  parseMatchers() {
    this.expectOp('{');
    const matchers = [];
    while (!this.isOp('}')) {
      const name = this.next();
      if (name.kind !== 'ident')
        throw new ParseError(`expected a label name, found ${describe(name)}`);
      const op = this.next();
      if (op.kind !== 'op' || !['=', '!=', '=~', '!~'].includes(op.value)) {
        throw new ParseError(`expected a label matcher (=, !=, =~, !~), found ${describe(op)}`);
      }
      const value = this.next();
      if (value.kind !== 'string')
        throw new ParseError(`expected a quoted label value, found ${describe(value)}`);
      matchers.push({ name: name.value, op: op.value, value: value.value });
      if (!this.isOp(',')) break;
      this.next();
    }
    this.expectOp('}');
    return matchers;
  }

  parseGrouping() {
    const mode = this.next().value;
    this.expectOp('(');
    const labels = [];
    while (!this.isOp(')')) {
      const label = this.next();
      if (label.kind !== 'ident')
        throw new ParseError(`expected a label name, found ${describe(label)}`);
      labels.push(label.value);
      if (!this.isOp(',')) break;
      this.next();
    }
    this.expectOp(')');
    return { mode, labels };
  }

  parseAggregation(op) {
    let grouping = null;
    if (isGroupingKeyword(this.peek())) grouping = this.parseGrouping();
    this.expectOp('(');
    const expr = this.parseAdditive();
    if (this.isOp(',')) throw new ParseError(`"${op}" takes a single argument`);
    this.expectOp(')');
    if (isGroupingKeyword(this.peek())) {
      if (grouping) throw new ParseError('grouping declared twice');
      grouping = this.parseGrouping();
    }
    return { type: 'aggregation', op, grouping, expr };
  }

  parseCall(name) {
    const arity = FUNCTIONS[name];
    if (arity === undefined) {
      throw new ParseError(
        `function "${name}" is not supported (available: ${[...AGGREGATIONS, ...Object.keys(FUNCTIONS)].join(', ')})`,
      );
    }
    this.expectOp('(');
    const args = [];
    while (!this.isOp(')')) {
      args.push(this.parseAdditive());
      if (!this.isOp(',')) break;
      this.next();
    }
    this.expectOp(')');
    const [minArgs, maxArgs] = Array.isArray(arity) ? arity : [arity, arity];
    if (args.length < minArgs || args.length > maxArgs) {
      throw new ParseError(`wrong number of arguments for "${name}"`);
    }
    return { type: 'call', name, args };
  }
}

function isGroupingKeyword(t) {
  return t.kind === 'ident' && (t.value === 'by' || t.value === 'without');
}

function describe(t) {
  if (t.kind === 'eof') return 'end of query';
  if (t.kind === 'string') return `string "${t.value}"`;
  return `"${t.value}"`;
}

function unsupportedAfter(t) {
  if (t.kind === 'op' && ['==', '!=', '>', '<', '>=', '<='].includes(t.value)) {
    return new ParseError('comparison operators are not supported: use Grafana thresholds instead');
  }
  if (t.kind === 'op' && t.value === '^') return new ParseError('"^" is not supported');
  if (
    t.kind === 'ident' &&
    ['and', 'or', 'unless', 'on', 'ignoring', 'group_left', 'group_right', 'bool'].includes(t.value)
  ) {
    return new ParseError(`"${t.value}" is not supported`);
  }
  return new ParseError(`unexpected ${describe(t)}`);
}

/** Parse a query into an AST. Throws ParseError. */
export function parse(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new ParseError('empty query');
  return new Parser(input).parse();
}

/** Parse a `match[]` series selector (used by the label/series endpoints). */
export function parseSelector(input) {
  const ast = parse(input);
  if (ast.type !== 'selector') throw new ParseError(`"${input}" is not a series selector`);
  return ast.matchers;
}
