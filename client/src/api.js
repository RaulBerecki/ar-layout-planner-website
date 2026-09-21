const TOKEN_KEY = 'arlp_token';
const USER_KEY = 'arlp_user';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch {
    return null;
  }
}

export function storeSession(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function request(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, { ...options, headers });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON response
  }
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  register: ({ username, password, orgMode, orgName, inviteCode }) =>
    request('/api/register', {
      method: 'POST',
      body: { username, password, orgMode, orgName, inviteCode },
    }),
  login: (username, password) =>
    request('/api/login', { method: 'POST', body: { username, password } }),
  recover: ({ username, recoveryCode, newPassword }) =>
    request('/api/recover', {
      method: 'POST',
      body: { username, recoveryCode, newPassword },
    }),
  me: () => request('/api/me'),
  getOrg: () => request('/api/org'),
  listFiles: () => request('/api/files'),
  uploadFile: (file, thumbnail) => {
    const form = new FormData();
    form.append('file', file);
    if (thumbnail) form.append('thumbnail', thumbnail);
    return request('/api/files', { method: 'POST', body: form });
  },
  setThumbnail: (id, thumbnail) =>
    request(`/api/files/${id}/thumbnail`, { method: 'POST', body: { thumbnail } }),
  deleteFile: (id) => request(`/api/files/${id}`, { method: 'DELETE' }),
  // Signed URL pointing directly at Supabase Storage (valid 5 minutes)
  getFileUrl: (id, { download = false } = {}) =>
    request(`/api/files/${id}/url${download ? '?download=1' : ''}`),
  downloadFile: async (id) => {
    const { url } = await api.getFileUrl(id, { download: true });
    // Direct link download: the browser streams from the CDN and shows
    // its native download progress; filename comes from the signed URL.
    const a = document.createElement('a');
    a.href = url;
    a.click();
  },

  // ---------- Production lines ----------
  listLines: () => request('/api/lines'),
  createLine: ({ name, markerSizeCm }) =>
    request('/api/lines', { method: 'POST', body: { name, markerSizeCm } }),
  updateLine: (id, changes) => request(`/api/lines/${id}`, { method: 'PATCH', body: changes }),
  deleteLine: (id) => request(`/api/lines/${id}`, { method: 'DELETE' }),
  // The QR image needs the login token, so it is fetched and turned into a local object URL.
  // Call URL.revokeObjectURL on the result when it is no longer shown.
  getLineQrUrl: async (id) => {
    const res = await fetch(`/api/lines/${id}/qr.png`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error(`Could not load the QR code (${res.status})`);
    return URL.createObjectURL(await res.blob());
  },

  // ---------- Roles and members ----------
  listPermissions: () => request('/api/permissions'),
  listRoles: () => request('/api/roles'),
  createRole: ({ name, permissions }) =>
    request('/api/roles', { method: 'POST', body: { name, permissions } }),
  updateRole: (id, changes) => request(`/api/roles/${id}`, { method: 'PATCH', body: changes }),
  deleteRole: (id) => request(`/api/roles/${id}`, { method: 'DELETE' }),
  setDefaultRole: (roleId) =>
    request('/api/org/default-role', { method: 'PUT', body: { roleId } }),
  listMembers: () => request('/api/members'),
  setMemberRole: (userId, roleId) =>
    request(`/api/members/${userId}/role`, { method: 'PUT', body: { roleId } }),
  // roleId null removes the per-line role, so the organization role applies again.
  setMemberLineRole: (userId, lineId, roleId) =>
    request(`/api/members/${userId}/lines/${lineId}`, { method: 'PUT', body: { roleId } }),
};
