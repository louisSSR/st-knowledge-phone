import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ZimEngine, ZimTimeoutError } from '../dist/zim/engine.js';

const SILENT = Symbol('withhold worker response');

function archive(name = 'reference_2026-07.zim') {
  const header = new Uint8Array(80);
  header.set([0x5a, 0x49, 0x4d, 4]);
  const file = new File([header], name);
  file.arrayBuffer = () => { throw new Error('Must not copy the whole archive'); };
  return file;
}

function fixture(t, respond = () => undefined) {
  const workers = [], timers = [];
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  class ControlledWorker {
    terminated = false;
    listeners = new Map();
    requests = [];
    constructor() { workers.push(this); }
    addEventListener(kind, listener) { this.listeners.set(kind, listener); }
    postMessage(message, [port]) {
      this.requests.push({ message, port });
      const value = respond(message, workers.indexOf(this));
      if (value === SILENT) return;
      if (value !== undefined) port.postMessage(value);
      else if (message.action === 'init') port.postMessage('runtime initialized');
      else if (message.action === 'st-count') port.postMessage(8302);
    }
    terminate() { this.terminated = true; }
  }
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: ControlledWorker });
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    timers.push(timer);
    return timer;
  });
  t.mock.method(globalThis, 'clearTimeout', timer => { timer.cleared = true; });
  const engine = new ZimEngine();
  t.after(() => {
    engine.close();
    if (originalWorker) Object.defineProperty(globalThis, 'Worker', originalWorker);
    else delete globalThis.Worker;
  });
  const requested = async (action, worker) => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const request = (worker ?? workers.at(-1))?.requests.find(item => item.message.action === action);
      if (request) return request;
      await nextTurn();
    }
    assert.fail(`Worker did not receive ${action}`);
  };
  return { engine, workers, timers, requested };
}

test('a timed-out search fails once, interrupts other requests and retains the same File for the next request', { concurrency: false }, async t => {
  const file = archive();
  const { engine, workers, timers, requested } = fixture(t, (message, index) => {
    if (index === 1 && message.action === 'st-read') return { mimeType: 'text/html', data: new Uint8Array([65]) };
  });
  await engine.open(file);
  const search = engine.search('扑克');
  const read = engine.read('扑克');
  const searchFailure = assert.rejects(search, error => error instanceof ZimTimeoutError && error.action === 'st-search'
    && error.timeoutMs === 90000 && /全文搜索/.test(error.message) && /无需重新下载或选择/.test(error.message));
  const readFailure = assert.rejects(read, /其他操作超时.*已中断/);
  await requested('st-search');
  await requested('st-read');
  const firstActiveTimer = timers.find(timer => !timer.cleared);
  firstActiveTimer.callback();
  await Promise.all([searchFailure, readFailure]);
  assert.equal(engine.isOpen(), false);
  assert.equal(engine.recoverable(), true);
  assert.equal(workers[0].terminated, true);
  assert.equal(workers.length, 1, 'the failed query is not automatically replayed');
  const page = await engine.read('扑克');
  assert.deepEqual(page.data, new Uint8Array([65]));
  assert.equal(workers.length, 2);
  assert.equal(workers[1].requests[0].message.files[0], file, 'recovery uses the retained File directly');
  assert.equal(workers[1].requests.filter(item => item.message.action === 'st-search').length, 0);
  assert.equal(engine.isOpen(), true);
});

test('concurrent requests share one recovery and a cleared old timeout cannot terminate the replacement', { concurrency: false }, async t => {
  const { engine, workers, timers, requested } = fixture(t, (message, index) => {
    if (index === 1 && message.action === 'st-suggest') return [{ path: '扑克', title: '扑克' }];
    if (index === 1 && message.action === 'st-read') return { mimeType: 'text/html', data: new Uint8Array([66]) };
  });
  await engine.open(archive());
  const pending = engine.search('扑克');
  const failure = assert.rejects(pending, ZimTimeoutError);
  await requested('st-search');
  const oldTimer = timers.find(timer => !timer.cleared);
  oldTimer.callback();
  await failure;
  const [titles, page] = await Promise.all([engine.suggest('扑克'), engine.read('扑克')]);
  assert.equal(titles[0].title, '扑克');
  assert.equal(page.data[0], 66);
  assert.equal(workers.length, 2);
  oldTimer.callback();
  assert.equal(workers[1].terminated, false);
  assert.equal(engine.isOpen(), true);
});

