// ============================================================
// CONFIGURATION
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbyK7Q4PGh6jSmNgN1NaBlgJnj-IkkduiqleToZjC7F2vGodtGO9RjN498QGvrgf1xykjw/exec';

// Anonymous, device-scoped tracking token used to tag entries a user creates so
// deletion can be limited to records they personally added.
const currentUserToken = (function () {
  try {
    if (!localStorage.getItem('wanganga_user_token')) {
      localStorage.setItem('wanganga_user_token', 'user_' + Math.random().toString(36).substring(2, 11));
    }
  } catch (e) { /* storage unavailable */ }
  return localStorage.getItem('wanganga_user_token') || 'user_guest';
})();

// Super-admin override code, set after the owner unlocks via the Admin button.
const adminCode = (function () {
  try { return localStorage.getItem('wanganga_admin_code') || ''; } catch (e) { return ''; }
})();
// View-only mode: ?view=1 or ?readonly=1 in URL
const isViewOnly = (function () {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('view') === '1' || params.get('readonly') === '1';
  } catch (e) { return false; }
})();

function isSuperAdminLocal() { return !!adminCode; }
function canManageRecord(rec) {
  return !isViewOnly && (String(rec.created_by || '') === currentUserToken || isSuperAdminLocal());
}

// ============================================================
// VISITOR TRACKING
// ============================================================
// A stable per-device id so the admin visit log can tell "the same phone
// returning" from a one-off viewer, even in anonymous view-only mode.
const visitorId = (function () {
  try {
    if (!localStorage.getItem('wanganga_visitor_id')) {
      localStorage.setItem('wanganga_visitor_id', 'v_' + Math.random().toString(36).substring(2, 12) + Date.now().toString(36));
    }
  } catch (e) { /* storage unavailable */ }
  return localStorage.getItem('wanganga_visitor_id') || 'v_unknown';
})();

// Approximate location, looked up once per device and cached locally. Fails
// silently to plain '' so anonymous viewers are never blocked or slowed.
let cachedLocation = (function () {
  try { return localStorage.getItem('wanganga_visitor_loc') || ''; } catch (e) { return ''; }
})();
function maybeResolveLocation() {
  if (cachedLocation) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  fetch('https://ipwho.is/', { signal: ctrl.signal })
    .then(r => r.json())
    .then(j => {
      const parts = [];
      if (j && j.city) parts.push(j.city);
      if (j && j.country) parts.push(j.country);
      cachedLocation = parts.join(', ');
      try { localStorage.setItem('wanganga_visitor_loc', cachedLocation); } catch (e) {}
    })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}

// Fire-and-forget event logger: never awaits, never throws, never blocks the
// UI. Backend pre-checks events against an allow-list before writing.
function logVisitorEvent(event, personName, personId) {
  const payload = {
    action: 'logEvent',
    event: event,
    visitor_id: visitorId,
    mode: isViewOnly ? 'view' : 'edit',
    location: cachedLocation,
    user_agent: (navigator.userAgent || '').slice(0, 400)
  };
  if (personId) payload.person_id = personId;
  if (personName) payload.person_name = personName;
  apiPost(payload).catch(() => {});
}

// ============================================================
// STATE
// ============================================================
let persons = [];
let relationships = [];
let selectedNode = null;
let svgGroup = null;
let zoomBehavior = null;
let searchDebounce = null;
let schemaReady = false;

// Congestion control: person_ids whose child branch the owner has collapsed.
// hidden by an expand/collapse toggle badge on the node. Survives rerenders.
const collapsedClusters = new Set();

// Drag-to-link state: any real drag suppresses the node's click (radial menu)
// for a short window so a drop never also opens the menu.
let pendingDragLink = null;
let suppressNodeClickUntil = 0;

// ============================================================
// API Layer
// ============================================================
// Apps Script anonymous web apps: the FIRST request a fresh browser makes
// performs a redirect/cookie handshake and can return a 404 HTML page — or, on
// some networks, stall on the auth redirect entirely. To make views reliable
// everywhere, every call gets a short timeout and retries. The request to the
// API itself is idempotent for reads; writes default to a single attempt so a
// timed-out-but-executed save is never duplicated.
const API_TIMEOUT_MS = 10000;

async function apiGet(action, params = {}, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    try {
      const qs = new URLSearchParams({ action, ...params }).toString();
      const res = await fetch(API_URL + '?' + qs, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('Non-JSON response (' + ct + ')');
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}

async function apiPost(payload, tries = 1) {
  payload.user_token = payload.user_token || currentUserToken;
  if (adminCode) payload.admin_token = payload.admin_token || adminCode;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('json')) throw new Error('Non-JSON response (' + ct + ')');
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      await new Promise(r => setTimeout(r, 1200));
    }
  }
  throw lastErr;
}

// ============================================================
// Safe Relationship Writes
// ============================================================
// The anonymous Apps Script endpoint is flaky: a write can return a 404 / HTML
// / network error yet STILL have executed server-side. Blindly retrying such a
// write creates a duplicate relationship row. These helpers therefore follow a
// "verify, then retry" discipline:
//   1. Skip the write entirely when the relationship already exists (dedupe).
//   2. If a write "fails", re-check the server: if it landed, treat as success.
//   3. Only retry a genuinely missing write (retry cannot duplicate).
function relationshipExists(parentId, childId, relType) {
  return relationships.some(r =>
    String(r.parent_id) === String(parentId) &&
    String(r.child_id) === String(childId) &&
    String(r.rel_type) === String(relType));
}

async function createRelationshipSafe(parentId, childId, relType) {
  // Spouse rows must key the man as parent_id, or the renderer walks the pair
  // backwards and his whole cluster un-routes. Orient by gender: if the row was
  // written reversed (woman as parent, man known as the child), swap it now.
  if (String(relType).toLowerCase() === 'spouse') {
    const ga = genderOf(parentId), gb = genderOf(childId);
    if (isFemaleGender(ga) && isMaleGender(gb)) { const t = parentId; parentId = childId; childId = t; }
  }
  const payload = { action: 'createRelationship', parent_id: parentId, child_id: childId, rel_type: relType, created_by: currentUserToken };
  const existing = relationships.find(r =>
    String(r.parent_id) === String(parentId) &&
    String(r.child_id) === String(childId) &&
    String(r.rel_type) === String(relType));
  if (existing) return { success: true, skipped: true, relationship_id: existing.relationship_id };

  let res = null;
  try { res = await apiPost(payload, 1); } catch (e) { res = null; }
  if (res && res.success) return { success: true, relationship_id: res.relationship_id };

  // The write "failed", but it may have executed. Re-sync from the server and
  // look for the row before deciding to retry.
  try {
    const fresh = await apiGet('getAll', {}, 3);
    if (fresh && fresh.success) {
      relationships = (fresh.relationships || []).filter(r => r.relationship_id && r.parent_id && r.child_id && r.rel_type);
      const landed = relationships.find(r =>
        String(r.parent_id) === String(parentId) &&
        String(r.child_id) === String(childId) &&
        String(r.rel_type) === String(relType));
      if (landed) return { success: true, landed: true, relationship_id: landed.relationship_id };
    }
  } catch (e) { /* keep going to a single retry */ }

  // Not present anywhere: a plain request failure. Safe to retry once.
  try {
    res = await apiPost(payload, 1);
  } catch (e) {
    res = null;
  }
  return (res && res.success)
    ? { success: true, relationship_id: res.relationship_id }
    : { success: false, error: (res && res.error) || 'Link failed (network).' };
}

async function deleteRelationshipSafe(relId) {
  const payload = { action: 'deleteRelationship', relationship_id: relId };
  let res = null;
  try { res = await apiPost(payload, 1); } catch (e) { res = null; }
  if (res && res.success) return { success: true };
  // 404 / "not found" either way means it is gone already — that is success for
  // a delete. Re-check the server to tell an executed delete from a real error.
  try {
    const fresh = await apiGet('getAll', {}, 3);
    if (fresh && fresh.success) {
      relationships = (fresh.relationships || []).filter(r => r.relationship_id && r.parent_id && r.child_id && r.rel_type);
      if (!relationships.some(r => String(r.relationship_id) === String(relId))) return { success: true, gone: true };
    }
  } catch (e) { /* fall through */ }
  return { success: false, error: (res && res.error) || 'Delete failed (network).' };
}

async function deletePersonSafe(personId) {
  const payload = { action: 'deletePerson', person_id: personId };
  let res = null;
  try { res = await apiPost(payload, 1); } catch (e) { res = null; }
  if (res && res.success) return { success: true };
  try {
    const fresh = await apiGet('getAll', {}, 3);
    if (fresh && fresh.success) {
      persons = (fresh.persons || []).filter(p => p.person_id && (p.gikuyu_name || p.fathers_name));
      relationships = (fresh.relationships || []).filter(r => r.relationship_id && r.parent_id && r.child_id && r.rel_type);
      if (!persons.some(p => String(p.person_id) === String(personId))) return { success: true, gone: true };
    }
  } catch (e) { /* fall through */ }
  return { success: false, error: (res && res.error) || 'Delete failed (network).' };
}

// ============================================================
// Undo (last operation, repeatable)
// ============================================================
// A small stack of undo closures. Every write path pushes an entry immediately
// BEFORE the mutation so the reverse can always run against fresh server state.
// Each entry carries both an undo and a redo closure so undone work can be re-applied.
let undoStack = [];
let redoStack = [];
const UNDO_LIMIT = 20;

function pushUndo(label, undoFn, redoFn) {
  undoStack.push({ label: label, undo: undoFn, redo: redoFn || null });
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  // A brand-new action invalidates any pending redo history.
  redoStack = [];
  renderUndoBtn();
}

function renderUndoBtn() {
  const btn = document.getElementById('undo-btn');
  const rbtn = document.getElementById('redo-btn');
  const top = undoStack[undoStack.length - 1];
  const rtop = redoStack[redoStack.length - 1];
  if (btn) {
    if (top) {
      btn.style.display = '';
      btn.classList.add('undo-available');
      btn.textContent = '↩ ' + top.label;
      btn.title = 'Undo the most recent change (' + top.label + ')';
    } else {
      btn.style.display = 'none';
      btn.classList.remove('undo-available');
    }
  }
  if (rbtn) {
    if (rtop && typeof rtop.redo === 'function') {
      rbtn.style.display = '';
      rbtn.classList.add('undo-available');
      rbtn.textContent = '↪ ' + rtop.label;
      rbtn.title = 'Redo the most recent change (' + rtop.label + ')';
    } else {
      rbtn.style.display = 'none';
      rbtn.classList.remove('undo-available');
    }
  }
}

async function performUndo() {
  const entry = undoStack.pop();
  renderUndoBtn();
  if (!entry) { showToast('Nothing to undo'); return; }
  showToast('Undoing: ' + entry.label + '…');
  try {
    await entry.undo();
    if (typeof entry.redo === 'function') {
      redoStack.push(entry);
      if (redoStack.length > UNDO_LIMIT) redoStack.shift();
    }
    renderUndoBtn();
    showToast('Undone: ' + entry.label);
  } catch (e) {
    showToast('Undo failed: ' + (e && e.message ? e.message : 'Unknown error'));
  }
  await loadData();
}

async function performRedo() {
  const entry = redoStack[redoStack.length - 1];
  if (!entry) { showToast('Nothing to redo'); return; }
  if (typeof entry.redo !== 'function') { showToast('Nothing to redo'); return; }
  redoStack.pop();
  renderUndoBtn();
  showToast('Redoing: ' + entry.label + '…');
  try {
    await entry.redo();
    undoStack.push(entry);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    renderUndoBtn();
    showToast('Redone: ' + entry.label);
  } catch (e) {
    showToast('Redo failed: ' + (e && e.message ? e.message : 'Unknown error'));
  }
  await loadData();
}

// All editable person fields, used to restore a record after an edit is undone.
function personUpdatePayload(person) {
  const p = person || {};
  return {
    gikuyu_name: p.gikuyu_name || '',
    fathers_name: p.fathers_name || '',
    other_names: p.other_names || '',
    gender: p.gender || 'Male',
    is_living: (p.is_living === undefined || p.is_living === '' || p.is_living === null) ? true : p.is_living,
    birth_year: p.birth_year || '',
    death_year: p.death_year || '',
    place_of_birth: p.place_of_birth || '',
    place_of_living: p.place_of_living || '',
    place_of_death: p.place_of_death || '',
    birth_qualifier: p.birth_qualifier || 'exact',
    birth_month: p.birth_month || '',
    birth_day: p.birth_day || '',
    death_qualifier: p.death_qualifier || 'exact',
    death_month: p.death_month || '',
    death_day: p.death_day || ''
  };
}

// ============================================================
// Change Photo (avatar header + Actions tab)
// ============================================================
let photoChangeTarget = null;
let photoChangePending = false;

function changePhotoFromAvatar() {
  if (!dashboardPerson) return;
  photoChangeTarget = dashboardPerson;
  const input = document.getElementById('avatar-photo-input');
  if (input) {
    input.value = '';
    photoChangePending = true;
    input.click();
  }
}

function handleAvatarPhotoSelect(input) {
  if (input.files && input.files[0] && /^image\//i.test(input.files[0].type)) {
    handlePhotoSelect(input, 'avatar-photo-preview');
  } else {
    photoChangePending = false;
    input.value = '';
  }
}

async function commitAvatarPhoto(input) {
  const person = photoChangeTarget || dashboardPerson;
  photoChangeTarget = null;
  photoChangePending = false;
  if (!person || !input || !input.dataset.croppedDataUrl) return;
  const prevUrl = person.photo_url || '';
  const base64 = input.dataset.croppedDataUrl;
  const mime = input.dataset.croppedMime || 'image/jpeg';
  showToast('Saving photo…');
  const res = await apiPost(Object.assign({ action: 'updatePerson', person_id: person.person_id, base64Image: base64, mimeType: mime }));
  showToast(res && res.success ? 'Photo updated' : 'Error: ' + ((res && res.error) || ''));
  if (res && res.success) {
    const pid = person.person_id;
    const name = shortName(person) || 'person';
    pushUndo('Change photo: ' + name, async () => {
      const restore = Object.assign({ action: 'updatePerson', person_id: pid }, prevUrl ? { photo_url: prevUrl } : { photo_url: '' });
      const r = await apiPost(restore);
      if (!r || !r.success) throw new Error((r && r.error) || 'Could not restore photo');
    }, async () => {
      const redo = Object.assign({ action: 'updatePerson', person_id: pid, base64Image: base64, mimeType: mime });
      const r = await apiPost(redo);
      if (!r || !r.success) throw new Error((r && r.error) || 'Could not redo photo');
    });
  }
  await loadData();
  const fresh = persons.find(p => p.person_id === person.person_id) || person;
  dashboardPerson = fresh;
  renderInfoDashboard(fresh);
}

