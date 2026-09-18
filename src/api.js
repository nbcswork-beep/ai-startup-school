let accessToken = '';

async function request(path, options = {}, retry = true) {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: 'include' });
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (refreshed.ok) {
      accessToken = (await refreshed.json()).accessToken;
      return request(path, options, false);
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error?.message || 'Не вдалося завантажити дані');
  }
  return response.status === 204 ? null : response.json();
}

async function authenticate() {
  const initData = window.Telegram?.WebApp?.initData;
  const endpoint = initData ? '/auth/telegram' : '/auth/development';
  const body = initData ? JSON.stringify({ initData }) : undefined;
  const result = await request(endpoint, { method: 'POST', ...(body ? { body } : {}) }, false);
  accessToken = result.accessToken;
  return result.user;
}

export const api = {
  authenticate,
  bootstrap: () => request('/bootstrap'),
  lesson: id => request(`/lessons/${id}`),
  completeLesson: (id, idempotencyKey) => request(`/lessons/${id}/complete`, { method: 'POST', body: JSON.stringify({ idempotencyKey }) }),
  schedule: () => request('/schedule'),
  homework: () => request('/homework'),
  submitHomework: (id, input) => request(`/homework/${id}/submissions`, { method: 'POST', body: JSON.stringify(input) }),
  portfolio: () => request('/portfolio'),
  addToPortfolio: (projectId, input = {}) => request(`/portfolio/projects/${projectId}`, { method: 'POST', body: JSON.stringify(input) }),
  mentorSlots: () => request('/mentor/availability'),
  bookMentor: availabilityId => request('/mentor/bookings', { method: 'POST', body: JSON.stringify({ availabilityId }) }),
  createProject: input => request('/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id, input) => request(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  completeTask: (projectId, taskId, idempotencyKey) => request(`/projects/${projectId}/tasks/${taskId}/complete`, { method: 'POST', body: JSON.stringify({ idempotencyKey }) }),
  createConversation: title => request('/ai/conversations', { method: 'POST', body: JSON.stringify({ title }) }),
  messages: id => request(`/ai/conversations/${id}/messages`),
  sendMessage: (id, content, clientMessageId) => request(`/ai/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ content, clientMessageId }) })
};
