import test from 'node:test';
import assert from 'node:assert/strict';
import { createActionGate, createNavigationGuard, navigationSection, performUiAction } from '../src/student-interactions.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function control(html = 'Надіслати <svg></svg>') {
  const attributes = new Map();
  return {
    innerHTML: html, disabled: false, isConnected: true, dataset: {},
    set textContent(value) { this.innerHTML = value; },
    get textContent() { return this.innerHTML; },
    setAttribute: (key, value) => attributes.set(key, value),
    removeAttribute: key => attributes.delete(key),
    getAttribute: key => attributes.get(key)
  };
}

function formWith(fields) {
  const form = control();
  form.querySelectorAll = () => fields;
  return form;
}

const options = (button, operation, extra = {}) => ({ key: 'submit', button, operation, loadingText: 'Надсилаємо…', successText: 'Надіслано', ...extra });

test('rapid presses share one request even after the button is replaced', async () => {
  const gate = createActionGate(), waiting = deferred();
  let requests = 0;
  const first = performUiAction(gate, options(control(), () => { requests++; return waiting.promise; }));
  const repeated = performUiAction(gate, options(control(), () => { requests++; }));
  assert.strictEqual(first, repeated);
  await Promise.resolve();
  assert.equal(requests, 1);
  waiting.resolve('saved');
  assert.deepEqual(await repeated, { ok: true, result: 'saved' });
  assert.equal(gate.busy, false);
});

test('unrelated actions can run independently', async () => {
  const gate = createActionGate(), one = deferred(), two = deferred();
  const a = gate.run('one', () => one.promise), b = gate.run('two', () => two.promise);
  one.resolve('one');
  assert.equal(await a, 'one');
  assert.equal(gate.has('one'), false);
  assert.equal(gate.has('two'), true);
  two.resolve('two');
  assert.equal(await b, 'two');
});

test('a synchronous request failure releases its lock for retry', async () => {
  const gate = createActionGate();
  await assert.rejects(gate.run('save', () => { throw new Error('offline'); }), /offline/);
  assert.equal(gate.busy, false);
  assert.equal(await gate.run('save', () => 'retry saved'), 'retry saved');
});

test('action revision changes only for accepted requests', async () => {
  const gate = createActionGate(), waiting = deferred();
  assert.equal(gate.version, 0);
  const pending = gate.run('save', () => waiting.promise);
  gate.run('save', () => 'duplicate');
  assert.equal(gate.version, 1);
  waiting.resolve();
  await pending;
  await gate.run('save', () => 'second accepted action');
  assert.equal(gate.version, 2);
});

test('pending writes expose loading and preserve the editable draft', async () => {
  const gate = createActionGate(), button = control(), waiting = deferred();
  const input = { value: 'My draft', readOnly: false }, fixed = { value: 'fixed', readOnly: true };
  const form = formWith([input, fixed]), statuses = [];
  const pending = performUiAction(gate, options(button, () => waiting.promise, { form, onStatus: (...status) => statuses.push(status) }));
  assert.equal(button.disabled, true);
  assert.equal(button.getAttribute('aria-busy'), 'true');
  assert.equal(form.getAttribute('aria-busy'), 'true');
  assert.equal(input.readOnly, true);
  assert.equal(input.value, 'My draft');
  assert.deepEqual(statuses[0], ['loading', 'Надсилаємо…']);
  waiting.reject(new Error('offline'));
  await pending;
  assert.equal(input.readOnly, false);
  assert.equal(fixed.readOnly, true);
  assert.equal(form.getAttribute('aria-busy'), undefined);
});

test('failure keeps the original label and icon, reports the error, and allows retry', async () => {
  const gate = createActionGate(), button = control(), statuses = [];
  const result = await performUiAction(gate, options(button, () => Promise.reject(new Error('No connection')), { onStatus: (...status) => statuses.push(status) }));
  assert.equal(result.ok, false);
  assert.equal(result.committed, false);
  assert.equal(button.innerHTML, 'Надіслати <svg></svg>');
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.actionState, 'error');
  assert.equal(button.getAttribute('aria-busy'), undefined);
  assert.deepEqual(statuses.at(-1), ['error', 'No connection']);
  assert.equal((await performUiAction(gate, options(button, () => 'saved'))).ok, true);
});

test('successful writes stay locked and show success while refresh finishes', async () => {
  const gate = createActionGate(), button = control(), refreshed = deferred();
  const pending = performUiAction(gate, options(button, () => 'saved', { afterSuccess: () => refreshed.promise }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button.dataset.actionState, 'success');
  assert.equal(button.textContent, 'Надіслано');
  assert.equal(button.disabled, true);
  assert.equal(gate.has('submit'), true);
  refreshed.resolve();
  await pending;
  assert.equal(button.disabled, true);
});

test('a failed refresh after a successful write cannot invite resubmission', async () => {
  const gate = createActionGate(), button = control(), statuses = [];
  const result = await performUiAction(gate, options(button, () => 'saved', {
    afterSuccess: () => { throw new Error('refresh failed'); }, onStatus: (...status) => statuses.push(status)
  }));
  assert.equal(result.committed, true);
  assert.equal(button.disabled, true);
  assert.equal(button.dataset.actionState, 'success');
  assert.equal(button.textContent, 'Надіслано');
  assert.match(statuses.at(-1)[1], /Надіслано.*Не вдалося оновити екран/);
  assert.equal(gate.busy, false);
});

test('temporary read actions restore their label and prior form state', async () => {
  const gate = createActionGate(), button = control('Обрати час'), input = { readOnly: false };
  await performUiAction(gate, options(button, () => ['slot'], { form: formWith([input]), keepDisabled: false }));
  assert.equal(button.textContent, 'Обрати час');
  assert.equal(button.disabled, false);
  assert.equal(input.readOnly, false);
  assert.equal(button.dataset.actionState, undefined);
});

test('detached controls do not receive late success feedback', async () => {
  const gate = createActionGate(), button = control(), waiting = deferred(), statuses = [];
  let refreshed = false;
  const pending = performUiAction(gate, options(button, () => waiting.promise, { onStatus: (...status) => statuses.push(status), afterSuccess: () => { refreshed = true; } }));
  button.isConnected = false;
  waiting.resolve('saved');
  await pending;
  assert.equal(refreshed, true);
  assert.deepEqual(statuses, [['loading', 'Надсилаємо…']]);
});

test('an existing disabled state is preserved when a read action ends', async () => {
  const button = control(); button.disabled = true;
  await performUiAction(createActionGate(), options(button, () => 'read', { keepDisabled: false }));
  assert.equal(button.disabled, true);
});

test('lesson and homework retain the Learning section in bottom navigation', () => {
  assert.equal(navigationSection('lesson'), 'learn');
  assert.equal(navigationSection('homework'), 'learn');
  for (const page of ['home', 'learn', 'project', 'portfolio', 'profile']) assert.equal(navigationSection(page), page);
});

test('leaving a lesson invalidates its late response', () => {
  const guard = createNavigationGuard();
  const lesson = guard.next();
  assert.equal(guard.isCurrent(lesson), true);
  const profile = guard.next();
  assert.equal(guard.isCurrent(lesson), false);
  assert.equal(guard.isCurrent(profile), true);
});

test('only the last requested transition can render', () => {
  const guard = createNavigationGuard();
  const first = guard.next(), second = guard.next(), last = guard.next();
  assert.deepEqual([first, second, last].map(token => guard.isCurrent(token)), [false, false, true]);
});
