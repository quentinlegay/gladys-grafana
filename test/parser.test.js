import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse, parseSelector, ParseError } from '../src/prometheus/parser.js';

test('a metric name with label matchers becomes a selector', () => {
  assert.deepEqual(parse('gladys_temperature_sensor_decimal{room="Salon", device=~"Th.*",}'), {
    type: 'selector',
    matchers: [
      { name: '__name__', op: '=', value: 'gladys_temperature_sensor_decimal' },
      { name: 'room', op: '=', value: 'Salon' },
      { name: 'device', op: '=~', value: 'Th.*' },
    ],
  });
});

test('a selector can have no metric name', () => {
  assert.deepEqual(parseSelector('{__name__="m", room!="Cave"}'), [
    { name: '__name__', op: '=', value: 'm' },
    { name: 'room', op: '!=', value: 'Cave' },
  ]);
});

test('aggregations accept the grouping before or after the expression', () => {
  const before = parse('avg by (room) (m)');
  const after = parse('avg(m) by (room)');
  assert.deepEqual(before, after);
  assert.equal(before.type, 'aggregation');
  assert.deepEqual(before.grouping, { mode: 'by', labels: ['room'] });
});

test('arithmetic follows the usual precedence', () => {
  const ast = parse('1 + 2 * m');
  assert.equal(ast.op, '+');
  assert.equal(ast.rhs.op, '*');
});

test('unary minus on a number folds into the literal', () => {
  assert.deepEqual(parse('-3'), { type: 'number', value: -3 });
  assert.deepEqual(parse('1+1'), {
    type: 'binary',
    op: '+',
    lhs: { type: 'number', value: 1 },
    rhs: { type: 'number', value: 1 },
  });
});

test('strings accept escapes and both quote styles', () => {
  assert.equal(parseSelector(`m{a='l\\'été', b="x\\"y"}`)[1].value, "l'été");
  assert.equal(parseSelector(`m{a='l\\'été', b="x\\"y"}`)[2].value, 'x"y');
});

test('comments are ignored', () => {
  assert.equal(parse('m # temperature\n').type, 'selector');
});

test('unsupported PromQL is rejected with an explicit message', () => {
  assert.throws(() => parse('rate(m[5m])'), /function "rate" is not supported/);
  assert.throws(() => parse('m[5m]'), /range vectors/);
  assert.throws(() => parse('m offset 1h'), /offset/);
  assert.throws(() => parse('m > 20'), /comparison operators/);
  assert.throws(() => parse('m and n'), /"and" is not supported/);
  assert.throws(() => parse(''), ParseError);
  assert.throws(() => parse('m{room=Salon}'), /quoted label value/);
  assert.throws(() => parseSelector('sum(m)'), /not a series selector/);
});
