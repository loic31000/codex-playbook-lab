const test = require('node:test');
const assert = require('node:assert/strict');
const { add } = require('../src/math.cjs');

test('add additionne deux nombres', () => {
  assert.equal(add(2, 3), 5);
  assert.equal(add(-2, 1), -1);
});
