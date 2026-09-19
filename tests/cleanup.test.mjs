import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { clearDatabase, openDatabase, DB_NAME, DB_VERSION, STORE_NAMES } from '../dist/library/storage.js';
import { onClean, onDelete } from '../index.js';

// Control commit/abort independently of requests to catch premature cleanup success.
function databaseFixture(t, { openError, blocked = false, transactionError, clearError } = {}) {
  const original = globalThis.indexedDB;
  t.after(() => {
    if (original === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = original;
  });
  const names = [...Object.values(STORE_NAMES), 'future-extension-store'];
  const rows = new Map(names.map(name => [name, [`saved-${name}`]]));
  rows.set(STORE_NAMES.values, ['preferences', 'bookmarks', 'history', 'chat-context']);
  const unrelated = new Map([['private-host-data', ['untouched']]]);
  const fixture = { opens: [], transactions: [], closed: 0, rows, unrelated, opening: null };
  const database = {
    objectStoreNames: names,
    close() { fixture.closed++; },
    transaction(requestedNames, mode) {
      assert.deepEqual(requestedNames, names);
      assert.equal(mode, 'readwrite');
      if (transactionError) throw transactionError;
      const cleared = [];
      const transaction = {
        cleared,
        error: null,
        aborted: false,
        objectStore(name) {
          assert.ok(names.includes(name));
          return { clear() {
            if (clearError && name === STORE_NAMES.values) throw clearError;
            cleared.push(name);
          } };
        },
        commit() {
          assert.equal(transaction.aborted, false);
          for (const name of cleared) rows.set(name, []);
          transaction.oncomplete();
        },
        abort(error = null) {
          transaction.aborted = true;
          transaction.error = error;
          queueMicrotask(() => transaction.onabort());
        },
      };
      fixture.transactions.push(transaction);
      return transaction;
    },
  };
  fixture.database = database;
  globalThis.indexedDB = {
    open(name, version) {
      fixture.opens.push([name, version]);
      const opening = { result: database, error: openError };
      fixture.opening = opening;
      queueMicrotask(() => {
        if (blocked) opening.onblocked();
        else if (openError) opening.onerror();
        else opening.onsuccess();
      });
      return opening;
    },
    deleteDatabase() { assert.fail('Cleanup must not queue a blocked database deletion'); },
  };
  return fixture;
}

test('clean hook clears every owned store only after atomic commit, including personal values', async t => {
  const fixture = databaseFixture(t);
  let settled = false;
  const cleaning = onClean().then(() => { settled = true; });
  await setImmediate();
  assert.deepEqual(fixture.opens, [[DB_NAME, DB_VERSION]]);
  assert.equal(fixture.transactions.length, 1);
  assert.equal(settled, false);
  assert.equal(fixture.closed, 0);
  assert.deepEqual(fixture.rows.get(STORE_NAMES.values), ['preferences', 'bookmarks', 'history', 'chat-context']);
  fixture.transactions[0].commit();
  await cleaning;
  assert.equal(settled, true);
  assert.ok([...fixture.rows.values()].every(records => records.length === 0));
  assert.deepEqual([...fixture.unrelated], [['private-host-data', ['untouched']]]);
  assert.equal(fixture.closed, 1);
});

test('clean rejects a transaction abort and leaves all data intact', async t => {
  const fixture = databaseFixture(t);
  const before = structuredClone(fixture.rows);
  const failure = new DOMException('Storage write failed', 'UnknownError');
  const cleaning = clearDatabase();
  const rejected = assert.rejects(cleaning, error => error === failure);
  await setImmediate();
  fixture.transactions[0].abort(failure);
  await rejected;
  assert.deepEqual(fixture.rows, before);
  assert.equal(fixture.closed, 1);
});

test('clear request setup failure aborts earlier clears instead of partially erasing data', async t => {
  const failure = new Error('Cannot clear values');
  const fixture = databaseFixture(t, { clearError: failure });
  const before = structuredClone(fixture.rows);
  await assert.rejects(clearDatabase(), error => error === failure);
  assert.equal(fixture.transactions[0].aborted, true);
  assert.ok(fixture.transactions[0].cleared.length > 0);
  assert.deepEqual(fixture.rows, before);
  assert.equal(fixture.closed, 1);
});

test('transaction creation failure closes the opened connection and rejects', async t => {
  const failure = new DOMException('Connection closing', 'InvalidStateError');
  const fixture = databaseFixture(t, { transactionError: failure });
  await assert.rejects(clearDatabase(), error => error === failure);
  assert.equal(fixture.closed, 1);
  assert.equal(fixture.transactions.length, 0);
});

test('clean hook propagates an IndexedDB open error without reporting success', async t => {
  const failure = new DOMException('IndexedDB unavailable', 'SecurityError');
  const fixture = databaseFixture(t, { openError: failure });
  await assert.rejects(onClean(), error => error === failure);
  assert.equal(fixture.transactions.length, 0);
});

test('blocked opening rejects promptly and late success closes without delayed clearing', async t => {
  const fixture = databaseFixture(t, { blocked: true });
  const before = structuredClone(fixture.rows);
  await assert.rejects(clearDatabase(), /其他页面占用/);
  fixture.opening.onsuccess();
  assert.equal(fixture.closed, 1);
  assert.equal(fixture.transactions.length, 0);
  assert.deepEqual(fixture.rows, before);
});

test('database connections close on another tab version change', async t => {
  const fixture = databaseFixture(t);
  const database = await openDatabase();
  database.onversionchange();
  assert.equal(fixture.closed, 1);
});

test('delete hook preserves data unless the host explicitly invokes clean', t => {
  const fixture = databaseFixture(t);
  const before = structuredClone(fixture.rows);
  onDelete();
  assert.equal(fixture.opens.length, 0);
  assert.deepEqual(fixture.rows, before);
});
