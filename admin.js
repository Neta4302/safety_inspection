(() => {
  'use strict';
  // System Admin screen: accounts, permissions, data correction, venues and equipment,
  // security log, and backups. Tabs are shown only for capabilities the account holds,
  // and the server refuses every request below without them anyway.
  const App = window.SafeCheckApp;
  const Api = window.SafeCheckApi;
  const { t, $, $$, escapeHtml, toast, formatDate, can, withLoading, errorText } = App;
  const state = App.state;
  const h = key => escapeHtml(t(key));

  const TABS = [
    { id: 'users', caps: ['user.manage'] },
    { id: 'permissions', caps: ['role.manage'] },
    { id: 'data', caps: ['data.correct'] },
    { id: 'venues', caps: ['venue.manage', 'equipment.manage'] },
    { id: 'security', caps: ['security.view'] },
    { id: 'sessions', caps: ['activity.view'] },
    { id: 'activity', caps: ['activity.view'] },
    { id: 'backup', caps: ['system.backup'] }
  ];
  const BRANCHES = ['BKK-CENTRAL', 'BKK-EAST', 'BKK-NORTH'];
  const VENUE_TYPES = ['Restaurant', 'Bar & Pub', 'Entertainment'];
  const EQUIPMENT_TYPES = ['fire_extinguisher', 'smoke_detector', 'exit_sign', 'sprinkler_head', 'emergency_light'];
  const CAP_GROUPS = [
    ['workflow', ['inspection.submit', 'inspection.review', 'inspection.approve', 'staff.notify']],
    ['alerts', ['alert.acknowledge', 'alert.escalate', 'alert.close', 'action.update', 'alert.simulate']],
    ['admin', ['user.manage', 'role.manage', 'data.correct', 'venue.manage', 'equipment.manage', 'security.view', 'activity.view', 'session.manage', 'system.backup', 'system.reset']],
    ['other', ['feedback.submit', 'feedback.read']]
  ];

  let tab = null;
  let users = [];
  let userSearch = '';
  let userRole = 'all';
  let userForm = null;         // null, {} for a new account, or the account being edited
  let permissions = null;
  let draftMatrix = null;
  let dataSearch = '';
  let correcting = null;       // id of the inspection being corrected
  let venueForm = null;
  let equipmentForm = null;
  let equipmentVenue = 'all';
  let activityFilter = { userId: '', category: 'all', hours: '168', q: '', hidePages: false, sessionId: '' };

  const root = () => $('#admin-content');
  const option = (value, label, selected) => `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const roleLabel = r => `${App.roleMeta(r).label} · ${App.roleMeta(r).th}`;
  const sizeText = bytes => (bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB');
  const clone = value => JSON.parse(JSON.stringify(value));
  const showLoading = () => { root().innerHTML = `<div class="panel empty-state">${h('admin.loading')}</div>`; };
  const showLoadError = err => { root().innerHTML = `<div class="panel empty-state"><b>${escapeHtml(errorText(err))}</b></div>`; };
  const panelHead = (titleKey, subKey, button = '') =>
    `<div class="panel-heading"><div><h3>${h(titleKey)}</h3>${subKey ? `<p>${h(subKey)}</p>` : ''}</div>${button}</div>`;
  const scrollTo = selector => { const el = $(selector); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  // Keeps the rest of the app (venue lists, dashboard, signed-in user's own rights) in
  // step after an administrative change.
  async function syncApp() {
    const { user } = await Api.me();
    if (user) state.user = user;
    await App.refreshData();
    App.renderAll();
  }

  async function render() {
    if (!state.data) return;
    const tabs = TABS.filter(tb => tb.caps.some(c => can(c)));
    if (!tabs.length) { root().innerHTML = ''; return; }
    if (!tab || !tabs.some(tb => tb.id === tab)) tab = tabs[0].id;
    $$('[data-admin-tab]').forEach(b => b.classList.toggle('active', b.dataset.adminTab === tab));
    const renderers = { users: renderUsers, permissions: renderPermissions, data: renderData, venues: renderVenues, security: renderSecurity, sessions: renderSessions, activity: renderActivity, backup: renderBackup };
    await renderers[tab](true);
  }

  // --- Users ----------------------------------------------------------------------------
  async function renderUsers(reload) {
    if (reload) {
      showLoading();
      try { users = (await Api.admin.listUsers()).users; } catch (err) { showLoadError(err); return; }
    }
    root().innerHTML = `<article class="panel">
      ${panelHead('admin.users.title', 'admin.users.sub', `<button class="btn btn-primary" type="button" data-user-new>${h('admin.users.add')}</button>`)}
      ${userForm ? userFormHtml(userForm) : ''}
      <div class="filter-row">
        <input id="admin-user-search" type="search" value="${escapeHtml(userSearch)}" placeholder="${h('admin.users.search')}">
        <select id="admin-user-role">${option('all', t('admin.users.allRoles'), userRole === 'all')}${App.ROLE_KEYS.map(r => option(r, roleLabel(r), userRole === r)).join('')}</select>
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>${h('admin.users.col.name')}</th><th>${h('admin.users.col.role')}</th><th>${h('admin.users.col.branch')}</th>
        <th>${h('admin.users.col.status')}</th><th>${h('admin.users.col.lastLogin')}</th><th>${h('admin.col.actions')}</th>
      </tr></thead><tbody id="admin-user-table"></tbody></table></div>
    </article>`;
    renderUserTable();
  }

  function renderUserTable() {
    const term = userSearch.toLowerCase();
    const rows = users.filter(u => (userRole === 'all' || u.role === userRole) && `${u.name} ${u.email} ${u.username}`.toLowerCase().includes(term));
    $('#admin-user-table').innerHTML = rows.map(u => {
      const scope = u.role === 'manager' || u.role === 'admin' ? t('admin.users.allVenues')
        : u.role === 'supervisor' ? t('admin.users.branchVenues') : t('admin.users.venues', { n: u.venues.length });
      const self = state.user && u.id === state.user.id;
      const actions = [`<button class="text-button" type="button" data-user-edit="${u.id}">${h('admin.edit')}</button>`];
      if (!u.isDemo && !self) {
        actions.push(u.status === 'suspended'
          ? `<button class="text-button" type="button" data-user-status="active" data-id="${u.id}">${h('admin.users.reactivate')}</button>`
          : `<button class="text-button danger-link" type="button" data-user-status="suspended" data-id="${u.id}">${h('admin.users.suspend')}</button>`);
        actions.push(`<button class="text-button danger-link" type="button" data-user-delete="${u.id}">${h('admin.delete')}</button>`);
      }
      return `<tr>
        <td class="user-cell"><b>${escapeHtml(u.name)}${u.isDemo ? `<span class="tag-demo">${h('admin.users.demo')}</span>` : ''}</b><small>${escapeHtml(u.email)}${u.username ? ' · @' + escapeHtml(u.username) : ''}</small></td>
        <td>${escapeHtml(roleLabel(u.role))}</td>
        <td class="user-cell">${escapeHtml(u.branch)}<small>${escapeHtml(scope)}</small></td>
        <td><span class="status-pill-${u.status}">${h('admin.users.' + u.status)}</span></td>
        <td>${u.lastLoginAt ? formatDate(u.lastLoginAt) : h('admin.users.never')}</td>
        <td class="row-actions">${actions.join(' ')}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="6"><div class="empty-state">${h('appr.emptyAll')}</div></td></tr>`;
  }

  function userFormHtml(u) {
    const editing = !!u.id;
    const role = u.role || 'user';
    const lock = u.isDemo ? ' disabled' : '';
    const venueChecks = state.data.venues.map(v =>
      `<label><input type="checkbox" name="venues" value="${v.id}"${(u.venues || []).includes(v.id) ? ' checked' : ''}${lock}><span>${escapeHtml(v.name)}</span><small>${escapeHtml(v.branch)}</small></label>`).join('');
    return `<form class="admin-form" id="user-form" data-id="${u.id || ''}">
      <h4>${escapeHtml(editing ? t('admin.users.formEdit', { name: u.name }) : t('admin.users.formNew'))}</h4>
      ${u.isDemo ? `<p class="admin-note">⚠ ${h('admin.users.demoNote')}</p>` : ''}
      <div class="field-row">
        <div><label for="uf-name">${h('admin.users.name')}</label><input id="uf-name" required maxlength="120" value="${escapeHtml(u.name || '')}"></div>
        <div><label for="uf-email">${editing ? escapeHtml(t('admin.users.emailKeep', { email: u.email })) : h('admin.users.email')}</label><input id="uf-email" type="email"${editing ? '' : ' required'}${lock} autocomplete="off"></div>
      </div>
      <div class="field-row">
        <div><label for="uf-username">${h('admin.users.username')}</label><input id="uf-username" maxlength="30" value="${escapeHtml(u.username || '')}"${lock} autocapitalize="none" spellcheck="false"><small class="field-hint">${h('admin.users.usernameHint')}</small></div>
        <div><label for="uf-password">${h(editing ? 'admin.users.passwordKeep' : 'admin.users.password')}</label><input id="uf-password" type="password" minlength="6"${editing ? '' : ' required'}${lock} autocomplete="new-password"></div>
      </div>
      <div class="field-row">
        <div><label for="uf-role">${h('admin.users.role')}</label><select id="uf-role"${lock}>${App.ROLE_KEYS.map(r => option(r, roleLabel(r), r === role)).join('')}</select><small class="field-hint" id="uf-role-help">${h('admin.users.roleHelp.' + role)}</small></div>
        <div><label for="uf-branch">${h('admin.users.branch')}</label><select id="uf-branch"${lock}>${BRANCHES.map(b => option(b, t('branch.' + b), b === (u.branch || BRANCHES[0]))).join('')}</select></div>
      </div>
      ${editing ? `<label for="uf-status">${h('admin.users.status')}</label><select id="uf-status"${lock}>${option('active', t('admin.users.active'), u.status !== 'suspended')}${option('suspended', t('admin.users.suspended'), u.status === 'suspended')}</select>` : ''}
      <div id="uf-venues"${role === 'user' || role === 'inspector' ? '' : ' hidden'}>
        <label>${h('admin.users.venuesLabel')}</label>
        <div class="venue-checks">${venueChecks}</div>
        <p class="admin-note">${h('admin.users.venuesHint')}</p>
      </div>
      <div class="form-error" hidden></div>
      <div class="admin-form-actions"><button class="btn btn-primary" type="submit">${h('admin.save')}</button><button class="btn btn-ghost" type="button" data-form-cancel="user">${h('admin.cancel')}</button></div>
    </form>`;
  }

  async function saveUser(form) {
    const id = form.dataset.id;
    const errorEl = form.querySelector('.form-error');
    App.hideFormError(errorEl);
    const existing = users.find(u => u.id === id);
    const role = $('#uf-role').value;
    const body = { name: $('#uf-name').value.trim(), username: $('#uf-username').value.trim(), role, branch: $('#uf-branch').value };
    if ($('#uf-email').value.trim()) body.email = $('#uf-email').value.trim();
    if ($('#uf-password').value) body.password = $('#uf-password').value;
    if (id) body.status = $('#uf-status').value;
    const checked = $$('#user-form input[name=venues]:checked').map(i => i.value);
    // A new account with nothing ticked gets its branch's venues from the server.
    if ((role === 'user' || role === 'inspector') && !(existing && existing.isDemo) && (id || checked.length)) body.venues = checked;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      if (id) await Api.admin.updateUser(id, body); else await Api.admin.createUser(body);
      userForm = null;
      toast(t(id ? 'admin.saved' : 'admin.users.created'));
      await syncApp();
      await renderUsers(true);
    } catch (err) {
      App.showFormError(errorEl, errorText(err));
      button.disabled = false;
    }
  }

  // --- Permissions ------------------------------------------------------------------------
  async function renderPermissions(reload) {
    if (reload || !permissions) {
      showLoading();
      try { permissions = await Api.admin.getPermissions(); } catch (err) { showLoadError(err); return; }
      draftMatrix = clone(permissions.matrix);
    }
    const roles = permissions.roles;
    const locked = (role, cap) => role === 'admin' && permissions.locked.admin.includes(cap);
    const body = CAP_GROUPS.map(([group, caps]) =>
      `<tr class="perm-group"><td colspan="${roles.length + 1}">${h('cap.group.' + group)}</td></tr>` +
      caps.filter(c => permissions.capabilities.includes(c)).map(cap => `<tr><td>${h('cap.' + cap)}<small>${cap}</small></td>${roles.map(r =>
        `<td><input type="checkbox" data-perm-role="${r}" data-perm-cap="${cap}"${draftMatrix[r].includes(cap) ? ' checked' : ''}${locked(r, cap) ? ` disabled title="${h('admin.perm.locked')}"` : ''} aria-label="${escapeHtml(App.roleMeta(r).label + ': ' + t('cap.' + cap))}"></td>`).join('')}</tr>`).join('')
    ).join('');
    const scopeRow = `<tr class="perm-group"><td colspan="${roles.length + 1}">${h('admin.perm.scopeTitle')}</td></tr><tr><td>${h('scope.title')}</td>${roles.map(r => `<td>${h('admin.perm.scope.' + r)}</td>`).join('')}</tr>`;
    root().innerHTML = `<article class="panel">
      ${panelHead('admin.perm.title', 'admin.perm.sub')}
      <div class="table-wrap"><table class="perm-table"><thead><tr><th>${h('admin.perm.capability')}</th>${roles.map(r => `<th>${escapeHtml(App.roleMeta(r).label)}<br><small>${escapeHtml(App.roleMeta(r).th)}</small></th>`).join('')}</tr></thead><tbody>${body}${scopeRow}</tbody></table></div>
      <div class="perm-bar"><span class="perm-dirty" id="perm-dirty"></span><div class="admin-form-actions" style="margin:0"><button class="btn btn-ghost" type="button" data-perm-reset>${h('admin.perm.reset')}</button><button class="btn btn-primary" type="button" data-perm-save>${h('admin.perm.save')}</button></div></div>
    </article>`;
    updateDirty();
  }

  const changedRoles = () => permissions.roles.filter(r => [...draftMatrix[r]].sort().join() !== [...permissions.matrix[r]].sort().join());
  function updateDirty() { const el = $('#perm-dirty'); if (el) el.textContent = changedRoles().length ? t('admin.perm.unsaved') : ''; }

  async function savePermissions(button) {
    const roles = changedRoles();
    if (!roles.length) { toast(t('admin.perm.noChanges')); return; }
    await withLoading(button, null, async () => {
      for (const role of roles) permissions = await Api.admin.setPermissions(role, draftMatrix[role]);
      draftMatrix = clone(permissions.matrix);
      toast(t('admin.perm.saved'));
      await syncApp();
      await render();
    });
  }

  async function resetPermissions(button) {
    if (!confirm(t('admin.perm.resetConfirm'))) return;
    await withLoading(button, null, async () => {
      permissions = await Api.admin.resetPermissions();
      draftMatrix = clone(permissions.matrix);
      toast(t('admin.perm.resetDone'));
      await syncApp();
      await render();
    });
  }

  // --- Data correction -------------------------------------------------------------------
  function dataRows() {
    const term = dataSearch.toLowerCase();
    return (state.data.inspections || [])
      .filter(i => i.status !== 'draft' && `${i.id} ${i.venueName} ${i.inspector}`.toLowerCase().includes(term))
      .sort((a, b) => b.date.localeCompare(a.date));
  }

  function renderDataTable() {
    $('#admin-data-table').innerHTML = dataRows().map(i => `<tr>
      <td><b>${escapeHtml(i.id)}</b></td><td>${formatDate(i.date)}</td><td>${escapeHtml(i.venueName)}</td><td>${escapeHtml(i.inspector)}</td>
      <td><span class="score-badge ${i.score < 70 ? 'low' : i.score < 85 ? 'mid' : ''}">${i.score}</span></td><td>${App.stageBadgeHtml(i)}</td>
      <td class="row-actions"><button class="text-button" type="button" data-detail="${i.id}">${h('hist.view')}</button> <button class="text-button" type="button" data-correct-row="${i.id}">${h('admin.edit')}</button></td>
    </tr>`).join('') || `<tr><td colspan="7"><div class="empty-state">${h('hist.notFound')}</div></td></tr>`;
    App.bindDynamicButtons();
  }

  function correctionFormHtml(ins) {
    const results = ['pass', 'fail', 'na'];
    const items = ins.items.map(item => `<div class="correct-row">
      <div><b>${escapeHtml(item.id)}</b> ${escapeHtml(App.itemTitle(item))}</div>
      <select data-correct-result="${item.id}" aria-label="${escapeHtml(item.id)}">${results.map(r => option(r, t('insp.' + r), item.result === r)).join('')}</select>
      <input data-correct-note="${item.id}" value="${escapeHtml(item.note || '')}" placeholder="${h('admin.data.itemNote')}" aria-label="${escapeHtml(item.id)} ${h('admin.data.itemNote')}">
    </div>`).join('');
    return `<form class="admin-form" id="correct-form" data-id="${ins.id}">
      <h4>${escapeHtml(t('admin.data.formTitle', { id: ins.id }))} · ${escapeHtml(ins.venueName)}</h4>
      <div class="field-row">
        <div><label for="cf-inspector">${h('admin.data.inspector')}</label><input id="cf-inspector" maxlength="120" value="${escapeHtml(ins.inspector)}"></div>
        <div><label for="cf-overall">${h('admin.data.overall')}</label><input id="cf-overall" maxlength="2000" value="${escapeHtml(ins.overallNote || '')}"></div>
      </div>
      <div class="correct-items">${items}</div>
      <label for="cf-reason">${h('admin.data.reason')}</label>
      <textarea id="cf-reason" rows="2" maxlength="500" placeholder="${h('admin.data.reasonPlaceholder')}"></textarea>
      <div class="form-error" hidden></div>
      <div class="admin-form-actions"><button class="btn btn-primary" type="submit">${h('admin.data.save')}</button><button class="btn btn-ghost" type="button" data-form-cancel="correct">${h('admin.cancel')}</button></div>
    </form>`;
  }

  function renderData() {
    const target = correcting && state.data.inspections.find(i => i.id === correcting);
    root().innerHTML = `<article class="panel">
      ${panelHead('admin.data.title', 'admin.data.sub')}
      ${target ? correctionFormHtml(target) : ''}
      <div class="filter-row"><input id="admin-data-search" type="search" value="${escapeHtml(dataSearch)}" placeholder="${h('admin.data.search')}"></div>
      <div class="table-wrap"><table><thead><tr><th>${h('hist.col.id')}</th><th>${h('hist.col.date')}</th><th>${h('hist.col.venue')}</th><th>${h('hist.col.inspector')}</th><th>${h('hist.col.score')}</th><th>${h('hist.col.status')}</th><th></th></tr></thead><tbody id="admin-data-table"></tbody></table></div>
    </article>`;
    renderDataTable();
    if (target) scrollTo('#correct-form');
  }

  async function saveCorrection(form) {
    const errorEl = form.querySelector('.form-error');
    App.hideFormError(errorEl);
    const reason = $('#cf-reason').value.trim();
    if (!reason) { App.showFormError(errorEl, t('err.reasonRequired')); $('#cf-reason').focus(); return; }
    const body = {
      reason, inspectorName: $('#cf-inspector').value, overallNote: $('#cf-overall').value,
      items: $$('#correct-form [data-correct-result]').map(select => ({
        id: select.dataset.correctResult, result: select.value,
        note: $(`#correct-form [data-correct-note="${select.dataset.correctResult}"]`).value
      }))
    };
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const result = await Api.admin.correctInspection(form.dataset.id, body);
      correcting = null;
      toast(t('admin.data.saved', { score: result.score }));
      await syncApp();
      renderData();
    } catch (err) {
      App.showFormError(errorEl, errorText(err));
      button.disabled = false;
    }
  }

  function openCorrection(id) {
    tab = 'data';
    correcting = id;
    App.showView('admin');
  }

  // --- Venues and equipment --------------------------------------------------------------
  function venueFormHtml(v) {
    return `<form class="admin-form" id="venue-form" data-id="${v.id || ''}">
      <h4>${escapeHtml(v.id ? t('admin.venues.formEdit', { name: v.name }) : t('admin.venues.formNew'))}</h4>
      <div class="field-row">
        <div><label for="vf-name">${h('admin.venues.name')}</label><input id="vf-name" required maxlength="120" value="${escapeHtml(v.name || '')}"></div>
        <div><label for="vf-type">${h('admin.venues.type')}</label><select id="vf-type">${VENUE_TYPES.map(ty => option(ty, ty, ty === v.type)).join('')}</select></div>
      </div>
      <div class="field-row">
        <div><label for="vf-location">${h('admin.venues.location')}</label><input id="vf-location" required maxlength="200" value="${escapeHtml(v.location || '')}"></div>
        <div><label for="vf-location-en">${h('admin.venues.locationEn')}</label><input id="vf-location-en" maxlength="200" value="${escapeHtml(v.locationEn || '')}"></div>
      </div>
      <div class="field-row">
        <div><label for="vf-branch">${h('admin.users.branch')}</label><select id="vf-branch">${BRANCHES.map(b => option(b, t('branch.' + b), b === (v.branch || BRANCHES[0]))).join('')}</select></div>
        <div><label for="vf-tables">${h('admin.venues.tables')}</label><input id="vf-tables" type="number" min="1" max="500" required value="${v.tablesCount || 10}"></div>
      </div>
      ${assigneesHtml(v)}
      <div class="form-error" hidden></div>
      <div class="admin-form-actions"><button class="btn btn-primary" type="submit">${h('admin.save')}</button><button class="btn btn-ghost" type="button" data-form-cancel="venue">${h('admin.cancel')}</button></div>
    </form>`;
  }

  function equipmentFormHtml(e) {
    return `<form class="admin-form" id="equipment-form" data-id="${e.id || ''}">
      <h4>${escapeHtml(e.id ? t('admin.eq.formEdit', { name: e.label }) : t('admin.eq.formNew'))}</h4>
      <div class="field-row">
        <div><label for="ef-venue">${h('admin.eq.venue')}</label><select id="ef-venue"${e.id ? ' disabled' : ''}>${state.data.venues.map(v => option(v.id, v.name, v.id === e.venueId)).join('')}</select></div>
        <div><label for="ef-type">${h('admin.eq.type')}</label><select id="ef-type">${EQUIPMENT_TYPES.map(ty => option(ty, App.equipmentTypeText(ty), ty === e.type)).join('')}</select></div>
      </div>
      <label for="ef-label">${h('admin.eq.label')}</label><input id="ef-label" required maxlength="120" value="${escapeHtml(e.label || '')}">
      <div class="field-row">
        <div><label for="ef-install">${h('admin.eq.install')}</label><input id="ef-install" type="date" value="${escapeHtml(e.installDate || '')}"></div>
        <div><label for="ef-expiry">${h('admin.eq.expiry')}</label><input id="ef-expiry" type="date" value="${escapeHtml(e.expiryDate || '')}"></div>
      </div>
      <div class="form-error" hidden></div>
      <div class="admin-form-actions"><button class="btn btn-primary" type="submit">${h('admin.save')}</button><button class="btn btn-ghost" type="button" data-form-cancel="equipment">${h('admin.cancel')}</button></div>
    </form>`;
  }

  // Who can inspect a place is chosen right where the place is added, so a new place
  // shows up for the right people without a second trip to the user screen.
  function assigneesHtml(v) {
    if (!can('user.manage') || !users.length) return '';
    const assigned = u => !!v.id && u.venues.includes(v.id);
    const eligible = users.filter(u => u.role === 'user' || u.role === 'inspector');
    return `<label>${h('admin.venues.assignees')}</label>
      <div class="venue-checks">${eligible.map(u => `<label><input type="checkbox" name="assignees" value="${u.id}"${assigned(u) ? ' checked' : ''}${u.isDemo && assigned(u) ? ' disabled' : ''}><span>${escapeHtml(u.name)}</span><small>${escapeHtml(roleLabel(u.role))} · ${escapeHtml(u.branch)}</small></label>`).join('')}</div>
      <p class="admin-note">${h('admin.venues.assigneesHint')}</p>`;
  }

  function openVenueForm(id) {
    tab = 'venues';
    venueForm = id ? (state.data.venues.find(v => v.id === id) || {}) : {};
    equipmentForm = null;
    App.showView('admin');
    setTimeout(() => scrollTo('#venue-form'), 450);
  }

  async function renderVenues() {
    if (venueForm && can('user.manage') && !users.length) {
      try { users = (await Api.admin.listUsers()).users; } catch (err) { /* form still works without assignees */ }
    }
    const venues = state.data.venues || [];
    const equipment = (state.data.equipment || []).filter(e => equipmentVenue === 'all' || e.venueId === equipmentVenue);
    const statusClass = s => (s === 'expired' ? 'low' : s === 'expiring_soon' ? 'mid' : '');
    root().innerHTML = `<div class="admin-grid">
      ${can('venue.manage') ? `<article class="panel">
        ${panelHead('admin.venues.title', 'admin.venues.sub', `<button class="btn btn-primary" type="button" data-venue-new>${h('admin.venues.add')}</button>`)}
        ${venueForm ? venueFormHtml(venueForm) : ''}
        <div class="table-wrap"><table><thead><tr><th>${h('admin.venues.name')}</th><th>${h('admin.venues.type')}</th><th>${h('admin.venues.location')}</th><th>${h('admin.users.branch')}</th><th>${h('admin.venues.tables')}</th><th>${h('admin.col.actions')}</th></tr></thead>
        <tbody>${venues.map(v => `<tr><td class="user-cell"><b>${escapeHtml(v.name)}</b><small class="mono">${escapeHtml(v.id)}</small></td><td>${escapeHtml(v.type)}</td><td>${escapeHtml(v.location)}</td><td>${escapeHtml(v.branch)}</td><td>${v.tablesCount}</td>
          <td class="row-actions"><button class="text-button" type="button" data-venue-edit="${v.id}">${h('admin.edit')}</button> <button class="text-button danger-link" type="button" data-venue-delete="${v.id}">${h('admin.delete')}</button></td></tr>`).join('')}</tbody></table></div>
      </article>` : ''}
      ${can('equipment.manage') ? `<article class="panel">
        ${panelHead('admin.eq.title', 'admin.eq.sub', `<button class="btn btn-primary" type="button" data-eq-new>${h('admin.eq.add')}</button>`)}
        ${equipmentForm ? equipmentFormHtml(equipmentForm) : ''}
        <div class="filter-row"><select id="admin-eq-venue">${option('all', t('admin.eq.allVenues'), equipmentVenue === 'all')}${venues.map(v => option(v.id, v.name, equipmentVenue === v.id)).join('')}</select></div>
        <div class="table-wrap"><table><thead><tr><th>${h('admin.eq.venue')}</th><th>${h('admin.eq.type')}</th><th>${h('admin.eq.label')}</th><th>${h('admin.eq.install')}</th><th>${h('admin.eq.expiry')}</th><th>${h('equip.col.status')}</th><th>${h('admin.col.actions')}</th></tr></thead>
        <tbody>${equipment.map(e => `<tr><td>${escapeHtml(e.venueName)}</td><td>${escapeHtml(App.equipmentTypeText(e.type))}</td><td><b>${escapeHtml(e.label)}</b></td><td>${escapeHtml(e.installDate || '-')}</td><td>${escapeHtml(e.expiryDate || '-')}</td>
          <td><span class="score-badge ${statusClass(e.status)}">${h('equip.st.' + e.status)}</span></td>
          <td class="row-actions"><button class="text-button" type="button" data-eq-edit="${e.id}">${h('admin.edit')}</button> <button class="text-button danger-link" type="button" data-eq-delete="${e.id}">${h('admin.delete')}</button></td></tr>`).join('') || `<tr><td colspan="7"><div class="empty-state">${h('equip.empty')}</div></td></tr>`}</tbody></table></div>
      </article>` : ''}
    </div>`;
  }

  async function saveForm(form, request, done) {
    const errorEl = form.querySelector('.form-error');
    App.hideFormError(errorEl);
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      await request();
      done();
      toast(t('admin.saved'));
      await syncApp();
      await render();
    } catch (err) {
      App.showFormError(errorEl, errorText(err));
      button.disabled = false;
    }
  }

  function saveVenue(form) {
    const id = form.dataset.id;
    const body = {
      name: $('#vf-name').value.trim(), type: $('#vf-type').value, location: $('#vf-location').value.trim(),
      locationEn: $('#vf-location-en').value.trim(), branch: $('#vf-branch').value, tablesCount: Number($('#vf-tables').value)
    };
    if ($('#venue-form input[name=assignees]')) body.assignees = $$('#venue-form input[name=assignees]:checked').map(i => i.value);
    // users[] carries each account's venues, which this save may have changed.
    return saveForm(form, () => (id ? Api.admin.updateVenue(id, body) : Api.admin.createVenue(body)), () => { venueForm = null; users = []; });
  }

  function saveEquipment(form) {
    const id = form.dataset.id;
    const body = { type: $('#ef-type').value, label: $('#ef-label').value.trim(), installDate: $('#ef-install').value, expiryDate: $('#ef-expiry').value };
    if (!id) body.venueId = $('#ef-venue').value;
    return saveForm(form, () => (id ? Api.updateEquipment(id, body) : Api.addEquipment(body)), () => { equipmentForm = null; });
  }

  // --- Security ---------------------------------------------------------------------------
  async function renderSecurity() {
    showLoading();
    let security;
    try { security = await Api.admin.security(); } catch (err) { showLoadError(err); return; }
    const s = security.summary;
    const cards = [
      ['failed', s.failedLogins24h, s.failedLogins24h > 0], ['success', s.successfulLogins24h, false],
      ['lockouts', s.lockouts24h, s.lockouts24h > 0], ['suspendedAttempts', s.suspendedAttempts24h, s.suspendedAttempts24h > 0],
      ['sessions', s.activeSessions, false], ['suspendedAccounts', s.suspendedAccounts, false]
    ];
    const none = cols => `<tr><td colspan="${cols}"><div class="empty-state">${h('admin.sec.none')}</div></td></tr>`;
    root().innerHTML = `<div class="admin-grid">
      <article class="panel">
        ${panelHead('admin.sec.title', 'admin.sec.sub', `<button class="btn btn-secondary" type="button" data-sec-refresh>${h('admin.sec.refresh')}</button>`)}
        <div class="sec-cards">${cards.map(([key, value, warn]) => `<div class="sec-card${warn ? ' warn' : ''}"><small>${h('admin.sec.' + key)}</small><strong>${value}</strong></div>`).join('')}</div>
      </article>
      <article class="panel">
        ${panelHead('admin.sec.suspiciousTitle', 'admin.sec.rule')}
        ${security.suspicious.length
          ? `<div class="sec-alerts">${security.suspicious.map(x => `<div class="sec-alert">${escapeHtml(t('admin.sec.kind.' + x.kind, { value: x.value, count: x.count }))}<small>${formatDate(x.last)}</small></div>`).join('')}</div>`
          : `<div class="sec-ok">${h('admin.sec.suspiciousNone')}</div>`}
      </article>
      <article class="panel">
        ${panelHead('admin.sec.loginTitle', 'admin.sec.maskNote')}
        <div class="table-wrap"><table><thead><tr><th>${h('admin.sec.col.time')}</th><th>${h('admin.sec.col.account')}</th><th>${h('admin.sec.col.ip')}</th><th>${h('admin.sec.col.result')}</th></tr></thead>
        <tbody>${security.loginEvents.map(ev => `<tr><td>${formatDate(ev.createdAt)}</td><td class="mono">${escapeHtml(ev.email || '-')}</td><td class="mono">${escapeHtml(ev.ip || '-')}</td>
          <td>${ev.success ? `<span class="result-ok">✓ ${h('admin.sec.ok')}</span>` : `<span class="result-bad">✕ ${h('admin.sec.reason.' + (ev.reason || 'invalid'))}</span>`}</td></tr>`).join('') || none(4)}</tbody></table></div>
      </article>
      <article class="panel">
        ${panelHead('admin.sec.auditTitle', '')}
        <div class="table-wrap"><table><thead><tr><th>${h('admin.sec.col.time')}</th><th>${h('admin.sec.col.actor')}</th><th>${h('admin.sec.col.action')}</th><th>${h('admin.sec.col.target')}</th><th>${h('admin.sec.col.detail')}</th></tr></thead>
        <tbody>${security.audit.map(a => `<tr><td>${formatDate(a.createdAt)}</td><td>${escapeHtml(a.actorName || '-')}</td><td>${escapeHtml(activityLabel(a.action, a.target))}</td><td class="mono">${escapeHtml(a.target || '-')}</td><td>${escapeHtml(a.detail || '')}</td></tr>`).join('') || none(5)}</tbody></table></div>
      </article>
    </div>`;
  }

  // --- Sessions ---------------------------------------------------------------------------
  function durationText(from, to) {
    const minutes = Math.max(1, Math.round((new Date(to) - new Date(from)) / 60000));
    if (minutes >= 1440) return t('time.days', { n: Math.floor(minutes / 1440) });
    if (minutes >= 60) return t('time.hours', { n: Math.floor(minutes / 60) });
    return t('time.minutes', { n: minutes });
  }
  const userCell = s => `<td class="user-cell"><b>${escapeHtml(s.userName)}</b><small>${escapeHtml(App.roleMeta(s.role).label)}</small></td>`;

  async function renderSessions() {
    showLoading();
    let data;
    try { data = await Api.admin.sessions(); } catch (err) { showLoadError(err); return; }
    const none = cols => `<tr><td colspan="${cols}"><div class="empty-state">${h('admin.sess.none')}</div></td></tr>`;
    const cards = [['active', data.summary.active], ['online', data.summary.onlineNow], ['users', data.summary.users]];
    root().innerHTML = `<div class="admin-grid">
      <article class="panel">
        <div class="panel-heading"><div><h3>${h('admin.sess.title')}</h3><p>${escapeHtml(t('admin.sess.sub', { idle: data.idleMinutes }))}</p></div><button class="btn btn-secondary" type="button" data-sessions-refresh>${h('admin.sec.refresh')}</button></div>
        <div class="sec-cards">${cards.map(([key, value]) => `<div class="sec-card"><small>${h('admin.sess.' + key)}</small><strong>${value}</strong></div>`).join('')}</div>
      </article>
      <article class="panel">
        ${panelHead('admin.sess.activeTitle', '')}
        <div class="table-wrap"><table><thead><tr><th>${h('admin.sess.col.user')}</th><th>${h('admin.sess.col.device')}</th><th>IP</th><th>${h('admin.sess.col.started')}</th><th>${h('admin.sess.col.lastSeen')}</th><th>${h('admin.col.actions')}</th></tr></thead>
        <tbody>${data.active.map(s => `<tr${s.current ? ' class="row-current"' : ''}>${userCell(s)}<td>${escapeHtml(s.device || '-')}</td><td class="mono">${escapeHtml(s.ip || '-')}</td><td>${formatDate(s.startedAt)}</td><td>${formatDate(s.lastSeenAt)}</td>
          <td class="row-actions"><button class="text-button" type="button" data-session-activity="${escapeHtml(s.sessionId)}">${h('admin.sess.viewActivity')}</button>
          ${s.current ? `<span class="stage-badge stage-approved">${h('admin.sess.you')}</span>` : can('session.manage') ? `<button class="text-button danger-link" type="button" data-session-revoke="${escapeHtml(s.sessionId)}" data-name="${escapeHtml(s.userName)}" data-device="${escapeHtml(s.device || '-')}">${h('admin.sess.revoke')}</button>` : ''}</td></tr>`).join('') || none(6)}</tbody></table></div>
      </article>
      <article class="panel">
        ${panelHead('admin.sess.recentTitle', '')}
        <div class="table-wrap"><table><thead><tr><th>${h('admin.sess.col.user')}</th><th>${h('admin.sess.col.device')}</th><th>${h('admin.sess.col.started')}</th><th>${h('admin.sess.col.ended')}</th><th>${h('admin.sess.col.duration')}</th><th>${h('admin.sess.col.reason')}</th><th></th></tr></thead>
        <tbody>${data.recent.map(s => `<tr>${userCell(s)}<td>${escapeHtml(s.device || '-')}</td><td>${formatDate(s.startedAt)}</td><td>${formatDate(s.endedAt)}</td><td>${durationText(s.startedAt, s.endedAt)}</td>
          <td><span class="session-reason reason-${escapeHtml(s.endReason)}">${h('sess.reason.' + s.endReason)}</span></td>
          <td><button class="text-button" type="button" data-session-activity="${escapeHtml(s.sessionId)}">${h('admin.sess.viewActivity')}</button></td></tr>`).join('') || none(7)}</tbody></table></div>
      </article>
    </div>`;
  }

  // --- Activity log -------------------------------------------------------------------------
  function activityCategory(action) {
    if (action === 'page.view') return 'page';
    if (action.startsWith('session.')) return 'session';
    if (action.startsWith('alert.')) return 'alert';
    if (/^(inspection|media)\./.test(action) || ['data.correct', 'staff.notify', 'action.update'].includes(action)) return 'inspection';
    if (/^(user|role|venue|equipment|system)\./.test(action)) return 'admin';
    return 'other';
  }

  function activityLabel(action, target) {
    if (action === 'page.view') {
      const section = document.getElementById('view-' + target);
      return t('actlog.page.view', { page: section ? t(section.dataset.titleKey) : target });
    }
    const key = 'actlog.' + action;
    return t(key) === key ? action : t(key);
  }

  async function renderActivity() {
    showLoading();
    const f = activityFilter;
    const params = { hours: f.hours };
    if (f.userId) params.userId = f.userId;
    if (f.category !== 'all') params.category = f.category;
    if (f.q) params.q = f.q;
    if (f.hidePages) params.hidePages = '1';
    if (f.sessionId) params.sessionId = f.sessionId;
    let data;
    try { data = await Api.admin.activity(params); } catch (err) { showLoadError(err); return; }
    const categories = ['all', 'session', 'inspection', 'alert', 'admin', 'page', 'other'];
    const detailText = r => [r.action === 'page.view' ? '' : r.target, r.detail].filter(Boolean).join(' · ');
    root().innerHTML = `<article class="panel">
      <div class="panel-heading"><div><h3>${h('admin.act.title')}</h3><p>${h('admin.act.sub')}</p></div><button class="btn btn-secondary" type="button" data-activity-refresh>${h('admin.sec.refresh')}</button></div>
      <div class="activity-filters">
        <select id="act-user" aria-label="${h('admin.act.col.user')}">${option('', t('admin.act.allUsers'), !f.userId)}${data.users.map(u => option(u.id, `${u.name} (${App.roleMeta(u.role).label})`, f.userId === u.id)).join('')}</select>
        <select id="act-category" aria-label="${h('admin.act.col.action')}">${categories.map(c => option(c, t('admin.act.cat.' + c), f.category === c)).join('')}</select>
        <select id="act-hours" aria-label="${h('admin.act.col.time')}">${['24', '168', '720'].map(p => option(p, t('admin.act.period.' + p), f.hours === p)).join('')}</select>
        <input id="act-q" type="search" value="${escapeHtml(f.q)}" placeholder="${h('admin.act.search')}">
        <label class="inline-check"><input type="checkbox" id="act-hide-pages"${f.hidePages ? ' checked' : ''}> ${h('admin.act.hidePages')}</label>
      </div>
      ${f.sessionId ? `<div class="filter-chip">${escapeHtml(t('admin.act.sessionOnly', { id: f.sessionId.slice(0, 8) }))} <button type="button" data-activity-clear-session aria-label="✕">✕</button></div>` : ''}
      <p class="admin-note">${escapeHtml(t('admin.act.count', { n: data.rows.length }))}</p>
      <div class="table-wrap"><table><thead><tr><th>${h('admin.act.col.time')}</th><th>${h('admin.act.col.user')}</th><th>${h('admin.act.col.action')}</th><th>${h('admin.act.col.detail')}</th><th>${h('admin.act.col.session')}</th></tr></thead>
      <tbody>${data.rows.map(r => `<tr>
        <td>${formatDate(r.createdAt)}</td>
        <td class="user-cell"><b>${escapeHtml(r.actorName || '-')}</b><small>${r.role ? escapeHtml(App.roleMeta(r.role).label) : ''}</small></td>
        <td><span class="act-dot act-${activityCategory(r.action)}"></span>${escapeHtml(activityLabel(r.action, r.target))}</td>
        <td>${escapeHtml(detailText(r))}</td>
        <td>${r.sessionId ? `<button type="button" class="session-chip" data-session-activity="${escapeHtml(r.sessionId)}" title="${escapeHtml(r.ip || '')}">${escapeHtml(r.sessionId.slice(0, 8))}</button>` : '-'}</td>
      </tr>`).join('') || `<tr><td colspan="5"><div class="empty-state">${h('admin.act.none')}</div></td></tr>`}</tbody></table></div>
    </article>`;
  }

  function showSessionActivity(sessionId) {
    activityFilter = { ...activityFilter, sessionId, userId: '', category: 'all', hidePages: false, q: '', hours: '720' };
    tab = 'activity';
    render();
  }

  // --- Backup and restore ----------------------------------------------------------------
  async function renderBackup() {
    showLoading();
    let backups;
    try { backups = (await Api.admin.listBackups()).backups; } catch (err) { showLoadError(err); return; }
    root().innerHTML = `<div class="admin-grid">
      <article class="panel">
        ${panelHead('admin.bak.title', 'admin.bak.sub')}
        <form id="backup-form" class="file-restore">
          <input id="backup-label" maxlength="80" placeholder="${h('admin.bak.labelPlaceholder')}" aria-label="${h('admin.bak.label')}" style="flex:1;min-width:200px">
          <button class="btn btn-primary" type="submit">${h('admin.bak.create')}</button>
        </form>
      </article>
      <article class="panel">
        ${panelHead('admin.bak.listTitle', '')}
        <div class="table-wrap"><table><thead><tr><th>${h('admin.bak.col.time')}</th><th>${h('admin.bak.col.label')}</th><th>${h('admin.bak.col.by')}</th><th>${h('admin.bak.col.size')}</th><th>${h('admin.col.actions')}</th></tr></thead>
        <tbody>${backups.map(b => `<tr><td>${formatDate(b.createdAt)}</td><td><b>${escapeHtml(b.label || t('admin.bak.untitled'))}</b></td><td>${escapeHtml(b.createdBy)}</td><td>${sizeText(b.size)}</td>
          <td class="row-actions"><a class="text-button" href="${Api.admin.backupUrl(b.id)}" download>${h('admin.bak.download')}</a> <button class="text-button danger-link" type="button" data-backup-restore="${b.id}" data-label="${escapeHtml(b.label || t('admin.bak.untitled'))}">${h('admin.bak.restore')}</button></td></tr>`).join('')
          || `<tr><td colspan="5"><div class="empty-state">${h('admin.bak.none')}</div></td></tr>`}</tbody></table></div>
      </article>
      <article class="panel">
        ${panelHead('admin.bak.fileTitle', 'admin.bak.fileSub')}
        <div class="file-restore"><input id="backup-file" type="file" accept="application/json,.json"><button class="btn btn-secondary" type="button" data-backup-file>${h('admin.bak.fileBtn')}</button></div>
      </article>
    </div>`;
  }

  async function restore(button, payload) {
    await withLoading(button, null, async () => {
      await Api.admin.restore(payload);
      toast(t('admin.bak.restored'));
      await syncApp();
      await renderBackup();
    });
  }

  // --- Events (delegated once on the admin container) -------------------------------------
  async function onClick(e) {
    const el = e.target.closest('button, a');
    if (!el || !root().contains(el)) return;
    const d = el.dataset;
    if ('userNew' in d) { userForm = {}; await renderUsers(false); scrollTo('#user-form'); }
    else if (d.userEdit) { userForm = users.find(u => u.id === d.userEdit); await renderUsers(false); scrollTo('#user-form'); }
    else if (d.userStatus) {
      const u = users.find(x => x.id === d.id);
      if (d.userStatus === 'suspended' && !confirm(t('admin.users.confirmSuspend', { name: u.name }))) return;
      await withLoading(el, null, async () => {
        await Api.admin.updateUser(d.id, { status: d.userStatus });
        toast(t(d.userStatus === 'suspended' ? 'admin.users.suspendedToast' : 'admin.users.reactivatedToast'));
        await syncApp();
        await renderUsers(true);
      });
    } else if (d.userDelete) {
      const u = users.find(x => x.id === d.userDelete);
      if (!confirm(t('admin.users.confirmDelete', { name: u.name }))) return;
      await withLoading(el, null, async () => {
        await Api.admin.deleteUser(d.userDelete);
        toast(t('admin.users.deletedToast'));
        await syncApp();
        await renderUsers(true);
      });
    } else if (d.formCancel) {
      if (d.formCancel === 'user') { userForm = null; await renderUsers(false); }
      if (d.formCancel === 'correct') { correcting = null; renderData(); }
      if (d.formCancel === 'venue') { venueForm = null; renderVenues(); }
      if (d.formCancel === 'equipment') { equipmentForm = null; renderVenues(); }
    }
    else if ('permSave' in d) savePermissions(el);
    else if ('permReset' in d) resetPermissions(el);
    else if (d.correctRow) { correcting = d.correctRow; renderData(); }
    else if ('venueNew' in d) { venueForm = {}; renderVenues(); scrollTo('#venue-form'); }
    else if (d.venueEdit) { venueForm = state.data.venues.find(v => v.id === d.venueEdit); renderVenues(); scrollTo('#venue-form'); }
    else if (d.venueDelete) {
      const v = state.data.venues.find(x => x.id === d.venueDelete);
      if (!confirm(t('admin.venues.confirmDelete', { name: v.name }))) return;
      await withLoading(el, null, async () => {
        await Api.admin.deleteVenue(d.venueDelete);
        toast(t('admin.venues.deleted'));
        await syncApp();
        renderVenues();
      });
    }
    else if ('eqNew' in d) { equipmentForm = { venueId: equipmentVenue !== 'all' ? equipmentVenue : '' }; renderVenues(); scrollTo('#equipment-form'); }
    else if (d.eqEdit) { equipmentForm = state.data.equipment.find(x => x.id === d.eqEdit); renderVenues(); scrollTo('#equipment-form'); }
    else if (d.eqDelete) {
      const eq = state.data.equipment.find(x => x.id === d.eqDelete);
      if (!confirm(t('admin.eq.confirmDelete', { name: eq.label }))) return;
      await withLoading(el, null, async () => {
        await Api.admin.deleteEquipment(d.eqDelete);
        toast(t('admin.eq.deleted'));
        await syncApp();
        renderVenues();
      });
    }
    else if ('secRefresh' in d) renderSecurity();
    else if ('sessionsRefresh' in d) renderSessions();
    else if ('activityRefresh' in d) renderActivity();
    else if (d.sessionActivity) showSessionActivity(d.sessionActivity);
    else if ('activityClearSession' in d) { activityFilter.sessionId = ''; renderActivity(); }
    else if (d.sessionRevoke) {
      if (!confirm(t('admin.sess.confirmRevoke', { name: d.name, device: d.device }))) return;
      await withLoading(el, null, async () => {
        await Api.admin.revokeSession(d.sessionRevoke);
        toast(t('admin.sess.revokedToast'));
        await renderSessions();
      });
    }
    else if (d.backupRestore) {
      if (!confirm(t('admin.bak.confirmRestore', { label: d.label }))) return;
      restore(el, { backupId: d.backupRestore });
    } else if ('backupFile' in d) {
      const file = $('#backup-file').files[0];
      if (!file) { $('#backup-file').click(); return; }
      if (!confirm(t('admin.bak.confirmFile', { name: file.name }))) return;
      restore(el, { payload: await file.text() });
    }
  }

  async function onSubmit(e) {
    const form = e.target;
    if (!root().contains(form)) return;
    e.preventDefault();
    if (form.id === 'user-form') saveUser(form);
    else if (form.id === 'correct-form') saveCorrection(form);
    else if (form.id === 'venue-form') saveVenue(form);
    else if (form.id === 'equipment-form') saveEquipment(form);
    else if (form.id === 'backup-form') {
      await withLoading(form.querySelector('button'), null, async () => {
        await Api.admin.createBackup($('#backup-label').value.trim());
        toast(t('admin.bak.created'));
        await renderBackup();
      });
    }
  }

  function onInput(e) {
    if (e.target.id === 'admin-user-search') { userSearch = e.target.value; renderUserTable(); }
    if (e.target.id === 'admin-data-search') { dataSearch = e.target.value; renderDataTable(); }
  }

  function onChange(e) {
    const el = e.target;
    if (el.id === 'admin-user-role') { userRole = el.value; renderUserTable(); }
    if (el.id === 'admin-eq-venue') { equipmentVenue = el.value; renderVenues(); }
    if (el.id === 'act-user') { activityFilter.userId = el.value; renderActivity(); }
    if (el.id === 'act-category') { activityFilter.category = el.value; renderActivity(); }
    if (el.id === 'act-hours') { activityFilter.hours = el.value; renderActivity(); }
    if (el.id === 'act-hide-pages') { activityFilter.hidePages = el.checked; renderActivity(); }
    // A search box fires "change" on Enter or when it loses focus, not on every key.
    if (el.id === 'act-q') { activityFilter.q = el.value.trim(); renderActivity(); }
    if (el.id === 'uf-role') {
      $('#uf-venues').hidden = !(el.value === 'user' || el.value === 'inspector');
      $('#uf-role-help').textContent = t('admin.users.roleHelp.' + el.value);
    }
    if (el.dataset.permRole) {
      const list = draftMatrix[el.dataset.permRole];
      const cap = el.dataset.permCap;
      draftMatrix[el.dataset.permRole] = el.checked ? [...new Set([...list, cap])] : list.filter(c => c !== cap);
      updateDirty();
    }
  }

  function bind() {
    $$('[data-admin-tab]').forEach(b => b.addEventListener('click', () => {
      tab = b.dataset.adminTab;
      userForm = venueForm = equipmentForm = correcting = null;
      render();
    }));
    const container = root();
    container.addEventListener('click', onClick);
    container.addEventListener('submit', onSubmit);
    container.addEventListener('input', onInput);
    container.addEventListener('change', onChange);
  }

  App.registerView('admin', { render, bind, openCorrection, openVenueForm });
})();
