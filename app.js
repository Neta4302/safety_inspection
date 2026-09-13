(() => {
  'use strict';
  const Core = window.SafetyCore;
  const Api = window.SafeCheckApi;
  const I18n = window.SafeCheckI18n;
  const t = (k, v) => I18n.t(k, v);
  const content = () => I18n.content();

  const Workflow = window.SafeCheckWorkflow;
  const ROLE_KEYS = ['user', 'inspector', 'supervisor', 'manager', 'admin'];
  function roleMeta(role) {
    const key = ROLE_KEYS.includes(role) ? role : 'user';
    return { label: t(`role.${key}.label`), th: t(`role.${key}.th`), permissions: t(`role.${key}.perm`) };
  }

  const state = { user: null, data: null, currentInspection: null, reportInspectionId: null };
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];

  // Screens that live in their own files (approvals.js, admin.js) register here, so this
  // file can route to them without knowing their internals.
  const extraViews = {};
  function registerView(name, view) { extraViews[name] = view; }

  // --- Language-aware accessors for database-stored content ------------------------
  const isEn = () => I18n.getLang() === 'en';
  const itemTitle = item => (isEn() && item.titleEn) ? item.titleEn : item.title;
  const itemDesc = item => (isEn() && item.descEn) ? item.descEn : (item.desc || '');
  const venueLocation = v => (isEn() && v.locationEn) ? v.locationEn : v.location;
  const equipLabel = e => (isEn() && e.labelEn) ? e.labelEn : e.label;

  // Alerts are stored as coordinates (anomaly type + phrasing variant + zone/staff
  // index), so the sentence is composed at render time in the active language.
  function alertZone(a) {
    const zones = content().alertZones;
    return zones[a.zoneIndex] || zones[0];
  }
  function alertStaffName(a) {
    const staff = content().alertStaff;
    return staff[a.staffIndex] || staff[0];
  }
  function alertDetected(a) {
    const cat = content().anomaly[a.anomalyType];
    if (!cat) return '';
    const variants = cat[a.level] || cat.caution || [];
    let text = variants[a.variantIndex] || variants[0] || '';
    if (a.obstructionPct != null) text += content().obstructionPct.split('{pct}').join(a.obstructionPct);
    return text;
  }
  function anomalyLabel(type) { return content().anomaly[type]?.label || type; }

  function deviceIconSvg(icon) {
    const icons = {
      camera: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3"><rect x="10" y="22" width="34" height="22" rx="4"/><circle cx="27" cy="33" r="7"/><rect x="44" y="27" width="10" height="12" rx="2" fill="currentColor" stroke="none"/><rect x="16" y="16" width="10" height="7" rx="2" fill="currentColor" stroke="none"/></svg>',
      edge: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3"><rect x="14" y="16" width="36" height="32" rx="4"/><path d="M22 24h20M22 32h20M22 40h12" stroke-linecap="round"/><circle cx="46" cy="40" r="2.5" fill="currentColor" stroke="none"/></svg>',
      door: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3"><rect x="10" y="12" width="14" height="14" rx="3"/><rect x="40" y="12" width="14" height="14" rx="3"/><path d="M24 19h16" stroke-dasharray="3 3"/><rect x="14" y="30" width="36" height="24" rx="3"/><circle cx="42" cy="42" r="2" fill="currentColor" stroke="none"/></svg>',
      smoke: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3"><ellipse cx="32" cy="24" rx="22" ry="8"/><path d="M10 24v6c0 4.4 9.8 8 22 8s22-3.6 22-8v-6"/><circle cx="32" cy="24" r="4" fill="currentColor" stroke="none"/></svg>',
      siren: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 40c0-14 6-24 14-24s14 10 14 24"/><rect x="14" y="40" width="36" height="8" rx="3" fill="currentColor" stroke="none"/><path d="M32 8v6M18 14l4 4M46 14l-4 4" stroke-linecap="round"/></svg>',
      pir: '<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3"><path d="M32 12 12 44h40L32 12z" stroke-linejoin="round"/><path d="M32 24v14M24 32h16" stroke-width="2.5"/><circle cx="32" cy="46" r="3" fill="currentColor" stroke="none"/></svg>'
    };
    return icons[icon] || '';
  }
  const CAMERA_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.6"/></svg>';

  // Picture beside each checklist item. UAT testers found a text-only checklist hard to
  // relate to the real equipment, so each item shows what to look at.
  const ILLUSTRATIONS = {
    exit: '<rect x="12" y="8" width="26" height="48" rx="2" fill="#e8f5fa" stroke="#123956" stroke-width="3"/><circle cx="32" cy="33" r="2.5" fill="#123956"/><path d="M42 32h16m-7-7 7 7-7 7" stroke="#16a59b" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
    extinguisher: '<rect x="22" y="18" width="20" height="40" rx="9" fill="#d94a4a"/><rect x="27" y="10" width="10" height="9" rx="2" fill="#123956"/><path d="M37 13h10l4 4" stroke="#123956" stroke-width="3" fill="none" stroke-linecap="round"/><rect x="26" y="30" width="12" height="12" rx="2" fill="#fff" opacity=".85"/>',
    gauge: '<circle cx="32" cy="34" r="22" fill="#fff" stroke="#123956" stroke-width="3"/><path d="M15 40a18 18 0 0 1 11-22" stroke="#d94a4a" stroke-width="5" fill="none"/><path d="M29 16a18 18 0 0 1 21 23" stroke="#16a59b" stroke-width="5" fill="none"/><path d="M32 34l11-9" stroke="#123956" stroke-width="3" stroke-linecap="round"/><circle cx="32" cy="34" r="3" fill="#123956"/>',
    emlight: '<rect x="10" y="20" width="44" height="18" rx="4" fill="#e8f5fa" stroke="#123956" stroke-width="3"/><circle cx="21" cy="29" r="5" fill="#f0a51b"/><circle cx="43" cy="29" r="5" fill="#f0a51b"/><circle cx="32" cy="29" r="2" fill="#16a59b"/><path d="M21 43v9M43 43v9M14 45l-4 6M50 45l4 6" stroke="#f0a51b" stroke-width="3" stroke-linecap="round"/>',
    battery: '<rect x="10" y="20" width="38" height="24" rx="4" fill="#e8f5fa" stroke="#123956" stroke-width="3"/><rect x="48" y="27" width="5" height="10" rx="1" fill="#123956"/><path d="M31 23l-8 11h7l-3 8 10-12h-7l3-7z" fill="#f0a51b"/>',
    exitsign: '<rect x="6" y="18" width="52" height="28" rx="4" fill="#16a59b"/><text x="25" y="37" font-size="13" font-weight="700" fill="#fff" text-anchor="middle" font-family="Arial, sans-serif">EXIT</text><path d="M43 32h9m-4-4 4 4-4 4" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>',
    kitchen: '<path d="M10 26h34v4a12 12 0 0 1-12 12H22a12 12 0 0 1-12-12z" fill="#123956"/><path d="M44 28h12" stroke="#123956" stroke-width="4" stroke-linecap="round"/><path d="M27 60c-6-2-6-8-2-12 0 3 2 4 3 3-1-4 2-7 5-9 0 5 6 7 5 12-1 4-4 6-7 6z" fill="#f0a51b"/><path d="M20 18c0-3 3-3 3-6M28 18c0-3 3-3 3-6M36 18c0-3 3-3 3-6" stroke="#9aa8b1" stroke-width="2" fill="none" stroke-linecap="round"/>',
    alarm: '<path d="M20 44V30a12 12 0 0 1 24 0v14l4 5H16z" fill="#d94a4a"/><circle cx="32" cy="54" r="4" fill="#123956"/><path d="M10 26a24 24 0 0 1 6-11M54 26a24 24 0 0 0-6-11" stroke="#f0a51b" stroke-width="3" fill="none" stroke-linecap="round"/>',
    sprinkler: '<path d="M6 10h52" stroke="#123956" stroke-width="4" stroke-linecap="round"/><rect x="28" y="10" width="8" height="10" fill="#123956"/><path d="M22 22h20l-4 6H26z" fill="#d94a4a"/><path d="M20 36l-4 8M32 34v10M44 36l4 8M26 48l-2 7M38 48l2 7" stroke="#1676a7" stroke-width="3" stroke-linecap="round"/>',
    plan: '<rect x="8" y="10" width="48" height="44" rx="3" fill="#fff" stroke="#123956" stroke-width="3"/><path d="M8 30h20V10M36 54V36h20" stroke="#9aa8b1" stroke-width="2" fill="none"/><path d="M18 20v22h24" stroke="#16a59b" stroke-width="3" fill="none" stroke-dasharray="4 3"/><circle cx="46" cy="42" r="5" fill="#d94a4a"/>',
    people: '<circle cx="17" cy="24" r="7" fill="#1676a7"/><circle cx="47" cy="24" r="7" fill="#1676a7"/><circle cx="32" cy="20" r="8" fill="#123956"/><path d="M5 50a12 12 0 0 1 24 0zM35 50a12 12 0 0 1 24 0z" fill="#1676a7"/><path d="M18 52a14 14 0 0 1 28 0z" fill="#123956"/>',
    electric: '<rect x="14" y="8" width="36" height="48" rx="4" fill="#e8f5fa" stroke="#123956" stroke-width="3"/><path d="M36 15l-13 19h9l-4 15 14-20h-9l3-14z" fill="#f0a51b"/>',
    document: '<path d="M16 8h24l10 10v38H16z" fill="#fff" stroke="#123956" stroke-width="3" stroke-linejoin="round"/><path d="M40 8v10h10" fill="none" stroke="#123956" stroke-width="3"/><path d="M22 28h20M22 35h20M22 42h10" stroke="#9aa8b1" stroke-width="2.5" stroke-linecap="round"/><circle cx="44" cy="46" r="9" fill="#16a59b"/><path d="M40 46l3 3 5-6" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/>'
  };
  const ITEM_ILLUSTRATION = {
    'DLY-01': 'exit', 'DLY-02': 'extinguisher', 'DLY-03': 'emlight', 'DLY-04': 'exitsign', 'DLY-05': 'kitchen',
    'MON-01': 'alarm', 'MON-02': 'gauge', 'MON-03': 'sprinkler', 'MON-04': 'battery', 'MON-05': 'plan', 'MON-06': 'people',
    'YRL-01': 'extinguisher', 'YRL-02': 'alarm', 'YRL-03': 'sprinkler', 'YRL-04': 'electric', 'YRL-05': 'document'
  };
  function checkIllustration(id) {
    const key = ITEM_ILLUSTRATION[id] || 'document';
    // Yearly items are certificates, so their picture carries a small document badge.
    const badge = String(id).startsWith('YRL-') && key !== 'document'
      ? '<g transform="translate(34 34) scale(.46)">' + ILLUSTRATIONS.document + '</g>' : '';
    return `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">${ILLUSTRATIONS[key]}${badge}</svg>`;
  }

  function howToHtml(item) {
    const steps = (content().checkGuides || {})[item.id];
    if (!steps) return '';
    return `<details class="howto"><summary>💡 ${escapeHtml(t('insp.howTo'))}</summary><ol>${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}</ol></details>`;
  }

  function alertLevelText(l) { return t(`lvl.${l}`); }
  function alertStatusText(s) { return t(`alerts.st.${s}`); }
  function frequencyText(f) { return t(`freq.${f}`); }
  function equipmentStatusText(s) { return t(`equip.st.${s}`); }
  function equipmentStatusClass(s) { return s === 'expired' ? 'low' : s === 'expiring_soon' ? 'mid' : ''; }
  function equipmentTypeText(ty) { return t(`equip.type.${ty}`); }
  function statusText(status) { return status === 'submitted' ? t('hist.submitted') : t('hist.draft'); }
  function actionText(status) { return ({ open: t('act.open'), in_progress: t('act.inProgress'), closed: t('act.closed') })[status] || t('act.open'); }
  function scoreClass(score) { return score < 70 ? 'low' : score < 85 ? 'mid' : ''; }
  function escapeHtml(text = '') { return String(text).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[c]); }
  function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove('show'), 3200); }

  // Server errors carry a stable code; show the translated sentence when there is one.
  function errorText(err) {
    if (err && err.code) { const translated = t(err.code); if (translated !== err.code) return translated; }
    return (err && err.message) || t('common.unknownError');
  }

  // --- Approval stage and deadline display -----------------------------------------------
  function stageOf(ins) { return ins.status === 'draft' ? 'draft' : (ins.reviewStatus || 'approved'); }
  function isActive(ins) { const stage = stageOf(ins); return stage !== 'draft' && stage !== 'rejected'; }
  function stageBadgeHtml(ins) {
    const stage = stageOf(ins);
    return `<span class="stage-badge stage-${stage}">${escapeHtml(t('stage.' + stage))}</span>`;
  }
  function durationText(ms) {
    const minutes = Math.max(1, Math.round(Math.abs(ms) / 60000));
    if (minutes >= 1440) return t('time.days', { n: Math.floor(minutes / 1440) });
    if (minutes >= 60) return t('time.hours', { n: Math.floor(minutes / 60) });
    return t('time.minutes', { n: minutes });
  }
  // Only meaningful while a record is still waiting for someone to act on it.
  function deadlineInfo(ins) {
    const stage = stageOf(ins);
    if (!ins.deadline || (stage !== 'pending_review' && stage !== 'pending_approval')) return null;
    const state = Workflow.deadlineState(ins.deadline, ins.frequency);
    const diff = new Date(ins.deadline).getTime() - Date.now();
    const text = state === 'overdue' ? t('dl.overdue', { time: durationText(diff) })
      : state === 'due_soon' ? t('dl.dueSoon', { time: durationText(diff) })
      : t('dl.onTrack', { date: formatDate(ins.deadline) });
    return { state, text };
  }
  function deadlineBadgeHtml(ins) {
    const info = deadlineInfo(ins);
    if (info) return `<span class="deadline-badge dl-${info.state}">⏱ ${escapeHtml(info.text)}</span>`;
    const approval = (ins.history || []).filter(h => h.action === 'approved').pop();
    return approval && approval.late ? `<span class="deadline-badge dl-overdue">${escapeHtml(t('dl.late'))}</span>` : '';
  }

  function timelineHtml(ins) {
    const events = ins.history || [];
    if (!events.length) return '';
    return `<div class="timeline"><b>${escapeHtml(t('tl.title'))}</b><ol>${events.map(h => `<li class="tl-${h.action}"><span class="tl-dot"></span><div><b>${escapeHtml(t('tl.' + h.action))}</b>${h.late ? ` <span class="deadline-badge dl-overdue">${escapeHtml(t('tl.late'))}</span>` : ''}<small>${escapeHtml(h.byName || '-')}${h.role ? ' · ' + escapeHtml(roleMeta(h.role).label) : ''} · ${formatDate(h.at)}</small>${h.note ? `<p>${escapeHtml(h.note)}</p>` : ''}${h.changes && h.changes.length ? `<p class="tl-changes">${escapeHtml(h.changes.join(' · '))}</p>` : ''}</div></li>`).join('')}</ol></div>`;
  }

  // Drafts and records sent back can be reopened by the person who made them.
  function historyEditButton(ins, className = 'text-button') {
    if (!state.user || ins.submittedBy !== state.user.id || !can('inspection.submit')) return '';
    const stage = stageOf(ins);
    if (stage === 'draft') return ` <button class="${className}" data-edit="${ins.id}">${t('hist.resume')}</button>`;
    if (stage === 'rejected') return ` <button class="${className} danger-link" data-edit="${ins.id}">${t('hist.fix')}</button>`;
    return '';
  }

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '-';
    const locale = isEn() ? 'en-GB' : 'th-TH';
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  async function refreshData() { state.data = await Api.getBootstrap(); }

  async function withLoading(button, label, fn) {
    const original = button.textContent;
    button.disabled = true;
    if (label) button.textContent = label;
    try { await fn(); }
    catch (err) { console.error(err); toast(t('common.error') + errorText(err)); }
    finally { button.disabled = false; if (label) button.textContent = original; }
  }

  // --- Language switching -----------------------------------------------------------
  function applyLanguage() {
    I18n.applyStatic();
    renderAiScopeLists();
    if (state.user) applyUserChrome(state.user);
    if (state.data) renderAll();
    if (state.currentInspection) renderInspection();
    const activeView = $('.view.active');
    if (activeView) $('#page-title').textContent = t(activeView.dataset.titleKey);
    const extra = activeView && extraViews[activeView.id.replace('view-', '')];
    if (extra && state.data) extra.render();
  }

  function toggleLanguage() {
    I18n.setLang(isEn() ? 'th' : 'en');
    applyLanguage();
  }

  function renderAiScopeLists() {
    const detects = $('#ai-scope-detects');
    const ignores = $('#ai-scope-ignores');
    if (detects) detects.innerHTML = content().aiScopeDetects.map(s => `<li>${s}</li>`).join('');
    if (ignores) ignores.innerHTML = content().aiScopeIgnores.map(s => `<li>${escapeHtml(s)}</li>`).join('');
  }

  // --- Capabilities -------------------------------------------------------------------
  // A mirror of the server's matrix, used only to hide or disable controls that would
  // be refused anyway. The server re-checks every one of these, so editing this in
  // devtools changes what the page looks like and nothing about what it can do.
  function can(capability) {
    return !!state.user && (state.user.capabilities || []).includes(capability);
  }

  // Static controls opt in with data-cap="...". They are disabled rather than removed,
  // with a tooltip explaining why, so the control is visibly present but refused.
  function applyCapabilities() {
    $$('[data-cap]').forEach(el => {
      const allowed = can(el.dataset.cap);
      el.disabled = !allowed;
      el.classList.toggle('cap-denied', !allowed);
      el.title = allowed ? '' : t('cap.denied');
    });
    // data-cap-any hides a control entirely when the role has none of the listed
    // capabilities — for whole menu entries a greyed-out item is only clutter, and UAT
    // testers found the full menu overwhelming.
    $$('[data-cap-any]').forEach(el => {
      el.hidden = !el.dataset.capAny.split(',').some(c => can(c.trim()));
    });
  }

  // Explains, in the UI, why this account is seeing a subset of the data.
  function renderScopeBanner() {
    const el = $('#scope-banner');
    const scope = state.data && state.data.scope;
    if (!el || !scope) return;
    const caps = (scope.capabilities || []).map(c => t('cap.' + c)).join(' · ');
    const summary = scope.unrestricted
      ? t('scope.all', { n: scope.totalVenueCount })
      : t('scope.limited', { n: scope.venueCount, total: scope.totalVenueCount, branch: scope.branch });
    const readOnly = !(scope.capabilities || []).some(c => c !== 'feedback.submit');
    el.innerHTML = `<div><b>${escapeHtml(t('scope.title'))}</b><p>${escapeHtml(summary)}</p>` +
      `<p class="scope-caps">${readOnly ? escapeHtml(t('scope.readOnly')) : `${escapeHtml(t('scope.canDo'))} ${escapeHtml(caps)}`}</p></div>`;
  }

  // --- Auth --------------------------------------------------------------------------
  function applyUserChrome(user) {
    const meta = roleMeta(user.role);
    const initial = user.name.trim().charAt(0) || 'U';
    $('#user-name').textContent = user.name;
    $('#user-role').textContent = meta.th;
    $('#user-initial').textContent = initial;
    $('#dropdown-initial').textContent = initial;
    $('#dropdown-name').textContent = user.name;
    $('#dropdown-email').textContent = user.email || '';
    $('#role-badge').textContent = `${meta.label} · ${meta.permissions}`;
    $('#welcome-title').textContent = `${t('dash.greeting')}, ${user.name.split(' ')[0]}`;
  }

  async function enterApp(user) {
    state.user = user;
    lastLoggedView = '';
    $('#login-screen').hidden = true;
    $('#app-shell').hidden = false;
    applyUserChrome(user);
    await refreshData();
    renderAll();
    showView('dashboard');
  }

  function showFormError(el, message) { el.textContent = message; el.hidden = false; }
  function hideFormError(el) { el.hidden = true; el.textContent = ''; }
  function showFormNotice(el, message) { el.textContent = message; el.hidden = false; }

  // Server errors arrive with a stable code; translate it when we know it, and fall
  // back to the server's own message for anything unmapped.
  function authErrorText(err) {
    if (!err.code) return err.message;
    const vars = { n: err.data?.remaining ?? 0, min: err.data?.minutes ?? 10 };
    const translated = t(err.code, vars);
    if (translated === err.code) return err.message;
    if (err.code === 'err.invalidCredentials' && err.data?.remaining > 0) {
      return `${translated} ${t('err.attemptsLeft', { n: err.data.remaining })}`;
    }
    return translated;
  }

  // Login/signup errors surface inline in the form only — not as a toast too, to
  // avoid double-signaling the same failure.
  async function submitLogin(email, password) {
    const errorEl = $('#login-error');
    hideFormError(errorEl);
    hideFormError($('#login-notice'));
    const btn = $('#login-form button[type=submit]');
    const original = btn.innerHTML;
    btn.disabled = true; btn.textContent = t('auth.loggingIn');
    try {
      const { user } = await Api.login(email, password);
      await enterApp(user);
    } catch (err) {
      showFormError(errorEl, authErrorText(err));
    } finally {
      btn.disabled = false; btn.innerHTML = original;
    }
  }

  // Signing up does not log you straight in — it hands you back to the login tab
  // with the new email prefilled, so the account is used at least once knowingly.
  async function submitSignup(payload) {
    const errorEl = $('#signup-error');
    hideFormError(errorEl);
    const btn = $('#signup-form button[type=submit]');
    const original = btn.innerHTML;
    btn.disabled = true; btn.textContent = t('auth.signingUp');
    try {
      const { user } = await Api.signup(payload);
      $('#signup-form').reset();
      switchAuthTab('login');
      hideFormError($('#login-error'));
      showFormNotice($('#login-notice'), t('auth.signupSuccess'));
      $('#login-email').value = user.email;
      $('#login-password').value = '';
      $('#login-password').focus();
    } catch (err) {
      showFormError(errorEl, authErrorText(err));
    } finally {
      btn.disabled = false; btn.innerHTML = original;
    }
  }

  // --- Profile menu -----------------------------------------------------------------
  function setUserMenuOpen(open) {
    const dropdown = $('#user-dropdown');
    const trigger = $('#user-menu');
    if (!dropdown || !trigger) return;
    dropdown.hidden = !open;
    trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    trigger.classList.toggle('open', open);
  }
  const userMenuOpen = () => !$('#user-dropdown')?.hidden;

  async function logout() {
    setUserMenuOpen(false);
    try { await Api.logout(); } catch (err) { console.error(err); }
    showLoginScreen(t('auth.loggedOut'));
  }

  // Also used when the server reports that the session has ended (idle, expired or
  // signed out by an administrator), so the person sees why they are back here.
  function showLoginScreen(notice) {
    state.user = null;
    state.data = null;
    state.currentInspection = null;
    lastLoggedView = '';
    if ($('#detail-dialog').open) $('#detail-dialog').close();
    $('#app-shell').hidden = true;
    $('#login-screen').hidden = false;
    // Land back on a clean login form, not whatever was last typed or shown.
    switchAuthTab('login');
    hideFormError($('#login-error'));
    showFormNotice($('#login-notice'), notice);
    $('#login-password').value = '';
  }

  // "Signed-in devices": every session of this account, with a way to end the others.
  async function openMySessions() {
    setUserMenuOpen(false);
    let data;
    try { data = await Api.listMySessions(); } catch (err) { toast(t('common.error') + errorText(err)); return; }
    const others = data.sessions.filter(s => !s.current);
    const row = s => `<div class="session-row${s.current ? ' is-current' : ''}">
      <div><b>${escapeHtml(s.device || t('sess.unknownDevice'))}</b>${s.current ? ` <span class="stage-badge stage-approved">${escapeHtml(t('sess.current'))}</span>` : ''}
        <small>IP ${escapeHtml(s.ip || '-')} · ${escapeHtml(t('sess.started'))} ${formatDate(s.startedAt)} · ${escapeHtml(t('sess.lastSeen'))} ${formatDate(s.lastSeenAt)}</small></div>
      ${s.current ? '' : `<button type="button" class="btn btn-danger-outline" data-end-session="${escapeHtml(s.sessionId)}">${escapeHtml(t('sess.end'))}</button>`}
    </div>`;
    $('#dialog-content').innerHTML = `<span class="eyebrow">SESSIONS</span><h2>${escapeHtml(t('sess.myTitle'))}</h2>
      <p class="admin-note">${escapeHtml(t('sess.mySub', { idle: data.idleMinutes }))}</p>
      <div class="session-list">${data.sessions.map(row).join('')}</div>
      ${others.length ? `<div class="result-actions"><button type="button" class="btn btn-secondary" id="end-other-sessions">${escapeHtml(t('sess.endOthers'))}</button></div>` : ''}`;
    if (!$('#detail-dialog').open) $('#detail-dialog').showModal();
    $$('[data-end-session]').forEach(b => { b.onclick = () => withLoading(b, null, async () => {
      await Api.endMySession(b.dataset.endSession);
      toast(t('sess.endedToast'));
      await openMySessions();
    }); });
    const endAll = $('#end-other-sessions');
    if (endAll) endAll.onclick = () => withLoading(endAll, null, async () => {
      await Api.endOtherSessions();
      toast(t('sess.endedToast'));
      await openMySessions();
    });
  }

  function switchAuthTab(tab) {
    $$('.tab-btn[data-auth-tab]').forEach(b => { const active = b.dataset.authTab === tab; b.classList.toggle('active', active); b.setAttribute('aria-selected', active ? 'true' : 'false'); });
    $('#login-form').hidden = tab !== 'login';
    $('#signup-form').hidden = tab !== 'signup';
  }

  // Page visits go to the activity log so an administrator can follow what someone did
  // during a session. Best effort: a failed log call never gets in the person's way.
  let lastLoggedView = '';
  function logView(name) {
    if (!state.user || name === lastLoggedView) return;
    lastLoggedView = name;
    Api.logView(name).catch(() => {});
  }

  function showView(name) {
    $$('.view').forEach(view => view.classList.toggle('active', view.id === `view-${name}`));
    $$('.main-nav button').forEach(btn => btn.classList.toggle('active', btn.dataset.view === name));
    const active = $(`#view-${name}`);
    $('#page-title').textContent = active ? t(active.dataset.titleKey) : 'SafeCheck';
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (name === 'dashboard') renderDashboard();
    if (name === 'venues') renderVenues();
    if (name === 'history') renderHistory();
    if (name === 'actions') renderActions();
    if (name === 'alerts') { renderAlerts(); renderAlertHistory(); }
    if (name === 'sensors') renderSensors();
    if (name === 'equipment') renderEquipment();
    if (name === 'standards') renderStandards();
    if (name === 'testing') renderTesting();
    if (name === 'feedback') renderFeedback();
    if (extraViews[name]) extraViews[name].render();
    logView(name);
    $('.sidebar').classList.remove('open');
  }

  // --- UAT feedback -------------------------------------------------------------
  // A tester only ever runs one track, so showing all six tasks made the form look
  // three times longer than the work they actually did. They also could not tell
  // which task "UAT-03" referred to without going back to the instructions file, so
  // each row now carries its Thai task name.
  const FB_TASKS = {
    'UAT-01': 'fb.task01', 'UAT-02': 'fb.task02', 'UAT-03': 'fb.task03',
    'UAT-04': 'fb.task04', 'UAT-05': 'fb.task05', 'UAT-06': 'fb.task06'
  };
  const FB_TRACKS = {
    A: ['UAT-01', 'UAT-02', 'UAT-06'],
    B: ['UAT-03', 'UAT-04', 'UAT-06'],
    C: ['UAT-05', 'UAT-06'],
    ALL: ['UAT-01', 'UAT-02', 'UAT-03', 'UAT-04', 'UAT-05', 'UAT-06']
  };
  let fbTrack = '';
  let fbEase = 0;

  function fbScenarioRow(id) {
    const opt = (v, key) => '<option value="' + v + '">' + escapeHtml(t(key)) + '</option>';
    return '<div class="fb-row">' +
      '<div class="fb-task">' +
        '<span class="fb-code">' + id + '</span>' +
        '<b>' + escapeHtml(t(FB_TASKS[id])) + '</b>' +
      '</div>' +
      '<div class="fb-controls">' +
        '<select data-fb-status="' + id + '" aria-label="' + escapeHtml(t(FB_TASKS[id])) + '">' +
          opt('', 'fb.notDone') + opt('pass', 'fb.pass') + opt('slow', 'fb.slow') + opt('fail', 'fb.fail') +
        '</select>' +
        '<select data-fb-difficulty="' + id + '" aria-label="' + escapeHtml(t('fb.difficulty')) + '">' +
          '<option value="">' + escapeHtml(t('fb.difficulty')) + '</option>' +
          '<option value="1">1</option><option value="2">2</option><option value="3">3</option>' +
          '<option value="4">4</option><option value="5">5</option>' +
        '</select>' +
      '</div>' +
      '<input class="fb-note" data-fb-note="' + id + '" maxlength="500" placeholder="' +
        escapeHtml(t('fb.notePlaceholder')) + '">' +
    '</div>';
  }

  function renderFeedbackTasks() {
    const host = $('#fb-scenarios');
    if (!host) return;
    if (!fbTrack) {
      host.innerHTML = '<p class="fb-hint">' + escapeHtml(t('fb.pickTrackFirst')) + '</p>';
      return;
    }
    host.innerHTML = FB_TRACKS[fbTrack].map(fbScenarioRow).join('');
  }

  function renderFeedbackForm() {
    const picker = $('#fb-track-picker');
    if (!picker || picker.dataset.built === 'yes') return;
    picker.dataset.built = 'yes';

    picker.innerHTML = ['A', 'B', 'C', 'ALL']
      .map(k => '<button type="button" class="fb-track-btn" data-track="' + k + '">' +
        escapeHtml(t('fb.track' + k)) + '</button>').join('');
    picker.onclick = e => {
      const btn = e.target.closest('[data-track]');
      if (!btn) return;
      fbTrack = btn.dataset.track;
      picker.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      renderFeedbackTasks();
    };
    renderFeedbackTasks();

    const scale = $('#fb-ease');
    if (scale) {
      scale.innerHTML = [1, 2, 3, 4, 5].map(v => '<button type="button" data-ease="' + v + '">' + v + '</button>').join('');
      scale.onclick = e => {
        const btn = e.target.closest('[data-ease]');
        if (!btn) return;
        fbEase = Number(btn.dataset.ease);
        scale.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
      };
    }
  }

  function feedbackAnswerHtml(r) {
    const line = s => (FB_TASKS[s.id] ? s.id + ' ' + escapeHtml(t(FB_TASKS[s.id])) : s.id) +
      ' — ' + escapeHtml(s.status || '-') +
      (s.difficulty ? ' (' + s.difficulty + '/5)' : '') +
      (s.note ? ' · ' + escapeHtml(s.note) : '');
    return '<div class="fb-answer">' +
      '<h4>' + escapeHtml(r.testerName) + '</h4>' +
      '<div class="fb-meta">' + formatDate(r.createdAt) + ' · ' + escapeHtml(r.device || '-') + ' · ' + escapeHtml(r.roleUsed || '-') + '</div>' +
      '<p><b>' + escapeHtml(t('fb.ease')) + ':</b> ' + (r.easeRating || '-') + '/5 · <b>' +
        escapeHtml(t('fb.useful')) + ':</b> ' + escapeHtml(r.usefulness || '-') + '</p>' +
      '<p><b>' + escapeHtml(t('fb.accept')) + ':</b> ' + escapeHtml(r.acceptance || '-') + ' ' + escapeHtml(r.acceptanceNote || '') + '</p>' +
      (r.confusing ? '<p><b>' + escapeHtml(t('fb.confusing')) + ':</b> ' + escapeHtml(r.confusing) + '</p>' : '') +
      (r.missing ? '<p><b>' + escapeHtml(t('fb.missing')) + ':</b> ' + escapeHtml(r.missing) + '</p>' : '') +
      '<p>' + r.scenarios.map(line).join('<br>') + '</p>' +
    '</div>';
  }

  function renderFeedback() {
    renderFeedbackForm();
    const pill = $('#nav-feedback-count');
    if (pill) pill.textContent = (state.data && state.data.feedbackCount) || 0;

    const panel = $('#fb-admin-panel');
    if (!panel) return;
    const rows = state.data && state.data.feedback;
    // `feedback` is null unless the server decided this user may read it, so the panel
    // cannot appear for anyone else — the data simply is not in the payload.
    panel.hidden = !rows;
    if (!rows) return;
    $('#fb-admin-list').innerHTML = rows.length
      ? rows.map(feedbackAnswerHtml).join('')
      : '<div class="empty-state"><b>' + escapeHtml(t('fb.adminEmpty')) + '</b></div>';
  }

  async function submitFeedback() {
    const errorEl = $('#fb-error');
    hideFormError(errorEl);
    const name = $('#fb-name').value.trim();
    if (!name) { showFormError(errorEl, t('fb.errName')); $('#fb-name').focus(); return; }
    if (!fbTrack) { showFormError(errorEl, t('fb.errTrack')); return; }
    const accept = document.querySelector('input[name="fb-accept"]:checked');
    if (!accept) { showFormError(errorEl, t('fb.errAccept')); return; }

    const scenarios = FB_TRACKS[fbTrack].map(id => ({
      id,
      status: $('[data-fb-status="' + id + '"]').value,
      difficulty: Number($('[data-fb-difficulty="' + id + '"]').value) || null,
      note: $('[data-fb-note="' + id + '"]').value.trim()
    })).filter(s => s.status || s.note);

    await withLoading($('#fb-form button[type=submit]'), t('fb.sending'), async () => {
      await Api.submitFeedback({
        testerName: name,
        device: $('#fb-device').value,
        scenarios,
        easeRating: fbEase,
        usefulness: $('#fb-useful').value,
        confusing: $('#fb-confusing').value.trim(),
        missing: $('#fb-missing').value.trim(),
        acceptance: accept.value,
        acceptanceNote: $('#fb-accept-note').value.trim()
      });
      await refreshData();
      $('#fb-form').hidden = true;
      $('#fb-thanks').hidden = false;
      renderFeedback();
      toast(t('fb.thanksToast'));
    });
  }

  function renderAll() {
    renderDashboard(); renderVenues(); renderHistory(); renderActions();
    renderAlerts(); renderAlertHistory(); renderSensors(); renderEquipment();
    renderStandards(); renderTesting();
    renderFeedback();
    Object.values(extraViews).forEach(v => v.refresh && v.refresh());
    renderScopeBanner(); applyCapabilities();
  }

  // --- Role-based dashboard emphasis — visual focus only, every page stays reachable.
  // Home-page task guide: three numbered steps for this role plus live counts, so a new
  // user can see what they are expected to do without first learning the menu.
  function renderRoleFocus() {
    const el = $('#role-focus-banner');
    if (!el || !state.user) return;
    const role = ROLE_KEYS.includes(state.user.role) ? state.user.role : 'user';
    const rows = state.data.inspections || [];
    const mine = rows.filter(i => i.submittedBy === state.user.id);
    const waiting = list => list.filter(i => ['pending_review', 'pending_approval'].includes(stageOf(i)));
    const withDeadline = (list, states) => list.filter(i => states.includes((deadlineInfo(i) || {}).state)).length;
    const summary = state.data.adminSummary || {};
    let stats;
    let cta = 'approvals';
    let ctaKey = 'guide.cta.' + role;
    if (role === 'user') {
      const rejected = mine.filter(i => stageOf(i) === 'rejected').length;
      stats = t('guide.stat.user', { pending: waiting(mine).length, rejected });
      if (rejected) ctaKey = 'guide.cta.userRejected'; else cta = 'venues';
    } else if (role === 'inspector') {
      const queue = rows.filter(i => stageOf(i) === 'pending_review');
      stats = t('guide.stat.inspector', { queue: queue.length, urgent: withDeadline(queue, ['overdue', 'due_soon']) });
    } else if (role === 'supervisor') {
      const queue = rows.filter(i => stageOf(i) === 'pending_approval');
      stats = t('guide.stat.supervisor', { queue: queue.length, overdue: withDeadline(queue, ['overdue']) });
    } else if (role === 'manager') {
      const pending = waiting(rows);
      stats = t('guide.stat.manager', { approved: rows.filter(i => stageOf(i) === 'approved').length, pending: pending.length, overdue: withDeadline(pending, ['overdue']) });
    } else {
      stats = t('guide.stat.admin', { users: summary.users || 0, suspended: summary.suspended || 0, suspicious: summary.suspicious || 0 });
      cta = 'admin';
    }
    const meta = roleMeta(role);
    const steps = [1, 2, 3].map(n => `<li><span>${n}</span>${escapeHtml(t(`guide.${role}.${n}`))}</li>`).join('');
    el.innerHTML = `<div class="role-guide-head"><div><span class="eyebrow">${escapeHtml(meta.label)} · ${escapeHtml(meta.th)}</span><b>${escapeHtml(t('guide.title'))}</b><p>${escapeHtml(stats)}</p></div><button class="btn btn-primary" type="button">${escapeHtml(t(ctaKey))}</button></div><ol class="role-guide-steps">${steps}</ol>`;
    el.querySelector('button').onclick = () => showView(cta);
  }

  function renderDashboard() {
    // Drafts and records sent back are not results yet, so they stay out of the figures.
    const stats = Core.dashboardStats(state.data.inspections.filter(isActive));
    const open = actionRows().filter(a => a.item.actionStatus !== 'closed').length;
    $('#nav-action-count').textContent = open;
    const metrics = [
      { icon: '✓', label: t('dash.metric.total'), value: stats.total, unit: t('dash.metric.totalUnit'), note: '' },
      { icon: '◎', label: t('dash.metric.avg'), value: `${stats.averageScore}%`, unit: t('dash.metric.avgUnit'), note: t('dash.metric.avgTarget') },
      { icon: '!', label: t('dash.metric.failed'), value: stats.failedItems, unit: t('dash.metric.failedUnit'), note: '' },
      { icon: '↻', label: t('dash.metric.open'), value: open, unit: t('dash.metric.openUnit'), note: '' }
    ];
    $('#metric-grid').innerHTML = metrics.map(m => `<article class="metric-card"><span class="metric-icon">${m.icon}</span><div><small>${escapeHtml(m.label)}</small><strong>${m.value}</strong><small>${escapeHtml(m.unit)}</small></div><em>${escapeHtml(m.note)}</em></article>`).join('');

    const latestByVenue = state.data.venues.map(v => {
      const rows = state.data.inspections.filter(i => i.venueId === v.id && isActive(i)).sort((a,b) => b.date.localeCompare(a.date));
      return { name: v.name, score: rows[0]?.score || 0 };
    }).filter(v => v.score > 0);
    $('#venue-bars').innerHTML = latestByVenue.length
      ? latestByVenue.map(v => `<div class="bar-row"><span>${escapeHtml(v.name)}</span><div class="bar-track"><div class="bar-fill" style="width:${v.score}%"></div></div><b>${v.score}</b></div>`).join('')
      : `<div class="empty-state"><b>${t('dash.noScores')}</b>${t('dash.noScoresSub')}</div>`;

    const actions = actionRows();
    const closed = actions.filter(a => a.item.actionStatus === 'closed').length;
    const total = actions.length;
    const closedPct = total ? Math.round(closed / total * 100) : 0;
    $('#action-donut').innerHTML = `<div class="donut" style="background:conic-gradient(var(--teal) 0 ${closedPct}%, #f0a51b ${closedPct}% 100%)"><div><strong>${total-closed}</strong><small>${t('dash.openItems')}</small></div></div><div class="donut-legend"><span><i style="background:var(--teal)"></i>${t('dash.closedCount')} ${closed}</span><span><i style="background:var(--yellow)"></i>${t('dash.trackingCount')} ${total-closed}</span></div>`;
    $('#recent-table').innerHTML = state.data.inspections.slice().sort((a,b) => b.date.localeCompare(a.date)).slice(0,5).map(i => `<tr><td>${formatDate(i.date)}</td><td><b>${escapeHtml(i.venueName)}</b> <span class="freq-tag">${frequencyText(i.frequency)}</span></td><td>${escapeHtml(i.inspector)}</td><td><span class="score-badge ${scoreClass(i.score)}">${i.score}</span></td><td>${stageBadgeHtml(i)}</td><td><button class="text-button" data-detail="${i.id}">${t('hist.view')}</button></td></tr>`).join('');
    renderRoleFocus();
    renderAIStatusPanel();
    renderEquipmentStatusPanel();
    bindDynamicButtons();
  }

  function renderAIStatusPanel() {
    const body = $('#ai-status-body');
    if (!body) return;
    const openAlerts = (state.data.aiAlerts || []).filter(a => a.status !== 'closed');
    const dangerCount = openAlerts.filter(a => a.level === 'danger').length;
    const cautionCount = openAlerts.filter(a => a.level === 'caution').length;
    const overallLevel = dangerCount ? 'danger' : cautionCount ? 'caution' : 'normal';
    const overallText = dangerCount ? t('dash.aiDanger', { n: dangerCount }) : cautionCount ? t('dash.aiCaution', { n: cautionCount }) : t('dash.aiAllNormal');
    const top = openAlerts.slice(0, 3);
    body.innerHTML = `
      <div class="ai-status-summary">
        <span class="ai-status-pill level-${overallLevel}">${overallLevel === 'danger' ? '🔴' : overallLevel === 'caution' ? '🟡' : '🟢'} ${escapeHtml(overallText)}</span>
        <div class="ai-status-mini"><span><b>${openAlerts.length}</b>${t('dash.openAlerts')}</span><span><b>${dangerCount}</b>${t('dash.dangerLevel')}</span><span><b>${cautionCount}</b>${t('dash.cautionLevel')}</span></div>
      </div>
      ${top.length ? `<div class="ai-status-list">${top.map(a => `<div class="ai-status-row"><span class="level-tag level-${a.level}">${alertLevelText(a.level)}</span><span><b>${escapeHtml(a.venue)}</b> · ${escapeHtml(alertZone(a))}</span><span>${formatDate(a.createdAt)}</span></div>`).join('')}</div>` : `<div class="empty-state" style="padding:18px"><b>${t('dash.noAlerts')}</b>${t('dash.noAlertsSub')}</div>`}
    `;
  }

  function renderEquipmentStatusPanel() {
    const body = $('#equipment-status-body');
    if (!body) return;
    const eq = state.data.equipment || [];
    const expired = eq.filter(e => e.status === 'expired').length;
    const soon = eq.filter(e => e.status === 'expiring_soon').length;
    const shortfallVenues = (state.data.equipmentCompliance || []).filter(c => c.shortfall > 0);
    const healthy = !expired && !soon && !shortfallVenues.length;
    const level = healthy ? 'normal' : (expired || shortfallVenues.length) ? 'danger' : 'caution';
    body.innerHTML = `
      <div class="ai-status-summary">
        <span class="ai-status-pill level-${level}">${healthy ? t('dash.equipOk') : level === 'danger' ? t('dash.equipDanger') : t('dash.equipCaution')}</span>
        <div class="ai-status-mini"><span><b>${expired}</b>${t('dash.expired')}</span><span><b>${soon}</b>${t('dash.expiringSoon')}</span><span><b>${shortfallVenues.length}</b>${t('dash.venuesShort')}</span></div>
      </div>`;
  }

  // Start buttons for people who inspect; an edit link for people who manage places.
  function venueCardActions(v) {
    const start = can('inspection.submit')
      ? ['daily', 'monthly', 'yearly'].map(f => `<button class="text-button" data-start="${v.id}" data-freq="${f}">${t('freq.' + f)}</button>`).join('')
      : '';
    const manage = can('venue.manage') ? `<button class="text-button" data-venue-manage="${v.id}">${t('venues.editPlace')}</button>` : '';
    return start || manage ? `<div class="freq-btns">${start}${manage}</div>` : '';
  }

  function renderVenues() {
    const term = ($('#venue-search')?.value || '').trim().toLowerCase();
    const type = $('#venue-type-filter')?.value || 'all';
    const rows = state.data.venues.filter(v => (type === 'all' || v.type === type) && `${v.name} ${v.location} ${v.locationEn} ${v.type}`.toLowerCase().includes(term));
    $('#venue-grid').innerHTML = rows.map(v => `<article class="venue-card"><div class="venue-cover"><span>${v.type}</span><b>${v.icon}</b></div><div class="venue-body"><h3>${escapeHtml(v.name)}</h3><p>⌖ ${escapeHtml(venueLocation(v))} · ${v.tablesCount} ${t('venues.tables')}</p><div class="venue-meta"><span>${t('venues.lastInspected')} ${v.lastInspectedDate ? formatDate(v.lastInspectedDate) : t('venues.never')}</span></div>${venueCardActions(v)}</div></article>`).join('') || `<div class="empty-state"><b>${t('venues.notFound')}</b>${t('venues.notFoundSub')}</div>`;
    bindDynamicButtons();
  }

  function startInspection(venueId, frequency) {
    const venue = state.data.venues.find(v => v.id === venueId);
    const templateItems = state.data.checklistItems?.[frequency];
    if (!venue || !templateItems) return;
    openInspectionEditor({
      id: `INS-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`,
      venueId: venue.id, venueName: venue.name, venueLocation: venue.location, venueLocationEn: venue.locationEn,
      frequency, inspector: state.user.name, role: roleMeta(state.user.role).label,
      date: new Date().toISOString(), status: 'draft', score: 0, overallNote: '',
      items: templateItems.map(c => ({ ...c, result: '', note: '', media: [], actionStatus: '' }))
    });
  }

  // Continues a draft, or reopens a record a reviewer sent back, with its answers kept.
  function editInspection(id) {
    const ins = state.data.inspections.find(i => i.id === id);
    if (!ins) return;
    const venue = state.data.venues.find(v => v.id === ins.venueId) || {};
    const templates = state.data.checklistItems?.[ins.frequency] || [];
    openInspectionEditor({
      ...ins, venueLocation: venue.location || ins.venueLocation, venueLocationEn: venue.locationEn,
      // Template text is re-attached so descriptions and the how-to guide show again.
      items: ins.items.map(item => ({ ...(templates.find(tpl => tpl.id === item.id) || {}), ...item, media: Array.isArray(item.media) ? item.media : [] }))
    });
  }

  function openInspectionEditor(inspection) {
    expandedFields.clear();
    collapsedFields.clear();
    state.currentInspection = inspection;
    $('#validation-banner').hidden = true;
    if ($('#detail-dialog').open) $('#detail-dialog').close();
    renderInspection();
    showView('inspection');
  }

  // --- Evidence media ---------------------------------------------------------------
  const mediaLimits = () => state.data?.mediaLimits || { maxPerItem: 3, imageMaxBytes: 5242880, videoMaxBytes: 20971520, accept: 'image/*,video/*' };
  const itemMedia = item => (item.media = Array.isArray(item.media) ? item.media : []);
  const mediaFull = item => itemMedia(item).length >= mediaLimits().maxPerItem;

  // --- Evidence requirement: required_on_fail / required_always / optional / none
  function evidenceState(item) {
    const req = item.evidenceRequirement || 'optional';
    if (req === 'none') return 'none';
    if (itemMedia(item).length > 0) return 'met';
    if (req === 'required_always' && item.result !== 'na') return 'required';
    if (req === 'required_on_fail' && item.result === 'fail') return 'required';
    return 'optional';
  }

  // Notes and photos are secondary to the pass/fail answer, so they stay collapsed
  // behind small "add" chips until they're actually needed — an empty textarea on
  // every row makes a 5-item checklist look far heavier than the work it represents.
  const expandedFields = new Set();
  // An explicit close wins over the auto-expand rules (typed note, failed result),
  // otherwise the ✕ would appear to do nothing on a failed item.
  const collapsedFields = new Set();
  const noteVisible = item => {
    if (collapsedFields.has(`${item.id}:note`)) return false;
    return expandedFields.has(`${item.id}:note`) || !!item.note || item.result === 'fail';
  };
  const photoVisible = item => {
    const evidence = evidenceState(item);
    if (evidence === 'none') return false;
    // Required evidence can't be dismissed — only the attached files can be removed.
    if (evidence === 'required') return true;
    if (collapsedFields.has(`${item.id}:photo`)) return false;
    return expandedFields.has(`${item.id}:photo`) || itemMedia(item).length > 0;
  };

  function openField(item, kind) {
    expandedFields.add(`${item.id}:${kind}`);
    collapsedFields.delete(`${item.id}:${kind}`);
    refreshCheckExtra(item);
  }

  // Closing clears what's in the field — the ✕ reads as "remove this", so leaving
  // hidden content behind (and still submitting it) would be dishonest.
  function closeField(item, kind) {
    if (kind === 'note') {
      item.note = '';
    } else {
      // Drop the uploaded blobs too, so closing doesn't leave orphans on the server.
      itemMedia(item).forEach(m => Api.deleteMedia(m.id).catch(err => console.warn('media cleanup failed', err)));
      item.media = [];
    }
    expandedFields.delete(`${item.id}:${kind}`);
    collapsedFields.add(`${item.id}:${kind}`);
    refreshCheckExtra(item);
    updateInspectionSummary();
  }
  function checkExtraHtml(item) {
    const evidence = evidenceState(item);
    const showNote = noteVisible(item);
    const showPhoto = photoVisible(item);
    const rows = [];

    if (showNote) {
      rows.push(`<div class="check-field">
        <div class="field-label-row">
          <label class="field-label" for="note-${item.id}">${t('insp.note')} <span class="field-optional">${t('insp.noteOptional')}</span></label>
          <button type="button" class="field-remove" data-remove-note="${item.id}" title="${escapeHtml(t('insp.removeNote'))}" aria-label="${escapeHtml(t('insp.removeNote'))}">×</button>
        </div>
        <textarea id="note-${item.id}" data-note="${item.id}" rows="2" placeholder="${escapeHtml(t('insp.notePlaceholder'))}">${escapeHtml(item.note)}</textarea>
      </div>`);
    }

    if (showPhoto) {
      const required = evidence === 'required';
      const media = itemMedia(item);
      const limits = mediaLimits();
      const full = media.length >= limits.maxPerItem;

      const tiles = media.map(m => `
        <div class="media-tile" data-media-id="${m.id}">
          ${m.kind === 'video'
            ? `<video src="${Api.mediaUrl(m.id)}" preload="metadata" playsinline muted></video><span class="media-kind" aria-hidden="true">▶</span>`
            : `<img src="${Api.mediaUrl(m.id)}" alt="${escapeHtml(t('insp.photoAlt'))} ${escapeHtml(itemTitle(item))}">`}
          <button type="button" class="media-remove" data-remove-media="${item.id}:${m.id}" title="${escapeHtml(t('insp.removeFile'))}" aria-label="${escapeHtml(t('insp.removeFile'))}">×</button>
        </div>`).join('');

      // The add tile is a <label> wrapping the file input; ✕ buttons sit outside it
      // so clicking a remove never opens the file picker.
      const addTile = full ? '' : `
        <label class="media-add ${required && !media.length ? 'evidence-required' : ''}">
          <span class="photo-icon">${CAMERA_ICON}</span>
          <span class="media-add-text">${media.length ? t('insp.addMore') : (required ? t('insp.photoRequired') : t('insp.photoOptional'))}</span>
          <input data-photo="${item.id}" type="file" accept="${limits.accept}" multiple>
        </label>`;

      const removeAll = required ? '' : `<button type="button" class="field-remove" data-remove-photo="${item.id}" title="${escapeHtml(t('insp.removePhoto'))}" aria-label="${escapeHtml(t('insp.removePhoto'))}">×</button>`;

      rows.push(`<div class="check-field media-field">
        <div class="field-label-row">
          <span class="field-label">${t('insp.evidenceLabel')} <span class="field-optional">${media.length}/${limits.maxPerItem}${required ? ' · ' + t('insp.requiredShort') : ''}</span></span>
          ${removeAll}
        </div>
        <div class="media-grid" data-media-grid="${item.id}">${tiles}${addTile}</div>
        <small class="media-hint">${t('insp.mediaHint', { img: Math.round(limits.imageMaxBytes / 1048576), vid: Math.round(limits.videoMaxBytes / 1048576) })}</small>
      </div>`);
    }

    const chips = [];
    if (!showNote) chips.push(`<button type="button" class="add-chip" data-add-note="${item.id}">${t('insp.addNote')}</button>`);
    if (!showPhoto && evidence !== 'none') chips.push(`<button type="button" class="add-chip" data-add-photo="${item.id}">${t('insp.addPhoto')}</button>`);
    if (chips.length) rows.push(`<div class="add-chip-row">${chips.join('')}</div>`);

    return rows.join('');
  }

  function refreshCheckExtra(item) {
    const extra = $(`[data-item="${item.id}"] .check-extra`);
    if (extra) extra.innerHTML = checkExtraHtml(item);
  }

  function renderInspection() {
    const ins = state.currentInspection;
    if (!ins) return;
    const loc = (isEn() && ins.venueLocationEn) ? ins.venueLocationEn : ins.venueLocation;
    $('#inspection-header').innerHTML = `<div><span class="eyebrow">${t('insp.eyebrow')}</span><h1>${escapeHtml(ins.venueName)} <span class="freq-tag">${frequencyText(ins.frequency)}</span></h1><p>⌖ ${escapeHtml(loc)} · ${t('insp.inspector')} ${escapeHtml(ins.inspector)}</p></div><div class="inspection-id"><small>${t('insp.idLabel')}</small><b>${ins.id}</b><small>${formatDate(ins.date)}</small></div>`;
    $('#checklist-container').innerHTML = ins.items.map((item, index) => `
      <article class="check-item" data-item="${item.id}">
        <div class="check-item-head">
          <span class="check-number">${String(index+1).padStart(2,'0')}</span>
          <div class="check-copy">
            <div class="check-title-row">
              <div class="check-illustration" aria-hidden="true">${checkIllustration(item.id)}</div>
              <div><h3>${escapeHtml(itemTitle(item))}</h3><p>${escapeHtml(itemDesc(item))}</p></div>
            </div>
            ${howToHtml(item)}
            <div class="result-options">
              <input id="${item.id}-pass" type="radio" name="${item.id}" value="pass" ${item.result==='pass'?'checked':''}><label class="pass" for="${item.id}-pass">${t('insp.optPass')}</label>
              <input id="${item.id}-fail" type="radio" name="${item.id}" value="fail" ${item.result==='fail'?'checked':''}><label class="fail" for="${item.id}-fail">${t('insp.optFail')}</label>
              <input id="${item.id}-na" type="radio" name="${item.id}" value="na" ${item.result==='na'?'checked':''}><label class="na" for="${item.id}-na">${t('insp.optNa')}</label>
            </div>
            <div class="check-extra">${checkExtraHtml(item)}</div>
          </div>
        </div>
      </article>`).join('');
    $('#overall-note').value = ins.overallNote || '';
    // A record that was sent back opens with the reviewer's reason on top.
    const rejection = ins.reviewStatus === 'rejected' ? (ins.history || []).filter(h => h.action === 'rejected').pop() : null;
    $('#rejection-banner').hidden = !rejection;
    if (rejection) {
      $('#rejection-banner').innerHTML = `<b>${escapeHtml(t('insp.rejectedTitle'))}</b><p>${escapeHtml(rejection.note || '')}</p><small>${escapeHtml(t('insp.rejectedBy', { name: rejection.byName || '-', date: formatDate(rejection.at) }))}</small>`;
    }
    $('#next-step-hint').textContent = t(state.user.role === 'user' ? 'insp.nextStep.user' : 'insp.nextStep.other');

    // Event delegation on the container: the extra area re-renders as fields expand,
    // so per-element listeners would need constant rebinding (and could double up).
    const container = $('#checklist-container');
    const findItem = id => ins.items.find(x => x.id === id);
    container.onchange = e => {
      if (e.target.matches('input[type=radio]')) {
        const item = findItem(e.target.name);
        item.result = e.target.value;
        $(`[data-item="${item.id}"]`)?.classList.remove('missing');
        refreshCheckExtra(item);
        updateInspectionSummary();
      } else if (e.target.matches('[data-photo]')) {
        handlePhoto(e);
      }
    };
    container.oninput = e => {
      if (e.target.matches('[data-note]')) findItem(e.target.dataset.note).note = e.target.value;
    };
    container.onclick = e => {
      const addNote = e.target.closest('[data-add-note]');
      const addPhoto = e.target.closest('[data-add-photo]');
      const removeNote = e.target.closest('[data-remove-note]');
      const removePhoto = e.target.closest('[data-remove-photo]');
      const removeMedia = e.target.closest('[data-remove-media]');
      if (removeMedia) {
        const [itemId, mediaId] = removeMedia.dataset.removeMedia.split(':');
        removeOneMedia(findItem(itemId), mediaId);
        return;
      }
      if (addNote) {
        const item = findItem(addNote.dataset.addNote);
        openField(item, 'note');
        $(`#note-${item.id}`)?.focus();
      } else if (addPhoto) {
        openField(findItem(addPhoto.dataset.addPhoto), 'photo');
      } else if (removeNote) {
        closeField(findItem(removeNote.dataset.removeNote), 'note');
      } else if (removePhoto) {
        closeField(findItem(removePhoto.dataset.removePhoto), 'photo');
      }
    };
    updateInspectionSummary();
  }

  async function handlePhoto(event) {
    const input = event.target;
    const item = state.currentInspection.items.find(x => x.id === input.dataset.photo);
    const files = [...(input.files || [])];
    input.value = '';
    if (!item || !files.length) return;

    const limits = mediaLimits();
    const free = limits.maxPerItem - itemMedia(item).length;
    if (free <= 0) { toast(t('insp.mediaFull', { n: limits.maxPerItem })); return; }

    // Only take what fits. The "some were dropped" warning is shown *last* so the
    // generic success toast can't bury it — otherwise files vanish silently.
    const accepted = files.slice(0, free);
    const trimmed = files.length > free;
    let added = 0;

    const grid = $(`[data-media-grid="${item.id}"]`);
    for (const file of accepted) {
      const isVideo = file.type.startsWith('video/');
      const cap = isVideo ? limits.videoMaxBytes : limits.imageMaxBytes;
      if (!file.type.startsWith('image/') && !isVideo) { toast(t('insp.mediaWrongType')); continue; }
      if (file.size > cap) { toast(t('insp.mediaTooLarge', { name: file.name, max: Math.round(cap / 1048576) })); continue; }
      const placeholder = document.createElement('div');
      placeholder.className = 'media-tile media-tile--loading';
      placeholder.innerHTML = '<span>⏳</span>';
      grid?.prepend(placeholder);
      try {
        const media = await Api.uploadMedia(file);
        itemMedia(item).push(media);
        added++;
      } catch (err) {
        toast(t('common.error') + err.message);
      } finally {
        placeholder.remove();
      }
    }
    refreshCheckExtra(item);
    updateInspectionSummary();
    if (trimmed) toast(t('insp.mediaTrimmed', { taken: added, total: files.length, max: limits.maxPerItem }));
    else if (added) toast(t('insp.photoAdded'));
  }

  async function removeOneMedia(item, mediaId) {
    item.media = itemMedia(item).filter(m => m.id !== mediaId);
    refreshCheckExtra(item);
    updateInspectionSummary();
    try { await Api.deleteMedia(mediaId); } catch (err) { console.warn('media cleanup failed', err); }
  }

  function updateInspectionSummary() {
    const items = state.currentInspection.items;
    const score = Core.calculateScore(items);
    state.currentInspection.score = score;
    const counts = { pass:0, fail:0, na:0, missing:0 };
    items.forEach(i => counts[i.result || 'missing']++);
    $('#live-score strong').textContent = score;
    $('#live-score').style.background = `conic-gradient(var(--teal) 0 ${score}%, #e9eef1 ${score}% 100%)`;
    $('#count-pass').textContent = counts.pass; $('#count-fail').textContent = counts.fail; $('#count-na').textContent = counts.na; $('#count-missing').textContent = counts.missing;
    const total = items.length;
    const done = total - counts.missing;
    const pct = total ? Math.round(done / total * 100) : 0;
    const label = done === total ? t('insp.progressDone') : t('insp.progress', { done, total });
    $('#inspection-progress').innerHTML = `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div><span>${escapeHtml(label)}</span>`;
    $('#mobile-progress').textContent = t('insp.progress', { done, total });
  }

  async function submitInspection() {
    const ins = state.currentInspection;
    ins.overallNote = $('#overall-note').value.trim();
    const validation = Core.validateInspection(ins.items);
    if (!validation.valid) {
      $('#validation-banner').hidden = false;
      const parts = [];
      if (validation.missingIds.length) parts.push(t('insp.validateMissing', { n: validation.missingIds.length }));
      if (validation.missingEvidenceIds.length) parts.push(t('insp.validateEvidence', { n: validation.missingEvidenceIds.length }));
      $('#validation-banner').textContent = t('insp.validatePrefix') + parts.join(t('insp.validateAnd'));
      [...validation.missingIds, ...validation.missingEvidenceIds].forEach(id => $(`[data-item="${id}"]`)?.classList.add('missing'));
      const firstId = validation.missingIds[0] || validation.missingEvidenceIds[0];
      $(`[data-item="${firstId}"]`)?.scrollIntoView({ behavior:'smooth', block:'center' });
      return;
    }
    $('#validation-banner').hidden = true;
    ins.status = 'submitted';
    ins.items.forEach(item => { if (item.result === 'fail') item.actionStatus = 'open'; });
    await withLoading($('#submit-inspection'), t('insp.submitting'), async () => {
      try {
        await Api.saveInspection(ins);
      } catch (err) {
        ins.status = 'draft';   // still editable if the server refused it
        throw err;
      }
      await refreshData();
      const saved = state.data.inspections.find(i => i.id === ins.id) || ins;
      state.currentInspection = null;
      renderResult(saved);
      showView('result');
      renderAll();
      toast(t('insp.saved'));
    });
  }

  async function saveDraft() {
    const ins = state.currentInspection;
    if (!ins) return;
    ins.overallNote = $('#overall-note').value.trim();
    ins.status = 'draft';
    await withLoading($('#save-draft'), null, async () => {
      await Api.saveInspection(ins);
      await refreshData();
      renderAll();
      toast(t('insp.draftSaved'));
    });
  }

  function resultNextStepHtml(ins) {
    const stage = stageOf(ins);
    if (stage !== 'pending_review' && stage !== 'pending_approval') return '';
    return `<div class="next-step-panel"><div><b>${escapeHtml(t('result.nextTitle'))}</b><p>${escapeHtml(t('result.next.' + stage, { deadline: formatDate(ins.deadline) }))}</p></div>${deadlineBadgeHtml(ins)}</div>`;
  }

  function renderResult(ins) {
    const failed = Core.failedItems(ins.items);
    $('#result-content').innerHTML = `<section class="result-hero"><div><span class="eyebrow" style="color:#74eadc">${t('result.eyebrow')} · ${frequencyText(ins.frequency).toUpperCase()}</span><h1>${failed.length ? t('result.withIssues') : t('result.allPass')}</h1><p>${escapeHtml(ins.venueName)} · ${formatDate(ins.date)}</p></div><div class="result-score"><strong>${ins.score}</strong><small>${t('result.score')}</small></div></section>${resultNextStepHtml(ins)}<div class="result-grid"><article class="panel"><div class="panel-heading"><div><h3>${t('result.title')}</h3><p>${t('result.subtitle')}</p></div></div><div class="metric-grid" style="grid-template-columns:repeat(3,1fr);margin:0"><div class="metric-card"><div><small>${t('insp.pass')}</small><strong>${ins.items.filter(i=>i.result==='pass').length}</strong></div></div><div class="metric-card"><div><small>${t('insp.fail')}</small><strong>${failed.length}</strong></div></div><div class="metric-card"><div><small>${t('insp.na')}</small><strong>${ins.items.filter(i=>i.result==='na').length}</strong></div></div></div><div class="result-actions"><button class="btn btn-primary" data-report="${ins.id}">${t('result.openReport')}</button><button class="btn btn-secondary" data-go="dashboard">${t('result.backDash')}</button></div></article><article class="panel"><div class="panel-heading"><div><h3>${t('result.toFix')}</h3><p>${t('result.toFixSub')}</p></div></div><div class="result-list">${failed.length ? failed.map(i=>`<div class="result-item"><b>${escapeHtml(itemTitle(i))}</b><p>${escapeHtml(i.note || t('result.defaultNote'))}</p></div>`).join('') : `<div class="empty-state"><b>${t('result.noFail')}</b>${t('result.noFailSub')}</div>`}</div></article></div>`;
    bindDynamicButtons();
  }

  function renderHistory() {
    const term = ($('#history-search')?.value || '').trim().toLowerCase();
    const status = $('#history-status')?.value || 'all';
    const rows = state.data.inspections.filter(i => (status === 'all' || i.status === status) && `${i.id} ${i.venueName} ${i.inspector}`.toLowerCase().includes(term)).sort((a,b)=>b.date.localeCompare(a.date));
    $('#history-table').innerHTML = rows.map(i => `<tr><td><b>${i.id}</b></td><td>${formatDate(i.date)}</td><td>${escapeHtml(i.venueName)}</td><td><span class="freq-tag">${frequencyText(i.frequency)}</span></td><td>${escapeHtml(i.inspector)}</td><td><span class="score-badge ${scoreClass(i.score)}">${i.score}</span></td><td>${Core.failedItems(i.items).length}</td><td>${stageBadgeHtml(i)}${deadlineInfo(i) ? '<br>' + deadlineBadgeHtml(i) : ''}</td><td class="row-actions"><button class="text-button" data-detail="${i.id}">${t('hist.view')}</button> <button class="text-button" data-report="${i.id}">${t('hist.report')}</button>${historyEditButton(i)}</td></tr>`).join('') || `<tr><td colspan="9"><div class="empty-state"><b>${t('hist.notFound')}</b>${t('hist.notFoundSub')}</div></td></tr>`;
    bindDynamicButtons();
  }

  function actionRows() {
    return state.data.inspections.filter(isActive).flatMap(inspection => inspection.items.filter(item => item.result === 'fail').map(item => ({ inspection, item })));
  }

  function renderActions() {
    const rows = actionRows();
    const open = rows.filter(r => r.item.actionStatus !== 'closed').length;
    $('#open-action-pill').textContent = t('act.openCount', { n: open });
    $('#nav-action-count').textContent = open;
    $('#actions-list').innerHTML = rows.length ? rows.map(({inspection:i,item}) => `<article class="action-card"><div><span class="status-badge ${item.actionStatus === 'in_progress' ? 'progress' : item.actionStatus}">${actionText(item.actionStatus)}</span><h3>${escapeHtml(itemTitle(item))}</h3><p>${escapeHtml(item.note || t('act.noNote'))}</p><div class="action-meta"><span>${t('act.venue')} ${escapeHtml(i.venueName)}</span><span>${t('act.id')} ${i.id}</span><span>${t('act.inspector')} ${escapeHtml(i.inspector)}</span></div></div><div><label for="action-${i.id}-${item.id}">${t('act.updateStatus')}</label><select id="action-${i.id}-${item.id}" data-action-inspection="${i.id}" data-action-item="${item.id}" ${can('action.update') ? '' : 'disabled title="' + escapeHtml(t('cap.denied')) + '"'}><option value="open" ${item.actionStatus==='open'?'selected':''}>${t('act.open')}</option><option value="in_progress" ${item.actionStatus==='in_progress'?'selected':''}>${t('act.inProgress')}</option><option value="closed" ${item.actionStatus==='closed'?'selected':''}>${t('act.closed')}</option></select></div></article>`).join('') : `<div class="panel empty-state"><b>${t('act.none')}</b>${t('act.noneSub')}</div>`;
    $$('[data-action-inspection]').forEach(select => select.addEventListener('change', async e => {
      const inspectionId = e.target.dataset.actionInspection, itemId = e.target.dataset.actionItem, value = e.target.value;
      select.disabled = true;
      try { await Api.updateAction(inspectionId, itemId, value); await refreshData(); renderActions(); renderDashboard(); toast(t('act.updated')); }
      catch (err) { toast(t('common.error') + err.message); }
      finally { select.disabled = false; }
    }));
  }

  function renderStandards() {
    $('#standards-list').innerHTML = content().standards.map(s => `<article class="standard-card"><div class="standard-head"><h3>${escapeHtml(s.code)}</h3><span class="standard-source">${escapeHtml(s.source)}</span></div><p><b>${t('std.relates')}</b> ${escapeHtml(s.relates)}</p><p>${escapeHtml(s.usage)}</p></article>`).join('');
  }

  function renderTesting() {
    $('#test-envs').innerHTML = content().testEnvironments.map(e => `<div class="test-env-card"><b>${escapeHtml(e.title)}</b><p>${escapeHtml(e.desc)}</p></div>`).join('');
    $('#test-data').innerHTML = content().testDataCollected.map(x => `<li>${escapeHtml(x)}</li>`).join('');
    $('#test-criteria-table').innerHTML = content().testCriteria.map(c => `<tr><td><b>${escapeHtml(c.case)}</b></td><td>${escapeHtml(c.method)}</td><td>${escapeHtml(c.target)}</td></tr>`).join('');
  }

  function renderSensors() {
    const devices = content().devices;
    $('#device-grid').innerHTML = devices.map(d => `<article class="device-card"><div class="device-icon">${deviceIconSvg(d.icon)}</div><h3>${escapeHtml(d.name)}</h3><small>${escapeHtml(d.spec)}</small><p>${escapeHtml(d.role)}</p><div class="device-reason"><b>${t('sensors.reasonLabel')}</b> ${escapeHtml(d.reason)}</div></article>`).join('');
    $('#device-table').innerHTML = devices.map(d => `<tr><td><b>${escapeHtml(d.name)}</b></td><td>${escapeHtml(d.install)}</td><td>${escapeHtml(d.spec)}</td><td>${escapeHtml(d.role)}</td><td>${escapeHtml(d.reason)}</td></tr>`).join('');
    const select = $('#sensor-check-select');
    if (select) {
      const prev = select.value;
      select.innerHTML = devices.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
      if (prev) select.value = prev;
    }
  }

  function runSensorCheck() {
    const device = content().devices.find(d => d.id === $('#sensor-check-select').value);
    if (!device) return;
    const resultEl = $('#sensor-check-result');
    const btn = $('#sensor-check-run');
    btn.disabled = true;
    resultEl.innerHTML = `<div class="sensor-check-card loading"><span>⏳</span><span>${t('sensors.checking')}</span></div>`;
    setTimeout(() => {
      const damaged = Math.random() < 0.5;
      const confidence = damaged ? Math.round(80 + Math.random() * 15) : Math.round(90 + Math.random() * 9);
      resultEl.innerHTML = damaged
        ? `<div class="sensor-check-card bad"><div class="sensor-check-icon bad">${deviceIconSvg(device.icon)}</div><div><b>${t('sensors.damaged')}</b><p>${escapeHtml(t('sensors.damagedDesc', { name: device.name, c: confidence }))}</p><small>${t('sensors.damagedHint')}</small></div></div>`
        : `<div class="sensor-check-card good"><div class="sensor-check-icon good">${deviceIconSvg(device.icon)}</div><div><b>${t('sensors.ok')}</b><p>${escapeHtml(t('sensors.okDesc', { name: device.name, c: confidence }))}</p></div></div>`;
      btn.disabled = false;
    }, 650);
  }

  // --- Equipment Registry ------------------------------------------------------------
  function renderEquipment() {
    const eq = state.data.equipment || [];
    if (!$('#equipment-table')) return;
    $('#equipment-table').innerHTML = eq.length ? eq.map(e => `<tr><td><b>${escapeHtml(e.venueName)}</b></td><td>${equipmentTypeText(e.type)}</td><td>${escapeHtml(equipLabel(e))}</td><td>${e.expiryDate ? formatDate(e.expiryDate) : '-'}</td><td><span class="score-badge ${equipmentStatusClass(e.status)}">${equipmentStatusText(e.status)}</span></td></tr>`).join('') : `<tr><td colspan="5"><div class="empty-state"><b>${t('equip.empty')}</b></div></td></tr>`;

    const compliance = state.data.equipmentCompliance || [];
    $('#equipment-compliance-table').innerHTML = compliance.map(c => `<tr><td><b>${escapeHtml(c.venueName)}</b></td><td>${c.tablesCount}</td><td>${c.current}</td><td>${c.required}</td><td>${c.shortfall > 0 ? `<span class="status-badge open">${t('equip.shortfall', { n: c.shortfall })}</span> ${can('equipment.manage') ? `<button class="text-button text-button-demo" data-buy="${c.venueId}">${t('equip.buyBtn')}</button>` : `<span class="cap-note">${escapeHtml(t('cap.managerOnly'))}</span>`}` : `<span class="status-badge closed">${t('equip.sufficient')}</span>`}</td></tr>`).join('');

    const select = $('#equipment-check-select');
    if (select) {
      const prev = select.value;
      select.innerHTML = eq.map(e => `<option value="${e.id}">${escapeHtml(e.venueName)} · ${escapeHtml(equipLabel(e))}</option>`).join('') || `<option value="">${t('equip.noneSelected')}</option>`;
      if (prev) select.value = prev;
    }

    $$('[data-buy]').forEach(b => b.onclick = () => purchaseMoreEquipment(b, b.dataset.buy));
  }

  async function purchaseMoreEquipment(button, venueId) {
    await withLoading(button, t('equip.buying'), async () => {
      const today = new Date();
      const expiry = new Date(today.getTime() + 5 * 365 * 86400000).toISOString().slice(0, 10);
      await Api.addEquipment({ venueId, type: 'fire_extinguisher', label: 'ถังดับเพลิงใหม่ (จัดซื้อผ่านระบบ)', labelEn: 'New extinguisher (purchased via system)', installDate: today.toISOString().slice(0, 10), expiryDate: expiry });
      await refreshData();
      renderEquipment(); renderDashboard();
      toast(t('equip.bought'));
    });
  }

  async function runEquipmentOcrCheck() {
    const select = $('#equipment-check-select');
    const id = select?.value;
    const eq = (state.data.equipment || []).find(e => e.id === id);
    if (!eq) { toast(t('equip.noneSelected')); return; }
    const btn = $('#equipment-check-run');
    const resultEl = $('#equipment-check-result');
    btn.disabled = true;
    resultEl.innerHTML = `<div class="sensor-check-card loading"><span>⏳</span><span>${t('equip.ocrRunning')}</span></div>`;
    const roll = Math.random();
    const today = Date.now();
    const detectedDate = roll < 0.35 ? new Date(today - (Math.random() * 60 + 1) * 86400000)
      : roll < 0.65 ? new Date(today + (Math.random() * 29 + 1) * 86400000)
      : new Date(today + (Math.random() * 600 + 120) * 86400000);
    const iso = detectedDate.toISOString().slice(0, 10);
    try {
      await new Promise(r => setTimeout(r, 650));
      await Api.updateEquipment(id, { expiryDate: iso, photo: 'ocr-simulated' });
      await refreshData();
      const updated = (state.data.equipment || []).find(e => e.id === id) || eq;
      const good = updated.status === 'normal';
      resultEl.innerHTML = `<div class="sensor-check-card ${good ? 'good' : 'bad'}"><div class="sensor-check-icon ${good ? 'good' : 'bad'}">🧯</div><div><b>${good ? '✅' : '⚠'} ${escapeHtml(t('equip.ocrRead', { date: formatDate(iso) }))}</b><p>${escapeHtml(t('equip.ocrStatus', { label: equipLabel(updated), venue: updated.venueName, status: equipmentStatusText(updated.status) }))}</p>${!good ? `<small>${t('equip.ocrSaved')}</small>` : ''}</div></div>`;
      renderEquipment(); renderDashboard();
      if (!good) toast(`${equipLabel(updated)} — ${equipmentStatusText(updated.status)}`);
    } catch (err) {
      resultEl.innerHTML = `<div class="sensor-check-card bad"><b>${t('common.error')}</b><p>${escapeHtml(err.message)}</p></div>`;
    } finally { btn.disabled = false; }
  }

  // --- AI Alerts ---------------------------------------------------------------------
  function renderAlerts() {
    const alerts = state.data.aiAlerts || [];
    const open = alerts.filter(a => a.status !== 'closed');
    if ($('#alert-open-pill')) $('#alert-open-pill').textContent = t('act.openCount', { n: open.length });
    $('#nav-alert-count').textContent = open.length;
    if (!$('#alerts-list')) return;
    $('#alerts-list').innerHTML = open.length ? open.map(a => `
      <article class="action-card alert-card level-${a.level}" id="alert-${a.id}">
        <div>
          <span class="status-badge ${a.status === 'escalated' ? 'open' : a.status === 'acknowledged' ? 'progress' : 'draft'}">${alertStatusText(a.status)}</span>
          <span class="level-tag level-${a.level}">${alertLevelText(a.level)}</span>
          <span class="level-tag anomaly-tag">${escapeHtml(anomalyLabel(a.anomalyType))}</span>
          <h3>${escapeHtml(alertZone(a))}</h3>
          <p>${escapeHtml(alertDetected(a))}</p>
          <div class="action-meta"><span>${t('alerts.venue')} ${escapeHtml(a.venue)}</span><span>${t('alerts.time')} ${formatDate(a.createdAt)}</span><span>${t('alerts.notified')} ${escapeHtml(alertStaffName(a))}</span><span>${t('alerts.confidence')} ${a.confidence}%</span></div>
        </div>
        <div class="alert-actions">
          ${a.status === 'notified' && can('alert.acknowledge') ? `<button class="btn btn-secondary" data-ack="${a.id}">${t('alerts.ack')}</button>` : ''}
          ${a.status === 'notified' && can('alert.escalate') ? `<button class="text-button text-button-demo" data-escalate="${a.id}">${t('alerts.escalateSim')}</button>` : ''}
          ${a.status === 'acknowledged' && can('alert.close') ? `<button class="btn btn-primary" data-close="${a.id}">${t('alerts.close')}</button>` : ''}
          ${a.status === 'escalated' && can('alert.close') ? `<button class="btn btn-primary" data-close="${a.id}">${t('alerts.closeSupervisor')}</button>` : ''}
        </div>
      </article>`).join('') : `<div class="panel empty-state"><b>${t('alerts.none')}</b>${t('alerts.noneSub')}</div>`;
    $$('[data-ack]').forEach(b => b.onclick = () => updateAlert(b, b.dataset.ack, { status: 'acknowledged', acknowledgedAt: new Date().toISOString() }));
    $$('[data-escalate]').forEach(b => b.onclick = () => updateAlert(b, b.dataset.escalate, { status: 'escalated', escalatedAt: new Date().toISOString() }));
    $$('[data-close]').forEach(b => b.onclick = () => updateAlert(b, b.dataset.close, { status: 'closed', closedAt: new Date().toISOString() }));
  }

  async function updateAlert(button, id, patch) {
    await withLoading(button, null, async () => {
      await Api.updateAlert(id, patch);
      await refreshData();
      renderAlerts(); renderAlertHistory(); renderDashboard();
      toast(patch.status === 'escalated' ? t('alerts.escalated') : patch.status === 'closed' ? t('alerts.closedToast') : t('alerts.ackToast'));
    });
  }

  function renderAlertHistory() {
    if (!$('#alert-history-table')) return;
    const term = ($('#alert-history-search')?.value || '').trim().toLowerCase();
    const level = $('#alert-history-level')?.value || 'all';
    const rows = (state.data.aiAlerts || [])
      .filter(a => (level === 'all' || a.level === level) && `${a.venue} ${alertZone(a)} ${alertDetected(a)}`.toLowerCase().includes(term))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    $('#alert-history-table').innerHTML = rows.length ? rows.map(a => {
      const duration = a.closedAt ? Math.max(1, Math.round((new Date(a.closedAt) - new Date(a.createdAt)) / 60000)) : null;
      return `<tr><td>${formatDate(a.createdAt)}</td><td><b>${escapeHtml(a.venue)}</b><br><small>${escapeHtml(alertZone(a))}</small></td><td><span class="level-tag level-${a.level}">${alertLevelText(a.level)}</span></td><td>${escapeHtml(alertDetected(a))}</td><td><span class="status-badge ${a.status === 'closed' ? 'closed' : a.status === 'escalated' ? 'open' : 'progress'}">${alertStatusText(a.status)}</span></td><td>${duration ? duration + ' ' + t('alerts.minutes') : '-'}</td></tr>`;
    }).join('') : `<tr><td colspan="6"><div class="empty-state"><b>${t('hist.notFound')}</b>${t('hist.notFoundSub')}</div></td></tr>`;
  }

  function pickAnomalyType() { const keys = Object.keys(content().anomaly); return keys[Math.floor(Math.random() * keys.length)]; }

  async function generateAlert(level, forcedType) {
    const type = forcedType || pickAnomalyType();
    const cat = content().anomaly[type];
    const venue = state.data.venues[Math.floor(Math.random() * state.data.venues.length)];
    const zoneIndex = Math.floor(Math.random() * content().alertZones.length);
    const staffIndex = Math.floor(Math.random() * content().alertStaff.length);
    const variants = cat[level] || cat.caution;
    const variantIndex = Math.floor(Math.random() * variants.length);
    const obstructionPct = type === 'obstruction'
      ? (level === 'danger' ? Math.round(55 + Math.random() * 35) : Math.round(20 + Math.random() * 29))
      : null;
    const alert = await Api.createAlert({
      venueId: venue.id, anomalyType: type, level,
      confidence: Math.round(80 + Math.random() * 18),
      variantIndex, obstructionPct, zoneIndex, staffIndex
    });
    await refreshData();
    renderAlerts(); renderAlertHistory(); renderDashboard();
    toast(t('alerts.newToast', { zone: content().alertZones[zoneIndex], type: cat.label, level: alertLevelText(level) }));
    return alert;
  }

  let simRunning = false;
  function simulateDetection() {
    if (simRunning) return;
    simRunning = true;
    const btn = $('#simulate-detection');
    btn.disabled = true;
    const stages = ['detect', 'process', 'classify', 'notify'];
    $$('#sim-flow .flow-step').forEach(s => s.classList.remove('active', 'done'));
    const box = $('#cam-mock-svg .obstruction-box');
    const boxText = $('#cam-mock-svg .obstruction-label');
    if (box) box.style.opacity = '0';
    $('#sim-log').textContent = t('ai.simStart');
    const roll = Math.random();
    const outcome = roll < 0.30 ? 'normal' : roll < 0.65 ? 'caution' : 'danger';
    const anomalyType = pickAnomalyType();
    const cat = content().anomaly[anomalyType];
    let i = 0;
    async function step() {
      if (i > 0) $(`#sim-flow [data-stage="${stages[i - 1]}"]`)?.classList.add('done');
      if (i >= stages.length) { finish(); return; }
      const stage = stages[i];
      $(`#sim-flow [data-stage="${stage}"]`)?.classList.add('active');
      if (stage === 'detect') {
        $('#sim-log').textContent = outcome === 'normal' ? t('ai.simDetectNormal') : t('ai.simDetectFound', { type: cat.label });
        if (outcome !== 'normal' && box) { box.style.opacity = '1'; if (boxText) boxText.textContent = cat.short; }
      } else if (stage === 'process') {
        $('#sim-log').textContent = t('ai.simProcess');
      } else if (stage === 'classify') {
        const badge = $('#live-status-badge');
        badge.className = 'live-status-badge level-' + outcome;
        badge.textContent = alertLevelText(outcome);
        $('#sim-log').textContent = outcome === 'normal' ? t('ai.simClassifyNormal') : t('ai.simClassify', { level: alertLevelText(outcome) });
      } else if (stage === 'notify') {
        if (outcome === 'normal') {
          $('#sim-log').textContent = t('ai.simNotifyNone');
        } else {
          $('#sim-log').textContent = t('ai.simNotifying');
          try {
            const newAlert = await generateAlert(outcome, anomalyType);
            $('#sim-log').innerHTML = `${escapeHtml(t('ai.simNotified', { level: alertLevelText(outcome), type: cat.label }))} <button type="button" class="text-button" id="sim-jump-alert">${t('ai.simJump')}</button>`;
            $('#sim-jump-alert').onclick = () => {
              showView('alerts');
              switchAlertTab('active');
              setTimeout(() => {
                const el = document.getElementById(`alert-${newAlert.id}`);
                if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash-highlight'); setTimeout(() => el.classList.remove('flash-highlight'), 1600); }
              }, 60);
            };
          } catch (err) {
            $('#sim-log').textContent = t('ai.simError') + err.message;
          }
        }
      }
      i++;
      setTimeout(step, 750);
    }
    function finish() {
      if (outcome !== 'normal' && box) setTimeout(() => { box.style.opacity = '0'; }, 1600);
      btn.disabled = false;
      simRunning = false;
    }
    step();
  }

  // Small evidence strip reused by the detail dialog and the printable report.
  function mediaStripHtml(item, { forPrint = false } = {}) {
    const media = itemMedia(item);
    if (!media.length) return '';
    const tiles = media.map(m => m.kind === 'video'
      ? (forPrint
        // A video can't render on paper, so the printed report names the file
        // instead of showing an empty black box.
        ? `<span class="evidence-file"><b>▶</b>${escapeHtml(m.name || t('insp.videoFile'))}</span>`
        : `<video src="${Api.mediaUrl(m.id)}" controls preload="metadata" playsinline></video>`)
      : `<img src="${Api.mediaUrl(m.id)}" alt="${escapeHtml(t('insp.photoAlt'))} ${escapeHtml(itemTitle(item))}">`
    ).join('');
    return `<div class="evidence-strip">${tiles}</div>`;
  }

  function openDetail(id) {
    const ins = state.data.inspections.find(i => i.id === id); if (!ins) return;
    $('#dialog-content').innerHTML = `<span class="eyebrow">${ins.id}</span><h2>${escapeHtml(ins.venueName)}</h2><p>${formatDate(ins.date)} · ${frequencyText(ins.frequency)} · ${t('insp.inspector')} ${escapeHtml(ins.inspector)} · ${t('result.score')} <b>${ins.score}</b></p><div class="detail-stage">${stageBadgeHtml(ins)} ${deadlineBadgeHtml(ins)}</div>${timelineHtml(ins)}<div class="dialog-checks">${ins.items.map(i=>`<div class="dialog-check"><div class="dialog-check-row"><span>${escapeHtml(itemTitle(i))}</span><span class="status-badge ${i.result==='fail'?'open':i.result==='pass'?'closed':'draft'}">${i.result==='pass'?t('insp.pass'):i.result==='fail'?t('insp.fail'):t('insp.na')}</span></div>${i.note ? `<p class="dialog-check-note">${escapeHtml(i.note)}</p>` : ''}${mediaStripHtml(i)}</div>`).join('')}</div><div class="result-actions"><button class="btn btn-primary" data-report="${ins.id}">${t('result.openReport')}</button>${historyEditButton(ins, 'btn btn-secondary')}${can('data.correct') ? ` <button class="btn btn-secondary" data-correct="${ins.id}">${t('detail.correct')}</button>` : ''}</div>`;
    $('#detail-dialog').showModal(); bindDynamicButtons();
  }

  function openReport(id) {
    const ins = state.data.inspections.find(i => i.id === id); if (!ins) return;
    state.reportInspectionId = id;
    const failed = Core.failedItems(ins.items);
    const venue = state.data.venues.find(v => v.id === ins.venueId);
    const loc = venue ? venueLocation(venue) : ins.venueLocation;
    $('#report-paper').innerHTML = `<header class="report-head"><div><h1>${t('report.title')}</h1><p>${t('report.subtitle')}</p></div><div class="report-logo"><span class="brand-mark">✓</span> SafeCheck</div></header><section class="report-info"><div><b>${t('report.id')}</b><span>${ins.id}</span></div><div><b>${t('report.freq')}</b><span>${frequencyText(ins.frequency)}</span></div><div><b>${t('report.date')}</b><span>${formatDate(ins.date)}</span></div><div><b>${t('report.venue')}</b><span>${escapeHtml(ins.venueName)}</span></div><div><b>${t('report.type')}</b><span>${venue?.type || '-'}</span></div><div><b>${t('report.location')}</b><span>${escapeHtml(loc)}</span></div><div><b>${t('report.inspector')}</b><span>${escapeHtml(ins.inspector)} (${escapeHtml(ins.role)})</span></div></section><section class="report-summary"><div class="report-score"><div><strong>${ins.score}</strong><small>${t('report.scoreUnit')}</small></div></div><div><h2>${ins.score >= 85 ? t('report.good') : ins.score >= 70 ? t('report.fair') : t('report.poor')}</h2><p>${t('report.counts', { pass: ins.items.filter(i=>i.result==='pass').length, fail: failed.length, na: ins.items.filter(i=>i.result==='na').length })}</p><p><b>${t('report.overallNote')}</b> ${escapeHtml(ins.overallNote || '-')}</p></div></section><table class="report-table"><thead><tr><th style="width:6%">${t('report.col.no')}</th><th>${t('report.col.item')}</th><th style="width:12%">${t('report.col.result')}</th><th style="width:27%">${t('report.col.note')}</th></tr></thead><tbody>${ins.items.map((i,index)=>`<tr class="${i.result==='fail'?'fail-row':''}"><td>${index+1}</td><td>${escapeHtml(itemTitle(i))}</td><td>${i.result==='pass'?t('insp.pass'):i.result==='fail'?t('insp.fail'):t('insp.na')}</td><td>${escapeHtml(i.note || '-')}</td></tr>`).join('')}</tbody></table>${(() => {
      const withEvidence = ins.items.filter(i => itemMedia(i).length);
      if (!withEvidence.length) return '';
      return `<section class="report-evidence"><h2>${t('report.evidenceTitle')}</h2>${withEvidence.map((i, idx) => `<article class="report-evidence-item"><b>${idx + 1}. ${escapeHtml(itemTitle(i))}</b>${i.note ? `<p>${escapeHtml(i.note)}</p>` : ''}${mediaStripHtml(i, { forPrint: true })}</article>`).join('')}</section>`;
    })()}<section class="report-footer"><div><div class="signature-line">${t('report.signInspector')}</div></div><div><div class="signature-line">${t('report.signSupervisor')}</div></div></section><p style="text-align:center;color:#8a98a2;font-size:9px;margin-top:35px">${t('report.footer')}</p>`;
    if ($('#detail-dialog').open) $('#detail-dialog').close();
    showView('report');
  }

  function bindDynamicButtons() {
    $$('[data-go]').forEach(btn => btn.onclick = () => showView(btn.dataset.go));
    $$('[data-start]').forEach(btn => btn.onclick = () => startInspection(btn.dataset.start, btn.dataset.freq));
    $$('[data-detail]').forEach(btn => btn.onclick = () => openDetail(btn.dataset.detail));
    $$('[data-report]').forEach(btn => btn.onclick = () => openReport(btn.dataset.report));
    $$('[data-edit]').forEach(btn => btn.onclick = () => editInspection(btn.dataset.edit));
    $$('[data-venue-manage]').forEach(btn => btn.onclick = () => {
      if (extraViews.admin && extraViews.admin.openVenueForm) extraViews.admin.openVenueForm(btn.dataset.venueManage);
    });
    $$('[data-correct]').forEach(btn => btn.onclick = () => {
      if ($('#detail-dialog').open) $('#detail-dialog').close();
      if (extraViews.admin && extraViews.admin.openCorrection) extraViews.admin.openCorrection(btn.dataset.correct);
    });
  }

  async function resetData() {
    if (!confirm(t('common.resetConfirm'))) return;
    await withLoading($('#reset-data'), t('shell.resetting'), async () => {
      await Api.reset();
      await refreshData();
      renderAll();
      showView('dashboard');
      toast(t('common.resetDone'));
    });
  }

  function switchAlertTab(tab) {
    $$('.tab-btn[data-alert-tab]').forEach(b => { const active = b.dataset.alertTab === tab; b.classList.toggle('active', active); b.setAttribute('aria-selected', active ? 'true' : 'false'); });
    $('#alerts-tab-active').hidden = tab !== 'active';
    $('#alerts-tab-history').hidden = tab !== 'history';
  }

  function bindStaticEvents() {
    $('#login-form').addEventListener('submit', e => { e.preventDefault(); submitLogin($('#login-email').value.trim(), $('#login-password').value); });
    $('#signup-form').addEventListener('submit', e => {
      e.preventDefault();
      const password = $('#signup-password').value;
      const confirmPw = $('#signup-confirm').value;
      if (password !== confirmPw) { showFormError($('#signup-error'), t('auth.errPasswordMismatch')); return; }
      submitSignup({ name: $('#signup-name').value.trim(), email: $('#signup-email').value.trim(), password, role: 'user', branch: $('#signup-branch').value });
    });
    const fbForm = $('#fb-form');
    if (fbForm) fbForm.addEventListener('submit', e => { e.preventDefault(); submitFeedback(); });
    $$('[data-auth-tab]').forEach(btn => btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab)));
    $$('[data-lang-toggle]').forEach(btn => btn.addEventListener('click', toggleLanguage));
    // Quick-fill only prefills the credentials — the real login request still runs,
    // so this is a convenience, not an auth bypass.
    $$('[data-demo-account]').forEach(btn => btn.addEventListener('click', () => {
      switchAuthTab('login');
      hideFormError($('#login-error'));
      $('#login-email').value = btn.dataset.demoAccount;
      $('#login-password').value = 'Demo1234!';
      $('#login-form button[type=submit]').focus();
    }));
    $$('.main-nav button').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
    $$('[data-go]').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.go)));
    $('#user-menu').addEventListener('click', e => { e.stopPropagation(); setUserMenuOpen(!userMenuOpen()); });
    $('#user-dropdown').addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => { if (userMenuOpen()) setUserMenuOpen(false); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && userMenuOpen()) { setUserMenuOpen(false); $('#user-menu').focus(); }
    });
    $('#logout-button').addEventListener('click', logout);
    $('#my-sessions-button').addEventListener('click', openMySessions);
    $('#add-venue-button').addEventListener('click', () => {
      if (extraViews.admin && extraViews.admin.openVenueForm) extraViews.admin.openVenueForm(null);
    });
    window.addEventListener('safecheck:unauthorized', () => {
      if (state.user) showLoginScreen(t('auth.sessionEnded'));
    });
    $('#reset-data').addEventListener('click', resetData);
    $('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
    $('#venue-search').addEventListener('input', renderVenues); $('#venue-type-filter').addEventListener('change', renderVenues);
    $('#history-search').addEventListener('input', renderHistory); $('#history-status').addEventListener('change', renderHistory);
    $('#submit-inspection').addEventListener('click', submitInspection);
    $('#save-draft').addEventListener('click', saveDraft);
    $('#mobile-submit').addEventListener('click', submitInspection);
    Object.values(extraViews).forEach(v => v.bind && v.bind());
    $('#overall-note').addEventListener('input', e => { if (state.currentInspection) state.currentInspection.overallNote = e.target.value; });
    $('#print-report').addEventListener('click', () => window.print());
    $('#close-dialog').addEventListener('click', () => $('#detail-dialog').close());
    $('#simulate-detection').addEventListener('click', simulateDetection);
    $('#generate-alert').addEventListener('click', () => { generateAlert(Math.random() < 0.55 ? 'caution' : 'danger'); switchAlertTab('active'); });
    $('#alert-history-search').addEventListener('input', renderAlertHistory);
    $('#alert-history-level').addEventListener('change', renderAlertHistory);
    $('#sensor-check-run').addEventListener('click', runSensorCheck);
    $('#equipment-check-run')?.addEventListener('click', runEquipmentOcrCheck);
    $$('[data-alert-tab]').forEach(btn => btn.addEventListener('click', () => switchAlertTab(btn.dataset.alertTab)));
  }

  async function init() {
    bindStaticEvents();
    I18n.applyStatic();
    renderAiScopeLists();
    // GET /api/me tells us whether the browser already holds a valid session cookie
    // (e.g. a reload) — the server is the source of truth, not client-side storage.
    try {
      const { user } = await Api.me();
      if (user) await enterApp(user);
    } catch (err) {
      console.error(err);
      document.body.innerHTML = `<div style="max-width:520px;margin:80px auto;text-align:center;font-family:'Noto Sans Thai',sans-serif;color:#a83333"><h2>${t('auth.connectFailTitle')}</h2><p>${escapeHtml(err.message)}</p><p style="color:#657786">${t('auth.connectFailHint')}</p></div>`;
    }
  }

  // Shared with approvals.js and admin.js, which add their screens through registerView.
  window.SafeCheckApp = {
    state, t, content, $, $$, escapeHtml, toast, formatDate, frequencyText, roleMeta, can, withLoading, errorText,
    refreshData, renderAll, showView, openDetail, editInspection, stageOf, stageBadgeHtml, deadlineBadgeHtml, deadlineInfo,
    itemTitle, registerView, bindDynamicButtons, showFormError, hideFormError, equipmentTypeText, ROLE_KEYS
  };

  document.addEventListener('DOMContentLoaded', init);
})();
