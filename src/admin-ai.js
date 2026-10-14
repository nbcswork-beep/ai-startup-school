// Admin OS · ШІ: providers and models, student token limits, purchased API resources, analytics.
// Purchased provider resources and student allowances are separate figures everywhere on these pages.

export const aiNav = [
  ['ai-providers', 'ШІ · Провайдери', '✦'],
  ['ai-tokens', 'ШІ · Токени', '◍'],
  ['ai-resources', 'ШІ · Ресурс API', '◬'],
  ['ai-analytics', 'ШІ · Аналітика', '▥'],
  ['ai-agent', 'ШІ · Агент', '✧']
];

const PRESETS = [[100_000, '100K'], [500_000, '500K'], [1_000_000, '1M'], [5_000_000, '5M']];
const FAMILIES = [['gpt', 'GPT (OpenAI)'], ['claude', 'Claude (Anthropic)'], ['gemini', 'Gemini (Google)'], ['deepseek', 'DeepSeek'], ['qwen', 'Qwen'], ['llama', 'Llama'], ['mistral', 'Mistral'], ['other', 'Інша']];
const LEDGER_LABELS = { grant: 'Видано', set: 'Новий баланс', reset: 'Обнулено', charge: 'Списано', block: 'Заблоковано', unblock: 'Розблоковано', monthly_on: 'Місячний ліміт увімкнено', monthly_off: 'Місячний ліміт вимкнено', monthly_renewal: 'Оновлення місячного ліміту', expired_reservation: 'Незавершений запит' };