// ============================================================
// Data Loading
// ============================================================
async function loadData() {
  // Warm the anonymous Apps Script session: the very first request from a
  // fresh browser session performs a redirect/cookie handshake (a 404 or a
  // stalled hop), retried by the timeout in apiGet until it succeeds.
  if (loadStatusEl) loadStatusEl.textContent = 'Connecting to data…';
  if (retryBtnEl) retryBtnEl.style.display = 'none';
  try { await apiGet('init'); } catch (e) { /* best-effort warm-up */ }
  if (!schemaReady) {
    localStorage.setItem('wanganga_schema_ok', '1');
    schemaReady = true;
  }

  // Auto-retry the actual fetch: the anonymous handshake can still 404 or
  // stall on the very first trip, so keep trying until data really arrives or
  // the user cancels via the Retry button.
  const MAX_LOAD_TRIES = 8;
  let data = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_LOAD_TRIES && !data; attempt++) {
    if (loadStatusEl) loadStatusEl.textContent = 'Attempt ' + attempt + ' of ' + MAX_LOAD_TRIES + '…';
    try {
      data = await apiGet('getAll');
      if (data && data.success) break;
      data = null; // success:false -> treat as a failed attempt, keep retrying
      lastErr = (data && data.error) || 'Unknown';
    } catch (e) {
      lastErr = e;
      data = null;
      if (attempt < MAX_LOAD_TRIES) await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (!data || !data.success) {
    if (loadStatusEl) loadStatusEl.textContent = 'Could not load the family tree.';
    if (retryBtnEl) retryBtnEl.style.display = 'inline-block';
    showToast('Could not load the family data. Tap Retry below, or refresh.');
    return;
  }
  persons = (data.persons || []).filter(p => p.person_id && (p.gikuyu_name || p.fathers_name));
  relationships = (data.relationships || []).filter(r => r.relationship_id && r.parent_id && r.child_id && r.rel_type);
  if (loadStatusEl) loadStatusEl.textContent = '';
  renderTree();
  // Visitor logging: fire-and-forget, done after a successful load so the
  // first-view handshake never makes logging the thing that blanks the tree.
  logVisitorEvent('visit');
  maybeResolveLocation();
}

const loadStatusEl = document.getElementById('load-status');
const retryBtnEl = document.getElementById('load-retry-btn');
function retryDataLoad() {
  if (retryBtnEl) retryBtnEl.style.display = 'none';
  loadData();
}

// ============================================================
// Helpers
// ============================================================
function isMaleGender(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'male' || s === 'm';
}
function isFemaleGender(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === 'female' || s === 'f';
}
function genderOf(personId) {
  const p = getPerson(personId);
  return p ? String(p.gender || '').trim() : '';
}

// The sheet allows Spouse rows in either direction; only the Male-must-be-parent
// convention keeps the hub stable. Rows written reversed (woman as parent) would
// mark the HUSBAND as a "wife" and un-route his whole cluster, so every spouse
// row is re-oriented here by gender before it feeds the layout. Duplicate
// reversed mirror rows (same unordered pair) are collapsed to one entry.
function buildSpouseMaps() {
  const spouseOf = {};
  const spousesOf = {};
  const primaryOf = {};
  const seen = new Set();
  relationships.forEach(r => {
    if (!(r.rel_type && String(r.rel_type).toLowerCase() === 'spouse')) return;
    let a = r.parent_id, b = r.child_id;
    const ga = genderOf(a), gb = genderOf(b);
    if (isFemaleGender(ga) && isMaleGender(gb)) { const t = a; a = b; b = t; }
    const key = [a, b].sort().join('|');
    if (seen.has(key)) return;
    seen.add(key);
    spouseOf[a] = b;
    if (!spousesOf[a]) spousesOf[a] = [];
    spousesOf[a].push(b);
    primaryOf[b] = a;
  });
  return { spouseOf, spousesOf, primaryOf };
}

// Get all spouses of a person (both directions)
function getAllSpouses(personId) {
  const { spousesOf, primaryOf } = buildSpouseMaps();
  const spouses = new Set();
  // Direct spouses (person is parent_id in spouse relationship)
  if (spousesOf[personId]) {
    spousesOf[personId].forEach(id => spouses.add(id));
  }
  // Reverse spouses (person is child_id in spouse relationship)
  Object.keys(spousesOf).forEach(parentId => {
    if (spousesOf[parentId].includes(personId)) {
      spouses.add(parentId);
    }
  });
  // Also follow primaryOf chain to get all spouses in polygamous cluster
  let cur = personId;
  const seen = new Set();
  while (primaryOf[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = primaryOf[cur];
  }
  // cur is now the primary anchor
  if (spousesOf[cur]) {
    spousesOf[cur].forEach(id => spouses.add(id));
  }
  return Array.from(spouses);
}

// Get all parents of a person (both father and mother)
function getAllParents(childId) {
  return relationships
    .filter(r => r.child_id === childId && /father|mother/i.test(r.rel_type || ''))
    .map(r => ({ parentId: r.parent_id, relType: r.rel_type }));
}

// Follows the spouse-primary chain so a spouse-of-a-spouse always resolves to
// the person who actually owns the tree-node cluster. Every spouse pair must
// render from (and be keyed on) this anchor or the partner is orphaned.
function resolvePrimaryAnchor(personId) {
  const { primaryOf } = buildSpouseMaps();
  let cur = personId;
  const seen = new Set();
  while (primaryOf[cur] && !seen.has(cur)) {
    seen.add(cur);
    cur = primaryOf[cur];
  }
  return cur;
}

function getPerson(pid) {
  return persons.find(p => p.person_id === pid) || null;
}

function isDeceased(p) {
  if (!p) return false;
  const living = (p.is_living === true || p.is_living === 'TRUE' || p.is_living === 'True');
  return !living || (p.death_year && String(p.death_year).trim() !== '');
}

function fullName(p) {
  if (!p) return '';
  const g = (p.gikuyu_name || '').trim();
  const f = (p.fathers_name || '').trim();
  let s = g;
  if (f) s += (s ? ' wa ' : '') + f;
  if (p.other_names) s += ' ' + String(p.other_names).trim();
  return s.replace(/\s+/g, ' ').trim();
}

// Short name: Gikuyu name + wa father's name, without the extra third name
// (baptism/other names such as Mary, Daniel, Kahata, Jay). Used by summaries.
function shortName(p) {
  if (!p) return '';
  const g = (p.gikuyu_name || '').trim();
  const f = (p.fathers_name || '').trim();
  let s = g;
  if (f) s += (s ? ' wa ' : '') + f;
  return s.replace(/\s+/g, ' ').trim();
}

// ============================================================
// Build Tree Hierarchy
// ============================================================
function buildHierarchy() {
  const personMap = {};
  persons.forEach(p => personMap[p.person_id] = Object.assign({}, p, { children: [], isWife: false }));

  const { primaryOf, spousesOf } = buildSpouseMaps();

  // Biological mothers / fathers from the raw relationship rows.
  const motherOf = {};
  const fatherOf = {};
  relationships.forEach(r => {
    if (!r.rel_type) return;
    if (/mother/i.test(r.rel_type)) motherOf[r.child_id] = r.parent_id;
    else if (/father/i.test(r.rel_type)) fatherOf[r.child_id] = r.parent_id;
  });

  // People recorded as the "child" side of a Spouse row are partners (wives in
  // the polygynous model). They render as a horizontal node beside their key
  // partner and are never charted as a child of their own parents.
  Object.keys(primaryOf).forEach(w => {
    if (personMap[w]) personMap[w].isWife = true;
  });

  // Tally how many wives each man's head node points to.
  const wifeCountOf = {};
  Object.keys(spousesOf).forEach(h => { wifeCountOf[h] = spousesOf[h].length; });

  // Decide where each non-wife person hangs:
  //   - One wife:         the child springs from the UNION (hangs below the
  //                       couple), so all of the man's children drop from a
  //                       single line between him and his wife.
  //   - Two+ wives:       the child springs from the SPECIFIC MOTHER, so the
  //                       half-siblings cluster under their own mother's box.
  //   - Mother only / unknown father's wives: fall back to that parent.
  const attachUnder = {};
  persons.forEach(p => {
    const pid = p.person_id;
    if (personMap[pid].isWife) return;
    const momRaw = motherOf[pid];
    const dadRaw = fatherOf[pid];
    const mom = (momRaw && personMap[momRaw]) ? momRaw : null;
    const dad = (dadRaw && personMap[(primaryOf[dadRaw] || dadRaw)]) ? (primaryOf[dadRaw] || dadRaw) : null;

    if (dad && mom) {
      const dadIsMan = !personMap[dad].isWife;
      attachUnder[pid] = (dadIsMan && (wifeCountOf[dad] || 0) > 1) ? mom : dad;
      return;
    }
    if (dad) { attachUnder[pid] = dad; return; }
    if (mom) {
      // Child known only through the mother. If she is the SOLE wife of her key
      // husband, the child belongs to the couple and must hang under the man so
      // it springs from the single-wife union bar (no explicit Father-Child
      // record required).
      const hus = primaryOf[mom];
      if (hus && hus !== mom && personMap[hus] && !personMap[hus].isWife &&
          (wifeCountOf[hus] || 0) === 1) {
        attachUnder[pid] = hus;
        return;
      }
      attachUnder[pid] = mom;
    }
  });

  const hasParentLink = id => !!(motherOf[id] || fatherOf[id]);

  // SYMMETRIC FOLD. The fold runs for the WHOLE household (wife + their
  // children), always anchoring it to whichever partner carries a parent link,
  // so a family renders inside its grandparent's umbrella instead of floating
  // as a disconnected tree. (The anchor person's own parent link is enough;
  // the folded spouse is attached as the child, so no one is duplicated.)
  //
  // Direction A: a husband/fatherless man folds under his wife's parent.
  Object.keys(spousesOf).forEach(headId => {
    const head = personMap[headId];
    if (!head || head.isWife) return;
    if (attachUnder[headId]) return; // already has parents of his own
    const wifeId = (spousesOf[headId] || []).find(w => {
      const wife = personMap[w];
      return wife && (motherOf[w] || fatherOf[w]);
    });
    if (!wifeId) return;
    const wifeDad = (fatherOf[wifeId] && personMap[fatherOf[wifeId]]) ? fatherOf[wifeId] : null;
    const wifeMom = (motherOf[wifeId] && personMap[motherOf[wifeId]]) ? motherOf[wifeId] : null;
    const parentId = wifeDad || wifeMom;
    if (!parentId || !personMap[parentId]) return;
    const parent = personMap[parentId];
    if (parent.isWife) return;
    attachUnder[headId] = parentId;
  });

  // Direction B: a fatherless woman (no parents of her own) folds under her
  // husband when he holds a parent branch, so her kids anchor to her in-laws'
  // umbrella. (The wife already renders beside her husband; the explicit
  // attach keeps the rule symmetric for any future parentless bride.)
  Object.keys(primaryOf).forEach(wifeId => {
    const wife = personMap[wifeId];
    if (!wife || !wife.isWife) return;
    if (attachUnder[wifeId]) return;
    if (hasParentLink(wifeId)) return; // has parents of her own
    const husId = primaryOf[wifeId];
    if (husId === wifeId) return;
    const hus = personMap[husId];
    if (!hus || hus.isWife) return;
    if (!(attachUnder[husId] || hasParentLink(husId))) return; // husband has no branch either
    attachUnder[wifeId] = husId;
  });

  // Wives become child nodes of their key partner (positioned horizontally
  // beside them by the layout pass). Each wife keeps her own children.
  Object.entries(spousesOf).forEach(([headId, partners]) => {
    const head = personMap[headId];
    if (!head || head.isWife) return;
    (partners || []).forEach(w => {
      const spouse = personMap[w];
      if (!spouse) return;
      if (attachUnder[w]) return; // already belongs to a parent branch
      head.children.push(spouse);
    });
  });

  // Attach every child under its resolved parent (mother by default).
  Object.entries(attachUnder).forEach(([childId, parentId]) => {
    const child = personMap[childId];
    const parent = personMap[parentId];
    if (!child || !parent || child === parent) return;
    parent.children.push(child);
  });

  // Manual wife-order overrides: for a man whose wives' own layout (column
  // order = wife entry order) is not the desired left->right order listed
  // here, re-sort his wife children without touching his own kids.
  const WIFE_ORDER = {
    // Wang'ang'a wa Kĩnyanjui: Karira (7 kids) far left, Warĩnga & Wanjũhĩ
    // (kidless) in the middle, Wanjirũ (3 kids) far right.
    '7fc20e59-737f-41e3-8dd5-c4550a676041': [
      '0d27fe93-d133-4554-a0a3-44702d08022d', // Karira wa Gĩcũrũ
      'c4a620d3-344f-411c-b62c-82f39cb7725f', // Warĩnga wa Nyũmba
      'f2aecb60-d3cb-443f-b862-b261626f99fb', // Wanjũhĩ wa Njamba
      '8cfbb7a2-da77-413a-9c27-c06daef1a66c', // Wanjirũ wa Gĩthiaka
    ],
  };
  Object.keys(WIFE_ORDER).forEach(headId => {
    const head = personMap[headId];
    if (!head) return;
    const order = WIFE_ORDER[headId];
    const rank = {};
    order.forEach((id, i) => rank[id] = i);
    head.children.sort((a, b) => {
      const ra = rank[a.person_id];
      const rb = rank[b.person_id];
      if (ra !== undefined && rb !== undefined) return ra - rb;
      return 0;
    });
  });

  const childIds = new Set(Object.keys(attachUnder));

  const roots = persons
    .filter(p => !childIds.has(p.person_id) && !personMap[p.person_id].isWife)
    .map(p => personMap[p.person_id]);

  if (roots.length === 0) return null;
  if (roots.length > 1) {
    return {
      person_id: '__virtual__', gikuyu_name: 'Family', fathers_name: 'Tree',
      other_names: '', gender: 'Male', is_living: true,
      children: roots
    };
  }
  return roots[0];
}

// ============================================================
// Custom Polygynous Layout (subtree bounding boxes, horizontal wives)
// ============================================================
// Replaces the rigid d3.tree pass. Every family is a block whose width grows
// with the man's wives and, recursively, with every descendant sub-tree.
// Sibling blocks are pushed apart horizontally by their TRUE bounding boxes,
// so a third/fourth-generation marriage automatically widens its row and
// shifts the neighbours right instead of squeezing a vertical stack.
//
// Rows are TRUE generations: the man and all his wives share ONE horizontal
// row, and his children — each wife's own cluster included — always hang
// exactly one row below. Two passes guarantee this at any depth:
//   measure(): subtree width, bottom-up;
//   place():   absolute x/y, top-down (never overwritten by a parent).
function layoutFamilyTree(hierarchyRoot, rowSpace) {
  const AVATAR_W = 96;
  const labelWidth = (p) => {
    if (!p) return AVATAR_W;
    const name = ((p.gikuyu_name || '') + (p.fathers_name ? ' wa ' + p.fathers_name : '')).trim();
    return Math.max(AVATAR_W, 30 + name.length * 7.6);
  };
  const MAN_WIFE_GAP = 30;
  const SIB_GAP = 56;

  // Heads that get the special "hub" layout: the man sits EXACTLY at the
  // midpoint of his marriage fan (equidistant from the two outer wives) and
  // his kidless wives hug him on either side.
  const HUB_MIDPOINTS = new Set(['7fc20e59-737f-41e3-8dd5-c4550a676041']);

  // Snapshot of one head's own fan: his wives and the ordered list of
  // children columns (his own kids first, then each wife's kids underneath).
  function snapshot(headNode) {
    const wives = (headNode.children || []).filter(c => c.data && c.data.isWife);
    const kids = (headNode.children || []).filter(c => !(c.data && c.data.isWife));
    const columns = [];
    kids.forEach(k => columns.push({ parent: headNode, kid: k }));
    wives.forEach(w => { (w.children || []).forEach(k => columns.push({ parent: w, kid: k })); });
    return { head: headNode, wives: wives, columns: columns };
  }

  // A "union" head = exactly one wife, and every child hangs from the couple
  // (single-wife men). Children sprout from the couple's midpoint (the middle
  // of the dotted bar), so the couple is laid out first and the children are
  // centred under that sprouting point.
  function isUnionHead(snap) {
    return snap.wives.length === 1 &&
      !snap.columns.some(c => c.parent === snap.wives[0]) &&
      snap.columns.some(c => c.parent === snap.head);
  }

  // Hub-head positions, all relative to the block start: children columns run
  // from it, wives-with-kids sit over their own child blocks, the man is placed
  // EXACTLY in the middle of the marriage row (his distance to the leftmost and
  // rightmost wife is identical), and his kidless wives hug him on either side.
  // Returns null when there is no anchored wife to centre between.
  function hubFan(snap, kidWs) {
    const headW = labelWidth(snap.head.data);
    const colStarts = [0];
    for (let i = 1; i < kidWs.length; i++) colStarts.push(colStarts[i - 1] + kidWs[i - 1] + SIB_GAP);
    const anchored = [];
    const kidless = [];
    snap.wives.forEach(w => {
      const wIdx = [];
      snap.columns.forEach((c, i) => { if (c.parent === w) wIdx.push(i); });
      const ww = labelWidth(w.data);
      if (wIdx.length) {
        const span = wIdx.reduce((s, idx, j) => s + kidWs[idx] + (j ? SIB_GAP : 0), 0);
        anchored.push({ w, x: colStarts[wIdx[0]] + span / 2, ww });
      } else {
        kidless.push({ w, ww, x: 0 });
      }
    });
    if (!anchored.length) return null;
    const minX = Math.min.apply(null, anchored.map(a => a.x));
    const maxX = Math.max.apply(null, anchored.map(a => a.x));
    const manX = (minX + maxX) / 2;
    let side = -1;
    kidless.forEach(k => {
      k.x = manX + side * (headW / 2 + MAN_WIFE_GAP + k.ww / 2);
      side = -side;
    });
    return { manX, wives: anchored.concat(kidless) };
  }

  // Bottom-up: the exact horizontal span this subtree occupies.
  // Offsets are measured from the MAN's centre (he sits at x=0 here); the
  // returned width is translation-invariant, so it also works top-down.
  function measure(snap) {
    const kidWs = snap.columns.map(c => measure(snapshot(c.kid)));
    const kidsSpan = kidWs.reduce((s, w) => s + w, 0) + SIB_GAP * Math.max(0, kidWs.length - 1);
    const headW = labelWidth(snap.head.data);

    if (isUnionHead(snap)) {
      const ww = labelWidth(snap.wives[0].data);
      const U = headW / 4 + MAN_WIFE_GAP / 2 + ww / 4;              // sprout point
      const left = Math.min(-headW / 2, U - kidsSpan / 2);          // block start
      const right = Math.max(headW / 2 + MAN_WIFE_GAP + ww, U + kidsSpan / 2);
      return Math.max(1, right - left);
    }

    // Hub heads: man-centred marriage fan (see hubFan). The man sits exactly in
    // the middle of his fan; the block is widened to be SYMMETRIC around him
    // (left edge at the block start) so his father, who centres over this whole
    // subtree, lands directly above him. Falls back to the content width if the
    // fan is too wide to stay symmetric.
    if (HUB_MIDPOINTS.has(snap.head.data.person_id)) {
      const fan = hubFan(snap, kidWs);
      if (fan) {
        let left = 0, right = kidsSpan;
        left = Math.min(left, fan.manX - headW / 2);
        right = Math.max(right, fan.manX + headW / 2);
        fan.wives.forEach(v => {
          left = Math.min(left, v.x - v.ww / 2);
          right = Math.max(right, v.x + v.ww / 2);
        });
        const half = Math.max(fan.manX - left, right - fan.manX);
        return Math.max(1, Math.max(2 * half, right));
      }
    }

    // General (2+ wives, mother-sprout, or leaf): children run from the block
    // start; the man centres over his own direct children (or floats left),
    // then his wives trail right of him.
    const wRow = snap.wives.reduce((s, w) => s + MAN_WIFE_GAP + labelWidth(w.data), headW);
    let manCenter = 0;
    let ownBlock = 0;
    snap.columns.forEach((c, i) => {
      if (c.parent === snap.head) ownBlock += kidWs[i] + (ownBlock ? SIB_GAP : 0);
    });
    if (ownBlock) manCenter = ownBlock / 2;
    return Math.max(kidsSpan, manCenter + wRow);
  }
  const rootSnap = snapshot(hierarchyRoot);
  const rootWidth = measure(rootSnap);

  // Top-down: parents hand each child a LEFT BOUND (never a centre), so every
  // node computes its own final x/y exactly once and can never be overwritten.
  function place(snap, topY, leftBound) {
    const kidWs = snap.columns.map(c => measure(snapshot(c.kid)));
    const headW = labelWidth(snap.head.data);

    if (isUnionHead(snap)) {
      const ww = labelWidth(snap.wives[0].data);
      const kidsSpan = kidWs.reduce((s, w) => s + w, 0) + SIB_GAP * Math.max(0, kidWs.length - 1);
      const U = headW / 4 + MAN_WIFE_GAP / 2 + ww / 4;              // sprout offset
      const left = Math.min(-headW / 2, U - kidsSpan / 2);
      const manX = leftBound - left;                                // man at x=0 <- left
      const wifeX = manX + headW / 2 + MAN_WIFE_GAP + ww / 2;
      snap.head.x = manX;
      snap.head.y = topY;
      snap.wives[0].x = wifeX;
      snap.wives[0].y = topY;
      snap.head._unionX = (manX + wifeX) / 2;                       // sprout from the bar

      let cursor = snap.head._unionX - kidsSpan / 2;
      snap.columns.forEach((c, i) => {
        place(snapshot(c.kid), topY + rowSpace, cursor);
        cursor += kidWs[i] + SIB_GAP;
      });
      return;
    }

    // Hub heads: children run from the block start; wives-with-kids sit over
    // their blocks, the man exactly midway in the fan, kidless wives on his
    // flanks (see hubFan).
    if (HUB_MIDPOINTS.has(snap.head.data.person_id)) {
      const fan = hubFan(snap, kidWs);
      if (fan) {
        let cursor = leftBound;
        snap.columns.forEach((c, i) => {
          place(snapshot(c.kid), topY + rowSpace, cursor);
          cursor += kidWs[i] + SIB_GAP;
        });
        fan.wives.forEach(v => { v.w.x = leftBound + v.x; v.w.y = topY; });
        snap.head.x = leftBound + fan.manX;
        snap.head.y = topY;
        return;
      }
    }

    // General branch: children in one row under their (seated) parent.
    let cursor = leftBound;
    snap.columns.forEach((c, i) => {
      place(snapshot(c.kid), topY + rowSpace, cursor);
      cursor += kidWs[i] + SIB_GAP;
    });

    // The man centres over his own direct children (or floats left; his widowed
    // fathers fan their kidless wives to the right).
    let manCenter = 0;
    let ownBlock = 0;
    snap.columns.forEach((c, i) => {
      if (c.parent === snap.head) ownBlock += kidWs[i] + (ownBlock ? SIB_GAP : 0);
    });
    if (ownBlock) manCenter = ownBlock / 2;
    const manX = leftBound + manCenter;
    snap.head.x = manX;
    snap.head.y = topY;
    let rowRight = manX + headW / 2;

    // Wives sit horizontally beside the man, each above her own children.
    snap.wives.forEach(w => {
      const wIdx = [];
      snap.columns.forEach((c, i) => { if (c.parent === w) wIdx.push(i); });
      const ww = labelWidth(w.data);
      let wx;
      if (wIdx.length) {
        const span = wIdx.reduce((s, idx, j) => s + kidWs[idx] + (j ? SIB_GAP : 0), 0);
        let blockStart = leftBound;
        for (let j = 0; j < wIdx[0]; j++) blockStart += kidWs[j] + SIB_GAP;
        wx = blockStart + span / 2;
      } else {
        wx = rowRight + MAN_WIFE_GAP + ww / 2;
      }
      wx = Math.max(wx, rowRight + MAN_WIFE_GAP / 2 + ww / 2);
      w.x = wx;
      w.y = topY;
      rowRight = Math.max(rowRight, wx + ww / 2);
    });
  }

  place(rootSnap, 0, 0, rootWidth);
}

// ============================================================
// SVG Defs (grayscale color matrix for the deceased)
// ============================================================
function addDefs(svg) {
  const defs = svg.append('defs');
  const filter = defs.append('filter').attr('id', 'deceasedFilter');
  filter.append('feColorMatrix').attr('type', 'saturate').attr('values', '0');
}

// ============================================================
// Avatar / Silhouette rendering
// ============================================================
function drawSilhouette(group, isFemale, scale) {
  const s = group.append('g').attr('transform', 'scale(' + (scale || 1) + ')').attr('opacity', 0.92).attr('fill', '#0f172a');
  if (isFemale) {
    s.append('circle').attr('cy', -9).attr('r', 8);
    s.append('circle').attr('cx', 2).attr('cy', -15).attr('r', 3);
    s.append('path').attr('d', 'M -9 -4 C -10 2 -8 6 -5 8 C -3 4 0 2 2 2 C 4 4 6 6 7 7 C 9 2 9 -3 8 -8 Z');
    s.append('path').attr('d', 'M -9 16 C -9 4 -5 0 0 0 C 5 0 9 4 9 16 Z');
  } else {
    s.append('circle').attr('cy', -9).attr('r', 8);
    s.append('path').attr('d', 'M -11 16 C -11 6 -7 1 0 1 C 7 1 11 6 11 16 Z');
  }
}

// Converts native Google Drive preview / share / edit links into direct raw
// image streams (drive thumbnail endpoint) that render cross-origin. Anything
// that is already a direct stream or a non-Google URL is returned untouched.
function convertToDirectStreamUrl(inputUrl) {
  if (!inputUrl) return "";
  const url = String(inputUrl).trim();
  if (!url) return "";

  // Already a direct thumbnail / stream URL: keep it.
  if (/drive\.google\.com\/thumbnail\?id=/i.test(url) ||
      /drive\.googleusercontent\.com\//i.test(url) ||
      /drive\.google\.com\/uc\?export=view/i.test(url)) {
    return url;
  }

  // Native preview / share / edit links:
  //   https://drive.google.com/file/d/FILE_ID/view?usp=sharing
  //   https://drive.google.com/open?id=FILE_ID
  //   https://drive.google.com/uc?id=FILE_ID&export=download
  let fileId = (url.match(/\/d\/([a-zA-Z0-9_-]+)/) || [])[1];
  if (!fileId) fileId = (url.match(/[?&]id=([a-zA-Z0-9_-]+)/) || [])[1];
  if (fileId) {
    return "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w400";
  }

  return url;
}

function renderAvatar(g, p, cx, updatedId, r) {
  const deceased = isDeceased(p);
  const isFemale = (p.gender === 'Female' || p.gender === 'F');
  const fill = isFemale ? '#f97316' : '#0d9488';
  const stroke = deceased ? '#1c1917' : (isFemale ? '#ea580c' : '#0f766e');
  const imgUrl = convertToDirectStreamUrl(p.photo_url);
  const radius = r || 32;
  const clipR = radius - 3;

  const group = g.append('g')
    .attr('transform', 'translate(' + cx + ',0)')
    .style('cursor', 'pointer');

  // STRICT SINGLE-PATH RULE: one node circle may only render ONE state.
  const cid = 'clip_' + updatedId;
  g.append('clipPath').attr('id', cid)
    .append('circle').attr('r', clipR).attr('cx', cx).attr('cy', 0);

  if (imgUrl) {
    // PATH A: profile photo ONLY (circle-masked image inside a thin ring).
    group.append('circle')
      .attr('class', 'node-circle')
      .attr('r', radius)
      .attr('fill', 'transparent')
      .attr('stroke', stroke)
      .attr('stroke-width', deceased ? 4 : 3)
      .attr('filter', deceased ? 'url(#deceasedFilter)' : null);

    const photo = group.append('image')
      .attr('class', 'node-photo')
      .attr('href', imgUrl)
      .attr('x', cx - clipR).attr('y', -clipR)
      .attr('width', clipR * 2).attr('height', clipR * 2)
      .attr('preserveAspectRatio', 'xMidYMid slice')
      .attr('clip-path', 'url(#' + cid + ')')
      .attr('filter', deceased ? 'url(#deceasedFilter)' : null);

    // If the stream never resolves, swap the ring to the vector chip + silhouette
    // so a person never renders as duplicate/hollow circles.
    photo.on('error', function () {
      photo.remove();
      group.select('.node-circle')
        .attr('fill', fill)
        .attr('stroke', stroke)
        .attr('filter', deceased ? 'url(#deceasedFilter)' : null);
      drawSilhouette(group, isFemale, radius / 32);
    });
  } else {
    // PATH B: gender vector placeholder ONLY (empty photo_url).
    group.append('circle')
      .attr('class', 'node-circle')
      .attr('r', radius)
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', deceased ? 4 : 3)
      .attr('filter', deceased ? 'url(#deceasedFilter)' : null);
    drawSilhouette(group, isFemale, radius / 32);
  }

  group.on('click', (event) => {
    event.stopPropagation();
    if (Date.now() < suppressNodeClickUntil) return; // just finished a drag
    if (window.isOnboardingSelectionMode) {
      handleNodeClickDuringOnboarding(p);
    } else if (isViewOnly) {
      // View-only: show info panel (LifeStory) but no radial menu
      onNodeSelected(p, event);
    } else {
      showRadialMenu(event, p);
    }
  });

  group.on('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (isViewOnly) return; // No radial menu in view-only mode
    if (!window.isOnboardingSelectionMode) {
      showRadialMenu(event, p);
    }
  });

  return group;
}

function renderLabels(g, p, cx, r) {
  const dy = (r || 32) - 32; // labels ride out with a larger avatar
  const deceased = isDeceased(p);
  g.append('text')
    .attr('class', 'node-label')
    .attr('x', cx).attr('y', 52 + dy)
    .text(((p.gikuyu_name || '') + (p.fathers_name ? ' wa ' + p.fathers_name : '')).trim());
  g.append('text')
    .attr('class', 'node-sublabel')
    .attr('x', cx).attr('y', 66 + dy)
    .text(p.other_names || '');
  if (deceased && p.death_year) {
    g.append('text')
      .attr('class', 'deceased-year')
      .attr('x', cx).attr('y', 82 + dy)
      .text('\u2020 ' + p.death_year);
  }
}

// ============================================================
// Descendant-driven avatar sizing
// ============================================================
// A person's avatar grows with the size of the clan they founded: every
// descendant (children + grandchildren + …) adds to a soft-capped radius so a
// big patriarch reads instantly while a leaf stays at the base size.
function computeDescendantCounts() {
  const counts = {};
  const childrenOf = {};
  relationships.forEach(r => {
    const t = String(r.rel_type || '');
    if (!/father|mother/i.test(t)) return;
    (childrenOf[r.parent_id] = childrenOf[r.parent_id] || []).push(r.child_id);
  });
  function descendants(id, memo, seen) {
    if (memo[id] !== undefined) return memo[id];
    if (seen.has(id)) return 0; // corrupt-cycle guard
    seen.add(id);
    let total = 0;
    (childrenOf[id] || []).forEach(cid => {
      total += 1 + descendants(cid, memo, seen);
    });
    seen.delete(id);
    memo[id] = total;
    return total;
  }
  const memo = {};
  persons.forEach(p => { counts[p.person_id] = descendants(p.person_id, memo, new Set()); });
  return counts;
}

function avatarRadiusFor(descCount) {
  if (!descCount || descCount <= 0) return 32;
  // Soft cap: +13px of growth by ~17 descendants, asymptote just below 46.
  return Math.min(46, 32 + 13 * Math.min(1, Math.log2(1 + descCount) / Math.log2(17)));
}

// A couple shares ONE size: every spouse takes the strongest descendant total
// in the marriage, so both avatars grow together and a founding couple is
// always read as one unit (a childless wife next to a big patriarch no longer
// stays tiny).
function computeCoupleCounts() {
  const own = computeDescendantCounts();
  const counts = {};
  persons.forEach(p => {
    const members = [p.person_id, ...getAllSpouses(p.person_id)];
    let best = 0;
    members.forEach(id => { best = Math.max(best, own[id] || 0); });
    counts[p.person_id] = best;
  });
  return counts;
}

// ============================================================
// D3 Tree Rendering (horizontal spouses + photo + death styling)
// ============================================================
function renderTree() {
  const container = document.getElementById('tree-container');
  const width = container.clientWidth;
  const height = container.clientHeight;

  // Full frame reset so stale fallback icons/photos never persist between
  // renders (loadData, resize, or post-save redraws).
  d3.select('#tree-svg').selectAll('*').remove();

  const svg = d3.select('#tree-svg');
  addDefs(svg);
  svgGroup = svg.append('g');

  zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 4])
    .filter((event) => {
      const onNode = (event.target && typeof event.target.closest === 'function')
        ? event.target.closest('.node-group') : null;
      if (onNode) {
        if (event.type === 'mousedown' || event.type === 'pointerdown') return false;
      }
      return true;
    })
    .on('zoom', (e) => svgGroup.attr('transform', e.transform));
  svg.call(zoomBehavior);

  const root = buildHierarchy();
  if (!root) {
    svgGroup.append('text')
      .attr('x', width / 2).attr('y', height / 2)
      .attr('text-anchor', 'middle').attr('fill', '#94a3b8')
      .attr('font-size', 16)
      .text('No family members yet. Click "+ Add Person" to begin.');
    document.getElementById('loading').style.display = 'none';
    return;
  }

  const hierarchyRoot = d3.hierarchy(root);

  // Adaptive spacing: widen columns so long "Gikuyu wa Father" names never
  // crowd, and open the generation gap so labels don't collide between rows.
  let longestLabel = 12 * 7.2;
  persons.forEach(p => {
    const lbl = ((p.gikuyu_name || '') + ' wa ' + (p.fathers_name || '')).trim();
    longestLabel = Math.max(longestLabel, lbl.length * 7.2);
  });
  const rowSpace = Math.max(200, longestLabel / 3.5 + 130);

  // Congestion control: move every collapsed branch into _children so the
  // layout, links, and descendants skip it (standard d3 collapse pattern).
  hierarchyRoot.each(d => {
    if (d.children && d.children.length && collapsedClusters.has(d.data.person_id)) {
      d._children = d.children;
      d.children = null;
    }
  });

  // Polygynous bounding-box layout: wives on the husband's row, children one
  // row below, sibling sub-trees pushed apart by their real widths — at every
  // generation depth (replaces the rigid d3.tree + wife-snapping passes).
  layoutFamilyTree(hierarchyRoot, rowSpace);
  const nodes = hierarchyRoot.descendants();

  // Descendant-driven avatar sizing: count every child/grandchild/… once per
  // person, then give each couple a shared size (will render Radar to match).
  const descCounts = computeCoupleCounts();
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  nodes.forEach(n => {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  });

  const treeWidth = maxX - minX;
  const treeHeight = maxY - minY;
  const scale = Math.min(width / (treeWidth + 200), height / (treeHeight + 200), 1.2);
  const tx = width / 2 - (minX + maxX) / 2 * scale;
  const ty = height / 2 - (minY + maxY) / 2 * scale + 40;

  svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));

  svgGroup.selectAll('.link')
    .data(hierarchyRoot.links())
    .enter()
    .append('path')
    .attr('class', d => (Math.abs(d.source.y - d.target.y) < 2) ? 'link marriage' : 'link')
    .attr('d', d => {
      const rSrc = avatarRadiusFor(descCounts[d.source.data.person_id] || 0);
      const rTgt = avatarRadiusFor(descCounts[d.target.data.person_id] || 0);
      const sx = d.source.x;
      const sy = d.source.y + (d.source.data.person_id === '__virtual__' ? 16 : rSrc + 12);
      const tx = d.target.x;
      const ty = d.target.y - (rTgt + 12);

      // Marriage bar: wife lifted onto the key partner's row -> straight
      // horizontal line stretched between the two avatar rims.
      if (Math.abs(d.source.y - d.target.y) < 2) {
        const cy = d.source.y;
        const dir = tx >= sx ? 1 : -1;
        const off = Math.max(rSrc, rTgt) + 6;
        return 'M' + (sx + dir * off) + ',' + cy + ' L' + (tx - dir * off) + ',' + cy;
      }

      // Single-wife union: every child sprouts from the couple's midpoint —
      // the middle of the dotted marriage bar — then runs down to the child.
      if (d.source._unionX !== undefined) {
        const y0 = d.source.y + 12;
        const spineY = (y0 + ty) * 0.5;
        return 'M' + d.source._unionX + ',' + y0 +
               ' C' + d.source._unionX + ',' + spineY +
               ' ' + d.source._unionX + ',' + spineY +
               ' ' + tx + ',' + ty;
      }

      return 'M' + sx + ',' + sy +
             ' C' + sx + ',' + ((sy + ty) / 2) +
             ' ' + tx + ',' + ((sy + ty) / 2) +
             ' ' + tx + ',' + ty;
    });

  const attrs = { count: 0 };
  const nodeGroups = svgGroup.selectAll('.node-group')
    .data(nodes.filter(d => d.data.person_id !== '__virtual__'))
    .enter()
    .append('g')
    .attr('class', 'node-group')
    .attr('transform', d => 'translate(' + d.x + ',' + d.y + ')');

  nodeGroups.each(function(d) {
    const data = d.data;
    const g = d3.select(this);

    const pid1 = data.person_id.replace(/[^a-zA-Z0-9_-]/g, '') + '_' + (attrs.count++);
    const radius = avatarRadiusFor(descCounts[data.person_id] || 0);
    renderAvatar(g, data, 0, pid1, radius);
    renderLabels(g, data, 0, radius);

    if (!isDeceased(data)) {
      g.append('circle')
        .attr('class', 'living-dot')
        .attr('cx', radius - 8)
        .attr('cy', -(radius - 6))
        .attr('r', 6);
    }

    // Congestion toggle badge: appears on the avatar's bottom rim when this
    // cluster has a child branch. Shows "−" when the branch is in view (click
    // to collapse) and "+" when it is hidden (click to expand).
    const childTotal = (d.children ? d.children.length : 0) + (d._children ? d._children.length : 0);
    if (childTotal > 0) {
      const isCollapsed = !!(d._children && d._children.length);
      const badge = g.append('g')
        .attr('class', 'collapse-badge')
        .attr('transform', 'translate(' + Math.round(radius * 0.75) + ',' + Math.round(radius * 0.88) + ')')
        .style('cursor', 'pointer')
        .on('click', function(event) {
          event.stopPropagation();
          event.preventDefault();
          if (isCollapsed) collapsedClusters.delete(data.person_id);
          else collapsedClusters.add(data.person_id);
          renderTree();
        });
      badge.append('circle')
        .attr('r', 11)
        .attr('fill', isCollapsed ? '#f59e0b' : '#334155')
        .attr('stroke', '#ffffff')
        .attr('stroke-width', 2);
      badge.append('text')
        .attr('y', 4)
        .attr('text-anchor', 'middle')
        .attr('font-size', 14)
        .attr('font-weight', 700)
        .attr('fill', '#ffffff')
        .text(isCollapsed ? '+' : '\u2212');
      badge.append('title').text(isCollapsed ? 'Expand this branch' : 'Collapse this branch');
    }
  });

  // Drag a person node onto another to create a link (child / parent / spouse).
  // The dragged node rides along with the pointer; dropping on a different node
  // opens a chooser, and the link is written via the API on selection.
  const dragLink = d3.drag()
    .filter((event) => {
      // PC-only and admin-only: link nodes by dragging. Everyone else taps
      // (mobile) or clicks (desktop) to open the radial menu, which always works.
      if (!isSuperAdminLocal()) return false;
      if (event.pointerType === 'touch') return false;
      if (typeof event.type === 'string' && event.type.indexOf('touch') === 0) return false;
      return true;
    })
    .subject(d => ({ x: d.x, y: d.y }))
    .on('start', function(event, d) {
      suppressNodeClickUntil = 0;
      d3.select(this).raise().classed('drag-source', true);
      document.body.classList.add('drag-linking');
      event.sourceEvent.stopPropagation();
    })
    .on('drag', function(event, d) {
      d3.select(this).attr('transform', 'translate(' + event.x + ',' + event.y + ')');
      svgGroup.selectAll('.node-group.drag-target').classed('drag-target', false);
      const targetEl = findNodeGroupAt(event.sourceEvent);
      if (targetEl) {
        const td = d3.select(targetEl).datum();
        if (td && td.data && td.data.person_id !== d.data.person_id) {
          d3.select(targetEl).classed('drag-target', true);
        }
      }
    })
    .on('end', function(event, d) {
      const g = d3.select(this);
      g.classed('drag-source', false).attr('transform', 'translate(' + d.x + ',' + d.y + ')');
      svgGroup.selectAll('.node-group.drag-target').classed('drag-target', false);
      document.body.classList.remove('drag-linking');

      const moved = Math.abs(event.x - d.x) > 4 || Math.abs(event.y - d.y) > 4;
      const targetEl = moved ? findNodeGroupAt(event.sourceEvent) : null;
      if (targetEl) {
        const td = d3.select(targetEl).datum();
        if (td && td.data && td.data.person_id !== d.data.person_id) {
          openLinkMenu(d.data, td.data, event.sourceEvent);
        } else {
          showToast('Drop on a different person to link them.');
        }
      }
      suppressNodeClickUntil = Date.now() + 350;
    });
  nodeGroups.call(dragLink);

  document.getElementById('loading').style.display = 'none';
}

