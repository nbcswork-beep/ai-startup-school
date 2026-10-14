import {announceAcademicChange} from './academic-sync.js';
let accessToken = '';

async function request(path, options = {}, retry = true) {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`/api/v1${path}`, { ...options, headers, credentials: 'include', cache:'no-store' });
  if (response.status === 401 && retry && !path.startsWith('/auth/')) {
    const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (refreshed.ok) {
      accessToken = (await refreshed.json()).accessToken;
      return request(path, options, false);
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw Object.assign(new Error(payload.error?.message || 'Не вдалося завантажити дані'), { status: response.status, code: payload.error?.code });
  }
  if(options.method&&!path.startsWith('/auth/'))announceAcademicChange();
  return response.status === 204 ? null : response.json();
}

// Streams an AI answer (server-sent events). Same token refresh as request(), but the body is
// returned unread so the caller can show the answer while it is being written.
async function stream(path, body, signal, retry = true) {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`/api/v1${path}`, { method: 'POST', headers, body: JSON.stringify(body), credentials: 'include', cache: 'no-store', signal });
  if (response.status === 401 && retry) {
    const refreshed = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'include' });
    if (refreshed.ok) {
      accessToken = (await refreshed.json()).accessToken;
      return stream(path, body, signal, false);
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw Object.assign(new Error(payload.error?.message || 'Не вдалося надіслати повідомлення'), { status: response.status, code: payload.error?.code });
  }
  return response;
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
  revision:()=>request('/academic-revision'),
  bootstrap: () => request('/bootstrap'),
  home: () => request('/home'),
  projects: () => request('/projects'),
  learning: () => request('/learning'),
  lesson: id => request(`/lessons/${id}`),
  completeLesson: (id, idempotencyKey) => request(`/lessons/${id}/complete`, { method: 'POST', body: JSON.stringify({ idempotencyKey }) }),
  recoveries:()=>request('/recoveries'),
  schedule: () => request('/schedule'),
  homework: () => request('/homework'),
  submitHomework: (id, input) => request(`/homework/${id}/submissions`, { method: 'POST', body: JSON.stringify(input) }),
  reserveUpload: (homeworkId, input) => request(`/homework/${homeworkId}/uploads`, { method: 'POST', body: JSON.stringify(input) }),
  completeUpload: (homeworkId, uploadId) => request(`/homework/${homeworkId}/uploads/${uploadId}/complete`, { method: 'POST' }),
  discardUpload: (homeworkId, uploadId) => request(`/homework/${homeworkId}/uploads/${uploadId}`, { method: 'DELETE' }),
  portfolio: () => request('/portfolio'),
  addToPortfolio: (projectId, input = {}) => request(`/portfolio/projects/${projectId}`, { method: 'POST', body: JSON.stringify(input) }),
  mentorSlots: () => request('/mentor/availability'),
  bookMentor: availabilityId => request('/mentor/bookings', { method: 'POST', body: JSON.stringify({ availabilityId }) }),
  notifications: () => request('/notifications'),
  markNotificationsRead: (notificationIds = []) => request('/notifications/read', { method: 'POST', body: JSON.stringify({ notificationIds }) }),
  createProject: input => request('/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id, input) => request(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  addProjectNote:(projectId,input)=>request(`/projects/${projectId}/notes`,{method:'POST',body:JSON.stringify(input)}),
  submitProjectTask:(projectId,taskId,input)=>request(`/projects/${projectId}/tasks/${taskId}/submit`,{method:'POST',body:JSON.stringify(input)}),
  completeTask: (projectId, taskId, idempotencyKey) => request(`/projects/${projectId}/tasks/${taskId}/complete`, { method: 'POST', body: JSON.stringify({ idempotencyKey }) }),
  aiMe: () => request('/ai/me'),
  aiConversations: () => request('/ai/conversations'),
  aiConversation: id => request(`/ai/conversations/${id}`),
  aiRename: (id, title) => request(`/ai/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  aiDelete: id => request(`/ai/conversations/${id}`, { method: 'DELETE' }),
  aiStream: (conversationId, input, signal) => stream(`/ai/conversations/${conversationId}/stream`, input, signal),
  aiJob: (jobId, from = 0) => request(`/ai/jobs/${jobId}?from=${from}`),
  aiStopJob: jobId => request(`/ai/jobs/${jobId}/stop`, { method: 'POST' }),
  aiConfirmJob: (jobId, input) => request(`/ai/jobs/${jobId}/confirm`, { method: 'POST', body: JSON.stringify(input) }),
  aiFileLink: fileId => request(`/ai/files/${fileId}/link`, { method: 'POST' }),
  aiReserveAttachment: input => request('/ai/attachments', { method: 'POST', body: JSON.stringify(input) }),
  aiCompleteAttachment: id => request(`/ai/attachments/${id}/complete`, { method: 'POST' }),
  aiDeleteAttachment: id => request(`/ai/attachments/${id}`, { method: 'DELETE' }),
  aiArchive: (conversationId, messageId) => request(`/ai/conversations/${conversationId}/messages/${messageId}/archive`, { method: 'POST' })
};
