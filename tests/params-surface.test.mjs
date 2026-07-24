import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ParamsSurfaceError,
  controlModel,
  normalizeCatalog,
  normalizedForOption,
  optionIndexForNormalized,
} from '../web/params-core.js';

const option = {
  index: 1, id: 'mode', type: 2, name: 'Mode', kind: 'option', normalized: 0.5,
  value_text: '2', min_text: '1', max_text: '3', formatted: 'B', behavior: '',
  writable: true, option_count: 3, options: ['A', 'B', 'C'],
};

test('catalog normalization preserves ordered typed items', () => {
  const catalog = normalizeCatalog({generation: '4', script: 'awake', items: [option]});
  assert.equal(catalog.items[0].id, 'mode');
  assert.deepEqual(catalog.items[0].options, ['A', 'B', 'C']);
});

test('option indices and normalized values round-trip', () => {
  for (let index = 1; index <= 5; index += 1) {
    assert.equal(optionIndexForNormalized(normalizedForOption(index, 5), 5), index);
  }
});

test('control model selects option, range, toggle, trigger and heading surfaces', () => {
  assert.equal(controlModel(option).surface, 'option');
  assert.equal(controlModel({...option, kind: 'control', options: [], option_count: 0}).surface, 'range');
  assert.equal(controlModel({...option, kind: 'binary', normalized: 1, options: [], option_count: 0}).checked, true);
  assert.equal(controlModel({...option, kind: 'trigger', options: [], option_count: 0}).surface, 'trigger');
  assert.equal(controlModel({...option, kind: 'group', options: [], option_count: 0}).surface, 'heading');
});

test('incomplete options and non-contiguous indices reject', () => {
  assert.throws(() => normalizeCatalog({generation: '1', script: 'x', items: [{...option, option_count: 4}]}), ParamsSurfaceError);
  assert.throws(() => normalizeCatalog({generation: '1', script: 'x', items: [{...option, index: 2}]}), ParamsSurfaceError);
});

test('invalid option selections reject', () => {
  assert.throws(() => normalizedForOption(0, 3), ParamsSurfaceError);
  assert.throws(() => optionIndexForNormalized(1.2, 3), ParamsSurfaceError);
});
