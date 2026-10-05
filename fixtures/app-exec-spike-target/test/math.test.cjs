'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { add } = require('../src/math.cjs');

test('add additionne deux nombres', () => {
  assert.equal(add(7, 5), 12);
});
