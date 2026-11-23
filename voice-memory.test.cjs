const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./voice-memory.cjs');
const { randomUUID } = require('node:crypto');
test('atomic token limit, confirmation retries, stale edits and separate profiles', () => {
  const store = new MemoryStore(':memory:');
  const id = randomUUID(), text = 'Testnotiz';
  const add = { op:'add',id,text };
  store.change('a',add); store.change('a',add);
  assert.equal(store.read('a').items.length,1);
  assert.equal(store.read('b').used,0);
  assert.throws(()=>store.change('a',{op:'edit',id,text:' x'.repeat(10000),previous:text}),/voll/);
  assert.equal(store.read('a').items[0].text,text);
  store.change('a',{op:'edit',id,text:'Neu',previous:text});
  assert.throws(()=>store.change('a',{op:'delete',id,previous:text}),/geändert/);
  store.change('a',{op:'delete',id,previous:'Neu'});
  assert.equal(store.read('a').used,0);
  store.db.close();
});