// ============================================================
// Radial Action Menu
// ============================================================
function showRadialMenu(event, nodeData) {
  selectedNode = nodeData;
  const menu = document.getElementById('radial-menu');
  menu.innerHTML = '<button class="radial-center" type="button" title="View Info &amp; LifeStory" onclick="radialInfoClick(event)">ℹ INFO</button>';

  const items = [
    { label: 'Add Parents', action: () => openAddPersonModal(nodeData, 'parent') },
    { label: 'Add Spouse', action: () => openAddPersonModal(nodeData, 'spouse') },
    { label: 'Add Child', action: () => openAddPersonModal(nodeData, 'child') }
  ];

  // "Add Sibling" only makes sense for someone who already has linked parents.
  const hasLinkedParents = relationships.some(r =>
    r.child_id === nodeData.person_id && /father|mother/i.test(r.rel_type || ''));
  if (hasLinkedParents) {
    items.push({ label: 'Add Sibling', action: () => openAddPersonModal(nodeData, 'sibling') });
  }

  items.push({ label: 'Link', action: () => openLinkModal(nodeData) });
  items.push({ label: 'Unlink', action: () => openUnlinkModal(nodeData) });

  // Edit/Delete are restricted to the record's creator unless the super-admin
  // has unlocked the Admin code.
  if (canManageRecord(nodeData)) {
    items.push({ label: 'Edit', action: () => openEditModal(nodeData) });
    items.push({ label: 'Delete', action: () => openDeleteModal(nodeData), danger: true });
  }

  const radius = 112;
  const startAngle = -Math.PI / 2;

  items.forEach((item, i) => {
    const angle = startAngle + (i / items.length) * 2 * Math.PI;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;

    const seg = document.createElement('div');
    seg.className = 'radial-segment' + (item.danger ? ' danger' : '');
    seg.textContent = item.label;
    seg.style.left = x + 'px';
    seg.style.top = y + 'px';
    seg.style.transitionDelay = (i * 30) + 'ms';
    seg.onclick = (e) => {
      e.stopPropagation();
      hideRadialMenu();
      item.action();
    };
    menu.appendChild(seg);
  });

  menu.style.left = event.clientX + 'px';
  menu.style.top = event.clientY + 'px';
  menu.style.display = 'block';
  setTimeout(() => menu.classList.add('active'), 10);
}

