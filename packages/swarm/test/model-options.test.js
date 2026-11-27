import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelOptions, normalizeModelOptions } from '../src/model-options.js';

const route = (provider, model) => ({ provider, model });

test('model options default to an empty list', () => {
  assert.deepEqual(normalizeModelOptions(undefined), []);
  assert.deepEqual(normalizeModelOptions([]), []);
});

test('model options accept provider/model routes and copy them', () => {
  const input = [route('deepseek', 'deepseek-v4.1'), route('subscription-xai', 'grok-4.7')];
  const options = normalizeModelOptions(input);
  assert.deepEqual(options, input);
  assert.notEqual(options[0], input[0]);
});

test('model options reject malformed or excessive lists', () => {
  assert.throws(() => normalizeModelOptions(null), /array/);
  assert.throws(() => normalizeModelOptions({}), /array/);
  assert.throws(() => normalizeModelOptions(Array.from({ length: 17 }, (_, i) => route('p', `m${i}`))), /at most 16/);
  assert.throws(() => normalizeModelOptions([{ provider: 'p', model: 'm', extra: true }]), /unknown field/);
  assert.throws(() => normalizeModelOptions([{ provider: '', model: 'm' }]), /invalid provider/);
  assert.throws(() => normalizeModelOptions([{ provider: 'p', model: 'has space' }]), /invalid model/);
  assert.throws(() => normalizeModelOptions([route('p', 'm'), route('p', 'm')]), /duplicate/);
});

test('model options store reads and writes one profile-level record', async () => {
  const table = new Map();
  let writes = 0;
  const store = {
    get: key => table.get(key),
    async transact(key, fn) {
      writes++;
      const { state, result } = fn();
      table.set(key, state);
      return result;
    },
  };
  const options = createModelOptions(store);
  assert.deepEqual(options.read(), []);
  const saved = await options.write([route('deepseek', 'deepseek-v4.1')]);
  assert.deepEqual(saved, [route('deepseek', 'deepseek-v4.1')]);
  assert.deepEqual(options.read(), saved);
  assert.equal(writes, 1);
  await assert.rejects(options.write([route('p', 'm'), route('p', 'm')]), /duplicate/);
  assert.equal(writes, 1);
});
