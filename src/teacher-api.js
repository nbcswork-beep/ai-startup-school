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
  const payload = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) { const error=new Error(payload?.error?.message || 'Не вдалося виконати дію');error.status=response.status;throw error; }
  return payload;
}

export const teacherApi = {
  async authenticate() {
    const result = await request('/auth/refresh', { method: 'POST' }, false);
    accessToken = result.accessToken;
    return result.user;
  },
  async logout() { await request('/auth/logout', { method:'POST' }, false); accessToken=''; },
  workspace: () => request('/teacher/bootstrap'),
  search: query => request(`/teacher/search?q=${encodeURIComponent(query)}`),
  createClass: input => request('/teacher/sessions', { method: 'POST', body: JSON.stringify(input) }),
  updateClass: (id, input) => request(`/teacher/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  reschedule: (id, input) => request(`/teacher/sessions/${id}/reschedule`, { method: 'POST', body: JSON.stringify(input) }),
  addMaterial: (id, input) => request(`/teacher/sessions/${id}/materials`, { method: 'POST', body: JSON.stringify(input) }),
  saveAttendance: (id, entries) => request(`/teacher/sessions/${id}/attendance`, { method: 'PUT', body: JSON.stringify({ entries }) }),
  createHomework: input => request('/teacher/homework', { method: 'POST', body: JSON.stringify(input) }),
  publishHomework: id => request(`/teacher/homework/${id}/publish`, { method: 'POST', body: JSON.stringify({ publishAt: new Date().toISOString() }) }),
  review: (id, input) => request(`/teacher/submissions/${id}/review`, { method: 'PUT', body: JSON.stringify(input) }),
  addNote: (studentId, input) => request(`/teacher/students/${studentId}/notes`, { method: 'POST', body: JSON.stringify(input) }),
  updatePortfolio: (id, input) => request(`/teacher/portfolio/items/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  createAvailability: input => request('/teacher/mentor/availability', { method: 'POST', body: JSON.stringify(input) }),
  updateBooking: (id, input) => request(`/teacher/mentor/bookings/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  generateReports: input => request('/teacher/reports/generate', { method: 'POST', body: JSON.stringify(input) }),
  saveReport: (id, input) => request(`/teacher/reports/${id}`, { method: 'PUT', body: JSON.stringify(input) }),
  approveReport: id => request(`/teacher/reports/${id}/approve`, { method: 'POST' })
};