function hideRadialMenu() {
  const menu = document.getElementById('radial-menu');
  menu.classList.remove('active');
  setTimeout(() => { menu.style.display = 'none'; }, 200);
}

// Radial center "INFO" trigger: clicking the inner core launches the unified
// info drawer focused on the chronological LifeStory timeline summary.
function radialInfoClick(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const node = selectedNode;
  hideRadialMenu();
  if (node) {
    onNodeSelected(node, null);
    switchInfoTab('lifestory');
  }
}

document.addEventListener('click', () => hideRadialMenu());

// ============================================================
// Info Dashboard
// ============================================================
let dashboardPerson = null;

// Simple lifespan shown under the profile name: "1900 – 1997", "born 1950",
// "died 1940" or "dates unrecorded".
function yearsLivedLabel(person) {
  const b = parseInt(person.birth_year, 10);
  const d = parseInt(person.death_year, 10);
  const hasB = !isNaN(b);
  const hasD = !isNaN(d);
  if (hasB && hasD) return b + ' – ' + d;
  if (hasB) return String(person.is_living).toUpperCase() !== 'FALSE' ? 'born ' + b + ' (living)' : 'born ' + b;
  if (hasD) return 'died ' + d;
  return 'dates unrecorded';
}

// Unified node-selection flow: open the action panel shell, arm the action
// buttons, render the LifeStory feed, and run the permission mask.
function onNodeSelected(selectedPerson, event) {
  dashboardPerson = selectedPerson;
  renderInfoDashboard(selectedPerson);
  setupActionButtons(selectedPerson);
  openModal('info-modal');
  logVisitorEvent('click', shortName(selectedPerson), selectedPerson.person_id);
}

function renderInfoDashboard(person) {
  const counts = aggregateFamilyCounts(person.person_id, relationships, persons);
  const title = [person.gikuyu_name, person.fathers_name, person.other_names].filter(Boolean).join(' ');
  const imgUrl = convertToDirectStreamUrl(person.photo_url);

  const avatar = document.getElementById('info-avatar');
  avatar.innerHTML = '';
  const initial = escapeHtml(String(person.gikuyu_name || '?').charAt(0).toUpperCase());
  if (imgUrl) {
    const avatarImg = document.createElement('img');
    avatarImg.src = imgUrl;
    avatarImg.alt = title;
    avatarImg.onerror = () => { avatar.textContent = initial; };
    avatar.appendChild(avatarImg);
  } else {
    avatar.textContent = initial;
  }

  document.getElementById('info-name').textContent = title;
  document.getElementById('info-meta').innerHTML =
    escapeHtml(String(person.gender || '')) + ' &middot; ' + escapeHtml(yearsLivedLabel(person));

  document.getElementById('info-summary').innerHTML =
    '<div class="summary-label">Summary</div>' +
    '<div class="summary-text">' + escapeHtml(buildLifeSummary(person, counts)) + '</div>';

  document.getElementById('info-timeline').innerHTML = renderLifeStoryTimeline(person);
  populateResearchForm(person);

  switchInfoTab(isViewOnly ? 'lifestory' : 'actions');
}

// In view-only mode the sidebar shows a person's story but no editing: hide the
// Actions and Research tabs so the drawer is purely informational.
function applyViewOnlyPanel() {
  const a = document.getElementById('tab-actions');
  const r = document.getElementById('tab-research');
  if (a) a.style.display = isViewOnly ? 'none' : '';
  if (r) r.style.display = isViewOnly ? 'none' : '';
}

// Actionable baseline targets for the Actions tab (single source of triggers).
function setupActionButtons(person) {
  const sib = document.getElementById('act-sibling');
  if (sib) sib.style.display = hasLinkedParents(person) ? '' : 'none';
  const del = document.getElementById('act-delete');
  if (del) del.style.display = canManageRecord(person) ? '' : 'none';
  // Change Photo (Actions tab + avatar overlay) only for records the acting
  // user may edit; the backend ownership check would reject anyone else anyway.
  const cp = document.getElementById('act-change-photo');
  if (cp) cp.style.display = canManageRecord(person) ? '' : 'none';
  const cam = document.getElementById('avatar-change-btn');
  if (cam) cam.style.display = canManageRecord(person) && !isViewOnly ? '' : 'none';
}

function hasLinkedParents(person) {
  return relationships.some(r => r.child_id === person.person_id && r.rel_type !== 'Spouse');
}

function actionAddChild() { if (dashboardPerson) { closeModal('info-modal'); openAddPersonModal(dashboardPerson, 'child'); } }
function actionAddSibling() { if (dashboardPerson) { closeModal('info-modal'); openAddPersonModal(dashboardPerson, 'sibling'); } }
function actionAddSpouse() { if (dashboardPerson) { closeModal('info-modal'); openAddPersonModal(dashboardPerson, 'spouse'); } }
function actionEditResearch() { switchInfoTab('research'); }
function actionDeleteProfile() {
  if (!dashboardPerson) return;
  closeModal('info-modal');
  openDeleteModal(dashboardPerson);
}

// Join a small name list nicely: "A, B and C" (capped at 'cap' names, then
// "+N more").
function nameList(names, cap = 4) {
  const n = (names || []).filter(Boolean);
  if (!n.length) return '';
  if (n.length > cap) return n.slice(0, cap).join(', ') + ' +' + (n.length - cap) + ' more';
  if (n.length === 1) return n[0];
  return n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
}

// Narrative summary pulled from the live record (never persisted).
function buildLifeSummary(person, counts) {
  const birth = parseInt(person.birth_year, 10);
  const death = parseInt(person.death_year, 10);
  const alive = String(person.is_living).toUpperCase() !== 'FALSE';
  const name = [person.gikuyu_name, person.fathers_name].filter(Boolean).join(' ') || 'This person';
  const female = /female/i.test(String(person.gender || '')) || String(person.gender) === 'F';
  const he = female ? 'She' : 'He';
  const child = female ? 'daughter' : 'son';
  const verb = alive ? 'has' : 'had';

  const sentences = [];

  // 1) Birth.
  if (birth && !isNaN(birth)) {
    let b = name + ' was born ' + datePhrase(person.birth_year, person.birth_qualifier, person.birth_month, person.birth_day);
    if (person.place_of_birth) b += ' in ' + person.place_of_birth;
    sentences.push(b + '.');
  } else {
    sentences.push(name + ' was born in an unrecorded year.');
  }

  // 2) Parents.
  const parents = parentsOf(person.person_id);
  const father = parents.find(p2 => ['male', 'm'].indexOf(String(p2.gender || '').trim().toLowerCase()) !== -1);
  const mother = parents.find(p2 => ['female', 'f'].indexOf(String(p2.gender || '').trim().toLowerCase()) !== -1);
  if (father && mother) {
    sentences.push(he + (alive ? ' is ' : ' was ') + 'the ' + child + ' of ' + shortName(father) + ' and ' + shortName(mother) + '.');
  } else if (father) {
    sentences.push(he + (alive ? ' is ' : ' was ') + 'the ' + child + ' of ' + shortName(father) + '.');
  } else if (mother) {
    sentences.push(he + (alive ? ' is ' : ' was ') + 'the ' + child + ' of ' + shortName(mother) + '.');
  }

  // 3) Death or current residence / age.
  if (!alive && death && !isNaN(death)) {
    let d = he + ' passed away ' + datePhrase(person.death_year, person.death_qualifier, person.death_month, person.death_day);
    if (person.place_of_death) d += ' in ' + person.place_of_death;
    if (birth && !isNaN(birth) && death >= birth) d += ' at ' + (death - birth) + ' years of age';
    sentences.push(d + '.');
  } else if (alive && person.place_of_living) {
    sentences.push(he + ' currently resides in ' + person.place_of_living + ' and is ' +
      ((birth && !isNaN(birth)) ? new Date().getFullYear() - birth + ' years old' : 'alive to this day') + '.');
  } else if (alive && birth && !isNaN(birth)) {
    sentences.push(he + ' is ' + (new Date().getFullYear() - birth) + ' years old.');
  }

  // 4) Spouses, siblings and children (with a few names when the family is small).
  const clauses = [];
  if (counts.spousesList.length) {
    clauses.push('married to ' + nameList(counts.spousesList, 6));
  }
  if (counts.siblingCount) {
    clauses.push((alive ? 'has ' : 'had ') + counts.siblingCount + ' ' + (counts.siblingCount === 1 ? 'sibling' : 'siblings') +
      (counts.siblingCount <= 4 ? ' (' + nameList(counts.siblingNames) + ')' : ''));
  }
  if (counts.childrenCount) {
    clauses.push((alive ? 'has ' : 'had ') + counts.childrenCount + ' ' + (counts.childrenCount === 1 ? 'child' : 'children') +
      (counts.childrenCount <= 4 ? ' (' + nameList(counts.childrenNames) + ')' : ''));
  }
  if (clauses.length) {
    // No extra "is/was" when the first clause already carries its own verb
    // ("He has 2 siblings..."), e.g. when there is no spouse clause.
    if (clauses.length > 1) {
      for (let i = 1; i < clauses.length; i++) clauses[i] = clauses[i].replace(/^(?:(?:has|had) )/, '');
      clauses[clauses.length - 1] = 'and ' + clauses[clauses.length - 1];
    }
    const prefix = clauses[0].startsWith('married to ') ? (alive ? he + ' is ' : he + ' was ') : '';
    sentences.push(prefix + clauses.join(', ') + '.');
  }

  return sentences.join(' ');
}

// ============================================================
// Tab Switching
// ============================================================
function switchInfoTab(tab) {
  document.querySelectorAll('.drawer-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  ['actions', 'lifestory', 'research'].forEach(t => {
    const panel = document.getElementById('panel-' + t);
    if (panel) panel.style.display = (t === tab) ? '' : 'none';
  });
}

// ============================================================
// LifeStory Chronological Timeline
// ============================================================
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_SHORT = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normalizeQualifier(q) {
  const v = String(q || '').toLowerCase();
  return (v === 'before' || v === 'during' || v === 'after') ? v : 'exact';
}

// Builds a readable date phrase from a year + optional precision (before /
// during / after) + optional month/day. Examples:
//   exact + year only        -> "in the year 1930"
//   exact + month + day      -> "on 14 June 1930"
//   before + year            -> "before 1930"
//   during (around) + month  -> "around June 1920"
//   after + year             -> "after 1950"
function datePhrase(year, qualifier, month, day) {
  if (!year) return '';
  const q = normalizeQualifier(qualifier);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  const monthName = (m >= 1 && m <= 12) ? MONTH_NAMES[m] : '';
  const hasDay = (d >= 1 && d <= 31);
  const exact = monthName
    ? (hasDay ? 'on ' + d + ' ' + monthName + ' ' + year : 'in ' + monthName + ' ' + year)
    : 'in the year ' + year;
  if (q === 'before') return 'before ' + exact.replace(/^(on|in) /, '');
  if (q === 'after') return 'after ' + exact.replace(/^(on|in) /, '');
  if (q === 'during') return 'around ' + exact.replace(/^(on|in) /, '');
  return exact;
}

// Short marker label for the timeline year pills (e.g. "1930", "~1930", "Bef 1930").
function dateMarkerLabel(qualifier, month, day, year) {
  if (!year) return '';
  const q = normalizeQualifier(qualifier);
  const m = parseInt(month, 10);
  const base = (q === 'before') ? 'Bef ' + year : (q === 'after') ? 'Aft ' + year : (q === 'during') ? '~' + year : year;
  if (q === 'exact' && m >= 1 && m <= 12) return MONTH_SHORT[m] + ' ' + year;
  return base;
}

// The profile's known father/mother from the relationships sheet.
function parentsOf(personId) {
  const ids = relationships
    .filter(r => r.child_id === personId && r.rel_type !== 'Spouse')
    .map(r => r.parent_id);
  return ids.map(id => persons.find(p => p.person_id === id)).filter(Boolean);
}

// "born by Kamau and Wanjiku" (or a single parent when only one is known —
// never the same person twice).
function bornByParents(targetPerson) {
  const parents = parentsOf(targetPerson.person_id);
  // Exact gender match: "female" CONTAINS the substring "male", so a naive
  // indexOf('male') check matches the mother first and silently swallows the
  // father. Compare the normalized, trimmed gender word instead.
  const maleLike = p2 => ['male', 'm'].indexOf(String(p2.gender || '').trim().toLowerCase()) !== -1;
  const femaleLike = p2 => ['female', 'f'].indexOf(String(p2.gender || '').trim().toLowerCase()) !== -1;
  const father = parents.find(p2 => maleLike(p2));
  const mother = parents.find(p2 => femaleLike(p2));
  const seen = new Set();
  const main = [father, mother].filter(p2 => p2 && !seen.has(p2.person_id) && seen.add(p2.person_id));
  if (!main.length) return '';
  const names = main.map(p3 => p3.gikuyu_name || fullName(p3)).filter(Boolean);
  return 'born by ' + names.join(' and ');
}

function generateChronologicalLifeStory(targetPerson, persons, relationships) {
  let events = [];
  const targetId = targetPerson.person_id;
  const live = String(targetPerson.is_living).toUpperCase() === 'TRUE';

  // 1. Core Event: Birth (born by parents, qualified date, origin + residence)
  if (targetPerson.birth_year) {
    const by = bornByParents(targetPerson);
    const birthPhrase = datePhrase(targetPerson.birth_year, targetPerson.birth_qualifier, targetPerson.birth_month, targetPerson.birth_day);
    const pBirth = targetPerson.place_of_birth ? ' in ' + targetPerson.place_of_birth : '';
    const pLiving = (live && targetPerson.place_of_living) ? ' They currently reside in ' + targetPerson.place_of_living + '.' : '';
    events.push({
      year: parseInt(targetPerson.birth_year, 10),
      title: "Birth",
      label: dateMarkerLabel(targetPerson.birth_qualifier, targetPerson.birth_month, targetPerson.birth_day, targetPerson.birth_year),
      description: `${targetPerson.gikuyu_name} ${targetPerson.fathers_name} ${targetPerson.other_names} was ${by ? by + ' ' : ''}born ${birthPhrase}${pBirth}.${pLiving}`
    });
  }

  // 2. Traversal Event: Birth of Children (children of the couple = union of
  // both parents' children, each child's place of birth included)
  const childLinks = unionChildrenOf(targetId).map(id => ({ child_id: id }));
  childLinks.forEach(link => {
    const child = persons.find(p => p.person_id === link.child_id);
    if (child && child.birth_year) {
      const childPhrase = datePhrase(child.birth_year, child.birth_qualifier, child.birth_month, child.birth_day);
      const childPlace = child.place_of_birth ? ' in ' + child.place_of_birth : '';
      events.push({
        year: parseInt(child.birth_year, 10),
        title: "Birth of child",
        label: dateMarkerLabel(child.birth_qualifier, child.birth_month, child.birth_day, child.birth_year),
        description: `Their child, ${child.gikuyu_name} ${child.fathers_name} ${child.other_names || ''}, was born ${childPhrase}${childPlace}.`
      });
    }
  });

  // 3. Traversal Event: Death of Parents (each parent's place of death)
  const parentLinks = relationships.filter(r => r.child_id === targetId && r.rel_type !== "Spouse");
  parentLinks.forEach(link => {
    const parent = persons.find(p => p.person_id === link.parent_id);
    if (parent && parent.death_year) {
      const parentPhrase = datePhrase(parent.death_year, parent.death_qualifier, parent.death_month, parent.death_day);
      const parentDeathPlace = parent.place_of_death ? ' in ' + parent.place_of_death : '';
      events.push({
        year: parseInt(parent.death_year, 10),
        title: `Death of ${parent.gender === 'Male' ? 'father' : 'mother'}`,
        label: dateMarkerLabel(parent.death_qualifier, parent.death_month, parent.death_day, parent.death_year),
        description: `Their ${parent.gender === 'Male' ? 'father' : 'mother'}, ${parent.gikuyu_name} ${parent.fathers_name}, passed away ${parentPhrase}${parentDeathPlace}.`
      });
    }
  });

  // 4. Core Event: Death of the target (qualified date + place + computed age)
  if (!live || targetPerson.death_year) {
    const dYear = parseInt(targetPerson.death_year, 10);
    if (dYear) {
      const deathPhrase = datePhrase(targetPerson.death_year, targetPerson.death_qualifier, targetPerson.death_month, targetPerson.death_day);
      const pDeath = targetPerson.place_of_death ? ' in ' + targetPerson.place_of_death : '';
      const birth = parseInt(targetPerson.birth_year, 10);
      const ageClause = (birth && !isNaN(birth)) ? ' at the age of ' + (dYear - birth) + ' years' : '';
      events.push({
        year: dYear,
        title: "Death",
        label: dateMarkerLabel(targetPerson.death_qualifier, targetPerson.death_month, targetPerson.death_day, targetPerson.death_year),
        description: `${targetPerson.gikuyu_name} passed away ${deathPhrase}${pDeath}${ageClause}.`
      });
    }
  }

  // CRITICAL STEP: Sort all generated items chronologically from lowest year to highest year
  return events.sort((a, b) => a.year - b.year);
}

function renderLifeStoryTimeline(person) {
  const events = generateChronologicalLifeStory(person, persons, relationships);
  if (!events.length) {
    return '<div class="timeline-empty">No recorded life events yet. Add birth and death years in the Research tab to build this timeline.</div>';
  }
  return events.map(ev =>
    '<div class="timeline-card">' +
    '<div class="timeline-year-marker">' + escapeHtml(String(ev.label || String(ev.year))) + '</div>' +
    '<div class="timeline-title">' + escapeHtml(ev.title) + '</div>' +
    '<div class="timeline-desc">' + escapeHtml(ev.description) + '</div>' +
    '</div>'
  ).join('');
}