test('cancelSearch releases a running search but leaves an ordinary read and idle engine alone', { concurrency: false }, async t => {
  const { engine, workers, requested } = fixture(t);
  await engine.open(archive());
  engine.cancelSearch();
  assert.equal(workers[0].terminated, false);
  const read = engine.read('扑克');
  const readRequest = await requested('st-read');
  engine.cancelSearch();
  assert.equal(workers[0].terminated, false);
  readRequest.port.postMessage({ mimeType: 'text/html', data: new Uint8Array([65]) });
  await read;
  const search = engine.search('扑克');
  const failure = assert.rejects(search, /搜索已取消/);
  await requested('st-search');
  engine.cancelSearch();
  await failure;
  assert.equal(workers[0].terminated, true);
  assert.equal(engine.recoverable(), true);
  await engine.ensureOpen();
  assert.equal(workers.length, 2);
});

test('cancelling before the ready promise resumes prevents a stale search from entering the worker', { concurrency: false }, async t => {
  const { engine, workers } = fixture(t);
  await engine.open(archive());
  const pending = engine.search('旧问题');
  const failure = assert.rejects(pending, /搜索已取消/);
  engine.cancelSearch();
  await failure;
  assert.equal(workers[0].requests.some(item => item.message.action === 'st-search'), false);
  assert.equal(engine.isOpen(), true);
});

test('explicit close forgets the file and cannot recover from a late old timeout', { concurrency: false }, async t => {
  const { engine, workers, timers, requested } = fixture(t);
  await engine.open(archive());
  const pending = engine.search('扑克');
  const failure = assert.rejects(pending, /已关闭/);
  await requested('st-search');
  const oldTimer = timers.find(timer => !timer.cleared);
  engine.close();
  await failure;
  oldTimer.callback();
  assert.equal(engine.recoverable(), false);
  await assert.rejects(engine.read('扑克'), /请先选择/);
  assert.equal(workers.length, 1);
});

test('each request timeout reports its actual operation and retained-file recovery stays bounded', { concurrency: false }, async t => {
  const { engine, workers, timers, requested } = fixture(t);
  await engine.open(archive());
  for (const [action, invoke, label] of [
    ['st-suggest', () => engine.suggest('扑克'), '标题搜索'],
    ['st-read', () => engine.read('扑克'), '原文读取'],
    ['st-stats', () => engine.diagnostics(), '状态读取'],
  ]) {
    const before = workers.length;
    const pending = invoke();
    const failure = assert.rejects(pending, error => error instanceof ZimTimeoutError && error.action === action && error.message.includes(label));
    // Recovery uses asynchronous MessagePorts for initialization before posting this operation.
    for (let attempt = 0; attempt < 20 && !workers.at(-1)?.requests.some(item => item.message.action === action); attempt++) await nextTurn();
    await requested(action);
    timers.find(timer => !timer.cleared).callback();
    await failure;
    assert.ok(workers.length <= before + 1, 'each request attempts initialization at most once');
    assert.equal(engine.recoverable(), true);
  }
});

test('initialization and directory timeouts identify the startup phase instead of calling it a search failure', { concurrency: false }, async t => {
  let blocked = 'init';
  const { engine, workers, timers, requested } = fixture(t, message => message.action === blocked ? SILENT : undefined);
  for (const [action, label, milliseconds] of [['init', '引擎初始化', 120000], ['st-count', '资料库目录读取', 90000]]) {
    blocked = action;
    const opening = engine.open(archive());
    const failure = assert.rejects(opening, error => error instanceof ZimTimeoutError && error.action === action
      && error.timeoutMs === milliseconds && error.message.includes(label));
    await requested(action);
    timers.find(timer => !timer.cleared).callback();
    await failure;
    assert.equal(engine.recoverable(), true);
    assert.equal(workers.at(-1).terminated, true);
  }
  assert.equal(workers.length, 2, 'initialization timeouts do not start a retry loop');
});

test('close during recovery cancels initialization and a new archive cannot be damaged by its late timer', { concurrency: false }, async t => {
  // Close before the asynchronous MessagePort initialization reply arrives.
  const { engine, workers, timers, requested } = fixture(t);
  await engine.open(archive('first_2026-07.zim'));
  const pending = engine.search('扑克');
  const failure = assert.rejects(pending, ZimTimeoutError);
  await requested('st-search');
  timers.find(timer => !timer.cleared).callback();
  await failure;
  const recovery = engine.ensureOpen();
  const cancelled = assert.rejects(recovery, /已关闭|取消/);
  const oldRecoveryTimer = timers.find(timer => !timer.cleared);
  engine.close();
  await cancelled;
  const next = archive('second_2026-08.zim');
  const info = await engine.open(next);
  oldRecoveryTimer.callback();
  assert.equal(info.name, next.name);
  assert.equal(workers.at(-1).terminated, false);
  assert.equal(engine.isOpen(), true);
});
