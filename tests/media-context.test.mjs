import test from 'node:test';
import assert from 'node:assert/strict';
import { linkParts, formatMedia } from '../scripts/lib/media-context.mjs';
import { withMediaContext } from '../scripts/lib/corpus.mjs';
import { renderSearch } from '../scripts/lib/render.mjs';

const links = [{ url: 'https://example.com/park', title: 'Wetland walk', summary: 'Meet Friday' }];
test('web previews keep their source, limits, and quoted-evidence labels', () => {
  const parts = linkParts([...links, { url: 'file:///private/path', title: 'no' }, { url: 'https://user:secret@example.com', title: 'no' }]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].source, 'beeper-preview');
  assert.match(formatMedia(parts), /quoted evidence, not the full page/);
  assert.match(formatMedia(parts), /https:\/\/example.com\/park/);
  assert.equal(linkParts([{ url: 'https://example.com', summary: 'x'.repeat(5000) }])[0].text.length, 3000);
  assert.deepEqual(linkParts(null), []);
});
test('live previews work without a Corpus and hidden or deleted messages never acquire context', async () => {
  const path = '/does-not-exist/media-test-corpus.db';
  const messages = await withMediaContext('chat', [
    { id: 'a', text: 'look at this', links },
    { id: 'b', text: 'deleted', links, isDeleted: true, mediaContext: 'stale' },
    { id: 'c', text: 'hidden', links, isHidden: true, mediaContext: 'stale' },
  ], path);
  assert.equal(messages[0].text, 'look at this');
  assert.match(messages[0].mediaContext, /Wetland walk/);
  assert.equal(messages[1].mediaContext, undefined);
  assert.equal(messages[2].mediaContext, undefined);
});
test('search renders authored words and media evidence once each', () => {
  const output = renderSearch({ query: 'wetland', items: [{ id: 'a', chatID: 'chat', text: 'look at this', timestamp: '2026-10-10T12:00:00Z', mediaContext: formatMedia(linkParts(links)) }], chats: { chat: { id: 'chat', title: 'Synthetic Chat', network: 'Signal', type: 'single' } } });
  assert.equal(output.split('Wetland walk').length - 1, 1);
  assert.equal(output.split('look at this').length - 1, 1);
  assert.match(output, /quoted evidence/);
});