// ============================================================
// Research (Editable Profile Fields)
// ============================================================
function populateResearchForm(person) {
  document.getElementById('ir-gikuyu').value = person.gikuyu_name || '';
  document.getElementById('ir-father').value = person.fathers_name || '';
  document.getElementById('ir-other').value = person.other_names || '';
  document.getElementById('ir-gender').value = (person.gender === 'Female') ? 'Female' : 'Male';
  document.getElementById('ir-birth').value = person.birth_year || '';
  document.getElementById('ir-death').value = person.death_year || '';
  fillPeriodFields('ir', person);
  document.getElementById('ir-place-birth').value = person.place_of_birth || '';
  document.getElementById('ir-place-living').value = person.place_of_living || '';
  document.getElementById('ir-place-death').value = person.place_of_death || '';
  document.getElementById('ir-living').value = isDeceased(person) ? 'false' : 'true';
  syncLivingUI('ir');
  // Linked parents: pick the actual Father-Child / Mother-Child partners.
  fillParentSelect('ir-father-link', person, (p) => String(p.gender).indexOf('Female') === -1);
  fillParentSelect('ir-mother-link', person, (p) => String(p.gender).indexOf('Female') !== -1);
  const linkedParents = parentsOf(person.person_id);
  const fatherLink = linkedParents.find(p2 => String(p2.gender).indexOf('Female') === -1);
  const motherLink = linkedParents.find(p2 => String(p2.gender).indexOf('Female') !== -1);
  document.getElementById('ir-father-link').value = fatherLink ? fatherLink.person_id : '';
  document.getElementById('ir-mother-link').value = motherLink ? motherLink.person_id : '';
  document.getElementById('ir-photo').value = '';
  delete document.getElementById('ir-photo').dataset.croppedDataUrl;
  delete document.getElementById('ir-photo').dataset.croppedMime;
  document.getElementById('ir-photo-url').value = person.photo_url || '';
  const preview = document.getElementById('ir-photo-preview');
  if (imgUrlForPreview(person.photo_url)) {
    preview.src = imgUrlForPreview(person.photo_url);
    preview.classList.add('has-photo');
  } else {
    preview.src = '';
    preview.classList.remove('has-photo');
  }

  protectResearchTab(person);
}

function fillParentSelect(selectId, person, genderTest) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— none —';
  sel.appendChild(none);
  persons
    .filter(p => p.person_id !== person.person_id && genderTest(p))
    .sort((a, b) => (a.gikuyu_name || '').localeCompare(b.gikuyu_name || ''))
    .forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.person_id;
      opt.textContent = [p.gikuyu_name, p.fathers_name].filter(Boolean).join(' wa ') +
        (p.other_names ? ' (' + p.other_names + ')' : '');
      sel.appendChild(opt);
    });
}

function imgUrlForPreview(rawUrl) {
  return convertToDirectStreamUrl(rawUrl);
}

