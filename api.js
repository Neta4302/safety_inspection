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
    // Raw binary upload — no base64 inflation, no multipart parsing needed.
    uploadMedia: file => request('/api/media', {
      method: 'POST',
      headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name || '') },
      body: file
    }),
    deleteMedia: id => request(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    mediaUrl: id => `/api/media/${encodeURIComponent(id)}`
  };

  if (typeof module === 'object' && module.exports) module.exports = Api;
  if (root) root.SafeCheckApi = Api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
