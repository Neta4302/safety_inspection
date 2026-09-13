(() => {
  'use strict';
  // Review & Approval screen, the notification bell, and the menu badges.
  // Every button here is a convenience: the server re-checks role, venue scope and the
  // record's stage on each request (see decideInspection in db.js).
  const App = window.SafeCheckApp;
  const Api = window.SafeCheckApi;
  const I18n = window.SafeCheckI18n;
  const { t, $, $$, escapeHtml, toast, formatDate, frequencyText, can, withLoading, errorText } = App;
  const state = App.state;

  let tab = 'queue';
  const openForms = new Map(); // record id -> 'reject' | 'notify'

  const currentRole = () => (state.user && App.ROLE_KEYS.includes(state.user.role) ? state.user.role : 'user');
  const isMine = ins => !!state.user && ins.submittedBy === state.user.id;

  // Overdue first, then the nearest deadline, then the newest.
  function byUrgency(a, b) {
    const rank = ins => ({ overdue: 0, due_soon: 1, on_track: 2 })[(App.deadlineInfo(ins) || {}).state] ?? 3;
    return rank(a) - rank(b) || String(a.deadline || '9').localeCompare(String(b.deadline || '9')) || b.date.localeCompare(a.date);
  }

  // Records that are waiting for this person to do something.
  function queue() {
    if (!state.data) return [];
    const rows = state.data.inspections || [];
    const stages = [];
    if (can('inspection.review')) stages.push('pending_review');
    if (can('inspection.approve')) stages.push('pending_approval');
    const toDecide = rows.filter(i => stages.includes(App.stageOf(i)) && !isMine(i));
    const toFix = can('inspection.submit') ? rows.filter(i => isMine(i) && App.stageOf(i) === 'rejected') : [];
    return [...toDecide, ...toFix].sort(byUrgency);
  }

  function allRows() {
    const status = $('#appr-status-filter').value;
    const term = $('#appr-search').value.trim().toLowerCase();
    return (state.data.inspections || [])
      // Staff follow their own records; other people's drafts are nobody else's business.
      .filter(i => (currentRole() === 'user' ? isMine(i) : App.stageOf(i) !== 'draft' || isMine(i)))
      .filter(i => status === 'all' || App.stageOf(i) === status)
      .filter(i => `${i.id} ${i.venueName} ${i.inspector}`.toLowerCase().includes(term))
      .sort(byUrgency);
  }

  function renderFlow(role) {
    const steps = ['user', 'inspector', 'supervisor', 'done'];
    const icons = { user: '📝', inspector: '🔎', supervisor: '✅', done: '🏁' };
    $('#appr-flow').innerHTML = steps.map((s, i) =>
      `${i ? '<span class="wf-arrow" aria-hidden="true">→</span>' : ''}<div class="wf-step ${s === role ? 'is-you' : ''}"><span aria-hidden="true">${icons[s]}</span><b>${escapeHtml(t('appr.flow.' + s))}</b>${s === role ? `<small>${escapeHtml(t('appr.flow.you'))}</small>` : ''}</div>`
    ).join('');
  }

  function formHtml(ins, kind) {
    const reject = kind === 'reject';
    return `<form class="appr-form" data-form="${kind}" data-id="${ins.id}">
      <label for="appr-${kind}-${ins.id}">${escapeHtml(t(reject ? 'appr.reasonLabel' : 'appr.notifyLabel'))}</label>
      <textarea id="appr-${kind}-${ins.id}" rows="2" maxlength="${reject ? 1000 : 500}" placeholder="${escapeHtml(t(reject ? 'appr.reasonPlaceholder' : 'notify.placeholder'))}"></textarea>
      <div class="form-error" hidden></div>
      <div class="appr-form-actions">
        <button class="btn ${reject ? 'btn-danger' : 'btn-primary'}" type="submit">${escapeHtml(t(reject ? 'appr.confirmReject' : 'appr.sendNotify'))}</button>
        <button class="btn btn-ghost" type="button" data-close-form="${ins.id}">${escapeHtml(t('appr.cancel'))}</button>
      </div>
    </form>`;
  }

  function cardHtml(ins) {
    const stage = App.stageOf(ins);
    const info = App.deadlineInfo(ins);
    const failed = (ins.items || []).filter(i => i.result === 'fail').length;
    const rejection = stage === 'rejected' ? (ins.history || []).filter(h => h.action === 'rejected').pop() : null;
    const canReview = stage === 'pending_review' && can('inspection.review') && !isMine(ins);
    const canApprove = stage === 'pending_approval' && can('inspection.approve') && !isMine(ins);
    const form = openForms.get(ins.id);

    let actions = `<button class="btn btn-secondary" type="button" data-detail="${ins.id}">${escapeHtml(t('appr.view'))}</button>`;
    if (canReview || canApprove) {
      actions += `<button class="btn btn-success" type="button" data-decide="${canReview ? 'review' : 'approve'}" data-id="${ins.id}">${escapeHtml(t(canReview ? 'appr.forward' : 'appr.approve'))}</button>`;
      actions += `<button class="btn btn-danger-outline" type="button" data-open-form="reject" data-id="${ins.id}">${escapeHtml(t('appr.reject'))}</button>`;
    }
    if (can('staff.notify') && ins.submittedBy && !isMine(ins)) {
      actions += `<button class="text-button" type="button" data-open-form="notify" data-id="${ins.id}">✉ ${escapeHtml(t('appr.notify'))}</button>`;
    }
    if (stage === 'rejected' && isMine(ins) && can('inspection.submit')) {
      actions += `<button class="btn btn-primary" type="button" data-edit="${ins.id}">${escapeHtml(t('appr.fix'))}</button>`;
    }
    const waitingFor = stage === 'pending_review' ? 'Inspector' : stage === 'pending_approval' ? 'Supervisor' : '';
    const scoreClass = ins.score < 70 ? 'low' : ins.score < 85 ? 'mid' : '';

    return `<article class="appr-card ${info ? 'dl-' + info.state : ''}" id="appr-${ins.id}">
      <div class="appr-main">
        <div class="appr-badges">${App.stageBadgeHtml(ins)}<span class="freq-tag">${escapeHtml(frequencyText(ins.frequency))}</span>${App.deadlineBadgeHtml(ins)}</div>
        <h3>${escapeHtml(ins.venueName)} <small>${escapeHtml(ins.id)}</small></h3>
        <div class="appr-meta">
          <span>${escapeHtml(t('appr.submittedBy'))} <b>${escapeHtml(ins.inspector)}</b></span>
          <span>${formatDate(ins.date)}</span>
          <span>${escapeHtml(t('result.score'))} <b class="score-badge ${scoreClass}">${ins.score}</b></span>
          ${failed ? `<span class="fail-count">${escapeHtml(t('appr.failed', { n: failed }))}</span>` : ''}
          ${waitingFor ? `<span>${escapeHtml(t('appr.waiting', { who: waitingFor }))}</span>` : ''}
        </div>
        ${rejection ? `<div class="appr-reason"><b>${escapeHtml(t('appr.rejectReason'))}</b> ${escapeHtml(rejection.note || '')} <small>— ${escapeHtml(rejection.byName || '')}</small></div>` : ''}
        ${form ? formHtml(ins, form) : ''}
      </div>
      <div class="appr-actions">${actions}</div>
    </article>`;
  }

  function emptyHtml(role) {
    if (tab === 'all') return `<div class="panel empty-state"><b>${escapeHtml(t('appr.emptyAll'))}</b></div>`;
    const user = role === 'user';
    return `<div class="panel empty-state"><b>${escapeHtml(t(user ? 'appr.emptyQueueUser' : 'appr.emptyQueue'))}</b>${escapeHtml(t(user ? 'appr.emptyQueueUserSub' : 'appr.emptyQueueSub'))}</div>`;
  }

  function renderNotifyForm() {
    const venue = $('#notify-venue');
    if (!venue || !can('staff.notify')) return;
    const previousVenue = venue.value;
    venue.innerHTML = state.data.venues.map(v => `<option value="${v.id}">${escapeHtml(v.name)}</option>`).join('');
    if (previousVenue) venue.value = previousVenue;
    const template = $('#notify-template');
    const previousTemplate = template.value;
    template.innerHTML = `<option value="">${escapeHtml(t('notify.templateNone'))}</option>` +
      [1, 2, 3, 4].map(n => `<option value="${n}">${escapeHtml(t('notify.tpl' + n))}</option>`).join('');
    template.value = previousTemplate;
  }

  function render() {
    if (!state.data) return;
    const role = currentRole();
    // Manager and Admin never have anything waiting on them, so an always-empty
    // "waiting for me" tab would only confuse; they get the full list straight away.
    const hasQueue = can('inspection.review') || can('inspection.approve') || can('inspection.submit');
    if (!hasQueue) tab = 'all';
    $('[data-appr-tab="queue"]').hidden = !hasQueue;
    $('#appr-title').textContent = t('appr.title.' + role);
    $('#appr-subtitle').textContent = t('appr.sub.' + role);
    const waiting = queue();
    $('#appr-pill').textContent = t('appr.pill', { n: waiting.length });
    $('#appr-pill').hidden = !waiting.length;
    renderFlow(role);
    $$('[data-appr-tab]').forEach(b => {
      const active = b.dataset.apprTab === tab;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    $('#appr-filter-row').hidden = tab !== 'all';
    const list = tab === 'queue' ? waiting : allRows();
    $('#appr-list').innerHTML = list.length ? list.map(cardHtml).join('') : emptyHtml(role);
    renderNotifyForm();
    App.bindDynamicButtons();
    refresh();
  }

  async function decide(button, id, step, decision, note) {
    await withLoading(button, null, async () => {
      const call = step === 'review' ? Api.reviewInspection : Api.approveInspection;
      const result = await call(id, decision, note);
      openForms.delete(id);
      await App.refreshData();
      App.renderAll();
      render();
      toast(decision === 'reject' ? t('appr.rejectedToast')
        : step === 'review' ? t('appr.forwardedToast')
        : result.late ? t('appr.approvedLateToast') : t('appr.approvedToast'));
    });
  }

  // --- Notification bell ---------------------------------------------------------------
  function notificationText(n) {
    const p = n.params || {};
    let freq = p.frequency ? frequencyText(p.frequency) : '';
    if (I18n.getLang() === 'en') freq = freq.toLowerCase();
    return t('notif.' + n.kind, {
      ...p, freq: freq ? ' ' + freq : '', fromName: n.fromName || '', byName: p.byName || n.fromName || '',
      deadline: p.deadline ? formatDate(p.deadline) : '-', note: p.note || '', message: p.message || '', venueName: p.venueName || ''
    });
  }

  function renderBellPanel() {
    const list = (state.data && state.data.notifications) || [];
    $('#notif-list').innerHTML = list.length
      ? list.map(n => `<button type="button" class="notif-item ${n.read ? '' : 'unread'}" data-notif="${n.id}"><span>${escapeHtml(notificationText(n))}</span><small>${formatDate(n.createdAt)}</small></button>`).join('')
      : `<div class="notif-empty">${escapeHtml(t('notif.empty'))}</div>`;
  }

  function setBellOpen(open) {
    $('#notif-panel').hidden = !open;
    $('#notif-button').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) renderBellPanel();
  }

  async function markRead(ids) {
    try { await Api.markNotificationsRead(ids); } catch (err) { console.warn('mark read failed', err); return; }
    (state.data.notifications || []).forEach(n => { if (!ids || ids.includes(n.id)) n.read = true; });
    refresh();
  }

  function openNotification(n) {
    if (!n) return;
    App.showView('approvals');
    if (n.inspectionId && state.data.inspections.some(i => i.id === n.inspectionId)) App.openDetail(n.inspectionId);
  }

  // Counts only — cheap enough to run after every data refresh.
  function refresh() {
    if (!state.data) return;
    const unread = (state.data.notifications || []).filter(n => !n.read).length;
    $('#notif-count').textContent = unread > 9 ? '9+' : unread;
    $('#notif-count').hidden = !unread;
    const waiting = queue().length;
    $('#nav-approval-count').textContent = waiting;
    $('#nav-approval-count').hidden = !waiting;
    const suspicious = (state.data.adminSummary && state.data.adminSummary.suspicious) || 0;
    $('#nav-admin-count').textContent = suspicious;
    $('#nav-admin-count').hidden = !suspicious;
    if (!$('#notif-panel').hidden) renderBellPanel();
  }

  // New submissions and decisions arrive without a reload. Skipped while someone is
  // filling in a checklist or typing a reason, so nothing they typed is redrawn away.
  async function poll() {
    if (!state.user || !state.data || document.visibilityState !== 'visible') return;
    if ($('#view-inspection').classList.contains('active') || openForms.size) return;
    try {
      state.data = await Api.getBootstrap();
      refresh();
      if ($('#view-approvals').classList.contains('active')) render();
    } catch (err) { /* offline for a moment — try again next time */ }
  }

  function bind() {
    $$('[data-appr-tab]').forEach(b => b.addEventListener('click', () => { tab = b.dataset.apprTab; render(); }));
    $('#appr-status-filter').addEventListener('change', render);
    $('#appr-search').addEventListener('input', render);

    const list = $('#appr-list');
    list.addEventListener('click', e => {
      const decideBtn = e.target.closest('[data-decide]');
      const openBtn = e.target.closest('[data-open-form]');
      const closeBtn = e.target.closest('[data-close-form]');
      if (decideBtn) {
        decide(decideBtn, decideBtn.dataset.id, decideBtn.dataset.decide, 'approve', '');
      } else if (openBtn) {
        openForms.set(openBtn.dataset.id, openBtn.dataset.openForm);
        render();
        const field = document.getElementById(`appr-${openBtn.dataset.openForm}-${openBtn.dataset.id}`);
        if (field) field.focus();
      } else if (closeBtn) {
        openForms.delete(closeBtn.dataset.closeForm);
        render();
      }
    });
    list.addEventListener('submit', async e => {
      const form = e.target.closest('[data-form]');
      if (!form) return;
      e.preventDefault();
      const id = form.dataset.id;
      const text = form.querySelector('textarea').value.trim();
      const errorEl = form.querySelector('.form-error');
      const button = form.querySelector('button[type=submit]');
      if (form.dataset.form === 'reject') {
        if (!text) { App.showFormError(errorEl, t('err.reasonRequired')); return; }
        const ins = state.data.inspections.find(i => i.id === id);
        await decide(button, id, ins && App.stageOf(ins) === 'pending_review' ? 'review' : 'approve', 'reject', text);
      } else {
        if (!text) { App.showFormError(errorEl, t('err.messageRequired')); return; }
        await withLoading(button, null, async () => {
          const result = await Api.notifyStaff({ inspectionId: id, message: text });
          openForms.delete(id);
          render();
          toast(t('appr.notifiedToast', { n: result.sent }));
        });
      }
    });

    $('#notify-template').addEventListener('change', e => {
      if (e.target.value) $('#notify-message').value = t('notify.tpl' + e.target.value);
    });
    $('#notify-form').addEventListener('submit', async e => {
      e.preventDefault();
      const errorEl = $('#notify-error');
      App.hideFormError(errorEl);
      const message = $('#notify-message').value.trim();
      if (!message) { App.showFormError(errorEl, t('err.messageRequired')); return; }
      const button = $('#notify-form button[type=submit]');
      button.disabled = true;
      try {
        const result = await Api.notifyStaff({ venueId: $('#notify-venue').value, message });
        $('#notify-message').value = '';
        $('#notify-template').value = '';
        toast(t('appr.notifiedToast', { n: result.sent }));
      } catch (err) {
        App.showFormError(errorEl, errorText(err));
      } finally {
        button.disabled = false;
      }
    });

    $('#notif-button').addEventListener('click', e => { e.stopPropagation(); setBellOpen($('#notif-panel').hidden); });
    $('#notif-panel').addEventListener('click', e => {
      e.stopPropagation();
      const item = e.target.closest('[data-notif]');
      if (!item) return;
      const n = (state.data.notifications || []).find(x => x.id === item.dataset.notif);
      setBellOpen(false);
      if (n && !n.read) markRead([n.id]);
      openNotification(n);
    });
    $('#notif-read-all').addEventListener('click', () => markRead(null));
    document.addEventListener('click', () => { if (!$('#notif-panel').hidden) setBellOpen(false); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#notif-panel').hidden) setBellOpen(false); });
    setInterval(poll, 60000);
  }

  App.registerView('approvals', { render, refresh, bind });
})();