async function saveInfoResearch() {
  const person = dashboardPerson;
  if (!person) return;
  const gikuyu = document.getElementById('ir-gikuyu').value.trim();
  const fathers = document.getElementById('ir-father').value.trim();
  if (!gikuyu || !fathers) {
    showToast('Gikuyu Name and Father\'s Name are required');
    return;
  }

  const photo = await savePhotoFrom(document.getElementById('ir-photo'));
  const photoUrlEntry = (document.getElementById('ir-photo-url').value || '').trim();
  const data = {
    person_id: person.person_id,
    gikuyu_name: gikuyu,
    fathers_name: fathers,
    other_names: document.getElementById('ir-other').value.trim(),
    gender: document.getElementById('ir-gender').value,
    birth_year: document.getElementById('ir-birth').value,
    death_year: document.getElementById('ir-death').value,
    place_of_birth: document.getElementById('ir-place-birth').value.trim(),
    place_of_living: document.getElementById('ir-place-living').value.trim(),
    place_of_death: document.getElementById('ir-place-death').value.trim(),
    is_living: toBool(document.getElementById('ir-living').value)
  };
  Object.assign(data, readPeriodFields('ir'));
  if (photo) {
    data.base64Image = photo.base64Image;
    data.mimeType = photo.mimeType;
  } else if (photoUrlEntry) {
    data.photo_url = convertToDirectStreamUrl(photoUrlEntry);
  }

  // Immediate feedback + button lock so research saves never look frozen.
  const saveBtn = document.getElementById('save-details-btn');
  if (saveBtn) saveBtn.disabled = true;
  showToast('Saving…');
  try {
    // Undo snapshot: previous person fields + the parent links we are about to
    // reconcile, so an "undo" restores both the text and the tree connections.
    const pid = person.person_id;
    const prevSnap = Object.assign({}, person);
    const prevFatherLink = currentLinkedParentId(pid, 'Father-Child');
    const prevMotherLink = currentLinkedParentId(pid, 'Mother-Child');

    // Reconcile linked parents against the two selects (add/remove/change).
    const wantFatherLink = document.getElementById('ir-father-link').value;
    const wantMotherLink = document.getElementById('ir-mother-link').value;
    await reconcileParentLink(person, 'Father-Child', wantFatherLink);
    await reconcileParentLink(person, 'Mother-Child', wantMotherLink);

    const res = await apiPost(Object.assign({ action: 'updatePerson' }, data));
    if (!res.success) {
      showToast('Error: ' + (res.error || ''));
      return;
    }

    const undoLabel = 'Edit: ' + (shortName(prevSnap) || 'profile');
    const redoSnap = Object.assign({}, data);
    pushUndo(undoLabel, async () => {
      const restore = Object.assign({ action: 'updatePerson', person_id: pid }, personUpdatePayload(prevSnap));
      restore.photo_url = prevSnap.photo_url || '';
      const r = await apiPost(restore);
      if (!r || !r.success) throw new Error((r && r.error) || 'Could not restore profile');
      const freshPerson = getPerson(pid) || prevSnap;
      await reconcileParentLink(freshPerson, 'Father-Child', prevFatherLink);
      await reconcileParentLink(freshPerson, 'Mother-Child', prevMotherLink);
    }, async () => {
      await reconcileParentLink(getPerson(pid) || prevSnap, 'Father-Child', wantFatherLink);
      await reconcileParentLink(getPerson(pid) || prevSnap, 'Mother-Child', wantMotherLink);
      const r = await apiPost(Object.assign({ action: 'updatePerson' }, redoSnap));
      if (!r || !r.success) throw new Error((r && r.error) || 'Could not redo profile edit');
    });

    showToast('Profile updated');
    await loadData();
    const fresh = persons.find(p => p.person_id === person.person_id) || person;
    dashboardPerson = fresh;
    renderInfoDashboard(fresh);
    switchInfoTab('research');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

// Current parent_id of a child's link of the given type ('' when unlinked).
function currentLinkedParentId(childId, relType) {
  const r = relationships.find(x =>
    String(x.child_id) === String(childId) && String(x.rel_type) === String(relType));
  return r ? r.parent_id : '';
}

// Point a person's Father-Child / Mother-Child link at a new parent ('' = none).
// Deletes the old record of that type first so a parent is never duplicated, and
// only then creates the replacement. Ownership/admin is enforced by the backend
// on every write; admins and the profile creator pass automatically.
async function reconcileParentLink(person, relType, wantId) {
  if (wantId === person.person_id) return;
  const current = relationships.find(r => r.child_id === person.person_id && r.rel_type === relType);
  const currentId = current ? current.parent_id : '';
  if (currentId === wantId) return;
  if (current) {
    const del = await deleteRelationshipSafe(current.relationship_id);
    if (!del.success) {
      showToast('Could not remove old ' + relType + ': ' + (del.error || ''));
      return;
    }
  }
  if (wantId) {
    await createRelationshipSafe(wantId, person.person_id, relType);
  }
}

// ============================================================
// Access Permissions (Research Tab Lock)
// ============================================================
// Locks the Research tab into read-only mode for everyone except the profile's
// original creator and tree admins. The backend still enforces ownership
// (ownsOrAdmin) on every write; this is the frontend authorization boundary.
function protectResearchTab(activeRelative) {
  const isAdmin = isSuperAdminLocal();
  const isAuthorized = isAdmin || String(activeRelative.created_by || '') === currentUserToken;

  const inputElements = document.querySelectorAll('.research-form-field');
  const saveBtn = document.getElementById('save-details-btn');
  const notice = document.getElementById('research-security-notice');

  if (!isAuthorized) {
    inputElements.forEach(input => {
      input.setAttribute('disabled', 'true');
      input.style.opacity = '0.6';
    });
    if (saveBtn) saveBtn.style.display = 'none';
    if (notice) {
      notice.innerHTML = displayFormSecurityNotice('🔒 Read-Only Mode: You can only alter details on profiles that you personally created.');
    }
  } else {
    inputElements.forEach(input => {
      input.removeAttribute('disabled');
      input.style.opacity = '';
    });
    if (saveBtn) saveBtn.style.display = 'block';
    if (notice) notice.innerHTML = '';
  }
}

function displayFormSecurityNotice(message) {
  return '<div class="research-lock-banner">' + message + '</div>';
}

function calculateVitalStats(person) {
  const currentYear = 2026;
  const birth = parseInt(person.birth_year, 10);
  const death = parseInt(person.death_year, 10);
  const isLiving = String(person.is_living).toUpperCase() === "TRUE";

  // Case 1: Missing birth year data
  if (!birth || isNaN(birth)) {
    return "Birth year unrecorded.";
  }

  // Case 2: Deceased relative
  if (!isLiving || (death && !isNaN(death))) {
    if (death && !isNaN(death)) {
      const ageAtDeath = death - birth;
      return `Born in ${birth}. Passed away at ${ageAtDeath} years of age in the year ${death}.`;
    }
    return `Born in ${birth}. (Deceased, year of death unrecorded).`;
  }

  // Case 3: Living relative
  const currentAge = currentYear - birth;
  return `Born in ${birth}. Is ${currentAge} years old.`;
}

// All children of a married couple, deduped across BOTH partners, so both
// parents shown together under the umbrella report the same family picture.
function unionChildrenOf(targetPersonId) {
  const spouseIds = relationships
    .filter(r => (r.parent_id === targetPersonId || r.child_id === targetPersonId) && r.rel_type === 'Spouse')
    .map(r => r.parent_id === targetPersonId ? r.child_id : r.parent_id);
  const ids = new Set();
  [targetPersonId].concat(spouseIds).forEach(pid => {
    relationships.forEach(r => {
      if (r.parent_id === pid && r.rel_type !== 'Spouse') ids.add(r.child_id);
    });
  });
  return Array.from(ids);
}

function aggregateFamilyCounts(targetPersonId, relationships, persons) {
  // 1. Calculate Children Count (union of both parents' children + dedupe)
  const childrenIds = unionChildrenOf(targetPersonId);
  const childrenLinks = childrenIds.map(id => ({ child_id: id }));

  // 2. Identify Parents to extract Sibling lists accurately
  const parentLinks = relationships.filter(r => r.child_id === targetPersonId && r.rel_type !== "Spouse");
  const parentIds = parentLinks.map(p => p.parent_id);

  let siblingIds = new Set();
  parentIds.forEach(pId => {
    const siblings = relationships.filter(r => r.parent_id === pId && r.child_id !== targetPersonId && r.rel_type !== "Spouse");
    siblings.forEach(s => siblingIds.add(s.child_id));
  });

  // 3. Identify and name current Spouses
  const spouseLinks = relationships.filter(r => (r.parent_id === targetPersonId || r.child_id === targetPersonId) && r.rel_type === "Spouse");
  const spouseNames = spouseLinks.map(link => {
    const spouseId = link.parent_id === targetPersonId ? link.child_id : link.parent_id;
    const spouseObj = persons.find(p => p.person_id === spouseId);
    return spouseObj ? `${spouseObj.gikuyu_name} ${spouseObj.fathers_name}`.trim() : null;
  }).filter(Boolean);

  return {
    childrenCount: childrenLinks.length,
    childrenNames: childrenIds.map(id => { const o = persons.find(p => p.person_id === id); return o ? shortName(o) : null; }).filter(Boolean),
    siblingCount: siblingIds.size,
    siblingNames: Array.from(siblingIds).map(id => { const o = persons.find(p => p.person_id === id); return o ? shortName(o) : null; }).filter(Boolean),
    spousesList: spouseNames
  };
}

// ============================================================
// Modal Helpers
// ============================================================
function openModal(id) { document.getElementById(id).classList.add('active'); }
function closeModal(id) { document.getElementById(id).classList.remove('active'); }

// ---- Super-admin unlock ----
function reflectAdminUI() {
  const b = document.getElementById('admin-btn');
  if (b) b.textContent = isSuperAdminLocal() ? '🔓 Admin' : '🔒 Admin';
  const visitsBtn = document.getElementById('visits-btn');
  if (visitsBtn) visitsBtn.style.display = isSuperAdminLocal() && !isViewOnly ? '' : 'none';
  if (visitsBtn && isSuperAdminLocal() && !isViewOnly) {
    visitsBtn.textContent = '👁 Visits';
  }
}
function openVisitsModal() {
  if (!isSuperAdminLocal()) { showToast('Unlock admin first to view the visitor log.'); return; }
  openModal('visits-modal');
  loadVisits();
}
async function loadVisits() {
  const meta = document.getElementById('visits-meta');
  const tbody = document.querySelector('#visits-table tbody');
  if (!tbody || !meta) return;
  meta.textContent = 'Loading…';
  tbody.innerHTML = '<tr><td colspan="7" style="padding:10px;color:#94a3b8">Fetching…</td></tr>';
  let res;
  try {
    res = await apiPost({ action: 'getVisits' });
  } catch (e) {
    meta.textContent = 'Could not reach the backend.';
    tbody.innerHTML = '';
    return;
  }
  if (!res || !res.success) {
    meta.textContent = 'Error: ' + ((res && res.error) || 'unknown');
    tbody.innerHTML = '';
    return;
  }
  const vs = res.visits || [];
  meta.textContent = (res.total || vs.length) + ' events logged. (Newest first, up to 500 shown.)';
  if (!vs.length) { tbody.innerHTML = '<tr><td colspan="7" style="padding:10px;color:#94a3b8">No visits recorded yet.</td></tr>'; return; }
  tbody.innerHTML = vs.map(v => {
    const when = fmtVisitTime(v.ts);
    const evtFull = String(v.event || '').toLowerCase();
    const evtBadge = evtFull === 'click'
      ? '<span style="color:#0d9488;font-weight:700">CLICK</span>'
      : '<span style="color:#94a3b8">VISIT</span>';
    const person = escapeHtml(String(v.person_name || '-'));
    const dev = escapeHtml(describeDevice(v.user_agent));
    const loc = escapeHtml(String(v.location || ''));
    const mode = escapeHtml(String(v.mode || ''));
    const vis = escapeHtml(String(v.visitor_id || '').slice(0, 14));
    return '<tr><td style="padding:6px;border-bottom:1px solid #222">' + when + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #222">' + evtBadge + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #222">' + person + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #222">' + dev + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #222">' + loc + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #222">' + mode + '</td>' +
      '<td style="padding:6px;border-bottom:1px solid #222;color:#94a3b8">' + vis + '</td></tr>';
  }).join('');
}
function fmtVisitTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  const now = new Date();
  const diffMin = Math.round((now - d) / 60000);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const datePart = dd + '/' + mm + ' ' + hh + ':' + mi;
  if (diffMin < 60) return diffMin + 'm ago';
  if (now.toDateString() === d.toDateString()) return 'today ' + hh + ':' + mi;
  return datePart;
}

// Friendly device description from the raw User-Agent: OS + browser + (mobile).
function describeDevice(ua) {
  if (!ua) return '-';
  const u = String(ua);
  let os = 'Other';
  let mob = '';
  if (/iPhone/i.test(u)) { os = 'iPhone'; mob = '📱 '; }
  else if (/iPad/i.test(u)) { os = 'iPad'; mob = '📱 '; }
  else if (/Android/i.test(u)) { os = 'Android'; mob = '📱 '; }
  else if (/Windows/i.test(u)) os = 'Windows';
  else if (/Mac OS/i.test(u)) os = 'Mac';
  else if (/Linux/i.test(u)) os = 'Linux';
  let br = 'Browser';
  if (/Edg\//i.test(u)) br = 'Edge';
  else if (/OPR\//i.test(u) || /Opera/i.test(u)) br = 'Opera';
  else if (/Firefox/i.test(u)) br = 'Firefox';
  else if (/Chrome\//i.test(u)) br = 'Chrome';
  else if (/Safari/i.test(u)) br = 'Safari';
  return mob + os + ' · ' + br;
}
function toggleAdminUnlock() {
  if (isSuperAdminLocal()) {
    localStorage.removeItem('wanganga_admin_code');
    location.reload();
    return;
  }
  document.getElementById('admin-code-input').value = '';
  openModal('admin-modal');
  setTimeout(() => { const i = document.getElementById('admin-code-input'); if (i) i.focus(); }, 50);
}
async function submitAdminUnlock() {
  const code = (document.getElementById('admin-code-input').value || '').trim();
  if (code.length < 8) { showToast('That code looks too short.'); return; }
  const res = await apiPost({ action: 'ping', admin_token: code });
  if (res && res.is_admin === true) {
    localStorage.setItem('wanganga_admin_code', code);
    location.reload();
  } else {
    showToast('Wrong admin code.');
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function zoomReset() {
  if (zoomBehavior) {
    const svg = d3.select('#tree-svg');
    svg.transition().duration(500).call(zoomBehavior.transform, d3.zoomIdentity);
  }
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const cropState = {
  input: null, previewId: null,
  img: null, scale: 1, minScale: 1,
  tx: 0, ty: 0, view: 320,
  drag: null, prevSrc: '', prevHas: false
};

function decodeImage(file) {
  if (window.createImageBitmap && file && typeof file.arrayBuffer === 'function') {
    return file.arrayBuffer()
      .then(buf => createImageBitmap(new Blob([buf], { type: file.type }), { imageOrientation: 'from-image' }))
      .catch(() => loadImageElement(file));
  }
  return loadImageElement(file);
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

function handlePhotoSelect(input, previewId) {
  if (input.files && input.files[0] && /^image\//i.test(input.files[0].type)) {
    const preview = document.getElementById(previewId);
    cropState.prevSrc = preview.src;
    cropState.prevHas = preview.classList.contains('has-photo');
    cropState.input = input;
    cropState.previewId = previewId;
    openPhotoCropper(input.files[0]);
  } else {
    input.value = '';
  }
}

async function openPhotoCropper(file) {
  try {
    const img = await decodeImage(file);
    cropState.img = img;
    cropState.minScale = Math.max(cropState.view / img.width, cropState.view / img.height);
    cropState.scale = cropState.minScale;
    cropState.tx = 0; cropState.ty = 0;
    syncZoomSlider();
    cropRender();
    document.getElementById('crop-overlay').classList.add('active');
  } catch (e) {
    cropState.input.value = '';
    showToast('Error: ' + (e && e.message ? e.message : 'Could not open image'));
  }
}

function cropRender() {
  const canvas = document.getElementById('crop-canvas');
  const v = cropState.view;
  canvas.width = v; canvas.height = v;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, v, v);
  const img = cropState.img;
  if (!img) return;
  const w = img.width * cropState.scale;
  const h = img.height * cropState.scale;
  ctx.save();
  ctx.beginPath();
  ctx.arc(v / 2, v / 2, v / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, v / 2 - w / 2 + cropState.tx, v / 2 - h / 2 + cropState.ty, w, h);
  ctx.restore();
}

function cropClamp() {
  const img = cropState.img;
  if (!img) return;
  const wHalf = (img.width * cropState.scale) / 2;
  const hHalf = (img.height * cropState.scale) / 2;
  const vHalf = cropState.view / 2;
  const maxTx = Math.max(0, wHalf - vHalf);
  const maxTy = Math.max(0, hHalf - vHalf);
  cropState.tx = Math.max(-maxTx, Math.min(maxTx, cropState.tx));
  cropState.ty = Math.max(-maxTy, Math.min(maxTy, cropState.ty));
}

function applyCropZoom(scale) {
  const ratio = scale / cropState.scale;
  cropState.scale = Math.max(cropState.minScale, Math.min(cropState.minScale * 5, scale));
  cropState.tx *= ratio;
  cropState.ty *= ratio;
  cropClamp();
  cropRender();
  syncZoomSlider();
}

function syncZoomSlider() {
  const t = (cropState.scale - cropState.minScale) / (cropState.minScale * 4);
  document.getElementById('crop-zoom').value = String(Math.round(Math.max(0, Math.min(1, t)) * 100));
}

function cropCancel() {
  photoChangePending = false;
  photoChangeTarget = null;
  const preview = document.getElementById(cropState.previewId);
  if (preview) {
    preview.src = cropState.prevSrc || '';
    if (cropState.prevHas) preview.classList.add('has-photo');
    else preview.classList.remove('has-photo');
  }
  if (cropState.input) {
    cropState.input.value = '';
    delete cropState.input.dataset.croppedDataUrl;
    delete cropState.input.dataset.croppedMime;
  }
  closeCrop();
}

function cropApply() {
  const out = 512;
  const canvas = document.createElement('canvas');
  canvas.width = out; canvas.height = out;
  const ctx = canvas.getContext('2d');
  const img = cropState.img;
  const s = cropState.scale * (out / cropState.view);
  const w = img.width * s;
  const h = img.height * s;
  const tx = cropState.tx * (out / cropState.view);
  const ty = cropState.ty * (out / cropState.view);
  ctx.drawImage(img, out / 2 - w / 2 + tx, out / 2 - h / 2 + ty, w, h);
  const fileType = cropState.input && cropState.input.files && cropState.input.files[0] ? cropState.input.files[0].type : '';
  const mime = /png/i.test(fileType) ? 'image/png' : 'image/jpeg';
  const dataUrl = canvas.toDataURL(mime, 0.9);
  cropState.input.dataset.croppedDataUrl = dataUrl;
  cropState.input.dataset.croppedMime = mime;
  const preview = document.getElementById(cropState.previewId);
  if (preview) {
    preview.src = dataUrl;
    preview.classList.add('has-photo');
  }
  const appliedInput = cropState.input;
  const applyAvatar = photoChangePending;
  closeCrop();
  // The avatar / Actions-tab Change Photo flow commits immediately after the
  // crop instead of waiting for a form save.
  if (applyAvatar && appliedInput && appliedInput.dataset.croppedDataUrl) {
    photoChangePending = false;
    commitAvatarPhoto(appliedInput);
  }
}

function closeCrop() {
  document.getElementById('crop-overlay').classList.remove('active');
  cropState.img = null;
  cropState.drag = null;
  cropState.input = null;
  cropState.previewId = null;
}

function toBool(v) {
  const t = String(v).toLowerCase();
  return (v === true || t === 'true' || t === '1');
}

// ============================================================
// Person CRUD
// ============================================================
function configureRelation(linkType) {
  const wrap = document.getElementById('pf-relation-wrap');
  const sel = document.getElementById('pf-relation');
  if (linkType === 'parent' || linkType === 'spouse') {
    wrap.style.display = '';
    const isParent = linkType === 'parent';
    document.getElementById('pf-relation-label').textContent =
      isParent ? 'Is this new person your Father or Mother?' : 'Is this new person your Husband or Wife?';
    sel.innerHTML = isParent
      ? '<option value="father">Father</option><option value="mother">Mother</option>'
      : '<option value="husband">Husband</option><option value="wife">Wife</option>';
    applyRelationGender(sel);
  } else {
    wrap.style.display = 'none';
  }
}

function applyRelationGender(sel) {
  const v = sel.value;
  if (v === 'father' || v === 'husband') {
    document.getElementById('pf-gender').value = 'Male';
  } else if (v === 'mother' || v === 'wife') {
    document.getElementById('pf-gender').value = 'Female';
  }
}

function syncLivingUI(prefix) {
  const sel = document.getElementById(prefix + '-living');
  if (!sel) return;
  const wrap = document.getElementById(prefix + '-death-wrap');
  if (wrap) wrap.style.display = sel.value === 'true' ? 'none' : '';
  const placeWrap = document.getElementById(prefix + '-place-death-wrap');
  if (placeWrap) placeWrap.style.display = sel.value === 'true' ? 'none' : '';
}

// Shared read/write helpers for the qualified date fields (year precision +
// optional month/day) shared by the pf / ob / ir forms.
function readPeriodFields(prefix) {
  const val = id => { const el = document.getElementById(prefix + '-' + id); return el ? el.value : ''; };
  return {
    birth_qualifier: val('birth-qualifier') || 'exact',
    birth_month: val('birth-month'),
    birth_day: val('birth-day'),
    death_qualifier: val('death-qualifier') || 'exact',
    death_month: val('death-month'),
    death_day: val('death-day')
  };
}

function fillPeriodFields(prefix, person) {
  person = person || {};
  const set = (id, v) => { const el = document.getElementById(prefix + '-' + id); if (el) el.value = v == null ? '' : String(v); };
  set('birth-qualifier', person.birth_qualifier || 'exact');
  set('birth-month', person.birth_month || '');
  set('birth-day', person.birth_day || '');
  set('death-qualifier', person.death_qualifier || 'exact');
  set('death-month', person.death_month || '');
  set('death-day', person.death_day || '');
}

function attachNameAutocomplete(inputId, resultsId, opts) {
  opts = opts || {};
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultsId);

  function hide() { results.classList.remove('active'); }

  function pick(person) {
    input.value = person.gikuyu_name || '';
    input.dataset.personId = person.person_id || '';
    input.dataset.pickedName = (person.gikuyu_name || '').toLowerCase();
    hide();
    if (opts.fillFather) {
      const fatherEl = document.getElementById(inputId.replace('-gikuyu', '-father'));
      if (fatherEl && !fatherEl.value.trim()) fatherEl.value = person.fathers_name || '';
    }
    if (typeof opts.onPick === 'function') opts.onPick(person);
    input.focus();
  }

  function build() {
    const q = input.value.trim().toLowerCase();
    if (input.value.trim().toLowerCase() !== (input.dataset.pickedName || '')) {
      input.dataset.personId = '';
    }
    if (q.length < 1) { hide(); return; }
    const matches = persons
      .filter(function (p) {
        const hay = String(fullName(p) + ' ' + (p.fathers_name || '') + ' ' + (p.other_names || '')).toLowerCase();
        return hay.indexOf(q) !== -1;
      })
      .slice(0, 8);
    if (matches.length === 0) { hide(); return; }
    results.innerHTML = matches.map(function (p) {
      return '<div class="autocomplete-item" data-person="' + p.person_id + '">' +
        '<div class="name">' + escapeHtml(fullName(p)) + '</div>' +
        '<div class="detail">' + escapeHtml(String(p.gender || '')) + ' &middot; ' + escapeHtml(String(p.birth_year || 'Unknown birth year')) + '</div>' +
        '</div>';
    }).join('');
    results.classList.add('active');
  }

  input.addEventListener('input', build);
  input.addEventListener('focus', function () { if (input.value.trim().length > 0) build(); });
  results.addEventListener('mousedown', function (e) {
    const item = e.target.closest('.autocomplete-item');
    if (!item) return;
    e.preventDefault();
    const p = persons.find(function (x) { return x.person_id === item.dataset.person; });
    if (p) pick(p);
  });
  document.addEventListener('click', function (e) {
    if (!results.contains(e.target) && e.target !== input) hide();
  });
}

function openAddPersonModal(linkParent, linkType) {
  const subtitle = document.getElementById('person-modal-subtitle');
  if (linkParent && linkType === 'parent') {
    subtitle.textContent = 'Adding a parent for ' + fullName(linkParent);
  } else if (linkParent && linkType === 'spouse') {
    subtitle.textContent = 'Adding a spouse for ' + fullName(linkParent);
  } else if (linkParent && linkType === 'child') {
    subtitle.textContent = 'Adding a child for ' + fullName(linkParent);
  } else if (linkParent && linkType === 'sibling') {
    subtitle.textContent = 'Adding a sibling for ' + fullName(linkParent);
  } else {
    subtitle.textContent = 'Fill in the details below';
  }
  document.getElementById('person-modal-title').textContent = 'Add Person';
  document.getElementById('pf-id').value = '';
  document.getElementById('pf-link-parent-id').value = linkParent ? linkParent.person_id : '';
  document.getElementById('pf-link-type').value = linkType || '';
  configureRelation(linkType || '');
  document.getElementById('pf-gikuyu').value = '';
  document.getElementById('pf-father').value = '';
  document.getElementById('pf-other').value = '';
  document.getElementById('pf-gender').value = 'Male';
  document.getElementById('pf-birth').value = '';
  document.getElementById('pf-death').value = '';
  fillPeriodFields('pf', {});
  document.getElementById('pf-living').value = 'true';
  syncLivingUI('pf');
  document.getElementById('pf-photo').value = '';
  delete document.getElementById('pf-photo').dataset.croppedDataUrl;
  delete document.getElementById('pf-photo').dataset.croppedMime;
  document.getElementById('pf-photo-preview').src = '';
  document.getElementById('pf-photo-preview').classList.remove('has-photo');

  if (linkParent && linkType === 'child') {
    // The Father's Name field must NEVER be filled with the clicked person's
    // name when that person is the mother — it belongs to her husband.
    const isMother = /female/i.test(String(linkParent.gender || '')) || String(linkParent.gender) === 'F';
    if (!isMother) {
      document.getElementById('pf-father').value = linkParent.gikuyu_name;
    } else {
      const husband = relationships
        .filter(r => (r.parent_id === linkParent.person_id || r.child_id === linkParent.person_id) && /spouse/i.test(r.rel_type || ''))
        .map(r => getPerson(r.parent_id === linkParent.person_id ? r.child_id : r.parent_id))
        .find(p => p && !/female/i.test(String(p.gender || '')));
      if (husband) document.getElementById('pf-father').value = husband.gikuyu_name;
    }
  } else if (linkParent && linkType === 'sibling') {
    const fatherRel = relationships.find(r => r.child_id === linkParent.person_id && /father/i.test(r.rel_type || ''));
    if (fatherRel) {
      const dad = getPerson(fatherRel.parent_id);
      if (dad && dad.gikuyu_name) document.getElementById('pf-father').value = dad.gikuyu_name;
    }
  }
  openModal('person-modal');
}

function openEditModal(node) {
  document.getElementById('person-modal-title').textContent = 'Edit Person';
  document.getElementById('person-modal-subtitle').textContent = 'Update the details below';
  document.getElementById('pf-id').value = node.person_id;
  document.getElementById('pf-link-parent-id').value = '';
  document.getElementById('pf-link-type').value = '';
  configureRelation('');
  document.getElementById('pf-gikuyu').value = node.gikuyu_name || '';
  document.getElementById('pf-father').value = node.fathers_name || '';
  document.getElementById('pf-other').value = node.other_names || '';
  document.getElementById('pf-gender').value = node.gender || 'Male';
  document.getElementById('pf-birth').value = node.birth_year || '';
  document.getElementById('pf-death').value = node.death_year || '';
  fillPeriodFields('pf', node);
  document.getElementById('pf-living').value = isDeceased(node) ? 'false' : 'true';
  syncLivingUI('pf');
  document.getElementById('pf-photo').value = '';
  document.getElementById('pf-photo').dataset.keepExisting = '1';
  delete document.getElementById('pf-photo').dataset.croppedDataUrl;
  delete document.getElementById('pf-photo').dataset.croppedMime;

  const preview = document.getElementById('pf-photo-preview');
  if (node.photo_url) {
    preview.src = node.photo_url;
    preview.classList.add('has-photo');
  } else {
    preview.src = '';
    preview.classList.remove('has-photo');
  }
  openModal('person-modal');
}

async function savePhotoFrom(input) {
  if (!input) return null;
  if (input.dataset.croppedDataUrl) {
    return { base64Image: input.dataset.croppedDataUrl, mimeType: input.dataset.croppedMime || 'image/jpeg' };
  }
  if (input.files && input.files[0]) {
    const dataUrl = await readFileAsDataURL(input.files[0]);
    return { base64Image: dataUrl, mimeType: input.files[0].type };
  }
  return null;
}

async function savePerson() {
  const id = document.getElementById('pf-id').value;
  const linkParentId = document.getElementById('pf-link-parent-id').value;
  const linkType = document.getElementById('pf-link-type').value;

  const gikuyu = document.getElementById('pf-gikuyu').value.trim();
  const fathers = document.getElementById('pf-father').value.trim();

  if (!gikuyu || !fathers) {
    showToast('Gikuyu Name and Father\'s Name are required');
    return;
  }

  // Duplicate gate (synchronous, so it runs while the modal is still open).
  if (!id) {
    const dup = persons.find(p =>
      p.gikuyu_name && p.gikuyu_name.toLowerCase() === gikuyu.toLowerCase() &&
      p.fathers_name && p.fathers_name.toLowerCase() === fathers.toLowerCase()
    );
    if (dup && !confirm(fullName(dup) + ' already exists in the tree. Create a duplicate anyway?')) {
      return;
    }
  }

  // Close the modal IMMEDIATELY so the UI never appears frozen. The network
  // work then runs in the background and reports via toast.
  closeModal('person-modal');
  const saveBtn = document.getElementById('save-person-btn');
  if (saveBtn) saveBtn.disabled = true;
  showToast('Saving…');

  try {
    const photo = await savePhotoFrom(document.getElementById('pf-photo'));

    const data = {
      gikuyu_name: gikuyu,
      fathers_name: fathers,
      other_names: document.getElementById('pf-other').value.trim(),
      gender: document.getElementById('pf-gender').value,
      birth_year: document.getElementById('pf-birth').value,
      death_year: document.getElementById('pf-death').value,
      is_living: toBool(document.getElementById('pf-living').value)
    };
    Object.assign(data, readPeriodFields('pf'));
    if (photo) {
      data.base64Image = photo.base64Image;
      data.mimeType = photo.mimeType;
    }

    if (id) {
      data.person_id = id;
      const prevRec = persons.find(p => String(p.person_id) === String(id)) || {};
      const prevSnap = Object.assign({}, prevRec);
      const res = await apiPost(Object.assign({ action: 'updatePerson' }, data));
      showToast(res.success ? 'Person updated' : 'Error: ' + (res.error || ''));
      if (res.success) {
        const pid = id;
        const label = 'Edit: ' + (shortName(prevSnap) || 'person');
        const redoEditData = Object.assign({}, data);
        pushUndo(label, async () => {
          const restore = Object.assign({ action: 'updatePerson', person_id: pid }, personUpdatePayload(prevSnap));
          restore.photo_url = prevSnap.photo_url || '';
          const r = await apiPost(restore);
          if (!r || !r.success) throw new Error((r && r.error) || 'Could not restore person');
        }, async () => {
          const r = await apiPost(Object.assign({ action: 'updatePerson', person_id: pid }, redoEditData));
          if (!r || !r.success) throw new Error((r && r.error) || 'Could not redo person edit');
        });
      }
    } else {
      const res = await apiPost(Object.assign({ action: 'createPerson', created_by: currentUserToken }, data));
      if (res.success) {
        const newId = res.person_id;
        const addData = Object.assign({}, data);
        const redoLink = { linkParentId: linkParentId, linkType: linkType, pfRelation: document.getElementById('pf-relation').value };
        let linked = true;
        if (linkParentId && linkType === 'parent') {
          const relation = document.getElementById('pf-relation').value;
          const lres = await createRelationshipSafe(newId, linkParentId, relation === 'mother' ? 'Mother-Child' : 'Father-Child');
          linked = lres.success;
        } else if (linkParentId && linkType === 'child') {
          // Link new child to parent AND all parent's spouses. Every relationship
          // call is individually guarded: a flaky API write must never abort the
          // whole batch or leave the child half-linked.
          const parentsToLink = [...new Set([linkParentId, ...getAllSpouses(linkParentId)])];
          linked = true;
          for (const parentId of parentsToLink) {
            const parent = getPerson(parentId);
            const relType = parent && parent.gender === 'Female' ? 'Mother-Child' : 'Father-Child';
            const lres = await createRelationshipSafe(parentId, newId, relType);
            if (!lres.success) linked = false;
          }
        } else if (linkParentId && linkType === 'sibling') {
          // Re-link the new person to every parent of the selected sibling, using
          // the same relationship type (Father-Child / Mother-Child) each parent had.
          const siblingParents = relationships.filter(r =>
            r.child_id === linkParentId && /father|mother/i.test(r.rel_type || ''));
          linked = true;
          for (const pr of siblingParents) {
            const lres = await createRelationshipSafe(pr.parent_id, newId, pr.rel_type);
            if (!lres.success) linked = false;
          }
        } else if (linkParentId && linkType === 'spouse') {
          // Anchor to the primary partner: a spouse must always be keyed on the
          // person who owns a real tree-node cluster, or they become a root and
          // jump to the very top of the tree.
          const anchor = resolvePrimaryAnchor(linkParentId);
          const lres = await createRelationshipSafe(anchor, newId, 'Spouse');
          linked = lres.success;
        }

        if (!linked) {
          // Roll back so an unlinked person never appears as an orphaned root.
          // Guard the rollback too: if it also throws, at least tell the user.
          const dr = await deletePersonSafe(newId);
          const rolledBack = dr.success;
          showToast(rolledBack
            ? 'Person added, but linking to the tree failed and was reverted.'
            : 'Could not link the new person to ' + fullName(getPerson(linkParentId)) + '. Reload the page, then link them from the Research tab.');
          return;
        }
        showToast('Person added');
        pushUndo('Add: ' + (shortName({ gikuyu_name: gikuyu, fathers_name: fathers }) || 'person'), async () => {
          const d = await deletePersonSafe(newId);
          if (!d.success) throw new Error((d && d.error) || 'Could not undo add');
        }, async () => {
          const c = await apiPost(Object.assign({ action: 'createPerson', created_by: currentUserToken }, addData));
          if (!c || !c.success) throw new Error((c && c.error) || 'Could not redo add');
          const reId = c.person_id;
          const rl = redoLink;
          let ok = true;
          if (rl.linkParentId && rl.linkType === 'parent') {
            const lres = await createRelationshipSafe(reId, rl.linkParentId, rl.pfRelation === 'mother' ? 'Mother-Child' : 'Father-Child');
            ok = lres.success;
          } else if (rl.linkParentId && rl.linkType === 'child') {
            const parentsToLink = [...new Set([rl.linkParentId, ...getAllSpouses(rl.linkParentId)])];
            for (const parentId of parentsToLink) {
              const parent = getPerson(parentId);
              const relType = parent && parent.gender === 'Female' ? 'Mother-Child' : 'Father-Child';
              const lres = await createRelationshipSafe(parentId, reId, relType);
              if (!lres.success) ok = false;
            }
          } else if (rl.linkParentId && rl.linkType === 'sibling') {
            const siblingParents = relationships.filter(r =>
              r.child_id === rl.linkParentId && /father|mother/i.test(r.rel_type || ''));
            for (const pr of siblingParents) {
              const lres = await createRelationshipSafe(pr.parent_id, reId, pr.rel_type);
              if (!lres.success) ok = false;
            }
          } else if (rl.linkParentId && rl.linkType === 'spouse') {
            const anchor = resolvePrimaryAnchor(rl.linkParentId);
            const lres = await createRelationshipSafe(anchor, reId, 'Spouse');
            ok = lres.success;
          }
          if (!ok) throw new Error('Could not redo the person links');
        });
      } else {
        showToast('Error: ' + (res.error || ''));
      }
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
  await loadData();
}

// ============================================================
// Delete
// ============================================================
function openDeleteModal(node) {
  document.getElementById('delete-confirm-btn').onclick = async () => {
    const pid = node.person_id;
    const deletedSnap = Object.assign({}, node);
    const relSnap = relationships
      .filter(r => String(r.parent_id) === String(pid) || String(r.child_id) === String(pid))
      .map(r => ({ parent_id: r.parent_id, child_id: r.child_id, rel_type: r.rel_type }));
    const label = 'Delete: ' + (shortName(node) || 'person');
    const res = await deletePersonSafe(pid);
    showToast(res.success ? 'Person deleted' : 'Error: ' + (res.error || ''));
    if (res.success) {
      let restoredId = null;
      pushUndo(label, async () => {
        const restore = Object.assign({ action: 'createPerson', created_by: deletedSnap.created_by || currentUserToken }, personUpdatePayload(deletedSnap));
        if (deletedSnap.photo_url) restore.photo_url = deletedSnap.photo_url;
        const c = await apiPost(restore);
        if (!c || !c.success) throw new Error((c && c.error) || 'Could not restore person');
        restoredId = c.person_id;
        // Recreate every relationship the deleted person had (children, parents,
        // spouses) by routing the old id to the fresh restore id.
        if (restoredId) {
          for (const r of relSnap) {
            const parentId = String(r.parent_id) === String(pid) ? restoredId : r.parent_id;
            const childId = String(r.child_id) === String(pid) ? restoredId : r.child_id;
            const cr = await createRelationshipSafe(parentId, childId, r.rel_type);
            if (!cr.success) throw new Error((cr && cr.error) || 'Could not restore relationships');
          }
        }
      }, async () => {
        const targetId = restoredId || pid;
        const d = await deletePersonSafe(targetId);
        if (!d.success) throw new Error((d && d.error) || 'Could not redo delete');
        restoredId = null;
      });
    }
    closeModal('delete-modal');
    await loadData();
  };
  openModal('delete-modal');
}

// ============================================================
// Link / Unlink
// ============================================================
let linkDir = 'father'; // 'father' | 'mother' | 'son' | 'daughter' | 'husband' | 'wife'
let linkNodeId = null;

function openLinkModal(node) {
  linkNodeId = node.person_id;
  linkDir = 'father';
  document.getElementById('onboard-modal').querySelector('h2').textContent = 'Link: ' + fullName(node);
  document.getElementById('onboard-modal').querySelector('.subtitle').textContent =
    'Choose how to link, then select a person below.';
  document.getElementById('ob-welcome').style.display = 'none';
  document.getElementById('ob-search-group').style.display = '';
  document.getElementById('ob-results').classList.remove('active');
  document.getElementById('ob-search').style.display = 'none';
  document.getElementById('ob-merge').classList.remove('active');
  document.getElementById('ob-new-form').style.display = 'none';

  let oldSelect = document.getElementById('link-type-select');
  if (!oldSelect) {
    oldSelect = document.createElement('div');
    oldSelect.id = 'link-type-select';
    oldSelect.className = 'form-group';
    oldSelect.innerHTML =
      '<label>Relationship Type</label>' +
      '<select id="link-type-value">' +
      '<option value="father">Other person is my Father</option>' +
      '<option value="mother">Other person is my Mother</option>' +
      '<option value="son">Other person is my Son</option>' +
      '<option value="daughter">Other person is my Daughter</option>' +
      '<option value="husband">Other person is my Husband</option>' +
      '<option value="wife">Other person is my Wife</option>' +
      '</select>';
    document.getElementById('ob-results').parentNode.insertBefore(oldSelect, document.getElementById('ob-results'));
  } else {
    oldSelect.style.display = '';
    document.getElementById('link-type-value').value = linkDir;
  }

  document.getElementById('link-type-value').addEventListener('change', function() {
    linkDir = this.value;
  });

  const others = persons.filter(p => p.person_id !== node.person_id);
  const list = document.getElementById('ob-results');
  list.innerHTML = others.map(p =>
    `<div class="autocomplete-item" onclick="confirmLink('${p.person_id}')">
      <div class="name">${escapeHtml(fullName(p))}</div>
      <div class="detail">${escapeHtml(String(p.gender || ''))} &middot; ${escapeHtml(String(p.birth_year || 'Unknown'))}</div>
    </div>`
  ).join('');
  list.classList.add('active');
  openModal('onboard-modal');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function confirmLink(otherId) {
  closeModal('onboard-modal');
  const sel = document.getElementById('link-type-value');
  if (sel) linkDir = sel.value;

  const node = getPerson(linkNodeId);
  const other = getPerson(otherId);
  const createdIds = [];
  const createdSpecs = [];
  const label = 'Link: ' + shortName(node) + ' ↔ ' + shortName(other);

  const trackCreated = (res, parentId, childId, relType) => {
    if (res && res.success && res.relationship_id) {
      createdIds.push(res.relationship_id);
      createdSpecs.push({ parent_id: parentId, child_id: childId, rel_type: relType });
    }
  };

  if (linkDir === 'father' || linkDir === 'mother') {
    // Link node as child of other (other is parent)
    const relType = linkDir === 'mother' ? 'Mother-Child' : 'Father-Child';
    const res = await createRelationshipSafe(other.person_id, node.person_id, relType);
    trackCreated(res, other.person_id, node.person_id, relType);
    // Also link to other's spouses (so child has both parents)
    if (res.success) {
      const spouses = getAllSpouses(other.person_id);
      for (const spouseId of spouses) {
        const spouse = getPerson(spouseId);
        if (spouse) {
          const spouseRelType = spouse.gender === 'Female' ? 'Mother-Child' : 'Father-Child';
          const sres = await createRelationshipSafe(spouseId, node.person_id, spouseRelType);
          trackCreated(sres, spouseId, node.person_id, spouseRelType);
        }
      }
    }
    showToast(res.success ? 'Parent link created (and linked to spouses)' : 'Error: ' + (res.error || ''));
  } else if (linkDir === 'son' || linkDir === 'daughter') {
    // Link other as child of node (node is parent)
    // Link to node AND all of node's spouses
    const parentsToLink = [node.person_id, ...getAllSpouses(node.person_id)];
    let allSuccess = true;
    for (const parentId of parentsToLink) {
      const parent = getPerson(parentId);
      const relType = parent && parent.gender === 'Female' ? 'Mother-Child' : 'Father-Child';
      const res = await createRelationshipSafe(parentId, other.person_id, relType);
      trackCreated(res, parentId, other.person_id, relType);
      if (!res.success) allSuccess = false;
    }
    showToast(allSuccess ? 'Child linked to all parents' : 'Some links failed');
  } else {
    // Spouse rows must be keyed on the man; orient by gender so a woman picked
    // as the clicked node still produces a correct male-anchored row.
    const ga = genderOf(node.person_id), gb = genderOf(other.person_id);
    const parentId = (isFemaleGender(ga) && isMaleGender(gb)) ? other.person_id : node.person_id;
    const childId = (parentId === node.person_id) ? other.person_id : node.person_id;
    const res = await createRelationshipSafe(parentId, childId, 'Spouse');
    trackCreated(res, parentId, childId, 'Spouse');
    showToast(res.success ? 'Spouse link created' : 'Error: ' + (res.error || ''));
  }
  if (createdIds.length) {
    pushUndo(label, async () => {
      for (const rid of createdIds) {
        const d = await deleteRelationshipSafe(rid);
        if (!d.success) throw new Error((d && d.error) || 'Could not undo link');
      }
    }, async () => {
      for (const spec of createdSpecs) {
        const c = await createRelationshipSafe(spec.parent_id, spec.child_id, spec.rel_type);
        if (!c.success) throw new Error((c && c.error) || 'Could not redo link');
      }
    });
  }
  await loadData();
}

function openUnlinkModal(node) {
  const rels = relationships.filter(r => r.parent_id === node.person_id || r.child_id === node.person_id);
  if (rels.length === 0) {
    showToast('No relationships to unlink');
    return;
  }

  document.getElementById('onboard-modal').querySelector('h2').textContent = 'Unlink: ' + fullName(node);
  document.getElementById('onboard-modal').querySelector('.subtitle').textContent = 'Select a relationship to remove:';
  document.getElementById('ob-welcome').style.display = 'none';
  document.getElementById('ob-search-group').style.display = '';
  document.getElementById('ob-search').style.display = 'none';
  document.getElementById('ob-merge').classList.remove('active');
  document.getElementById('ob-new-form').style.display = 'none';
  const sel = document.getElementById('link-type-select');
  if (sel) sel.style.display = 'none';

  const list = document.getElementById('ob-results');
  list.innerHTML = rels.map(r => {
    const otherId = r.parent_id === node.person_id ? r.child_id : r.parent_id;
    const other = getPerson(otherId);
    const otherName = other ? fullName(other) : 'Unknown';
    let direction;
    if (String(r.rel_type).toLowerCase() === 'spouse') {
      direction = 'Spouse of ' + otherName;
    } else {
      direction = r.parent_id === node.person_id
        ? 'Parent of ' + otherName
        : 'Child of ' + otherName;
    }
    return `<div class="autocomplete-item" onclick="confirmUnlink('${r.relationship_id}')">
      <div class="name">${escapeHtml(direction)}</div>
      <div class="detail">${escapeHtml(String(r.rel_type || ''))}</div>
    </div>`;
  }).join('');
  list.classList.add('active');
  openModal('onboard-modal');
}

async function confirmUnlink(relId) {
  closeModal('onboard-modal');
  const rel = relationships.find(r => String(r.relationship_id) === String(relId));
  const res = await deleteRelationshipSafe(relId);
  showToast(res.success ? 'Relationship removed' : 'Error: ' + (res.error || ''));
  if (res.success && rel) {
    const relSnap = { parent_id: rel.parent_id, child_id: rel.child_id, rel_type: rel.rel_type };
    const label = 'Unlink (' + String(rel.rel_type || '') + ')';
    let recreatedId = null;
    pushUndo(label, async () => {
      const c = await createRelationshipSafe(relSnap.parent_id, relSnap.child_id, relSnap.rel_type);
      if (!c.success) throw new Error((c && c.error) || 'Could not undo unlink');
      recreatedId = c.relationship_id || null;
    }, async () => {
      const targetId = recreatedId || relId;
      const d = await deleteRelationshipSafe(targetId);
      if (!d.success) throw new Error((d && d.error) || 'Could not redo unlink');
      recreatedId = null;
    });
  }
  await loadData();
}

// ============================================================
// Drag-to-Link (drop a person onto another to create a link)
// ============================================================
function findNodeGroupAt(e) {
  const active = document.querySelector('.node-group.drag-source');
  if (!active) return null;
  const prev = active.style.pointerEvents;
  active.style.pointerEvents = 'none'; // let elementFromPoint see what's below
  let el = null;
  try { el = document.elementFromPoint(e.clientX, e.clientY); } catch (err) { el = null; }
  active.style.pointerEvents = prev;
  return (el && typeof el.closest === 'function') ? el.closest('.node-group') : null;
}

function openLinkMenu(source, target, event) {
  pendingDragLink = { source: source, target: target };
  const menu = document.getElementById('drag-link-menu');
  menu.innerHTML =
    '<div class="drag-link-title">Link ' + escapeHtml(fullName(source)) + ' with ' + escapeHtml(fullName(target)) + '</div>' +
    '<button type="button" data-link="child">' + escapeHtml(fullName(source)) + ' is a child of ' + escapeHtml(fullName(target)) + '</button>' +
    '<button type="button" data-link="parent">' + escapeHtml(fullName(source)) + ' is a parent of ' + escapeHtml(fullName(target)) + '</button>' +
    '<button type="button" data-link="spouse">' + escapeHtml(fullName(source)) + ' and ' + escapeHtml(fullName(target)) + ' are spouses</button>';
  menu.style.left = Math.min(event.clientX + 12, window.innerWidth - 300) + 'px';
  menu.style.top = Math.min(event.clientY + 12, window.innerHeight - 180) + 'px';
  menu.classList.add('active');
}

function hideLinkMenu() {
  const menu = document.getElementById('drag-link-menu');
  if (menu) menu.classList.remove('active');
}

async function createDragLink(kind, source, target) {
  if (kind === 'spouse') {
    // Keep the convention that the man is the "parent" side of a Spouse row.
    const male = String(source.gender || '').toLowerCase() === 'male' || String(source.gender) === 'M';
    const parentId = male ? source.person_id : target.person_id;
    const childId = male ? target.person_id : source.person_id;
    const anchor = resolvePrimaryAnchor(parentId);
    return createRelationshipSafe(anchor, childId, 'Spouse');
  }
  if (kind === 'child') {
    const relType = (String(target.gender || '').toLowerCase() === 'female' || String(target.gender) === 'F')
      ? 'Mother-Child' : 'Father-Child';
    return createRelationshipSafe(target.person_id, source.person_id, relType);
  }
  // parent
  const relType = (String(source.gender || '').toLowerCase() === 'female' || String(source.gender) === 'F')
    ? 'Mother-Child' : 'Father-Child';
  return createRelationshipSafe(source.person_id, target.person_id, relType);
}

document.getElementById('drag-link-menu').addEventListener('click', async (e) => {
  const btn = e.target && e.target.closest ? e.target.closest('button[data-link]') : null;
  if (!btn) return;
  const kind = btn.dataset.link;
  const pending = pendingDragLink;
  hideLinkMenu();
  pendingDragLink = null;
  if (!pending) return;
  const res = await createDragLink(kind, pending.source, pending.target);
  showToast(res.success ? 'Link created' : 'Error: ' + (res.error || ''));
  if (res.success && res.relationship_id) {
    const rid = res.relationship_id;
    const label = 'Link: ' + shortName(pending.source) + ' ↔ ' + shortName(pending.target);
    const redoKind = kind;
    const redoSource = pending.source;
    const redoTarget = pending.target;
    pushUndo(label, async () => {
      const d = await deleteRelationshipSafe(rid);
      if (!d.success) throw new Error((d && d.error) || 'Could not undo link');
    }, async () => {
      const c = await createDragLink(redoKind, redoSource, redoTarget);
      if (!c || !c.success) throw new Error((c && c.error) || 'Could not redo link');
    });
  }
  await loadData();
});
document.addEventListener('click', (e) => {
  if (!e.target || !e.target.closest || !e.target.closest('#drag-link-menu')) hideLinkMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideLinkMenu();
});

// ============================================================
// Onboarding with Autocomplete & Merge
// ============================================================
let obSelectedPerson = null;
let targetRelative = null;
let obForceNew = false;

function checkOnboarding() {
  const params = new URLSearchParams(window.location.search);
  const wantsOnboard = params.get('onboard') === '1' || params.get('join') === '1' || params.get('mode') === 'onboard';
  if (wantsOnboard) { openOnboarding(); return; }
  // Hosted Apps Script mode (legacy): this page once ran in a sandboxed iframe
  // so location.search could be empty. On GitHub Pages the params are readable
  // directly. Keep the fallback for anyone still hosting via Apps Script.
  try {
    if (window.google && google.script && google.script.url && typeof google.script.url.getLocation === 'function') {
      google.script.url.getLocation(function (loc) {
        const p = (loc && loc.parameter) || {};
        if (p.onboard === '1' || p.join === '1' || p.mode === 'onboard') openOnboarding();
      });
    }
  } catch (e) { /* not hosted or API unavailable */ }
}

function openOnboarding() {
  obSelectedPerson = null;
  targetRelative = null;
  obForceNew = false;
  window.isOnboardingSelectionMode = false;

  document.getElementById('ob-modal-title').textContent = 'Welcome to the Wang\'ang\'a Family Tree';
  document.getElementById('ob-modal-subtitle').textContent = 'Find yourself on the tree to begin.';

  document.getElementById('ob-welcome').style.display = '';
  document.getElementById('ob-search-group').style.display = 'none';
  document.getElementById('ob-merge').classList.remove('active');
  document.getElementById('ob-new-form').style.display = 'none';
  document.getElementById('ob-relation-anchor').style.display = 'none';

  document.getElementById('ob-search').value = '';
  document.getElementById('ob-results').innerHTML = '';
  document.getElementById('ob-results').classList.remove('active');
  document.getElementById('ob-living').value = 'true';
  syncLivingUI('ob');
  resetLinkFields();
  const sel = document.getElementById('link-type-select');
  if (sel) sel.style.display = 'none';
  openModal('onboard-modal');
}

// ============================================================
// Visual Onboarding Selection Mode
// ============================================================
function clearOnboardingSelectionUI() {
  const banner = document.getElementById('onboarding-helper-banner');
  if (banner) banner.remove();
  document.querySelectorAll('.pulse-onboarding-target').forEach(n => n.classList.remove('pulse-onboarding-target'));
}

// Triggered from the "Got it!" button in the welcome dialog.
function initiateVisualOnboardingSelection() {
  closeModal('onboard-modal');
  window.isOnboardingSelectionMode = true;

  const banner = document.createElement('div');
  banner.id = 'onboarding-helper-banner';
  banner.textContent = '👆 Tap your closest relative (Father, Mother, or Spouse) on the tree';
  document.body.appendChild(banner);

  document.querySelectorAll('.node-group').forEach(node => {
    node.classList.add('pulse-onboarding-target');
  });
}

function cancelOnboardingSelection() {
  window.isOnboardingSelectionMode = false;
  clearOnboardingSelectionUI();
}

// A node was clicked while in selection mode: clean up and open the targeted form.
function handleNodeClickDuringOnboarding(clickedRelative) {
  if (!clickedRelative) return;
  cancelOnboardingSelection();
  openTargetedOnboardingForm(clickedRelative);
}

// Opens the join form anchored to the selected relative.
function openTargetedOnboardingForm(relative) {
  targetRelative = relative;
  obSelectedPerson = null;
  obForceNew = false;

  document.getElementById('ob-modal-title').textContent = 'Join the Family Tree';
  document.getElementById('ob-modal-subtitle').textContent = 'Tell us how you connect to ' + (relative.gikuyu_name || 'the selected person') + ', then add your details.';

  document.getElementById('ob-welcome').style.display = 'none';
  document.getElementById('ob-search-group').style.display = 'none';
  document.getElementById('ob-merge').classList.remove('active');

  clearTargetedForm();
  document.getElementById('ob-relation-label').textContent =
    'How are you related to ' + (relative.gikuyu_name || 'them') + '?';
  document.getElementById('ob-relation-anchor').style.display = '';
  document.getElementById('ob-link-section').style.display = 'none';
  document.getElementById('ob-new-form').style.display = 'block';
  openModal('onboard-modal');
}

function clearTargetedForm() {
  obForceNew = false;
  document.getElementById('ob-gikuyu').value = '';
  document.getElementById('ob-father').value = '';
  delete document.getElementById('ob-gikuyu').dataset.personId;
  delete document.getElementById('ob-gikuyu').dataset.pickedName;
  document.getElementById('ob-other').value = '';
  document.getElementById('ob-gender').value = 'Male';
  document.getElementById('ob-birth').value = '';
  document.getElementById('ob-death').value = '';
  fillPeriodFields('ob', {});
  document.getElementById('ob-living').value = 'true';
  syncLivingUI('ob');
  document.getElementById('ob-photo').value = '';
  delete document.getElementById('ob-photo').dataset.croppedDataUrl;
  delete document.getElementById('ob-photo').dataset.croppedMime;
  document.getElementById('ob-photo-preview').src = '';
  document.getElementById('ob-photo-preview').classList.remove('has-photo');
  document.getElementById('ob-photo-url').value = '';
  resetLinkFields();
  document.querySelectorAll('input[name="ob-relation"]').forEach(r => r.checked = false);
}

function getSelectedRelationValue() {
  const el = document.querySelector('input[name="ob-relation"]:checked');
  return el ? el.value : '';
}

// The join guide may ONLY be dismissed via the "Understood" button; Escape and
// misplaced clicks are ignored while the guide is showing.
function obGuideShowing() {
  const welcome = document.getElementById('ob-welcome');
  const modal = document.getElementById('onboard-modal');
  return !!welcome && !!modal && welcome.style.display !== 'none' && modal.classList.contains('active');
}

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && window.isOnboardingSelectionMode) {
    if (obGuideShowing()) return; // block dismissal while the guide is up
    cancelOnboardingSelection();
  }
});
document.addEventListener('click', function (e) {
  if (obGuideShowing() && e.target && e.target.id === 'onboard-modal') return;
}, true);

document.getElementById('ob-search').addEventListener('input', function() {
  clearTimeout(searchDebounce);
  const query = this.value.trim();
  if (query.length < 2) {
    document.getElementById('ob-results').classList.remove('active');
    return;
  }

  searchDebounce = setTimeout(async () => {
    const res = await apiGet('search', { query });
    const list = document.getElementById('ob-results');
    if (res.success && res.results.length > 0) {
      list.innerHTML = res.results.map(p =>
        `<div class="autocomplete-item" onclick="onboardSelectPerson('${p.person_id}')">
          <div class="name">${escapeHtml(fullName(p))}</div>
          <div class="detail">${escapeHtml(String(p.gender || ''))} &middot; ${escapeHtml(String(p.birth_year || 'Unknown birth year'))}</div>
        </div>`
      ).join('');
      list.classList.add('active');
    } else {
      list.innerHTML = '<div class="autocomplete-item" style="color:var(--text-dim)">No matches found. <a href="#" onclick="onboardNewProfile();return false;" style="color:var(--accent)">Create new profile?</a></div>';
      list.classList.add('active');
    }
  }, 300);
});

function onboardSelectPerson(personId) {
  obSelectedPerson = persons.find(p => p.person_id === personId) || obSelectedPerson;
  if (!obSelectedPerson) return;
  document.getElementById('ob-results').classList.remove('active');
  document.getElementById('ob-search').value = obSelectedPerson.gikuyu_name + ' ' + obSelectedPerson.fathers_name;
  document.getElementById('ob-merge').classList.add('active');
}

function onboardMergeProfile() {
  document.getElementById('ob-merge').classList.remove('active');
  if (obSelectedPerson && obSelectedPerson.photo_url) {
    const preview = document.getElementById('ob-photo-preview');
    preview.src = obSelectedPerson.photo_url;
    preview.classList.add('has-photo');
  }
  document.getElementById('ob-gikuyu').value = obSelectedPerson.gikuyu_name || '';
  document.getElementById('ob-father').value = obSelectedPerson.fathers_name || '';
  document.getElementById('ob-other').value = obSelectedPerson.other_names || '';
  document.getElementById('ob-gender').value = obSelectedPerson.gender || 'Male';
  document.getElementById('ob-birth').value = obSelectedPerson.birth_year || '';
  document.getElementById('ob-death').value = obSelectedPerson.death_year || '';
  fillPeriodFields('ob', obSelectedPerson);
  document.getElementById('ob-living').value = isDeceased(obSelectedPerson) ? 'false' : 'true';
  syncLivingUI('ob');
  document.getElementById('ob-new-form').style.display = 'block';
}

async function onboardSubmitNew() {
  if (onboardSubmitNew.busy) return;
  const gikuyu = document.getElementById('ob-gikuyu').value.trim();
  const fathers = document.getElementById('ob-father').value.trim();

  if (!gikuyu || !fathers) {
    showToast('Name fields are required');
    return;
  }

  let relation = '';
  if (targetRelative) {
    relation = getSelectedRelationValue();
    if (!relation) {
      showToast('Please choose how you are related to ' + (targetRelative.gikuyu_name || 'the selected person'));
      return;
    }
  }

  // Immediate feedback + lock to stop double-submits while it saves.
  onboardSubmitNew.busy = true;
  showToast('Saving…');

  try {
  const photo = await savePhotoFrom(document.getElementById('ob-photo'));
  const data = {
    gikuyu_name: gikuyu,
    fathers_name: fathers,
    other_names: document.getElementById('ob-other').value.trim(),
    gender: document.getElementById('ob-gender').value,
    birth_year: document.getElementById('ob-birth').value,
    death_year: document.getElementById('ob-death').value,
    is_living: toBool(document.getElementById('ob-living').value)
  };
  Object.assign(data, readPeriodFields('ob'));
  if (photo) {
    data.base64Image = photo.base64Image;
    data.mimeType = photo.mimeType;
  } else {
    const photoUrlEl = document.getElementById('ob-photo-url');
    const photoUrlEntry = photoUrlEl ? photoUrlEl.value.trim() : '';
    if (photoUrlEntry) {
      data.photo_url = convertToDirectStreamUrl(photoUrlEntry);
    }
  }

  // Duplicate guard: typed a name that already exists but never confirmed a merge.
  if (!obSelectedPerson && !obForceNew) {
    const dup = persons.find(p =>
      p.gikuyu_name && p.gikuyu_name.toLowerCase() === gikuyu.toLowerCase() &&
      p.fathers_name && p.fathers_name.toLowerCase() === fathers.toLowerCase());
    if (dup) {
      obSelectedPerson = dup;
      document.getElementById('ob-merge').classList.add('active');
      showToast('We found an existing profile matching your name. Would you like to merge your profile details here?');
      return;
    }
  }

  let userId = null;

  if (obSelectedPerson) {
    data.existing_person_id = obSelectedPerson.person_id;
    const res = await apiPost(Object.assign({ action: 'mergePerson' }, data));
    if (!res.success) {
      showToast('Error: ' + (res.error || ''));
      return;
    }
    userId = res.person_id || obSelectedPerson.person_id;
  } else {
    const res = await apiPost(Object.assign({ action: 'createPerson', created_by: currentUserToken }, data));
    if (!res.success) {
      showToast('Error: ' + (res.error || ''));
      return;
    }
    userId = res.person_id;
    // New profile: undo removes the freshly-created person (their links are
    // removed on the same click if targetRelative is set; a delete cascades
    // both directions server-side too).
    if (!obSelectedPerson) {
      const newPersonLabel = 'Add: ' + (shortName({ gikuyu_name: gikuyu, fathers_name: fathers }) || 'person');
      const redoAddData = Object.assign({}, data);
      const redoRelation = relation;
      const redoRelative = targetRelative;
      pushUndo(newPersonLabel, async () => {
        const d = await deletePersonSafe(userId);
        if (!d.success) throw new Error((d && d.error) || 'Could not undo add');
      }, async () => {
        const c = await apiPost(Object.assign({ action: 'createPerson', created_by: currentUserToken }, redoAddData));
        if (!c || !c.success) throw new Error((c && c.error) || 'Could not redo add');
        const reId = c.person_id;
        if (redoRelative && redoRelation) {
          const lr = await linkUserToRelative(reId, redoRelation, redoRelative);
          if (lr.failed > 0) throw new Error('Could not redo the person links');
        }
      });
    }
  }

  if (targetRelative && relation) {
    const linkResults = await linkUserToRelative(userId, relation, targetRelative);
    const baseMsg = obSelectedPerson ? 'Profile merged' : 'Profile created';
    showToast(baseMsg + ' and linked to ' + (targetRelative.gikuyu_name || 'your relative') +
      (linkResults.failed > 0 ? ' (' + linkResults.failed + ' links failed)' : ''));
  } else {
    showToast(obSelectedPerson ? 'Profile claimed and updated!' : 'Profile created!');
  }

  targetRelative = null;
  obSelectedPerson = null;
  closeModal('onboard-modal');
  await loadData();
  } finally {
    onboardSubmitNew.busy = false;
  }
}

// Builds the Google Sheets relationship payloads for the selected anchor.
async function linkUserToRelative(userId, relation, relative) {
  const done = new Set();
  let ok = 0, failed = 0;
  const createLink = async (parentId, childId, relType) => {
    const key = parentId + '|' + childId + '|' + relType;
    if (done.has(key)) return;
    if (relationships.some(r =>
      String(r.parent_id) === String(parentId) &&
      String(r.child_id) === String(childId) &&
      String(r.rel_type) === String(relType))) { done.add(key); return; }
    done.add(key);
    const res = await createRelationshipSafe(parentId, childId, relType);
    if (res && res.success) ok++; else failed++;
  };

  switch (relation) {
    case 'parent': {
      // The selected relative is the user's parent.
      // Link to relative AND all their spouses (so user has both parents)
      const parentsToLink = [relative.person_id, ...getAllSpouses(relative.person_id)];
      for (const parentId of parentsToLink) {
        const parent = getPerson(parentId);
        const relType = parent && parent.gender === 'Female' ? 'Mother-Child' : 'Father-Child';
        await createLink(parentId, userId, relType);
      }
      break;
    }
    case 'child': {
      // The selected relative is the user's child.
      // Link child to user AND all user's spouses
      const parentsToLink = [userId, ...getAllSpouses(userId)];
      for (const parentId of parentsToLink) {
        const parent = getPerson(parentId);
        const relType = parent && parent.gender === 'Female' ? 'Mother-Child' : 'Father-Child';
        await createLink(parentId, relative.person_id, relType);
      }
      break;
    }
    case 'spouse': {
      // Horizontal spouse bridge row.
      await createLink(relative.person_id, userId, 'Spouse');
      break;
    }
    case 'sibling': {
      // Inherit the selected relative's parents so they share a family cluster.
      const sibParents = relationships.filter(r =>
        r.child_id === relative.person_id && /father|mother/i.test(r.rel_type || ''));
      for (const pr of sibParents) {
        await createLink(pr.parent_id, userId, pr.rel_type);
      }
      break;
    }
  }
  return { ok, failed };
}

function resetLinkFields() {
  ['ob-parent-father', 'ob-parent-mother', 'ob-sibling'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.value = '';
      el.dataset.personId = '';
      el.dataset.pickedName = '';
    }
  });
}

async function linkNewProfileToFamily(newId) {
  const fatherId = document.getElementById('ob-parent-father').dataset.personId || '';
  const motherId = document.getElementById('ob-parent-mother').dataset.personId || '';
  const sibId = document.getElementById('ob-sibling').dataset.personId || '';

  // Also dedupe against edges created earlier in this same save (e.g. the
  // picked father is also the picked sibling's father).
  const done = new Set();
  const exists = (parentId, childId, relType) => {
    const key = parentId + '|' + childId + '|' + relType;
    if (done.has(key)) return true;
    return relationships.some(r =>
      String(r.parent_id) === String(parentId) &&
      String(r.child_id) === String(childId) &&
      String(r.rel_type) === String(relType));
  };
  const createLink = async (parentId, relType) => {
    if (!parentId || parentId === newId) return;
    if (exists(parentId, newId, relType)) return;
    const res = await createRelationshipSafe(parentId, newId, relType);
    if (res && res.success) done.add(parentId + '|' + newId + '|' + relType);
  };

  if (fatherId) await createLink(fatherId, 'Father-Child');
  if (motherId) await createLink(motherId, 'Mother-Child');
  if (sibId) {
    // Link through the sibling's parents so they share a family cluster.
    const sibParents = relationships.filter(r =>
      r.child_id === sibId && /father|mother/i.test(r.rel_type || ''));
    for (const pr of sibParents) {
      await createLink(pr.parent_id, pr.rel_type);
    }
  }
}

function onboardNewProfile() {
  obSelectedPerson = null;
  obForceNew = true;
  document.getElementById('ob-merge').classList.remove('active');
  resetLinkFields();
  document.getElementById('ob-gikuyu').value = '';
  document.getElementById('ob-father').value = '';
  document.getElementById('ob-other').value = '';
  document.getElementById('ob-gender').value = 'Male';
  document.getElementById('ob-birth').value = '';
  document.getElementById('ob-death').value = '';
  fillPeriodFields('ob', {});
  document.getElementById('ob-living').value = 'true';
  syncLivingUI('ob');
  document.getElementById('ob-photo').value = '';
  delete document.getElementById('ob-photo').dataset.croppedDataUrl;
  delete document.getElementById('ob-photo').dataset.croppedMime;
  document.getElementById('ob-photo-preview').src = '';
  document.getElementById('ob-photo-preview').classList.remove('has-photo');
  document.getElementById('ob-new-form').style.display = 'block';
}

// ============================================================
// Init
// ============================================================
attachNameAutocomplete('pf-gikuyu', 'pf-gikuyu-results', { fillFather: true });
attachNameAutocomplete('pf-father', 'pf-father-results');
attachNameAutocomplete('ob-gikuyu', 'ob-gikuyu-results', {
  fillFather: true,
  onPick: (person) => {
    obSelectedPerson = person;
    const el = document.getElementById('ob-merge');
    if (el) el.classList.add('active');
  }
});
attachNameAutocomplete('ob-father', 'ob-father-results');
attachNameAutocomplete('ob-parent-father', 'ob-parent-father-results');
attachNameAutocomplete('ob-parent-mother', 'ob-parent-mother-results');
attachNameAutocomplete('ob-sibling', 'ob-sibling-results');

document.getElementById('pf-relation').addEventListener('change', function () {
  applyRelationGender(this);
});
document.getElementById('pf-living').addEventListener('change', function () {
  syncLivingUI('pf');
});
document.getElementById('ob-living').addEventListener('change', function () {
  syncLivingUI('ob');
});
document.getElementById('ir-living').addEventListener('change', function () {
  syncLivingUI('ir');
});
document.getElementById('ir-photo-url').addEventListener('input', function () {
  const preview = document.getElementById('ir-photo-preview');
  const direct = convertToDirectStreamUrl(this.value);
  preview.src = direct || '';
  preview.classList.toggle('has-photo', !!direct);
});
document.getElementById('ob-photo-url').addEventListener('input', function () {
  const preview = document.getElementById('ob-photo-preview');
  const direct = convertToDirectStreamUrl(this.value);
  preview.src = direct || '';
  preview.classList.toggle('has-photo', !!direct);
});

(function wireCrop() {
  const view = document.getElementById('crop-viewport');
  const slider = document.getElementById('crop-zoom');

  slider.addEventListener('input', function () {
    const t = this.value / 100;
    applyCropZoom(cropState.minScale + t * cropState.minScale * 4);
  });

  view.addEventListener('wheel', function (e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    applyCropZoom(cropState.scale * factor);
  }, { passive: false });

  view.addEventListener('pointerdown', function (e) {
    cropState.drag = { x: e.clientX, y: e.clientY, tx: cropState.tx, ty: cropState.ty };
    try { view.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointers may not support capture */ }
    view.classList.add('dragging');
  });
  document.addEventListener('pointermove', function (e) {
    if (!cropState.drag) return;
    cropState.tx = cropState.drag.tx + (e.clientX - cropState.drag.x);
    cropState.ty = cropState.drag.ty + (e.clientY - cropState.drag.y);
    cropClamp();
    cropRender();
  });
  const endDrag = function () {
    cropState.drag = null;
    view.classList.remove('dragging');
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  document.getElementById('crop-apply-btn').addEventListener('click', cropApply);
  document.getElementById('crop-cancel-btn').addEventListener('click', cropCancel);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && document.getElementById('crop-overlay').classList.contains('active')) {
      cropCancel();
    }
  });
})();

reflectAdminUI();

function applyViewOnlyMode() {
  if (!isViewOnly) return;
  
  // Hide Add Person button
  const addBtn = document.querySelector('button[onclick="openAddPersonModal(null)"]');
  if (addBtn) addBtn.style.display = 'none';
  
  // Hide admin button
  const adminBtn = document.getElementById('admin-btn');
  if (adminBtn) adminBtn.style.display = 'none';
  
  // Disable info modal edit/delete buttons
  const editBtn = document.getElementById('act-edit');
  const delBtn = document.getElementById('act-delete');
  const researchBtn = document.getElementById('act-research');
  if (editBtn) editBtn.style.display = 'none';
  if (delBtn) delBtn.style.display = 'none';
  if (researchBtn) researchBtn.style.display = 'none';
  
  // Disable onboarding
  window.isOnboardingSelectionMode = false;
  
  // Show view-only badge
  const badge = document.createElement('div');
  badge.id = 'view-only-badge';
  badge.textContent = '👁 View Only';
  badge.style.cssText = 'position:fixed;bottom:20px;right:20px;background:var(--accent);color:#fff;padding:8px 16px;border-radius:20px;font-size:14px;font-weight:600;z-index:1000;box-shadow:0 4px 12px rgba(0,0,0,.15)';
  document.body.appendChild(badge);
}

window.addEventListener('load', async () => {
  applyViewOnlyMode();
  applyViewOnlyPanel();
  await loadData();
  checkOnboarding();
});

window.addEventListener('resize', () => {
  renderTree();
});