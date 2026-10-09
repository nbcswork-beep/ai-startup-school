// Client-side controls only. API payloads and server rules remain in api.js.
export function createActionGate() {
  const pending = new Map();
  let version = 0;
  return {
    has: key => pending.has(key),
    get: key => pending.get(key),
    get busy() { return pending.size > 0; },
    get version() { return version; },
    run(key, operation) {
      if (pending.has(key)) return pending.get(key);
      version++;
      const promise = Promise.resolve().then(operation).finally(() => {
        if (pending.get(key) === promise) pending.delete(key);
      });
      pending.set(key, promise);
      return promise;
    }
  };
}

export function createNavigationGuard() {
  let version = 0;
  return { next: () => ++version, isCurrent: token => token === version };
}

export function navigationSection(page) {
  return page === 'lesson' || page === 'homework' ? 'learn' : page;
}

// One action stays locked across DOM replacements. Failures preserve the action
// label and editable draft; a successful write is never retried because refresh failed.
export function performUiAction(gate, {
  key, button, form, loadingText, successText = 'Готово', operation,
  afterSuccess = () => {}, onStatus = () => {}, keepDisabled = true
}) {
  if (gate.has(key)) return gate.get(key);
  const original = { html: button.innerHTML, disabled: button.disabled };
  const fields = [...(form?.querySelectorAll('input, textarea') ?? [])].map(field => ({ field, readOnly: field.readOnly }));
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.dataset.actionState = 'loading';
  button.textContent = loadingText;
  form?.setAttribute('aria-busy', 'true');
  for (const { field } of fields) field.readOnly = true;
  onStatus('loading', loadingText);

  return gate.run(key, async () => {
    let committed = false;
    try {
      const result = await operation();
      committed = true;
      if (button.isConnected !== false) {
        button.dataset.actionState = 'success';
        button.textContent = successText;
        onStatus('success', successText);
      }
      await afterSuccess(result);
      return { ok: true, result };
    } catch (error) {
      if (button.isConnected !== false) {
        button.dataset.actionState = committed ? 'success' : 'error';
        if (!committed) { button.innerHTML = original.html; button.disabled = original.disabled; }
        onStatus('error', committed
          ? `${successText}. Не вдалося оновити екран. Дані оновляться після відновлення зв’язку.`
          : error?.message || 'Не вдалося виконати дію. Спробуй ще раз.');
      }
      return { ok: false, committed, error };
    } finally {
      button.removeAttribute('aria-busy');
      form?.removeAttribute('aria-busy');
      if (!committed || !keepDisabled) {
        for (const { field, readOnly } of fields) field.readOnly = readOnly;
        if (!keepDisabled && button.isConnected !== false) {
          button.innerHTML = original.html;
          button.disabled = original.disabled;
          if (committed) delete button.dataset.actionState;
        }
      }
    }
  });
}
