import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { maybeNotifyManagerOfResign } from '../employee.service.js';

const NOW = new Date('2026-06-23T10:00:00.000Z');
const daysFromNow = (n) => new Date(NOW.getTime() + n * 86400000);

const makeSpy = () => {
  const calls = [];
  const fn = async (...args) => { calls.push(args); };
  fn.calls = calls;
  return fn;
};

describe('maybeNotifyManagerOfResign', () => {
  it('notifies manager when resignDate within 30 days', async () => {
    const spy = makeSpy();
    await maybeNotifyManagerOfResign(
      { fullName: 'Amit', resignDate: daysFromNow(10), reportingManager: 'mgr1' }, NOW, spy
    );
    assert.equal(spy.calls.length, 1);
    const [userId, opts] = spy.calls[0];
    assert.equal(String(userId), 'mgr1');
    assert.equal(opts.type, 'task');
    assert.match(opts.message, /Amit/);
  });

  it('does not notify when already resigned (past date)', async () => {
    const spy = makeSpy();
    await maybeNotifyManagerOfResign(
      { fullName: 'Amit', resignDate: daysFromNow(-1), reportingManager: 'mgr1' }, NOW, spy
    );
    assert.equal(spy.calls.length, 0);
  });

  it('does not notify when resignDate beyond 30 days', async () => {
    const spy = makeSpy();
    await maybeNotifyManagerOfResign(
      { fullName: 'Amit', resignDate: daysFromNow(40), reportingManager: 'mgr1' }, NOW, spy
    );
    assert.equal(spy.calls.length, 0);
  });

  it('does not notify when no reporting manager', async () => {
    const spy = makeSpy();
    await maybeNotifyManagerOfResign(
      { fullName: 'Amit', resignDate: daysFromNow(10), reportingManager: null }, NOW, spy
    );
    assert.equal(spy.calls.length, 0);
  });

  it('does not notify when resignDate cleared', async () => {
    const spy = makeSpy();
    await maybeNotifyManagerOfResign(
      { fullName: 'Amit', resignDate: null, reportingManager: 'mgr1' }, NOW, spy
    );
    assert.equal(spy.calls.length, 0);
  });
});
