import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yotoCatalog } from '../src/yoto-catalog.ts';

test('Yoto catalog exposes selection metadata without credentials or private media URLs', async () => {
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer example-token');
    if (String(url).includes('/devices/mine')) return new Response(JSON.stringify({ devices: [{ deviceId: 'example-player', name: 'Example player', online: true, privateField: 'private' }] }));
    return new Response(JSON.stringify({ cards: [{ cardId: 'example-card', familyId: 'private-family', card: { title: 'Example music', privateUrl: 'not-for-the-browser' } }] }));
  };
  const result = await yotoCatalog('example-token', new AbortController().signal, fetcher);
  assert.deepEqual(result.players, [{ id: 'example-player', name: 'Example player', online: true }]);
  assert.deepEqual(result.cards, [{ id: 'example-card', title: 'Example music', uri: 'https://yoto.io/example-card' }]);
  assert.ok(!JSON.stringify(result).includes('private-family'));
  assert.ok(!JSON.stringify(result).includes('example-token'));
});