export function createAiAdmin(ctx) {
  const { api, shell, openModal, toast, esc, fmt } = ctx;
  const cache = {};
  const ui = { analytics: { range: 'week', groupId: '', studentId: '', modelId: '' }, discovered: {} };
  const numberFormat = new Intl.NumberFormat('uk-UA');
  const num = value => value === null || value === undefined ? '—' : numberFormat.format(Math.round(Number(value) || 0));
  const money = (amount, currency) => {
    if (amount === null || amount === undefined) return '—';
    try { return new Intl.NumberFormat('uk-UA', { style: 'currency', currency, maximumFractionDigits: amount < 1 ? 4 : 2 }).format(amount); }
    catch { return `${amount} ${esc(currency)}`; }
  };
  const status = (value, label) => `<span class="status status--${esc(value)}">${esc(label)}</span>`;
  const metric = (label, value, note = '') => `<div class="metric"><span>${esc(label)}</span><strong>${value}</strong><small>${note}</small></div>`;
  const field = (label, name, value = '', type = 'text', extra = '') => `<label class="field"><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const select = (label, name, options, selected = '', extra = '') => `<label class="field"><span>${label}</span><select name="${name}" ${extra}>${options.map(([value, text]) => `<option value="${esc(value)}" ${String(value) === String(selected ?? '') ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
  const intro = (text, extra = '') => `<div class="intro"><p>${esc(text)}</p>${extra}</div>`;
  const loading = () => '<div class="panel ai-loading-panel"><p class="muted-copy">Завантажуємо дані з захищеного backend…</p></div>';
  const failure = error => `<div class="panel"><div class="empty"><strong>Не вдалося завантажити</strong><p>${esc(error.message)}</p><button class="secondary" data-ai-action="reload">Спробувати ще раз</button></div></div>`;
  // Package dates are calendar days stored at UTC midnight; show them as days, not times.
  const day = value => value ? new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(value)) : '—';
  const numberOrNull = value => value === '' || value === null || value === undefined ? null : Number(value);

  /** A read-only dialog on the shared modal layer, for results and journals. */
  function showInfo(title, body) {
    const layer = document.querySelector('#modal');
    layer.innerHTML = `<div class="modal ai-info" role="dialog" aria-modal="true" aria-labelledby="aiInfoTitle"><div class="modal-head"><h2 id="aiInfoTitle">${esc(title)}</h2><button type="button" class="close" aria-label="Закрити">×</button></div>${body}<div class="modal-actions"><button type="button" class="secondary close-button">Закрити</button></div></div>`;
    layer.classList.add('open');
    const close = () => layer.classList.remove('open');
    layer.querySelector('.close').onclick = close;
    layer.querySelector('.close-button').onclick = close;
    layer.onclick = event => { if (event.target === layer) close(); };
    layer.querySelector('.close-button').focus();
  }

  /** Runs one action with a busy button and a toast, then reloads the page data. */
  async function run(button, work, success) {
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    try {
      const result = await work();
      if (success) toast(typeof success === 'function' ? success(result) : success);
      await reload();
      return result;
    } catch (error) {
      toast(error.message, true);
      return null;
    } finally {
      if (button?.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); }
    }
  }

  // -----------------------------------------------------------------------------------------
  // Data

  const loaders = {
    'ai-providers': () => api.aiProviders(),
    'ai-tokens': async () => {
      const [tokens, ledger] = await Promise.all([api.aiTokens(), api.aiLedger(null, 60)]);
      return { ...tokens, ledger: ledger.entries };
    },
    'ai-resources': async () => {
      const [resources, providers] = await Promise.all([api.aiResources(), api.aiProviders()]);
      return { ...resources, providerList: providers.providers };
    },
    'ai-analytics': async () => { const [data, feedback] = await Promise.all([api.aiAnalytics(ui.analytics), api.aiFeedback()]); return { ...data, feedback: feedback.rows }; },
    'ai-agent': () => api.aiAgent()
  };

  let currentRoute = null;
  // Live pages refresh on their own while visible and no dialog is open.
  setInterval(() => {
    if (!['ai-tokens', 'ai-resources', 'ai-analytics'].includes(currentRoute) || document.visibilityState !== 'visible' || document.querySelector('.modal-layer.open')) return;
    void reload();
  }, 30_000);
  async function reload() {
    const route = currentRoute;
    if (!route || !loaders[route]) return;
    try {
      cache[route] = { data: await loaders[route](), error: null };
    } catch (error) {
      cache[route] = { data: cache[route]?.data ?? null, error };
    }
    if (currentRoute === route) paint(route);
  }

  function paint(route) {
    const host = document.querySelector('#ai-root');
    if (!host) return;
    const entry = cache[route];
    if (!entry) { host.innerHTML = loading(); return; }
    if (!entry.data && entry.error) { host.innerHTML = failure(entry.error); return; }
    const filter = host.querySelector('[data-filter]');
    const kept = filter ? { value: filter.value, focused: document.activeElement === filter } : null;
    host.innerHTML = ({ 'ai-providers': providersView, 'ai-tokens': tokensView, 'ai-resources': resourcesView, 'ai-analytics': analyticsView, 'ai-agent': agentView })[route](entry.data);
    const nextFilter = host.querySelector('[data-filter]');
    if (kept?.value && nextFilter) { nextFilter.value = kept.value; nextFilter.dispatchEvent(new Event('input', { bubbles: true })); }
    if (kept?.focused) nextFilter?.focus();
    if (route === 'ai-analytics') bindAnalyticsFilters();
  }

  // -----------------------------------------------------------------------------------------
  // Providers and models

  const protocolLabel = protocol => protocol === 'anthropic' ? 'Anthropic Messages API' : 'OpenAI-compatible API';
  const balanceLabel = source => ({ none: 'Не отримувати', openrouter: 'OpenRouter (/credits)', deepseek: 'DeepSeek (/user/balance)' })[source] ?? source;

  function providerCard(provider, models) {
    const check = provider.lastCheck;
    const providerModels = models.filter(model => model.providerId === provider.id);
    return `<article class="panel ai-provider">
      <div class="panel-head">
        <div><span class="kicker">${esc(protocolLabel(provider.protocol))}</span><h2>${esc(provider.name)}</h2><span class="code">${esc(provider.baseUrl)}</span></div>
        ${status(provider.enabled ? 'active' : 'disabled', provider.enabled ? 'Увімкнено' : 'Вимкнено')}
      </div>
      <div class="ai-check ${check ? (check.ok ? 'is-ok' : 'is-fail') : ''}">
        <strong>${check ? (check.ok ? 'Зʼєднання працює' : 'Помилка зʼєднання') : 'Ще не перевірено'}</strong>
        ${check ? `<span>${esc(check.message)}</span><small>${fmt(check.at)}${check.latencyMs !== null ? ` · ${num(check.latencyMs)} мс` : ''}</small>` : '<span>Натисніть «Перевірити зʼєднання», щоб переконатися, що ключ і адреса правильні.</span>'}
      </div>
      <div class="ai-subhead">API-ключі</div>
      <div class="ai-keys">${provider.keys.length ? provider.keys.map(key => `<div class="ai-key">
        <div><strong>${esc(key.label)}</strong><span class="code">${key.hint ? `••••${esc(key.hint)}` : '••••'}</span></div>
        ${status(key.enabled ? 'active' : 'disabled', key.enabled ? 'Активний' : 'Вимкнений')}
        <div class="ai-row-actions"><button class="text-button" data-ai-action="key-toggle" data-provider="${provider.id}" data-key="${key.id}" data-enabled="${key.enabled}">${key.enabled ? 'Вимкнути' : 'Увімкнути'}</button><button class="text-button ai-danger-link" data-ai-action="key-delete" data-provider="${provider.id}" data-key="${key.id}" data-label="${esc(key.label)}">Видалити</button></div>
      </div>`).join('') : '<p class="muted-copy">Ключів немає — провайдер не працюватиме, доки ви не додасте ключ.</p>'}</div>
      ${provider.headers.length ? `<p class="muted-copy">Додаткові заголовки: ${provider.headers.map(header => `<span class="pill">${esc(header.name)}${header.hint ? ` ••••${esc(header.hint)}` : ''}</span>`).join(' ')}</p>` : ''}
      <p class="muted-copy">Баланс у провайдера: ${provider.balanceSource === 'none' ? 'метод отримання не вибрано' : provider.syncedBalance ? `<strong class="ai-strong">${money(provider.syncedBalance.amount, provider.syncedBalance.currency)}</strong> · підтверджено провайдером ${fmt(provider.syncedBalance.at)}` : 'ще не синхронізовано'}</p>
      <p class="muted-copy">${provider.rateLimitPerMinute ? `Спільна черга: до ${num(provider.rateLimitPerMinute)} запитів за хвилину` : 'Без обмеження запитів за хвилину'}</p>
      <p class="muted-copy">Моделей підключено: ${providerModels.length}${providerModels.length ? ` (${providerModels.filter(model => model.enabled).length} увімкнено)` : ''}</p>
      ${provider.recentErrors?.length ? `<details class="ai-errors"><summary>Останні помилки API (${provider.recentErrors.length})</summary>${provider.recentErrors.map(item => `<p><span class="code">${fmt(item.at)}</span> ${item.status ? `HTTP ${item.status} · ` : ''}${esc(item.code)} — ${esc(item.message)}</p>`).join('')}</details>` : ''}
      <div class="ai-actions">
        <button class="secondary" data-ai-action="provider-test" data-id="${provider.id}">Перевірити зʼєднання</button>
        <button class="secondary" data-ai-action="provider-discover" data-id="${provider.id}">Моделі з API</button>
        <button class="secondary" data-ai-action="key-new" data-id="${provider.id}">Додати ключ</button>
        ${provider.balanceSource !== 'none' ? `<button class="secondary" data-ai-action="provider-balance" data-id="${provider.id}">Синхронізувати баланс</button>` : ''}
        <button class="secondary" data-ai-action="provider-edit" data-id="${provider.id}">Редагувати</button>
        <button class="secondary" data-ai-action="provider-toggle" data-id="${provider.id}" data-enabled="${provider.enabled}">${provider.enabled ? 'Вимкнути' : 'Увімкнути'}</button>
        <button class="danger" data-ai-action="provider-delete" data-id="${provider.id}" data-name="${esc(provider.name)}">Видалити</button>
      </div>
    </article>`;
  }

  function priceLabel(model) {
    const { inputPer1M, outputPer1M, currency } = model.pricing;
    if (inputPer1M === null || outputPer1M === null) return '<small class="ai-warn">Тариф не задано</small>';
    return `${money(inputPer1M, currency)} / ${money(outputPer1M, currency)}<small>вхід / вихід за 1M</small>`;
  }

  function providersView(data) {
    const { providers, models, settings } = data;
    const providerName = id => providers.find(item => item.id === id)?.name ?? '—';
    const rows = models.map(model => `<tr>
      <td><strong>${esc(model.label)}</strong><small class="code">${esc(model.apiModelId)}</small>${settings.defaultModelId === model.id ? '<span class="pill ai-pill-accent">За замовчуванням</span>' : ''}${settings.agentModelId === model.id ? '<span class="pill ai-pill-accent">Для агента</span>' : ''}${model.vision ? '<span class="pill">Фото</span>' : ''}${model.agent === false ? '<span class="pill">Без агента</span>' : ''}</td>
      <td>${esc(providerName(model.providerId))}<small>${esc(FAMILIES.find(([id]) => id === model.family)?.[1] ?? model.family)}</small></td>
      <td>${status(model.enabled ? 'active' : 'disabled', model.enabled ? 'Доступна учням' : 'Вимкнена')}<small>${model.verifiedAt ? `Перевірено ${fmt(model.verifiedAt)}` : 'Не перевірено запитом'}</small>${model.lastTestError ? `<small class="ai-warn">${esc(model.lastTestError)}</small>` : ''}</td>
      <td>${num(model.maxInputTokens)} / ${num(model.maxOutputTokens)}<small>вхід / вихід, токенів</small></td>
      <td>${priceLabel(model)}</td>
      <td>${model.fallbackModelId ? esc(models.find(item => item.id === model.fallbackModelId)?.label ?? '—') : '—'}</td>
      <td class="actions">
        <button class="text-button" data-ai-action="model-probe" data-id="${model.id}">Фото й інструменти</button>
        <button class="text-button" data-ai-action="model-test" data-id="${model.id}">Тест</button>
        <button class="text-button" data-ai-action="model-toggle" data-id="${model.id}" data-enabled="${model.enabled}">${model.enabled ? 'Вимкнути' : 'Увімкнути'}</button>
        ${settings.defaultModelId !== model.id && model.enabled ? `<button class="text-button" data-ai-action="model-default" data-id="${model.id}">Основна</button>` : ''}
        <button class="text-button" data-ai-action="model-edit" data-id="${model.id}">Редагувати</button>
        <button class="text-button ai-danger-link" data-ai-action="model-delete" data-id="${model.id}" data-name="${esc(model.label)}">Видалити</button>
      </td>
    </tr>`);
    return `${data.secretsAvailable ? '' : '<div class="security-banner"><b>КЛЮЧІ НЕ ЗБЕРЕЖУТЬСЯ</b><p>На сервері не задано AI_SECRETS_KEY або SESSION_TOKEN_PEPPER — шифрувати API-ключі нічим.</p></div>'}
      ${providers.length ? `<div class="ai-provider-grid">${providers.map(provider => providerCard(provider, models)).join('')}</div>` : `<div class="panel"><div class="empty"><strong>Провайдерів ще немає</strong><p>Додайте свій API: OpenAI-сумісний сервіс, агрегатор (наприклад OpenRouter), реселер із власним Base URL або Anthropic.</p><button class="primary" data-ai-action="provider-new">Додати провайдера</button></div></div>`}
      <section class="panel ai-section">
        <div class="panel-head"><div><span class="kicker">Моделі</span><h2>Моделі для учнів</h2><span>Учні бачать лише увімкнені моделі. Увімкнути можна тільки після успішного тестового запиту через ваш API.</span></div><button class="primary" data-ai-action="model-new" ${providers.length ? '' : 'disabled'}>Додати модель</button></div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Модель</th><th>Провайдер</th><th>Стан</th><th>Ліміти</th><th>Тариф</th><th>Резервна</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="muted-copy">Моделей ще немає. Отримайте список з API провайдера або додайте ID моделі вручну.</p>'}
      </section>
      <section class="panel ai-section">
        <div class="panel-head"><div><span class="kicker">Налаштування</span><h2>Поведінка асистента та обмеження</h2></div></div>
        <form id="ai-settings" class="ai-settings">
          <label class="field ai-wide"><span>Системна інструкція (не показується учням)</span><textarea name="systemPrompt" maxlength="8000" required>${esc(settings.systemPrompt)}</textarea></label>
          ${select('Модель за замовчуванням', 'defaultModelId', [['', 'Перша доступна'], ...models.filter(model => model.enabled).map(model => [model.id, model.label])], settings.defaultModelId ?? '')}
          ${field('Максимум символів у повідомленні', 'maxMessageChars', settings.maxMessageChars, 'number', 'min="200" max="32000" required')}
          <label class="check"><input type="checkbox" name="memoryEnabled" ${settings.memoryEnabled !== false ? 'checked' : ''}><span>Стискати довгі діалоги в памʼять (токени враховуються)</span></label>
          ${field('Запитів на хвилину на учня', 'requestsPerMinute', settings.requestsPerMinute, 'number', 'min="1" max="120" required')}
          ${field('Одночасних відповідей на учня', 'maxConcurrentPerStudent', settings.maxConcurrentPerStudent, 'number', 'min="1" max="5" required')}
          ${field('«Ліміт закінчується» нижче, токенів', 'lowBalanceTokens', settings.lowBalanceTokens, 'number', 'min="0" required')}
          ${field('Попереджати про ресурс API нижче, %', 'resourceWarningPercent', settings.resourceWarningPercent, 'number', 'min="1" max="90" required')}
          <div class="ai-wide ai-form-actions"><button class="primary" type="submit">Зберегти налаштування</button></div>
        </form>
      </section>`;
  }

  const providerRate = form => numberOrNull(form.get('rateLimitPerMinute'));
  const providerForm = (provider = null) => `
    ${field('Назва *', 'name', provider?.name ?? '', 'text', 'required maxlength="80" placeholder="Напр. OpenRouter школи"')}
    ${select('Протокол *', 'protocol', [['openai', 'OpenAI-compatible (Chat Completions)'], ['anthropic', 'Anthropic Messages API']], provider?.protocol ?? 'openai')}
    ${field('API Base URL *', 'baseUrl', provider?.baseUrl ?? '', 'url', 'required maxlength="500" placeholder="https://api.example.com/v1" spellcheck="false"')}
    <p class="muted-copy">Приклади: https://api.openai.com/v1 · https://openrouter.ai/api/v1 · https://api.deepseek.com · https://dashscope-intl.aliyuncs.com/compatible-mode/v1 · https://api.anthropic.com</p>
    ${provider ? '' : `${field('API Key *', 'apiKey', '', 'password', 'required minlength="8" maxlength="1000" autocomplete="off" spellcheck="false"')}${field('Назва ключа', 'keyLabel', '', 'text', 'maxlength="60" placeholder="Основний ключ"')}`}
    <label class="field"><span>Додаткові заголовки авторизації — по одному на рядок, «Назва: значення»${provider ? '. Порожнє значення залишає збережене.' : ''}</span><textarea name="headers" spellcheck="false" placeholder="HTTP-Referer: https://school.example">${provider ? provider.headers.map(header => `${esc(header.name)}: `).join('\n') : ''}</textarea></label>
    ${field('Загальний ліміт запитів за хвилину', 'rateLimitPerMinute', provider?.rateLimitPerMinute ?? '', 'number', 'min="1" max="10000" placeholder="Для NVIDIA рекомендовано 35"')}
    <p class="muted-copy">Спільна черга для всіх учнів. Порожнє поле вимикає обмеження; для нового NVIDIA-провайдера автоматично ставиться 35.</p>
    ${select('Баланс провайдера', 'balanceSource', [['none', 'Не отримувати'], ['openrouter', 'OpenRouter (/credits)'], ['deepseek', 'DeepSeek (/user/balance)']], provider?.balanceSource ?? 'none')}
    <p class="muted-copy">Ключ шифрується на сервері й більше ніколи не показується — лише останні 4 символи.</p>`;

  const parseHeaders = text => String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const index = line.indexOf(':');
    if (index < 1) throw new Error(`Рядок заголовка має бути у форматі «Назва: значення»: ${line.slice(0, 40)}`);
    return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
  });

  function modelForm(data, model = null) {
    const providerOptions = data.providers.map(provider => [provider.id, provider.name]);
    const discovered = ui.discovered[model?.providerId ?? data.providers[0]?.id] ?? [];
    const others = data.models.filter(item => item.id !== model?.id).map(item => [item.id, item.label]);
    return `${select('Провайдер *', 'providerId', providerOptions, model?.providerId ?? ui.lastProvider ?? data.providers[0]?.id, model ? 'disabled' : '')}
      ${field('ID моделі в API *', 'apiModelId', model?.apiModelId ?? ui.prefillModel ?? '', 'text', 'required maxlength="200" spellcheck="false" list="ai-model-ids" placeholder="Точний ID, як у документації провайдера"')}
      <datalist id="ai-model-ids">${discovered.map(item => `<option value="${esc(item.id)}">${esc(item.label)}</option>`).join('')}</datalist>
      ${field('Назва для учнів', 'label', model?.label ?? '', 'text', 'maxlength="80" placeholder="Напр. GPT-4o mini"')}
      ${select('Сімейство', 'family', FAMILIES, model?.family ?? 'other')}
      <div class="ai-two">${field('Макс. токенів відповіді', 'maxOutputTokens', model?.maxOutputTokens ?? 2048, 'number', 'min="16" max="200000" required')}${field('Макс. токенів контексту', 'maxInputTokens', model?.maxInputTokens ?? 16000, 'number', 'min="512" max="2000000" required')}</div>
      <fieldset><legend>Тариф провайдера за 1 млн токенів (для оцінки вартості; залиште порожнім, якщо невідомо)</legend>
        <div class="ai-two">${field('Валюта', 'currency', model?.pricing.currency ?? 'USD', 'text', 'maxlength="3" pattern="[A-Za-z]{3}"')}${field('Вхідні', 'inputPer1M', model?.pricing.inputPer1M ?? '', 'number', 'min="0" step="any"')}</div>
        <div class="ai-two">${field('Вихідні', 'outputPer1M', model?.pricing.outputPer1M ?? '', 'number', 'min="0" step="any"')}${field('Кешовані вхідні', 'cachedInputPer1M', model?.pricing.cachedInputPer1M ?? '', 'number', 'min="0" step="any"')}</div>
      </fieldset>
      ${select('Резервна модель (лише якщо ця не відповіла, до початку відповіді)', 'fallbackModelId', [['', 'Без резервної'], ...others], model?.fallbackModelId ?? '')}
      ${model ? `<label class="check"><input type="checkbox" name="agent" ${model.agent === false ? '' : 'checked'}><span>Режим агента: модель уміє викликати інструменти (читати й створювати файли). Вимкніть для моделей без підтримки tools.</span></label>` : ''}
      ${model ? `<label class="check"><input type="checkbox" name="vision" ${model.vision ? 'checked' : ''}><span>Модель розпізнає фотографії</span></label>` : ''}
      ${model?.capabilities ? `<p class="muted-copy">${esc(model.capabilities.note)}</p>` : ''}
      ${model ? '' : '<p class="muted-copy">Модель зʼявиться у списку вимкненою. Щоб відкрити її учням, натисніть «Увімкнути» — сервер спершу надішле справжній тестовий запит.</p>'}`;
  }

  const modelPayload = form => ({
    apiModelId: String(form.get('apiModelId')).trim(),
    label: String(form.get('label') ?? '').trim(),
    family: form.get('family'),
    maxOutputTokens: Number(form.get('maxOutputTokens')),
    maxInputTokens: Number(form.get('maxInputTokens')),
    pricing: { currency: String(form.get('currency') || 'USD').toUpperCase(), inputPer1M: numberOrNull(form.get('inputPer1M')), outputPer1M: numberOrNull(form.get('outputPer1M')), cachedInputPer1M: numberOrNull(form.get('cachedInputPer1M')) },
    fallbackModelId: form.get('fallbackModelId') || null,
    vision: form.get('vision') === 'on',
    ...(form.has('agent') || form.get('apiModelId') ? { agent: form.get('agent') === 'on' } : {})
  });

  function testResult(result, label) {
    if (!result.ok) return `<div class="ai-check is-fail"><strong>Модель «${esc(label)}» не відповіла</strong><span>${esc(result.message)}</span><small>${num(result.latencyMs)} мс</small></div>`;
    return `<div class="ai-check is-ok"><strong>Відповідь отримано за ${num(result.latencyMs)} мс</strong><span>Ключ: ${esc(result.keyLabel)}</span></div>
      <div class="ai-test-text">${esc(result.text) || '<em>порожня відповідь</em>'}</div>
      <p class="muted-copy">Використано: вхід ${num(result.usage.input)}, вихід ${num(result.usage.output)}${result.usage.reasoning ? `, з них reasoning ${num(result.usage.reasoning)}` : ''}${result.usage.cached ? `, кешовано ${num(result.usage.cached)}` : ''} — разом ${num(result.usage.total)} токенів${result.usage.approximate ? ' (оцінка: провайдер не повідомив точне число)' : ' (дані провайдера)'}. Баланси учнів не змінюються.</p>`;
  }

  // -----------------------------------------------------------------------------------------
  // Tokens and limits

  function tokensView(data) {
    const { students, groups, totals, ledger, models } = data;
    const rows = students.map(row => `<tr>
      <td><strong>${esc(row.name)}</strong><small>${esc(row.groupName ?? 'Без групи')}</small></td>
      <td><strong class="ai-strong">${num(row.available)}</strong>${row.reserved ? `<small>у резерві ${num(row.reserved)}</small>` : '<small>доступно</small>'}</td>
      <td>${num(row.used)}<small>${row.approxUsed ? `з них ≈${num(row.approxUsed)} оцінкою` : `вхід ${num(row.inputUsed)} · вихід ${num(row.outputUsed)}`}</small></td>
      <td>${num(row.allocated)}<small>використано + залишок</small></td>
      <td>${num(row.requests)}</td>
      <td>${esc(row.lastModel ?? '—')}<small>${row.models.length ? `доступно моделей: ${row.models.length}` : 'немає доступних моделей'}${row.rule ? ' · особисті правила' : ''}</small></td>
      <td>${fmt(row.lastActivityAt)}</td>
      <td>${row.blocked ? status('disabled', 'Заблоковано') : status('active', 'Активний')}${row.monthlyLimit ? `<small>щомісяця ${num(row.monthlyLimit)}</small>` : ''}</td>
      <td class="actions"><div class="ai-presets">${PRESETS.map(([amount, label]) => `<button class="pill ai-preset" data-ai-action="grant" data-student="${row.studentId}" data-amount="${amount}" aria-label="Видати ${num(amount)} токенів: ${esc(row.name)}">+${label}</button>`).join('')}<button class="secondary ai-manage" data-ai-action="student-manage" data-student="${row.studentId}">Керувати</button></div></td>
    </tr>`);
    const modelName = id => models.find(model => model.id === id)?.label ?? '—';
    const groupRows = groups.map(group => `<tr>
      <td><strong>${esc(group.name)}</strong><small>${num(group.studentCount)} учнів · ${group.status === 'active' ? 'активна' : 'архів'}</small></td>
      <td>${group.rule ? (group.rule.modelIds ? group.rule.modelIds.map(id => `<span class="pill">${esc(modelName(id))}</span>`).join(' ') : 'Усі увімкнені') : 'Усі увімкнені'}${group.rule?.defaultModelId ? `<small>основна: ${esc(modelName(group.rule.defaultModelId))}</small>` : ''}</td>
      <td class="actions"><button class="text-button" data-ai-action="access" data-scope="group" data-id="${group.id}">Моделі групи</button><button class="text-button" data-ai-action="group-grant" data-id="${group.id}" ${group.status === 'active' ? '' : 'disabled'}>Видати групі</button></td>
    </tr>`);
    const ledgerRows = ledger.map(entry => `<tr>
      <td>${fmt(entry.at)}</td><td><strong>${esc(entry.studentName)}</strong></td>
      <td>${esc(LEDGER_LABELS[entry.type] ?? entry.type)}${entry.batchId ? '<small>масова видача</small>' : ''}</td>
      <td class="${entry.amount < 0 ? 'ai-minus' : entry.amount > 0 ? 'ai-plus' : ''}">${entry.amount > 0 ? '+' : ''}${num(entry.amount)}</td>
      <td>${num(entry.balanceAfter)}</td><td>${esc(entry.note ?? '')}</td>
    </tr>`);
    return `<div class="metrics ai-metrics">
        ${metric('Виділено учням', num(totals.used + totals.balance), 'використано + залишок')}
        ${metric('Залишок у учнів', num(totals.balance), 'внутрішні ліміти')}
        ${metric('Використано', num(totals.used), 'за фактичним usage API')}
        ${metric('У резерві зараз', num(totals.reserved), 'відповіді, що генеруються')}
        ${metric('Запитів', num(totals.requests), 'усього')}
      </div>
      <div class="toolbar"><input data-filter placeholder="Знайти учня або групу" aria-label="Фільтр учнів"><button class="secondary" data-ai-action="group-grant">Видати групі…</button></div>
      ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Учень</th><th>Залишок</th><th>Використано</th><th>Виділено</th><th>Запити</th><th>Модель</th><th>Активність</th><th>Статус</th><th>Видати</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="panel"><div class="empty"><strong>Учнів немає</strong><p>Додайте учнів у розділі «Учні».</p></div></div>'}
      <section class="panel ai-section"><div class="panel-head"><div><span class="kicker">Групи</span><h2>Моделі та масова видача</h2><span>Правило групи діє для всіх її учнів, якщо в учня немає власного.</span></div></div>
        ${groupRows.length ? `<div class="table-wrap"><table class="ai-compact"><thead><tr><th>Група</th><th>Доступні моделі</th><th></th></tr></thead><tbody>${groupRows.join('')}</tbody></table></div>` : '<p class="muted-copy">Груп немає.</p>'}
      </section>
      <section class="panel ai-section"><div class="panel-head"><div><span class="kicker">Журнал операцій</span><h2>Останні зміни балансів</h2><span>Видачі, нові баланси, обнулення, блокування й оновлення місячних лімітів. Списання — у журналі кожного учня.</span></div></div>
        ${ledgerRows.length ? `<div class="table-wrap"><table class="ai-compact"><thead><tr><th>Час</th><th>Учень</th><th>Операція</th><th>Зміна</th><th>Баланс після</th><th>Примітка</th></tr></thead><tbody>${ledgerRows.join('')}</tbody></table></div>` : '<p class="muted-copy">Записів ще немає.</p>'}
      </section>`;
  }

  function studentManage(data, studentId) {
    const row = data.students.find(item => item.studentId === studentId);
    if (!row) return;
    openModal(`ШІ-ліміт · ${row.name}`, `
      <div class="ai-summary"><span>Доступно <strong>${num(row.available)}</strong></span><span>Використано <strong>${num(row.used)}</strong></span><span>Запитів <strong>${num(row.requests)}</strong></span></div>
      <fieldset><legend>Баланс</legend>
        <label class="check"><input type="radio" name="op" value="add" checked><span>Додати до поточного балансу</span></label>
        <label class="check"><input type="radio" name="op" value="set"><span>Встановити новий баланс</span></label>
        <label class="check"><input type="radio" name="op" value="reset"><span>Обнулити баланс</span></label>
        ${field('Кількість токенів', 'amount', '', 'number', 'min="0" max="100000000000" step="1" inputmode="numeric"')}
        <div class="ai-presets">${PRESETS.map(([amount, label]) => `<button type="button" class="pill ai-preset" data-fill="${amount}">${label}</button>`).join('')}</div>
        ${field('Примітка', 'note', '', 'text', 'maxlength="300" placeholder="Напр. Бонус за проєкт"')}
      </fieldset>
      <div class="ai-modal-links">
        <button type="button" class="secondary" data-ai-action="block" data-student="${row.studentId}" data-blocked="${row.blocked}">${row.blocked ? 'Розблокувати доступ до ШІ' : 'Тимчасово заборонити доступ'}</button>
        <button type="button" class="secondary" data-ai-action="monthly" data-student="${row.studentId}">${row.monthlyLimit ? `Місячний ліміт: ${num(row.monthlyLimit)}` : 'Автооновлення щомісяця'}</button>
        <button type="button" class="secondary" data-ai-action="access" data-scope="student" data-id="${row.studentId}">Моделі учня</button>
        <button type="button" class="secondary" data-ai-action="journal" data-student="${row.studentId}">Журнал учня</button>
      </div>`, async form => {
      const op = form.get('op');
      const amount = Number(form.get('amount'));
      if (op !== 'reset' && (!Number.isInteger(amount) || amount < (op === 'add' ? 1 : 0))) throw new Error('Вкажіть кількість токенів цілим числом');
      const result = await api.aiAdjust(row.studentId, { op, ...(op === 'reset' ? {} : { amount }), note: String(form.get('note') ?? '').trim() || undefined });
      return { message: `Баланс ${row.name}: ${num(result.before)} → ${num(result.after)}` };
    }, false, 'Застосувати');
    const modal = document.querySelector('#modal .modal');
    modal.querySelectorAll('[data-fill]').forEach(button => { button.onclick = () => { modal.querySelector('[name="amount"]').value = button.dataset.fill; }; });
    const amountField = modal.querySelector('[name="amount"]');
    modal.querySelectorAll('[name="op"]').forEach(radio => { radio.onchange = () => { amountField.disabled = radio.value === 'reset' && radio.checked; }; });
    modal.querySelectorAll('[data-ai-action]').forEach(button => { button.onclick = () => handle(button.dataset.aiAction, button.dataset, button); });
  }

  function accessModal(data, scope, targetId) {
    const models = (data.models ?? []).filter(model => model.enabled && model.verified);
    const target = scope === 'student' ? data.students.find(item => item.studentId === targetId) : data.groups.find(item => item.id === targetId);
    const rule = target?.rule ?? null;
    const name = target?.name ?? '';
    const inherit = scope === 'student' ? 'Як у групи (або всі увімкнені)' : 'Усі увімкнені моделі';
    openModal(`Моделі · ${name}`, `
      <fieldset><legend>Доступні моделі</legend>
        <label class="check"><input type="radio" name="mode" value="inherit" ${rule?.modelIds ? '' : 'checked'}><span>${inherit}</span></label>
        <label class="check"><input type="radio" name="mode" value="custom" ${rule?.modelIds ? 'checked' : ''}><span>Лише вибрані:</span></label>
        <div class="check-grid">${models.map(model => `<label class="check"><input type="checkbox" name="modelIds" value="${model.id}" ${rule?.modelIds?.includes(model.id) ? 'checked' : ''}><span>${esc(model.label)}</span></label>`).join('') || '<p class="muted-copy">Немає увімкнених моделей.</p>'}</div>
      </fieldset>
      ${select('Модель за замовчуванням', 'defaultModelId', [['', 'Загальна за замовчуванням'], ...models.map(model => [model.id, model.label])], rule?.defaultModelId ?? '')}
      <p class="muted-copy">Учень обирає лише з дозволених моделей. Запит до іншої моделі сервер відхилить.</p>`, async form => {
      const custom = form.get('mode') === 'custom';
      const modelIds = custom ? form.getAll('modelIds') : null;
      const defaultModelId = form.get('defaultModelId') || null;
      if (custom && !modelIds.length) throw new Error('Виберіть хоча б одну модель або залиште доступ до всіх');
      if (!custom && !defaultModelId) { if (rule) await api.aiDeleteAccess(scope, targetId); }
      else await api.aiSetAccess(scope, targetId, { modelIds, defaultModelId });
      return { message: 'Доступ до моделей оновлено' };
    }, false, 'Зберегти');
  }

  // -----------------------------------------------------------------------------------------
  // Purchased resources

  function resourcesView(data) {
    const { packages, summary, alerts, providerList, modelsWithoutPricing } = data;
    const unitLabel = item => item.unit === 'tokens' ? 'токени' : item.unit === 'credits' ? `кредити (${item.currency})` : `гроші (${item.currency})`;
    const amount = (item, value) => value === null || value === undefined ? '—' : item.unit === 'tokens' ? num(value) : money(value, item.currency);
    const rows = packages.map(item => `<tr>
      <td><strong>${esc(item.name)}</strong><small>${esc(item.providerName)}</small>${item.note ? `<small>${esc(item.note)}</small>` : ''}</td>
      <td>${esc(unitLabel(item))}</td>
      <td>${amount(item, item.purchasedAmount)}${item.cost !== null ? `<small>вартість ${money(item.cost, item.costCurrency)}</small>` : ''}</td>
      <td>${day(item.purchasedAt)}<small>${item.expiresAt ? `діє до ${day(item.expiresAt)}` : 'без терміну'}</small></td>
      <td>${item.usedBasis === 'unknown' ? '<small class="ai-warn">невідомо: немає тарифів</small>' : amount(item, item.used)}<small>${item.usedBasis === 'cost' ? `за тарифами моделей · ${num(item.usedTokens)} токенів` : item.usedBasis === 'tokens' ? 'за usage API' : ''}</small></td>
      <td><strong class="ai-strong">${amount(item, item.estimatedRemaining)}</strong><small>розрахунковий${item.remainingShare !== null ? ` · ${Math.round(item.remainingShare * 100)}%` : ''}</small></td>
      <td>${item.confirmedRemaining ? `${amount(item, item.confirmedRemaining.amount)}<small>${item.confirmedRemaining.source === 'provider' ? 'від API провайдера' : 'введено вручну'} · ${fmt(item.confirmedRemaining.at)}</small>` : '<small>не підтверджено</small>'}</td>
      <td>${item.expired ? status('disabled', 'Минув') : item.warnings.length ? status('warning', 'Увага') : status('active', 'Ок')}${item.warnings.map(text => `<small class="ai-warn">${esc(text)}</small>`).join('')}</td>
      <td class="actions"><button class="text-button" data-ai-action="package-edit" data-id="${item.id}">Редагувати</button><button class="text-button ai-danger-link" data-ai-action="package-delete" data-id="${item.id}" data-name="${esc(item.name)}">Видалити</button></td>
    </tr>`);
    return `<div class="metrics ai-metrics">
        ${metric('Куплено токенів', num(summary.purchasedTokens), 'активні пакети в токенах')}
        ${metric('Розрахунковий залишок', num(summary.remainingTokens), 'куплено − використано API')}
        ${metric('Виділено учням', num(summary.allocatedToStudents), 'поточні залишки учнів')}
        ${metric('Не розподілено', summary.unallocatedTokens === null ? '—' : num(summary.unallocatedTokens), summary.unallocatedTokens === null ? 'немає пакетів у токенах' : 'залишок − виділене')}
        ${metric('У резерві зараз', num(summary.reservedNow), 'відповіді, що генеруються')}
      </div>
      ${alerts.length ? `<div class="security-banner ai-alerts"><b>УВАГА</b><div>${alerts.map(alert => `<p>${esc(alert.packageName)}: ${esc(alert.message)}</p>`).join('')}</div></div>` : ''}
      <section class="panel ai-section"><div class="panel-head"><div><span class="kicker">Пакети</span><h2>Куплений ресурс провайдерів</h2><span>Розрахунковий залишок — оцінка за журналом використання. Підтверджений — з API провайдера або введений вами з його кабінету.</span></div><button class="primary" data-ai-action="package-new" ${providerList.length ? '' : 'disabled'}>Додати пакет</button></div>
        ${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Пакет</th><th>Одиниця</th><th>Куплено</th><th>Дата</th><th>Використано</th><th>Залишок</th><th>Підтверджено</th><th>Стан</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<p class="muted-copy">Пакетів ще немає. Додайте покупку, щоб бачити залишок і попередження.</p>'}
      </section>
      <section class="panel ai-section"><div class="panel-head"><div><span class="kicker">Баланс у провайдерів</span><h2>Синхронізація з API</h2></div></div>
        ${providerList.map(provider => `<div class="ai-key"><div><strong>${esc(provider.name)}</strong><span class="code">${esc(balanceLabel(provider.balanceSource))}</span></div><span>${provider.syncedBalance ? `${money(provider.syncedBalance.amount, provider.syncedBalance.currency)}<small> · ${fmt(provider.syncedBalance.at)}</small>` : provider.balanceSource === 'none' ? '<small>API не надає баланс — використовуйте розрахунковий</small>' : '<small>ще не отримано</small>'}</span>${provider.balanceSource !== 'none' ? `<button class="secondary" data-ai-action="provider-balance" data-id="${provider.id}">Синхронізувати</button>` : '<span></span>'}</div>`).join('') || '<p class="muted-copy">Провайдерів немає.</p>'}
      </section>
      ${modelsWithoutPricing.length ? `<p class="muted-copy">Без тарифів (вартість не рахується): ${modelsWithoutPricing.map(model => `<span class="pill">${esc(model.label)}</span>`).join(' ')}</p>` : ''}`;
  }

  function packageForm(data, item = null) {
    const today = new Date().toISOString().slice(0, 10);
    return `${field('Назва пакета *', 'name', item?.name ?? '', 'text', 'required maxlength="80" placeholder="Напр. OpenRouter $50 · жовтень"')}
      ${select('Провайдер *', 'providerId', data.providerList.map(provider => [provider.id, provider.name]), item?.providerId ?? data.providerList[0]?.id)}
      ${select('Що куплено *', 'unit', [['tokens', 'Токени'], ['credits', 'Кредити провайдера'], ['money', 'Грошовий баланс']], item?.unit ?? 'tokens')}
      <div class="ai-two">${field('Кількість *', 'purchasedAmount', item?.purchasedAmount ?? '', 'number', 'required min="0" step="any"')}${field('Валюта (для кредитів/грошей)', 'currency', item?.currency ?? 'USD', 'text', 'maxlength="3" pattern="[A-Za-z]{3}"')}</div>
      <div class="ai-two">${field('Вартість покупки', 'cost', item?.cost ?? '', 'number', 'min="0" step="any"')}${field('Валюта покупки', 'costCurrency', item?.costCurrency ?? 'USD', 'text', 'maxlength="3" pattern="[A-Za-z]{3}"')}</div>
      <div class="ai-two">${field('Дата покупки *', 'purchasedAt', (item?.purchasedAt ?? today).slice(0, 10), 'date', 'required')}${field('Діє до', 'expiresAt', item?.expiresAt?.slice(0, 10) ?? '', 'date')}</div>
      ${field('Залишок з кабінету провайдера (необовʼязково)', 'manualRemaining', item?.manualRemaining ?? '', 'number', 'min="0" step="any"')}
      ${field('Примітка', 'note', item?.note ?? '', 'text', 'maxlength="500"')}
      <p class="muted-copy">Кредити в грошах не перетворюються на токени автоматично: витрати рахуються за тарифами моделей, якщо ви їх задали.</p>`;
  }

  const packagePayload = form => ({
    name: String(form.get('name')).trim(), providerId: form.get('providerId'), unit: form.get('unit'),
    purchasedAmount: Number(form.get('purchasedAmount')), currency: String(form.get('currency') || 'USD').toUpperCase(),
    cost: numberOrNull(form.get('cost')), costCurrency: String(form.get('costCurrency') || 'USD').toUpperCase(),
    purchasedAt: form.get('purchasedAt'), expiresAt: form.get('expiresAt') || null,
    manualRemaining: numberOrNull(form.get('manualRemaining')), note: String(form.get('note') ?? '').trim()
  });

  // -----------------------------------------------------------------------------------------
  // Analytics

  function chart(series, range) {
    if (!series.length) return '';
    const width = 760, height = 220, left = 56, bottom = 28, top = 12;
    const max = Math.max(1, ...series.map(item => item.tokens));
    const step = (width - left - 8) / series.length;
    const barWidth = Math.max(4, Math.min(28, step * 0.62));
    const scale = value => (height - bottom - top) * value / max;
    const grid = [0, 0.5, 1].map(share => {
      const y = height - bottom - (height - bottom - top) * share;
      return `<line x1="${left}" x2="${width - 4}" y1="${y}" y2="${y}" class="ai-grid-line"/><text x="${left - 8}" y="${y + 4}" text-anchor="end" class="ai-axis">${num(max * share)}</text>`;
    }).join('');
    const label = key => range === 'day' ? key.slice(11, 13) : `${key.slice(8, 10)}.${key.slice(5, 7)}`;
    const every = Math.ceil(series.length / 12);
    const bars = series.map((item, index) => {
      const x = left + index * step + (step - barWidth) / 2;
      const h = scale(item.tokens);
      return `<g><title>${esc(label(item.key))}: ${num(item.tokens)} токенів, ${num(item.requests)} запитів</title><rect x="${x.toFixed(1)}" y="${(height - bottom - h).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(h, item.tokens ? 1 : 0).toFixed(1)}" rx="3" class="ai-bar"/>${index % every === 0 ? `<text x="${(x + barWidth / 2).toFixed(1)}" y="${height - 9}" text-anchor="middle" class="ai-axis">${esc(label(item.key))}</text>` : ''}</g>`;
    }).join('');
    return `<svg class="ai-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Витрата токенів за період">${grid}${bars}</svg>
      <table class="visually-hidden"><caption>Витрата токенів</caption><thead><tr><th>Період</th><th>Токени</th><th>Запити</th></tr></thead><tbody>${series.map(item => `<tr><td>${esc(label(item.key))}</td><td>${num(item.tokens)}</td><td>${num(item.requests)}</td></tr>`).join('')}</tbody></table>`;
  }

  function bars(items, labelOf, valueOf = item => item.tokens) {
    if (!items.length) return '<p class="muted-copy">Даних за період немає.</p>';
    const max = Math.max(1, ...items.map(valueOf));
    return `<div class="ai-bars">${items.slice(0, 12).map(item => `<div class="ai-bar-row"><span>${labelOf(item)}</span><div class="ai-bar-track"><i style="width:${Math.max(1, Math.round(valueOf(item) / max * 100))}%"></i></div><strong>${num(valueOf(item))}</strong></div>`).join('')}</div>`;
  }

  function analyticsView(data) {
    const f = ui.analytics;
    const t = data.totals;
    const filtered = Boolean(f.groupId || f.studentId || f.modelId);
    const costs = data.costs.length ? data.costs.map(cost => money(cost.amount, cost.currency)).join(' + ') : '—';
    const option = (items, selected, empty, labelOf) => `<option value="">${empty}</option>${items.map(item => `<option value="${item.id}" ${item.id === selected ? 'selected' : ''}>${esc(labelOf(item))}</option>`).join('')}`;
    return `<div class="toolbar ai-filters" role="group" aria-label="Фільтри аналітики">
        <div class="ai-segment" role="radiogroup" aria-label="Період">${[['day', 'День'], ['week', 'Тиждень'], ['month', 'Місяць']].map(([value, label]) => `<button type="button" role="radio" aria-checked="${f.range === value}" class="${f.range === value ? 'is-active' : ''}" data-range="${value}">${label}</button>`).join('')}</div>
        <select data-filter-key="groupId" aria-label="Група">${option(data.filters.groups, f.groupId, 'Усі групи', item => item.name)}</select>
        <select data-filter-key="studentId" aria-label="Учень">${option(data.filters.students.filter(item => !f.groupId || item.groupId === f.groupId), f.studentId, 'Усі учні', item => item.name)}</select>
        <select data-filter-key="modelId" aria-label="Модель">${option(data.filters.models, f.modelId, 'Усі моделі', item => item.label)}</select>
        ${filtered ? '<button class="text-button" data-ai-action="filters-reset">Скинути фільтри</button>' : ''}
      </div>
      <div class="metrics ai-metrics">
        ${metric('Токени', num(t.tokens), filtered ? 'за фільтром' : `вхід ${num(t.input)} · вихід ${num(t.output)}`)}
        ${metric('Запити', num(t.requests), filtered ? '' : `помилок: ${num(t.errors)}`)}
        ${metric('Reasoning / кеш', filtered ? '—' : `${num(t.reasoning)} / ${num(t.cached)}`, 'за даними провайдера')}
        ${metric('Оцінкою', filtered ? '—' : num(t.approximate), 'провайдер не повідомив usage')}
        ${metric('Орієнтовна вартість', filtered ? '—' : costs, 'лише для моделей із тарифом')}
        ${metric('Тести адміністратора', filtered ? '—' : num(t.adminTests), 'не списуються з учнів')}
      </div>
      <section class="panel ai-section"><div class="panel-head"><div><span class="kicker">Динаміка</span><h2>Витрата токенів</h2><span>${f.range === 'day' ? 'Останні 24 години, по годинах' : f.range === 'week' ? 'Останні 7 днів' : 'Останні 30 днів'} · час Києва</span></div></div>${chart(data.series, data.range)}</section>
      <section class="panel ai-section"><h2>Оцінки відповідей · за весь час</h2><p class="muted-copy">Лише оцінки у збережених чатах; фільтри витрат не застосовуються.</p><div class="table-wrap"><table><thead><tr><th>Модель</th><th>Навичка</th><th>👍</th><th>👎</th></tr></thead><tbody>${(data.feedback ?? []).map(row => `<tr><td>${esc(row.model)}</td><td>${esc(row.skill ?? 'Без навички')}</td><td>${num(row.up)}</td><td>${num(row.down)}</td></tr>`).join('') || '<tr><td colspan="4">Оцінок ще немає</td></tr>'}</tbody></table></div></section>
      <div class="grid-3 ai-breakdowns">
        <section class="panel"><div class="panel-head"><div><span class="kicker">Моделі</span><h2>Розхід за моделями</h2></div></div>${bars(data.byModel, item => `${esc(item.label)}${item.costMicros !== null && item.currency ? ` <small>${money(item.costMicros / 1_000_000, item.currency)}</small>` : ''}`)}</section>
        <section class="panel"><div class="panel-head"><div><span class="kicker">Групи</span><h2>Розхід за групами</h2></div></div>${bars(data.byGroup, item => esc(item.name))}</section>
        <section class="panel"><div class="panel-head"><div><span class="kicker">Учні</span><h2>Найбільший розхід</h2></div></div>${bars(data.byStudent, item => `${esc(item.name)}${item.groupName ? ` <small>${esc(item.groupName)}</small>` : ''}`)}</section>
      </div>
      <section class="panel ai-section"><div class="panel-head"><div><span class="kicker">Помилки API</span><h2>Що повернули провайдери</h2></div></div>
        ${data.errors.length ? `<div class="table-wrap"><table class="ai-compact"><thead><tr><th>Час</th><th>Провайдер</th><th>Модель</th><th>Код</th><th>Повідомлення</th></tr></thead><tbody>${data.errors.map(item => `<tr><td>${fmt(item.at)}</td><td>${esc(item.providerName)}</td><td>${esc(item.modelLabel ?? '—')}</td><td>${item.status ? `HTTP ${item.status}<small>${esc(item.code)}</small>` : esc(item.code)}</td><td>${esc(item.message)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted-copy">Помилок за період немає.</p>'}
      </section>`;
  }

  function bindAnalyticsFilters() {
    document.querySelectorAll('#ai-root [data-range]').forEach(button => { button.onclick = () => { ui.analytics.range = button.dataset.range; void reloadAnalytics(); }; });
    document.querySelectorAll('#ai-root [data-filter-key]').forEach(control => {
      control.onchange = () => {
        ui.analytics[control.dataset.filterKey] = control.value;
        if (control.dataset.filterKey === 'groupId') ui.analytics.studentId = '';
        void reloadAnalytics();
      };
    });
  }

  async function reloadAnalytics() {
    document.querySelector('#ai-root')?.setAttribute('aria-busy', 'true');
    await reload();
    document.querySelector('#ai-root')?.removeAttribute('aria-busy');
  }

  // -----------------------------------------------------------------------------------------
  // Agent: profile, skills (SKILL.md) and plugins

  const LANGUAGES = [['auto', 'Мовою учня'], ['uk', 'Українська'], ['en', 'English'], ['pl', 'Polski'], ['de', 'Deutsch']];
  const STYLES = [['friendly', 'Дружній, на «ти»'], ['concise', 'Стислий'], ['detailed', 'Докладний, з прикладами'], ['academic', 'Академічний']];
  const PERMISSIONS = { 'files:read': 'Читає прикріплені файли', 'files:write': 'Створює файли', network: 'Зовнішні запити — лише з підтвердженням учня', compute: 'Обчислення на сервері' };
  const TOOL_NAMES = ['read_file', 'create_file', 'calculate', 'wikipedia_search'];

  function agentView(data) {
    const { profile, skills, plugins } = data;
    const toolNames = [...new Set([...TOOL_NAMES, ...plugins.flatMap(plugin => plugin.tools.map(tool => tool.name))])].filter(name => name !== 'use_skill');
    ui.agentTools = toolNames;
    return `<section class="panel ai-agent-profile" aria-labelledby="aiAgentProfile">
        <div class="panel-head"><div><span class="kicker">Профіль</span><h2 id="aiAgentProfile">Агент для учнів</h2></div>${status(profile.agentEnabled ? 'active' : 'disabled', profile.agentEnabled ? 'Режим агента увімкнено' : 'Режим агента вимкнено')}</div>
        <form id="ai-agent-profile" class="ai-agent-form">
          <div class="ai-two">${field('Імʼя агента *', 'agentName', profile.agentName, 'text', 'required maxlength="40"')}${field('Кроків за одне завдання', 'agentMaxSteps', profile.agentMaxSteps, 'number', 'min="1" max="20" required')}</div>
          ${select('Модель для агента', 'agentModelId', [['', 'Основна доступна модель'], ...(data.models ?? []).filter(model => model.enabled && model.agent !== false).map(model => [model.id, model.label])], profile.agentModelId ?? '')}
          ${field('Опис (бачать учні)', 'agentDescription', profile.agentDescription, 'text', 'maxlength="300"')}
          <div class="ai-two">${select('Мова відповідей', 'agentLanguage', LANGUAGES, profile.agentLanguage)}${select('Стиль', 'agentStyle', STYLES, profile.agentStyle)}</div>
          <label class="field"><span>Інструкції (системний промпт для всіх відповідей)</span><textarea name="systemPrompt" rows="7" maxlength="8000" required>${esc(profile.systemPrompt)}</textarea></label>
          <label class="check"><input type="checkbox" name="agentEnabled" ${profile.agentEnabled ? 'checked' : ''}><span>Учні можуть вмикати режим агента: робота з файлами, створення документів, навички й плагіни</span></label>
          <div class="ai-actions"><button class="primary" type="submit">Зберегти профіль</button></div>
        </form>
      </section>
      <section class="panel" aria-labelledby="aiSkillsTitle">
        <div class="panel-head"><div><span class="kicker">SKILL.md</span><h2 id="aiSkillsTitle">Навички</h2></div><span class="muted-copy">${skills.filter(skill => skill.enabled).length} з ${skills.length} увімкнено</span></div>
        <p class="muted-copy">Навичка — інструкції для типового завдання: назва, опис, коли застосовувати, інструкції та інструменти. Учень обирає навичку в чаті, а в режимі агента агент може обрати її сам за умовами застосування.</p>
        <div class="ai-actions">
          <button class="primary" data-ai-action="skill-new">Створити навичку</button>
          <button class="secondary" data-ai-action="skill-import">Імпорт SKILL.md</button>
          <button class="secondary" data-ai-action="skill-export-all">Експорт усіх · ZIP</button>
        </div>
        <div class="ai-agent-list">${skills.map(skill => `<article class="ai-agent-item">
          <div class="ai-agent-item-head"><div><strong>${esc(skill.name)}</strong>${skill.builtin ? ' <span class="pill">Вбудована</span>' : ''}</div>${status(skill.enabled ? 'active' : 'disabled', skill.enabled ? 'Увімкнено' : 'Вимкнено')}</div>
          <p>${esc(skill.description) || '<span class="muted-copy">Без опису</span>'}</p>
          <p class="muted-copy"><b>Коли:</b> ${esc(skill.when) || '—'}</p>
          <p class="muted-copy"><b>Інструменти:</b> ${skill.tools.length ? skill.tools.map(tool => `<span class="pill code">${esc(tool)}</span>`).join(' ') : 'усі увімкнені'}</p>
          <div class="ai-row-actions">
            <button class="text-button" data-ai-action="skill-edit" data-id="${esc(skill.id)}">Редагувати</button>
            <button class="text-button" data-ai-action="skill-toggle" data-id="${esc(skill.id)}" data-enabled="${skill.enabled}">${skill.enabled ? 'Вимкнути' : 'Увімкнути'}</button>
            <button class="text-button" data-ai-action="skill-export" data-id="${esc(skill.id)}">Експорт</button>
            <button class="text-button ai-danger-link" data-ai-action="skill-delete" data-id="${esc(skill.id)}" data-name="${esc(skill.name)}" data-builtin="${skill.builtin}">${skill.builtin ? 'Скинути' : 'Видалити'}</button>
          </div>
        </article>`).join('')}</div>
      </section>
      <section class="panel" aria-labelledby="aiPluginsTitle">
        <div class="panel-head"><div><span class="kicker">Інструменти</span><h2 id="aiPluginsTitle">Плагіни</h2></div></div>
        <p class="muted-copy">Плагіни дають агенту інструменти. Секретні ключі зберігаються лише на сервері, зашифровано. Будь-який запит до зовнішнього сервісу агент виконує тільки після підтвердження учня; вказівки з документів не дають агенту нових дозволів.</p>
        <div class="ai-actions"><button class="primary" data-ai-action="plugin-import">Підключити плагін (маніфест JSON)</button></div>
        <div class="ai-agent-list">${plugins.map(plugin => `<article class="ai-agent-item">
          <div class="ai-agent-item-head"><div><strong>${esc(plugin.name)}</strong> <span class="code">v${esc(plugin.version)}</span> ${plugin.core ? '<span class="pill">Ядро</span>' : plugin.builtin ? '<span class="pill">Вбудований</span>' : '<span class="pill">Підключений</span>'}</div>${status(plugin.enabled ? 'active' : 'disabled', plugin.enabled ? 'Увімкнено' : plugin.installed ? 'Вимкнено' : 'Не встановлено')}</div>
          <p>${esc(plugin.description)}</p>
          ${plugin.baseUrl ? `<p class="muted-copy">Сервіс: <span class="code">${esc(plugin.baseUrl)}</span></p>` : ''}
          <p class="muted-copy"><b>Дозволи:</b> ${plugin.permissions.length ? plugin.permissions.map(permission => `<span class="pill">${esc(PERMISSIONS[permission] ?? permission)}</span>`).join(' ') : 'немає'}</p>
          <p class="muted-copy"><b>Інструменти:</b> ${plugin.tools.map(tool => `<span class="pill code" title="${esc(tool.description)}">${esc(tool.name)}</span>`).join(' ')}</p>
          ${plugin.secretsSchema.length ? `<p class="muted-copy"><b>Секрети:</b> ${plugin.secretsSchema.map(secret => `${esc(secret.label)} — ${plugin.secretsSet.includes(secret.key) ? 'задано' : '<span class="ai-warn">не задано</span>'}`).join(', ')}</p>` : ''}
          ${plugin.core ? '' : `<div class="ai-row-actions">
            ${plugin.installed ? `<button class="text-button" data-ai-action="plugin-toggle" data-id="${esc(plugin.id)}" data-enabled="${plugin.enabled}">${plugin.enabled ? 'Вимкнути' : 'Увімкнути'}</button>` : `<button class="text-button" data-ai-action="plugin-install" data-id="${esc(plugin.id)}">Встановити</button>`}
            ${plugin.installed && (plugin.settingsSchema.length || plugin.secretsSchema.length) ? `<button class="text-button" data-ai-action="plugin-settings" data-id="${esc(plugin.id)}">Налаштування</button>` : ''}
            ${plugin.installed ? `<button class="text-button ai-danger-link" data-ai-action="plugin-delete" data-id="${esc(plugin.id)}" data-name="${esc(plugin.name)}">Видалити</button>` : ''}
          </div>`}
        </article>`).join('')}</div>
      </section>`;
  }

  function skillForm(skill = null) {
    const tools = ui.agentTools ?? TOOL_NAMES;
    const chosen = new Set(skill?.tools ?? ['read_file', 'create_file']);
    return `${field('Назва *', 'name', skill?.name ?? '', 'text', 'required maxlength="60"')}
      ${field('Опис', 'description', skill?.description ?? '', 'text', 'maxlength="300"')}
      <label class="field"><span>Коли застосовувати</span><textarea name="when" rows="2" maxlength="500">${esc(skill?.when ?? '')}</textarea></label>
      <label class="field"><span>Інструкції *</span><textarea name="instructions" rows="10" maxlength="8000" required>${esc(skill?.instructions ?? '')}</textarea></label>
      <fieldset><legend>Інструменти навички (жодного — всі увімкнені)</legend><div class="check-grid">${tools.map(tool => `<label class="check"><input type="checkbox" name="tools" value="${esc(tool)}" ${chosen.has(tool) ? 'checked' : ''}><span class="code">${esc(tool)}</span></label>`).join('')}</div></fieldset>`;
  }

  const skillPayload = form => ({
    name: String(form.get('name')).trim(), description: String(form.get('description') ?? '').trim(),
    when: String(form.get('when') ?? '').trim(), instructions: String(form.get('instructions')).trim(), tools: form.getAll('tools').map(String)
  });

  async function saveDownload(promise) {
    const { blob, fileName } = await promise;
    const url = URL.createObjectURL(blob);
    const anchor = Object.assign(document.createElement('a'), { href: url, download: fileName });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function handleAgent(action, data, button, page) {
    switch (action) {
      case 'skill-new':
        return openModal('Нова навичка', skillForm(), async form => { await api.aiCreateSkill(skillPayload(form)); return { message: 'Навичку створено' }; }, false, 'Створити');
      case 'skill-edit': {
        const skill = page.skills.find(item => item.id === data.id);
        return openModal(`Навичка · ${skill.name}`, skillForm(skill), async form => { await api.aiUpdateSkill(skill.id, skillPayload(form)); return { message: 'Навичку збережено' }; }, false, 'Зберегти');
      }
      case 'skill-toggle':
        return run(button, () => api.aiUpdateSkill(data.id, { enabled: data.enabled !== 'true' }), data.enabled === 'true' ? 'Навичку вимкнено' : 'Навичку увімкнено');
      case 'skill-delete':
        return openModal(data.builtin === 'true' ? 'Скинути навичку' : 'Видалити навичку', data.builtin === 'true'
          ? `<p>Повернути вбудовану навичку «${esc(data.name)}» до початкового вигляду? Ваші зміни зникнуть.</p>`
          : `<p>Видалити навичку «${esc(data.name)}»? Учні більше не зможуть її обрати.</p>`, async () => {
          await api.aiDeleteSkill(data.id);
          return { message: data.builtin === 'true' ? 'Навичку скинуто' : 'Навичку видалено' };
        }, true, data.builtin === 'true' ? 'Скинути' : 'Видалити');
      case 'skill-export':
        return run(button, () => saveDownload(api.aiExportSkills(data.id)), null);
      case 'skill-export-all':
        return run(button, () => saveDownload(api.aiExportSkills(null)), null);
      case 'skill-import':
        return openModal('Імпорт навичок', `<p class="muted-copy">Оберіть один або кілька файлів SKILL.md (формат: метадані між рядками «---» — name, description, when, tools — і інструкції нижче) або вставте текст. Навичка з такою самою назвою буде замінена. Якщо хоч один файл некоректний, нічого не зміниться.</p>
          <label class="field"><span>Файли .md</span><input type="file" name="files" accept=".md,text/markdown,text/plain" multiple></label>
          <label class="field"><span>Або вставте SKILL.md</span><textarea name="pasted" rows="8" spellcheck="false" placeholder="---&#10;name: Моя навичка&#10;description: …&#10;when: …&#10;tools: read_file, create_file&#10;---&#10;Інструкції…"></textarea></label>`, async form => {
          const files = [];
          for (const file of form.getAll('files')) if (file && typeof file === 'object' && file.size) files.push({ name: file.name, content: await file.text() });
          const pasted = String(form.get('pasted') ?? '').trim();
          if (pasted) files.push({ name: 'вставлений текст', content: pasted });
          if (!files.length) throw new Error('Оберіть файл або вставте текст навички.');
          const result = await api.aiImportSkills(files);
          return { message: `Імпортовано навичок: ${result.imported}${result.replaced ? `, замінено: ${result.replaced}` : ''}` };
        }, false, 'Імпортувати');
      case 'plugin-install':
        return run(button, () => api.aiInstallPlugin(data.id), 'Плагін встановлено й увімкнено');
      case 'plugin-toggle':
        return run(button, () => api.aiUpdatePlugin(data.id, { enabled: data.enabled !== 'true' }), data.enabled === 'true' ? 'Плагін вимкнено' : 'Плагін увімкнено');
      case 'plugin-delete':
        return openModal('Видалити плагін', `<p>Видалити плагін «${esc(data.name)}» разом з його налаштуваннями й секретами? Агент більше не матиме його інструментів.</p>`, async () => {
          await api.aiDeletePlugin(data.id);
          return { message: 'Плагін видалено' };
        }, true, 'Видалити');
      case 'plugin-settings': {
        const plugin = page.plugins.find(item => item.id === data.id);
        const settingField = setting => {
          const value = plugin.settings[setting.key] ?? setting.default ?? '';
          if (setting.type === 'boolean') return `<label class="check"><input type="checkbox" name="s:${esc(setting.key)}" ${value ? 'checked' : ''}><span>${esc(setting.label)}</span></label>`;
          if (setting.type === 'select') return select(esc(setting.label), `s:${setting.key}`, (setting.options ?? []).map(option => [option, option]), value);
          return field(esc(setting.label), `s:${setting.key}`, value, setting.type === 'number' ? 'number' : 'text', 'maxlength="500"');
        };
        return openModal(`Налаштування · ${plugin.name}`, `${plugin.settingsSchema.map(settingField).join('')}
          ${plugin.secretsSchema.map(secret => `<label class="field"><span>${esc(secret.label)} ${plugin.secretsSet.includes(secret.key) ? '(задано — залиште порожнім, щоб не змінювати)' : '(не задано)'}</span><input name="k:${esc(secret.key)}" type="password" autocomplete="off" spellcheck="false" maxlength="4000"></label>`).join('')}
          ${plugin.secretsSchema.length ? '<p class="muted-copy">Секрети шифруються на сервері й ніколи не показуються в браузері. Щоб прибрати секрет, введіть «-».</p>' : ''}`, async form => {
          const settings = {};
          for (const setting of plugin.settingsSchema) {
            const raw = form.get(`s:${setting.key}`);
            settings[setting.key] = setting.type === 'boolean' ? raw === 'on' : setting.type === 'number' ? Number(raw) : String(raw ?? '');
          }
          const secrets = {};
          for (const secret of plugin.secretsSchema) {
            const raw = String(form.get(`k:${secret.key}`) ?? '').trim();
            if (raw === '-') secrets[secret.key] = null;
            else if (raw) secrets[secret.key] = raw;
          }
          await api.aiUpdatePlugin(plugin.id, { ...(plugin.settingsSchema.length ? { settings } : {}), ...(Object.keys(secrets).length ? { secrets } : {}) });
          return { message: 'Налаштування плагіна збережено' };
        }, false, 'Зберегти');
      }
      case 'plugin-import':
        return openModal('Підключити плагін', `<p class="muted-copy">Маніфест описує HTTPS-сервіс та його інструменти: id, name, version (1.0.0), description, permissions (network), baseUrl, secrets (ключі й заголовок, у якому їх надсилати), tools (name, description, parameters — JSON Schema, http: method і path). Після підключення плагін вимкнений: задайте секрети й увімкніть його.</p>
          <label class="field"><span>Файл plugin.json</span><input type="file" name="file" accept=".json,application/json"></label>
          <label class="field"><span>Або вставте JSON</span><textarea name="json" rows="10" spellcheck="false" placeholder='{"id":"dictionary","name":"Довідник","version":"1.0.0","permissions":["network"],"baseUrl":"https://api.example.com","secrets":[{"key":"apiKey","label":"API-ключ","header":"X-Api-Key"}],"tools":[{"name":"lookup_term","description":"Знайти визначення","parameters":{"type":"object","properties":{"term":{"type":"string"}},"required":["term"]},"http":{"method":"GET","path":"/lookup"}}]}'></textarea></label>`, async form => {
          const file = form.get('file');
          const text = file && typeof file === 'object' && file.size ? await file.text() : String(form.get('json') ?? '');
          let manifest;
          try { manifest = JSON.parse(text); } catch { throw new Error('Це не коректний JSON.'); }
          const result = await api.aiImportPlugin(manifest);
          return { message: result.updated ? 'Плагін оновлено' : 'Плагін підключено. Задайте секрети в «Налаштуваннях» і увімкніть його.' };
        }, false, 'Підключити');
    }
    return undefined;
  }

  // -----------------------------------------------------------------------------------------
  // Actions

  async function handle(action, data, button) {
    const route = currentRoute;
    // Balances change with every student request: act on fresh numbers.
    if (['grant', 'student-manage', 'monthly'].includes(action) && !document.querySelector('#modal.open')) await reload();
    const page = cache[route]?.data;
    if (action.startsWith('skill-') || action.startsWith('plugin-')) return handleAgent(action, data, button, page);
    switch (action) {
      case 'reload': return reload();
      case 'filters-reset': ui.analytics = { range: ui.analytics.range, groupId: '', studentId: '', modelId: '' }; return reloadAnalytics();
      case 'provider-new':
        return openModal('Новий провайдер ШІ', providerForm(), async form => {
          await api.aiCreateProvider({
            name: String(form.get('name')).trim(), protocol: form.get('protocol'), baseUrl: String(form.get('baseUrl')).trim(),
            apiKey: String(form.get('apiKey')).trim(), keyLabel: String(form.get('keyLabel') ?? '').trim() || undefined,
            headers: parseHeaders(form.get('headers')), balanceSource: form.get('balanceSource'), rateLimitPerMinute: providerRate(form), enabled: true
          });
          cache['ai-providers'] = null;
          return { message: 'Провайдера додано. Перевірте зʼєднання й додайте моделі.' };
        }, false, 'Додати');
      case 'provider-edit': {
        const provider = page.providers.find(item => item.id === data.id);
        return openModal(`Редагувати · ${provider.name}`, providerForm(provider), async form => {
          await api.aiUpdateProvider(provider.id, { name: String(form.get('name')).trim(), protocol: form.get('protocol'), baseUrl: String(form.get('baseUrl')).trim(), headers: parseHeaders(form.get('headers')), balanceSource: form.get('balanceSource'), rateLimitPerMinute: providerRate(form) });
          return { message: 'Провайдера оновлено. Якщо змінилась адреса або протокол, моделі треба перевірити знову.' };
        }, false, 'Зберегти');
      }
      case 'provider-toggle':
        return run(button, () => api.aiUpdateProvider(data.id, { enabled: data.enabled !== 'true' }), data.enabled === 'true' ? 'Провайдера вимкнено — його моделі недоступні учням' : 'Провайдера увімкнено');
      case 'provider-delete':
        return openModal('Видалити провайдера', `<p>Видалити «${esc(data.name)}» разом з його ключами та моделями? Учні втратять доступ до цих моделей. Історія використання залишиться в аналітиці.</p>`, async () => {
          await api.aiDeleteProvider(data.id);
          return { message: 'Провайдера видалено' };
        }, true, 'Видалити');
      case 'provider-test': {
        const result = await run(button, () => api.aiTestProvider(data.id));
        if (result) showInfo('Перевірка зʼєднання', `<div class="ai-check ${result.ok ? 'is-ok' : 'is-fail'}"><strong>${result.ok ? 'Зʼєднання працює' : 'Помилка'}</strong><span>${esc(result.message)}</span><small>${num(result.latencyMs)} мс</small></div>`);
        return;
      }
      case 'provider-balance': {
        const result = await run(button, () => api.aiSyncBalance(data.id));
        if (result) toast(`Баланс провайдера: ${money(result.amount, result.currency)}`);
        return;
      }
      case 'provider-discover': {
        button.disabled = true; button.setAttribute('aria-busy', 'true');
        try {
          const { models } = await api.aiDiscover(data.id);
          ui.discovered[data.id] = models;
          const list = models.map(model => `<div class="ai-discovered" data-search="${esc(`${model.id} ${model.label}`.toLowerCase())}"><div><strong>${esc(model.label)}</strong><span class="code">${esc(model.id)}</span>${model.contextWindow ? `<small>контекст ${num(model.contextWindow)}</small>` : ''}</div>${model.added ? '<span class="pill">Додано</span>' : `<button type="button" class="secondary" data-add-model="${esc(model.id)}" data-label="${esc(model.label)}" data-context="${model.contextWindow ?? ''}">Додати</button>`}</div>`).join('');
          showInfo(`Моделі з API · ${models.length}`, `<input class="ai-search" type="search" placeholder="Пошук: gpt, claude, gemini, deepseek, qwen…" aria-label="Пошук моделі"><div class="ai-discovered-list">${list || '<p class="muted-copy">Провайдер повернув порожній список.</p>'}</div>`);
          const layer = document.querySelector('#modal');
          layer.querySelector('.ai-search').oninput = event => {
            const term = event.target.value.trim().toLowerCase();
            layer.querySelectorAll('.ai-discovered').forEach(row => { row.hidden = Boolean(term) && !row.dataset.search.includes(term); });
          };
          layer.querySelectorAll('[data-add-model]').forEach(add => {
            add.onclick = async () => {
              add.disabled = true; add.setAttribute('aria-busy', 'true');
              try {
                const context = Number(add.dataset.context) || 16000;
                await api.aiCreateModel({ providerId: data.id, apiModelId: add.dataset.addModel, label: add.dataset.label, family: guessFamily(add.dataset.addModel), maxOutputTokens: 2048, maxInputTokens: Math.max(512, Math.min(context, 128000)) });
                add.replaceWith(Object.assign(document.createElement('span'), { className: 'pill', textContent: 'Додано' }));
                toast('Модель додано вимкненою. Увімкніть її в таблиці моделей — сервер перевірить запитом.');
                void reload();
              } catch (error) { add.disabled = false; add.removeAttribute('aria-busy'); toast(error.message, true); }
            };
          });
        } catch (error) { toast(error.message, true); }
        finally { if (button.isConnected) { button.disabled = false; button.removeAttribute('aria-busy'); } }
        return;
      }
      case 'key-new':
        return openModal('Додати API-ключ', `${field('Назва ключа', 'label', '', 'text', 'maxlength="60" placeholder="Напр. Резервний"')}${field('API Key *', 'apiKey', '', 'password', 'required minlength="8" maxlength="1000" autocomplete="off" spellcheck="false"')}<p class="muted-copy">Кілька ключів одного провайдера: якщо перший відповідає помилкою доступу чи ліміту, сервер спробує наступний — до початку відповіді.</p>`, async form => {
          await api.aiAddKey(data.id, { label: String(form.get('label') ?? '').trim() || undefined, apiKey: String(form.get('apiKey')).trim() });
          return { message: 'Ключ додано й зашифровано' };
        }, false, 'Додати');
      case 'key-toggle':
        return run(button, () => api.aiUpdateKey(data.provider, data.key, { enabled: data.enabled !== 'true' }), data.enabled === 'true' ? 'Ключ вимкнено' : 'Ключ увімкнено');
      case 'key-delete':
        return openModal('Видалити ключ', `<p>Видалити ключ «${esc(data.label)}»? Його не можна буде відновити — лише ввести знову.</p>`, async () => {
          await api.aiDeleteKey(data.provider, data.key);
          return { message: 'Ключ видалено' };
        }, true, 'Видалити');
      case 'model-new':
        return openModal('Нова модель', modelForm(page), async form => {
          const model = await api.aiCreateModel({ providerId: form.get('providerId'), ...modelPayload(form) });
          return { message: `Модель «${model.label}» додано. Натисніть «Увімкнути», щоб перевірити її й відкрити учням.` };
        }, false, 'Додати');
      case 'model-edit': {
        const model = page.models.find(item => item.id === data.id);
        return openModal(`Редагувати · ${model.label}`, modelForm(page, model), async form => {
          await api.aiUpdateModel(model.id, modelPayload(form));
          return { message: 'Модель оновлено' };
        }, false, 'Зберегти');
      }
      case 'model-toggle': {
        const enabling = data.enabled !== 'true';
        if (enabling) button.textContent = 'Перевіряємо…';
        return run(button, () => api.aiUpdateModel(data.id, { enabled: enabling }), enabling ? 'Модель відповіла на тестовий запит і тепер доступна учням' : 'Модель вимкнено');
      }
      case 'model-default':
        return run(button, () => api.aiSettings({ defaultModelId: data.id }), 'Основну модель змінено');
      case 'model-delete':
        return openModal('Видалити модель', `<p>Видалити «${esc(data.name)}»? Вона зникне з дозволених моделей учнів і груп.</p>`, async () => {
          await api.aiDeleteModel(data.id);
          return { message: 'Модель видалено' };
        }, true, 'Видалити');
      case 'model-probe': {
        const result = await run(button, () => api.aiProbeModel(data.id));
        if (result) showInfo('Можливості моделі', `<p>${esc(result.note)}</p><p class="muted-copy">Виконано два пробні запити. Баланси учнів не змінюються.</p>`);
        return;
      }
      case 'model-test': {
        const model = page.models.find(item => item.id === data.id);
        const result = await run(button, () => api.aiTestModel(data.id));
        if (result) showInfo(`Тест · ${model.label}`, testResult(result, model.label));
        return;
      }
      case 'grant': {
        const row = page.students.find(item => item.studentId === data.student);
        const amount = Number(data.amount);
        return openModal('Видати токени', `<p>Додати <strong>${num(amount)}</strong> токенів до балансу учня ${esc(row.name)}? Зараз доступно ${num(row.available)}.</p>${field('Примітка', 'note', '', 'text', 'maxlength="300"')}`, async form => {
          const result = await api.aiAdjust(row.studentId, { op: 'add', amount, note: String(form.get('note') ?? '').trim() || undefined });
          return { message: `${row.name}: ${num(result.before)} → ${num(result.after)} токенів` };
        }, false, `Видати ${num(amount)}`);
      }
      case 'student-manage': return studentManage(page, data.student);
      case 'block': {
        const blocking = data.blocked !== 'true';
        return openModal(blocking ? 'Заборонити доступ до ШІ' : 'Відновити доступ до ШІ', `<p>${blocking ? 'Учень бачитиме повідомлення «Доступ до ШІ тимчасово призупинено». Баланс не зміниться.' : 'Учень знову зможе надсилати запити в межах балансу.'}</p>${field('Примітка', 'note', '', 'text', 'maxlength="300"')}`, async form => {
          await api.aiFlags(data.student, { blocked: blocking, note: String(form.get('note') ?? '').trim() || undefined });
          return { message: blocking ? 'Доступ до ШІ призупинено' : 'Доступ до ШІ відновлено' };
        }, blocking, blocking ? 'Заборонити' : 'Відновити');
      }
      case 'monthly': {
        const row = page.students.find(item => item.studentId === data.student);
        return openModal('Автооновлення місячного ліміту', `<p>На початку кожного місяця (за київським часом) баланс учня встановлюється на цей ліміт. Невикористані токени не переносяться. Щоб вимкнути — вкажіть 0.</p>${field('Ліміт на місяць, токенів', 'limit', row.monthlyLimit || 1_000_000, 'number', 'required min="0" step="1"')}${field('Примітка', 'note', '', 'text', 'maxlength="300"')}`, async form => {
          const limit = Number(form.get('limit'));
          if (!Number.isInteger(limit) || limit < 0) throw new Error('Вкажіть ціле число токенів');
          await api.aiFlags(data.student, { monthlyLimit: limit, note: String(form.get('note') ?? '').trim() || undefined });
          return { message: limit ? `Щомісячний ліміт ${num(limit)} увімкнено, баланс оновлено` : 'Автооновлення вимкнено' };
        }, false, 'Зберегти');
      }
      case 'access': return accessModal(page, data.scope, data.id);
      case 'journal': {
        const row = page.students.find(item => item.studentId === data.student);
        try {
          const { entries } = await api.aiLedger(data.student, 200);
          showInfo(`Журнал · ${row?.name ?? ''}`, entries.length ? `<div class="table-wrap"><table class="ai-compact"><thead><tr><th>Час</th><th>Операція</th><th>Зміна</th><th>Баланс</th><th>Деталі</th></tr></thead><tbody>${entries.map(entry => `<tr><td>${fmt(entry.at)}</td><td>${esc(LEDGER_LABELS[entry.type] ?? entry.type)}</td><td class="${entry.amount < 0 ? 'ai-minus' : entry.amount > 0 ? 'ai-plus' : ''}">${entry.amount > 0 ? '+' : ''}${num(entry.amount)}</td><td>${num(entry.balanceAfter)}</td><td>${esc(entry.modelLabel ?? '')}${entry.approximate ? ' · оцінка' : ''}${entry.note ? ` · ${esc(entry.note)}` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted-copy">Записів немає.</p>');
        } catch (error) { toast(error.message, true); }
        return;
      }
      case 'group-grant': {
        const groups = page.groups.filter(group => group.status === 'active');
        return openModal('Видати токени групі', `${select('Група *', 'groupId', groups.map(group => [group.id, `${group.name} · ${group.studentCount} учнів`]), data.id ?? groups[0]?.id)}
          <label class="check"><input type="radio" name="op" value="add" checked><span>Додати кожному учню</span></label>
          <label class="check"><input type="radio" name="op" value="set"><span>Встановити кожному новий баланс</span></label>
          ${field('Кількість токенів на учня *', 'amount', 1_000_000, 'number', 'required min="0" step="1"')}
          <div class="ai-presets">${PRESETS.map(([amount, label]) => `<button type="button" class="pill ai-preset" data-fill="${amount}">${label}</button>`).join('')}</div>
          ${field('Примітка', 'note', '', 'text', 'maxlength="300"')}
          <p class="muted-copy">Кожна зміна потрапить у журнал з однією позначкою масової видачі.</p>`, async form => {
          const amount = Number(form.get('amount'));
          if (!Number.isInteger(amount) || amount < 0) throw new Error('Вкажіть ціле число токенів');
          const result = await api.aiGroupGrant(form.get('groupId'), { op: form.get('op'), amount, note: String(form.get('note') ?? '').trim() || undefined });
          return { message: `Оновлено балансів: ${result.count}. Загальна зміна ${num(result.delta)} токенів` };
        }, false, 'Застосувати');
      }
      case 'package-new':
        return openModal('Новий пакет ресурсу', packageForm(page), async form => {
          await api.aiCreatePackage(packagePayload(form));
          return { message: 'Пакет додано' };
        }, false, 'Додати');
      case 'package-edit': {
        const item = page.packages.find(entry => entry.id === data.id);
        return openModal(`Редагувати · ${item.name}`, packageForm(page, item), async form => {
          await api.aiUpdatePackage(item.id, packagePayload(form));
          return { message: 'Пакет оновлено' };
        }, false, 'Зберегти');
      }
      case 'package-delete':
        return openModal('Видалити пакет', `<p>Видалити запис про пакет «${esc(data.name)}»? Використання API та баланси учнів не зміняться.</p>`, async () => {
          await api.aiDeletePackage(data.id);
          return { message: 'Пакет видалено' };
        }, true, 'Видалити');
    }
  }

  function guessFamily(id) {
    const value = id.toLowerCase();
    if (/gpt|o1|o3|o4|openai/.test(value)) return 'gpt';
    if (/claude|anthropic/.test(value)) return 'claude';
    if (/gemini|google/.test(value)) return 'gemini';
    if (/deepseek/.test(value)) return 'deepseek';
    if (/qwen/.test(value)) return 'qwen';
    if (/llama/.test(value)) return 'llama';
    if (/mistral|mixtral/.test(value)) return 'mistral';
    return 'other';
  }

  // -----------------------------------------------------------------------------------------
  // Shell integration

  const intros = {
    'ai-providers': intro('Підключайте сторонні API — OpenAI-сумісні сервіси, агрегатори, реселерів із власним Base URL або Anthropic — і відкривайте учням лише перевірені моделі. Ключі зберігаються тільки на сервері, зашифровано.', '<button class="primary" data-ai-action="provider-new">Додати провайдера</button>'),
    'ai-tokens': intro('Внутрішні ліміти учнів у токенах. Сервер резервує бюджет перед запитом і списує фактичне використання з відповіді провайдера — дані клієнта не враховуються.'),
    'ai-resources': intro('Ресурс, куплений у провайдерів, окремо від лімітів учнів. Кредити в грошах не перераховуються в токени без ваших тарифів.'),
    'ai-analytics': intro('Витрата токенів, запити, помилки API й орієнтовна вартість. Тести адміністратора рахуються в ресурсі провайдера, але не в балансах учнів.'),
    'ai-agent': intro('Налаштуйте агента: імʼя, мову, стиль та інструкції; навички у форматі SKILL.md для типових навчальних завдань; плагіни з інструментами. Агент читає PDF, Word, Excel, PowerPoint і текст та створює справжні файли.')
  };

  return {
    views: Object.fromEntries(aiNav.map(([route]) => [route, () => shell(`${intros[route]}<div id="ai-root" aria-live="polite">${cache[route]?.data ? '' : loading()}</div>`)])),
    bind(route) {
      currentRoute = route;
      if (cache[route]?.data) paint(route);
      void reload();
      document.querySelectorAll('[data-ai-action]').forEach(element => {
        if (element.closest('#ai-root')) return;
        element.onclick = () => handle(element.dataset.aiAction, element.dataset, element);
      });
      const root = document.querySelector('#ai-root');
      if (root && !root.dataset.bound) {
        root.dataset.bound = '1';
        root.addEventListener('click', event => {
          const target = event.target.closest('[data-ai-action]');
          if (!target || target.disabled) return;
          void handle(target.dataset.aiAction, target.dataset, target);
        });
        root.addEventListener('input', event => {
          if (!event.target.matches('[data-filter]')) return;
          const term = event.target.value.toLocaleLowerCase('uk');
          root.querySelectorAll('tbody tr').forEach(row => { row.hidden = !row.textContent.toLocaleLowerCase('uk').includes(term); });
        });
        root.addEventListener('submit', async event => {
          if (event.target.id === 'ai-agent-profile') {
            event.preventDefault();
            const form = new FormData(event.target);
            const submit = event.target.querySelector('[type="submit"]');
            await run(submit, () => api.aiSettings({
              agentName: String(form.get('agentName')).trim(), agentDescription: String(form.get('agentDescription') ?? '').trim(),
              agentLanguage: form.get('agentLanguage'), agentStyle: form.get('agentStyle'), agentEnabled: form.get('agentEnabled') === 'on',
              agentMaxSteps: Number(form.get('agentMaxSteps')), agentModelId: form.get('agentModelId') || null, systemPrompt: String(form.get('systemPrompt')).trim()
            }), 'Профіль агента збережено');
            return;
          }
          if (event.target.id !== 'ai-settings') return;
          event.preventDefault();
          const form = new FormData(event.target);
          const submit = event.target.querySelector('[type="submit"]');
          await run(submit, () => api.aiSettings({
            systemPrompt: String(form.get('systemPrompt')).trim(), defaultModelId: form.get('defaultModelId') || null,
            maxMessageChars: Number(form.get('maxMessageChars')), requestsPerMinute: Number(form.get('requestsPerMinute')),
            maxConcurrentPerStudent: Number(form.get('maxConcurrentPerStudent')), lowBalanceTokens: Number(form.get('lowBalanceTokens')),
            resourceWarningPercent: Number(form.get('resourceWarningPercent')), memoryEnabled: form.get('memoryEnabled') === 'on'
          }), 'Налаштування збережено');
        });
      }
    },
    leave() { currentRoute = null; }
  };
}
