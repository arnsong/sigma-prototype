import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareQuery, splitStatements, stripComments } from '../src/sql.js';

test('strips comments but keeps strings and line positions', () => {
  assert.equal(stripComments("select '--not' -- yes\nfrom t"), "select '--not' \nfrom t");
  assert.equal(stripComments('a /* x\ny */ b'), 'a     \n     b');
});

test('splits statements on top-level semicolons only', () => {
  assert.deepEqual(splitStatements("select ';' ; select 2;"), ["select ';'", ' select 2']);
  assert.deepEqual(splitStatements('select 1; -- trailing;'), ['select 1']);
});

test('prepareQuery strips the trailing semicolon', () => {
  assert.equal(prepareQuery('SELECT 1;'), 'SELECT 1');
  assert.equal(prepareQuery('  (SELECT 1)'), '  (SELECT 1)');
});

test('prepareQuery rejects empty, multi and write statements', () => {
  assert.throws(() => prepareQuery('  -- nothing'), /empty/);
  assert.throws(() => prepareQuery('select 1; select 2'), /one statement/);
  assert.throws(() => prepareQuery('DROP TABLE x'), /read-only/);
  assert.throws(() => prepareQuery('/* hi */ insert into x values 1'), /read-only/);
  assert.throws(() => prepareQuery('EXPLAIN ANALYZE DELETE FROM x'), /read-only/);
  assert.equal(prepareQuery('delete from x', { allowWrites: true }), 'delete from x');
  assert.equal(prepareQuery('with a as (select 1) select * from a'), 'with a as (select 1) select * from a');
});
