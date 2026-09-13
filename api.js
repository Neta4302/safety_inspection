(function (root) {
  'use strict';
  // Thin fetch wrapper around the SafeCheck REST API. Every call either returns
  // parsed JSON or throws an Error with a Thai message the UI can toast directly.
  async function request(path, options) {
    let res;
    try {
      res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    } catch (err) {
      throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบว่า node server.js กำลังทำงานอยู่');
    }
    if (!res.ok) {
      let message = `คำขอไม่สำเร็จ (${res.status})`;
      let payload = null;
      try { payload = await res.json(); } catch (_) { /* non-JSON error body */ }
      if (payload && payload.error) message = payload.error;
      const err = new Error(message);
      // `code` lets the bilingual UI translate the message instead of showing the
      // server's Thai fallback; `data` carries values like remaining attempts.
      if (payload && payload.code) err.code = payload.code;
      if (payload) err.data = payload;
      err.status = res.status;
      // Signed in a moment ago but refused now: the session ended (idle, expired or
      // revoked). The app listens for this and returns to the login screen with a reason.
      if (res.status === 401 && !/^\/api\/(login|me|logout)$/.test(path) && root && typeof root.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        root.dispatchEvent(new CustomEvent('safecheck:unauthorized', { detail: payload }));
      }
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  const Api = {
    signup: payload => request('/api/signup', { method: 'POST', body: JSON.stringify(payload) }),
    login: (email, password) => request('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => request('/api/logout', { method: 'POST' }),
    me: () => request('/api/me'),
    getBootstrap: () => request('/api/bootstrap'),
    saveInspection: inspection => request('/api/inspections', { method: 'POST', body: JSON.stringify(inspection) }),
    updateAction: (inspectionId, itemId, actionStatus) =>
      request(`/api/actions/${encodeURIComponent(inspectionId)}/${encodeURIComponent(itemId)}`, { method: 'PATCH', body: JSON.stringify({ actionStatus }) }),
    createAlert: alert => request('/api/alerts', { method: 'POST', body: JSON.stringify(alert) }),
    updateAlert: (id, patch) => request(`/api/alerts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    updateEquipment: (id, patch) => request(`/api/equipment/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    addEquipment: equipment => request('/api/equipment', { method: 'POST', body: JSON.stringify(equipment) }),
    reset: () => request('/api/reset', { method: 'POST' }),
    submitFeedback: payload => request('/api/feedback', { method: 'POST', body: JSON.stringify(payload) }),
    getFeedback: () => request('/api/feedback'),
    // Raw binary upload — no base64 inflation, no multipart parsing needed.
    uploadMedia: file => request('/api/media', {
      method: 'POST',
      headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || '') },
      body: file
    }),
    deleteMedia: id => request(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    mediaUrl: id => `/api/media/${encodeURIComponent(id)}`,

    // Sessions and activity
    listMySessions: () => request('/api/sessions'),
    endMySession: sessionId => request(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
    endOtherSessions: () => request('/api/sessions/end-others', { method: 'POST' }),
    logView: view => request('/api/activity/view', { method: 'POST', body: JSON.stringify({ view }) }),

    // Approval workflow
    reviewInspection: (id, decision, note) =>
      request(`/api/inspections/${encodeURIComponent(id)}/review`, { method: 'POST', body: JSON.stringify({ decision, note }) }),
    approveInspection: (id, decision, note) =>
      request(`/api/inspections/${encodeURIComponent(id)}/approve`, { method: 'POST', body: JSON.stringify({ decision, note }) }),
    notifyStaff: payload => request('/api/notify', { method: 'POST', body: JSON.stringify(payload) }),
    markNotificationsRead: ids => request('/api/notifications/read', { method: 'POST', body: JSON.stringify({ ids }) }),

    // Administration — the server refuses all of these without the matching capability.
    admin: {
      listUsers: () => request('/api/admin/users'),
      createUser: user => request('/api/admin/users', { method: 'POST', body: JSON.stringify(user) }),
      updateUser: (id, patch) => request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      deleteUser: id => request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      getPermissions: () => request('/api/admin/permissions'),
      setPermissions: (role, capabilities) =>
        request(`/api/admin/permissions/${encodeURIComponent(role)}`, { method: 'PUT', body: JSON.stringify({ capabilities }) }),
      resetPermissions: () => request('/api/admin/permissions/reset', { method: 'POST' }),
      correctInspection: (id, patch) =>
        request(`/api/admin/inspections/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
      createVenue: venue => request('/api/admin/venues', { method: 'POST', body: JSON.stringify(venue) }),
      updateVenue: (id, venue) => request(`/api/admin/venues/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(venue) }),
      deleteVenue: id => request(`/api/admin/venues/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      deleteEquipment: id => request(`/api/equipment/${encodeURIComponent(id)}`, { method: 'DELETE' }),
      security: () => request('/api/admin/security'),
      listBackups: () => request('/api/admin/backups'),
      createBackup: label => request('/api/admin/backups', { method: 'POST', body: JSON.stringify({ label }) }),
      backupUrl: id => `/api/admin/backups/${encodeURIComponent(id)}`,
      restore: payload => request('/api/admin/restore', { method: 'POST', body: JSON.stringify(payload) }),
      sessions: () => request('/api/admin/sessions'),
      revokeSession: sessionId => request(`/api/admin/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
      activity: params => request('/api/admin/activity?' + new URLSearchParams(params || {}).toString())
    }
  };

  if (typeof module === 'object' && module.exports) module.exports = Api;
  if (root) root.SafeCheckApi = Api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
