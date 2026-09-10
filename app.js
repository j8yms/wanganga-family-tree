// ============================================================
// CONFIGURATION
// ============================================================
const API_URL = 'https://script.google.com/macros/s/AKfycbyK7Q4PGh6jSmNgN1NaBlgJnj-IkkduiqleToZjC7F2vGodtGO9RjN498QGvrgf1xykjw/exec';
const SPOUSE_GAP = 70;
const GHOST_SPOUSE_GAP = 140;
const GHOST_PUSH_RANGE = 200;
const GHOST_SIBLING_SHIFT = 180;

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
function isSuperAdminLocal() { return !!adminCode; }
function canManageRecord(rec) {
  return String(rec.created_by || '') === currentUserToken || isSuperAdminLocal();
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

// ============================================================
// API Layer
// ============================================================
async function apiGet(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(API_URL + '?' + qs);
  return res.json();
}

async function apiPost(payload) {
  payload.user_token = payload.user_token || currentUserToken;
  if (adminCode) payload.admin_token = payload.admin_token || adminCode;
  const res = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }
  });
  return res.json();
}

// ============================================================
// Data Loading
// ============================================================
async function loadData() {
  if (!schemaReady) {
    await apiGet('init');
    schemaReady = true;
  }
  const data = await apiGet('getAll');
  if (!data.success) {
    showToast('Error loading data: ' + (data.error || 'Unknown'));
    return;
  }
  persons = data.persons || [];
  relationships = data.relationships || [];
  renderTree();
}

// ============================================================
// Helpers
// ============================================================
function buildSpouseMaps() {
  const spouseOf = {};
  const primaryOf = {};
  relationships.forEach(r => {
    if (r.rel_type && String(r.rel_type).toLowerCase() === 'spouse') {
      spouseOf[r.parent_id] = r.child_id;
      primaryOf[r.child_id] = r.parent_id;
    }
  });
  return { spouseOf, primaryOf };
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
  return ((p.gikuyu_name || '') + ' ' + (p.fathers_name || '') + ' ' + (p.other_names || '')).replace(/\s+/g, ' ').trim();
}

// ============================================================
// Build Tree Hierarchy
// ============================================================
function buildHierarchy() {
  const personMap = {};
  persons.forEach(p => personMap[p.person_id] = Object.assign({}, p, { children: [] }));

  const { primaryOf } = buildSpouseMaps();

  // Each child hangs under exactly ONE parent (Father preferred) so the layout
  // stays a clean tree of married-couple "marriage clusters" instead of a DAG
  // of shared node objects that overlap. A person charted inside a partner's
  // cluster (primaryOf) is never an independent tree node; their children are
  // re-pointed to the primary partner.
  const parentForChild = {};
  relationships.forEach(r => {
    if (!r.rel_type || !/father|mother/i.test(r.rel_type)) return;
    const parent = personMap[r.parent_id];
    const child = personMap[r.child_id];
    if (!parent || !child) return;
    if (primaryOf[r.child_id]) return;
    const anchored = personMap[primaryOf[r.parent_id] || r.parent_id];
    if (!anchored) return;
    const rank = /father/i.test(r.rel_type) ? 1 : 2;
    if (!parentForChild[r.child_id] || parentForChild[r.child_id].rank > rank) {
      parentForChild[r.child_id] = { parent: anchored, rank: rank };
    }
  });

  Object.keys(parentForChild).forEach(childId => {
    parentForChild[childId].parent.children.push(personMap[childId]);
  });

  const childIds = new Set(Object.keys(parentForChild));

  const roots = persons
    .filter(p => !childIds.has(p.person_id) && !primaryOf[p.person_id])
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
// Ghost-Node / Collision Cleanup
// ============================================================
// Runs right before the node rendering cycle so no phantom icons, virtual
// layout coordinates, or clipped overlapping avatars survive a redraw.
function clearGhostNodes(nodes, links) {
  const byId = new Map(nodes.map(n => [n.data.person_id, n]));

  links.forEach(link => {
    if (!link.rel_type || String(link.rel_type).toLowerCase() !== 'spouse') return;
    const primaryNode = byId.get(link.parent_id);
    const spouseNode = byId.get(link.child_id);
    if (!primaryNode || !spouseNode) return;

    // Lock both partners to the exact same horizontal baseline.
    spouseNode.y = primaryNode.y;

    // Enforce a strict 140px horizontal margin between the partners.
    spouseNode.x = primaryNode.x + GHOST_SPOUSE_GAP;

    // PREVENT THE GHOST ICON: push any overlapping same-tier sibling nodes
    // completely out of this cluster's footprint, moving each conflicting
    // subtree as one block so parent-child edges stay connected.
    nodes.forEach(otherNode => {
      if (otherNode === primaryNode || otherNode === spouseNode) return;
      if (otherNode.y !== primaryNode.y) return;
      if (Math.abs(otherNode.x - primaryNode.x) < GHOST_PUSH_RANGE) {
        shiftSubtree(otherNode, GHOST_SIBLING_SHIFT);
      }
    });
  });
}

function shiftSubtree(node, dx) {
  node.x += dx;
  if (node.children) node.children.forEach(child => shiftSubtree(child, dx));
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
function drawSilhouette(group, isFemale) {
  const s = group.append('g').attr('opacity', 0.92).attr('fill', '#0f172a');
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

function renderAvatar(g, p, cx, updatedId) {
  const deceased = isDeceased(p);
  const isFemale = (p.gender === 'Female' || p.gender === 'F');
  const fill = isFemale ? '#f97316' : '#0d9488';
  const stroke = deceased ? '#1c1917' : (isFemale ? '#ea580c' : '#0f766e');
  const imgUrl = convertToDirectStreamUrl(p.photo_url);

  const group = g.append('g')
    .attr('transform', 'translate(' + cx + ',0)')
    .style('cursor', 'pointer');

  // STRICT SINGLE-PATH RULE: one node circle may only render ONE state.
  const cid = 'clip_' + updatedId;
  g.append('clipPath').attr('id', cid)
    .append('circle').attr('r', 29).attr('cx', cx).attr('cy', 0);

  if (imgUrl) {
    // PATH A: profile photo ONLY (circle-masked image inside a thin ring).
    group.append('circle')
      .attr('class', 'node-circle')
      .attr('r', 32)
      .attr('fill', 'transparent')
      .attr('stroke', stroke)
      .attr('stroke-width', deceased ? 4 : 3)
      .attr('filter', deceased ? 'url(#deceasedFilter)' : null);

    const photo = group.append('image')
      .attr('class', 'node-photo')
      .attr('href', imgUrl)
      .attr('x', cx - 29).attr('y', -29)
      .attr('width', 58).attr('height', 58)
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
      drawSilhouette(group, isFemale);
    });
  } else {
    // PATH B: gender vector placeholder ONLY (empty photo_url).
    group.append('circle')
      .attr('class', 'node-circle')
      .attr('r', 32)
      .attr('fill', fill)
      .attr('stroke', stroke)
      .attr('stroke-width', deceased ? 4 : 3)
      .attr('filter', deceased ? 'url(#deceasedFilter)' : null);
    drawSilhouette(group, isFemale);
  }

  group.on('click', (event) => {
    event.stopPropagation();
    if (window.isOnboardingSelectionMode) {
      handleNodeClickDuringOnboarding(p);
    } else {
      showRadialMenu(event, p);
    }
  });

  group.on('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!window.isOnboardingSelectionMode) {
      showRadialMenu(event, p);
    }
  });

  return group;
}

function renderLabels(g, p, cx) {
  const deceased = isDeceased(p);
  g.append('text')
    .attr('class', 'node-label')
    .attr('x', cx).attr('y', 52)
    .text(((p.gikuyu_name || '') + ' ' + (p.fathers_name || '')).trim());
  g.append('text')
    .attr('class', 'node-sublabel')
    .attr('x', cx).attr('y', 66)
    .text(p.other_names || '');
  if (deceased && p.death_year) {
    g.append('text')
      .attr('class', 'deceased-year')
      .attr('x', cx).attr('y', 82)
      .text('\u2020 ' + p.death_year);
  }
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

  const { spouseOf } = buildSpouseMaps();

  const treeLayout = d3.tree()
    .nodeSize([200, 150])
    .separation((a, b) => {
      const wed = d => d.data && spouseOf[d.data.person_id] !== undefined;
      const aWed = wed(a), bWed = wed(b);
      const base = a.parent === b.parent ? 1.2 : 1.8;
      return base + (aWed && bWed ? 0.5 : 0.2);
    });

  const hierarchyRoot = d3.hierarchy(root);

  // Congestion control: move every collapsed branch into _children so the
  // layout, links, and descendants skip it (standard d3 collapse pattern).
  hierarchyRoot.each(d => {
    if (d.children && d.children.length && collapsedClusters.has(d.data.person_id)) {
      d._children = d.children;
      d.children = null;
    }
  });

  treeLayout(hierarchyRoot);

  // Clear ghost/clipping icons from the layout before rendering fresh nodes.
  clearGhostNodes(hierarchyRoot.descendants(), relationships);
  const nodes = hierarchyRoot.descendants();
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
    .attr('class', 'link')
    .attr('d', d => {
      const sx = d.source.x;
      const sy = d.source.y + (d.source.data.person_id === '__virtual__' ? 16 : 44);
      const tx = d.target.x;
      const ty = d.target.y - 44;
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
    const spouseId = spouseOf[data.person_id];
    const spouse = spouseId ? getPerson(spouseId) : null;

    if (spouse) {
      g.append('line')
        .attr('class', 'spouse-bridge')
        .attr('x1', -SPOUSE_GAP + 32)
        .attr('y1', 0)
        .attr('x2', SPOUSE_GAP - 32)
        .attr('y2', 0);
    }

    const primaryCx = spouse ? -SPOUSE_GAP : 0;
    const pid1 = data.person_id.replace(/[^a-zA-Z0-9_-]/g, '') + '_' + (attrs.count++);
    renderAvatar(g, data, primaryCx, pid1);
    renderLabels(g, data, primaryCx);

    if (!isDeceased(data)) {
      g.append('circle')
        .attr('class', 'living-dot')
        .attr('cx', primaryCx + 24)
        .attr('cy', -26)
        .attr('r', 6);
    }

    if (spouse) {
      const pid2 = spouse.person_id.replace(/[^a-zA-Z0-9_-]/g, '') + '_' + (attrs.count++);
      const sg = renderAvatar(g, spouse, SPOUSE_GAP, pid2);
      renderLabels(g, spouse, SPOUSE_GAP);
      if (!isDeceased(spouse)) {
        g.append('circle')
          .attr('class', 'living-dot')
          .attr('cx', SPOUSE_GAP + 24)
          .attr('cy', -26)
          .attr('r', 6);
      }
      sg.raise();
    }

    // Congestion toggle badge: appears on the primary avatar's bottom rim when
    // this cluster has a child branch. Shows "−" when the branch is in view
    // (click to collapse) and "+" when it is hidden (click to expand).
    const childTotal = (d.children ? d.children.length : 0) + (d._children ? d._children.length : 0);
    if (childTotal > 0) {
      const isCollapsed = !!(d._children && d._children.length);
      const badge = g.append('g')
        .attr('class', 'collapse-badge')
        .attr('transform', 'translate(' + (primaryCx + 24) + ',' + 28 + ')')
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

// Unified node-selection flow: open the action panel shell, arm the action
// buttons, render the LifeStory feed, and run the permission mask.
function onNodeSelected(selectedPerson, event) {
  dashboardPerson = selectedPerson;
  renderInfoDashboard(selectedPerson);
  setupActionButtons(selectedPerson);
  openModal('info-modal');
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
    escapeHtml(String(person.gender || '')) + ' &middot; <span class="id">' + escapeHtml(String(person.person_id)) + '</span>';

  document.getElementById('info-summary').innerHTML =
    '<div class="summary-label">Summary</div>' +
    '<div class="summary-text">' + escapeHtml(buildLifeSummary(person, counts)) + '</div>';

  document.getElementById('info-timeline').innerHTML = renderLifeStoryTimeline(person);
  populateResearchForm(person);

  switchInfoTab('actions');
}

// Actionable baseline targets for the Actions tab (single source of triggers).
function setupActionButtons(person) {
  const sib = document.getElementById('act-sibling');
  if (sib) sib.style.display = hasLinkedParents(person) ? '' : 'none';
  const del = document.getElementById('act-delete');
  if (del) del.style.display = canManageRecord(person) ? '' : 'none';
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

// Narrative summary pulled from the live record (never persisted).
function buildLifeSummary(person, counts) {
  const birth = parseInt(person.birth_year, 10);
  const name = [person.gikuyu_name, person.fathers_name].filter(Boolean).join(' ') || 'This person';
  const siblingWord = counts.siblingCount === 1 ? 'sibling' : 'siblings';
  const childWord = counts.childrenCount === 1 ? 'child' : 'children';

  let s = (birth && !isNaN(birth))
    ? name + ' was born in ' + birth + (person.place_of_birth ? ' ' + person.place_of_birth : '') + '.'
    : name + ' was born in an unrecorded year.';

  if (String(person.is_living).toUpperCase() !== 'FALSE' && person.place_of_living) {
    s += ' They currently reside in ' + person.place_of_living + '.';
  }

  if (counts.spousesList.length > 0) {
    s += ' They have ' + counts.siblingCount + ' ' + siblingWord + ' and ' +
      counts.childrenCount + ' ' + childWord + ' with ' + counts.spousesList.join(', ') + '.';
  } else {
    s += ' They have ' + counts.siblingCount + ' ' + siblingWord + ' and ' +
      counts.childrenCount + ' ' + childWord + '.';
  }
  return s;
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
function generateChronologicalLifeStory(targetPerson, persons, relationships) {
  let events = [];
  const targetId = targetPerson.person_id;
  const live = String(targetPerson.is_living).toUpperCase() === 'TRUE';

  // 1. Core Event: Birth (origin + current residence blended in)
  if (targetPerson.birth_year) {
    const pBirth = targetPerson.place_of_birth ? ' in ' + targetPerson.place_of_birth : '';
    const pLiving = (live && targetPerson.place_of_living) ? ' They currently reside in ' + targetPerson.place_of_living + '.' : '';
    events.push({
      year: parseInt(targetPerson.birth_year, 10),
      title: "Birth",
      description: `${targetPerson.gikuyu_name} ${targetPerson.fathers_name} ${targetPerson.other_names} was born in the year ${targetPerson.birth_year}${pBirth}.${pLiving}`
    });
  }

  // 2. Traversal Event: Birth of Children (each child's place of birth)
  const childLinks = relationships.filter(r => r.parent_id === targetId && r.rel_type !== "Spouse");
  childLinks.forEach(link => {
    const child = persons.find(p => p.person_id === link.child_id);
    if (child && child.birth_year) {
      const childPlace = child.place_of_birth ? ' in ' + child.place_of_birth : '';
      events.push({
        year: parseInt(child.birth_year, 10),
        title: "Birth of child",
        description: `Their child, ${child.gikuyu_name} ${child.fathers_name} ${child.other_names || ''}, was born in the year ${child.birth_year}${childPlace}.`
      });
    }
  });

  // 3. Traversal Event: Death of Parents (each parent's place of death)
  const parentLinks = relationships.filter(r => r.child_id === targetId && r.rel_type !== "Spouse");
  parentLinks.forEach(link => {
    const parent = persons.find(p => p.person_id === link.parent_id);
    if (parent && parent.death_year) {
      const parentDeathPlace = parent.place_of_death ? ' in ' + parent.place_of_death : '';
      events.push({
        year: parseInt(parent.death_year, 10),
        title: `Death of ${parent.gender === 'Male' ? 'father' : 'mother'}`,
        description: `Their ${parent.gender === 'Male' ? 'father' : 'mother'}, ${parent.gikuyu_name} ${parent.fathers_name}, passed away in the year ${parent.death_year}${parentDeathPlace}.`
      });
    }
  });

  // 4. Core Event: Death of the target (place + computed age)
  if (!live || targetPerson.death_year) {
    const dYear = parseInt(targetPerson.death_year, 10);
    if (dYear) {
      const pDeath = targetPerson.place_of_death ? ' in ' + targetPerson.place_of_death : '';
      const birth = parseInt(targetPerson.birth_year, 10);
      const ageClause = (birth && !isNaN(birth)) ? ' at the age of ' + (dYear - birth) + ' years' : '';
      events.push({
        year: dYear,
        title: "Death",
        description: `${targetPerson.gikuyu_name} passed away in the year ${targetPerson.death_year}${pDeath}${ageClause}.`
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
    '<div class="timeline-year-marker">' + escapeHtml(String(ev.year)) + '</div>' +
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
  document.getElementById('ir-place-birth').value = person.place_of_birth || '';
  document.getElementById('ir-place-living').value = person.place_of_living || '';
  document.getElementById('ir-place-death').value = person.place_of_death || '';
  document.getElementById('ir-living').value = isDeceased(person) ? 'false' : 'true';
  syncLivingUI('ir');
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
  if (photo) {
    data.base64Image = photo.base64Image;
    data.mimeType = photo.mimeType;
  } else if (photoUrlEntry) {
    data.photo_url = convertToDirectStreamUrl(photoUrlEntry);
  }

  const res = await apiPost(Object.assign({ action: 'updatePerson' }, data));
  if (!res.success) {
    showToast('Error: ' + (res.error || ''));
    return;
  }

  showToast('Profile updated');
  await loadData();
  const fresh = persons.find(p => p.person_id === person.person_id) || person;
  dashboardPerson = fresh;
  renderInfoDashboard(fresh);
  switchInfoTab('research');
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

function aggregateFamilyCounts(targetPersonId, relationships, persons) {
  // 1. Calculate Children Count (Excluding spouse relationship rows)
  const childrenLinks = relationships.filter(r => r.parent_id === targetPersonId && r.rel_type !== "Spouse");

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
    siblingCount: siblingIds.size,
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
  closeCrop();
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
  document.getElementById('pf-living').value = 'true';
  syncLivingUI('pf');
  document.getElementById('pf-photo').value = '';
  delete document.getElementById('pf-photo').dataset.croppedDataUrl;
  delete document.getElementById('pf-photo').dataset.croppedMime;
  document.getElementById('pf-photo-preview').src = '';
  document.getElementById('pf-photo-preview').classList.remove('has-photo');

  if (linkParent && linkType === 'child') {
    document.getElementById('pf-father').value = linkParent.gikuyu_name;
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
  if (photo) {
    data.base64Image = photo.base64Image;
    data.mimeType = photo.mimeType;
  }

  if (id) {
    data.person_id = id;
    const res = await apiPost(Object.assign({ action: 'updatePerson' }, data));
    showToast(res.success ? 'Person updated' : 'Error: ' + (res.error || ''));
  } else {
    const dup = persons.find(p =>
      p.gikuyu_name && p.gikuyu_name.toLowerCase() === gikuyu.toLowerCase() &&
      p.fathers_name && p.fathers_name.toLowerCase() === fathers.toLowerCase()
    );
    if (dup && !confirm(fullName(dup) + ' already exists in the tree. Create a duplicate anyway?')) {
      return;
    }
    const res = await apiPost(Object.assign({ action: 'createPerson', created_by: currentUserToken }, data));
    if (res.success) {
      const newId = res.person_id;
      if (linkParentId && linkType === 'parent') {
        const relation = document.getElementById('pf-relation').value;
        await apiPost({
          action: 'createRelationship',
          parent_id: newId,
          child_id: linkParentId,
          rel_type: relation === 'mother' ? 'Mother-Child' : 'Father-Child',
          created_by: currentUserToken
        });
      } else if (linkParentId && linkType === 'child') {
        await apiPost({
          action: 'createRelationship',
          parent_id: linkParentId,
          child_id: newId,
          rel_type: data.gender === 'Female' ? 'Mother-Child' : 'Father-Child',
          created_by: currentUserToken
        });
      } else if (linkParentId && linkType === 'sibling') {
        // Re-link the new person to every parent of the selected sibling, using
        // the same relationship type (Father-Child / Mother-Child) each parent had.
        const siblingParents = relationships.filter(r =>
          r.child_id === linkParentId && /father|mother/i.test(r.rel_type || ''));
        for (const pr of siblingParents) {
          await apiPost({
            action: 'createRelationship',
            parent_id: pr.parent_id,
            child_id: newId,
            rel_type: pr.rel_type,
            created_by: currentUserToken
          });
        }
      } else if (linkParentId && linkType === 'spouse') {
        await apiPost({
          action: 'createRelationship',
          parent_id: linkParentId,
          child_id: newId,
          rel_type: 'Spouse',
          created_by: currentUserToken
        });
      }
      showToast('Person added');
    } else {
      showToast('Error: ' + (res.error || ''));
    }
  }

  closeModal('person-modal');
  await loadData();
}

// ============================================================
// Delete
// ============================================================
function openDeleteModal(node) {
  document.getElementById('delete-confirm-btn').onclick = async () => {
    const res = await apiPost({ action: 'deletePerson', person_id: node.person_id, user_token: currentUserToken });
    showToast(res.success ? 'Person deleted' : 'Error: ' + (res.error || ''));
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

  if (linkDir === 'father' || linkDir === 'mother') {
    const res = await apiPost({
      action: 'createRelationship',
      parent_id: other.person_id,
      child_id: node.person_id,
      rel_type: linkDir === 'mother' ? 'Mother-Child' : 'Father-Child',
      created_by: currentUserToken
    });
    showToast(res.success ? 'Parent link created' : 'Error: ' + (res.error || ''));
  } else if (linkDir === 'son' || linkDir === 'daughter') {
    const res = await apiPost({
      action: 'createRelationship',
      parent_id: node.person_id,
      child_id: other.person_id,
      rel_type: node.gender === 'Female' ? 'Mother-Child' : 'Father-Child',
      created_by: currentUserToken
    });
    showToast(res.success ? 'Child link created' : 'Error: ' + (res.error || ''));
  } else {
    const res = await apiPost({
      action: 'createRelationship',
      parent_id: node.person_id,
      child_id: other.person_id,
      rel_type: 'Spouse',
      created_by: currentUserToken
    });
    showToast(res.success ? 'Spouse link created' : 'Error: ' + (res.error || ''));
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
  const res = await apiPost({ action: 'deleteRelationship', relationship_id: relId, user_token: currentUserToken });
  showToast(res.success ? 'Relationship removed' : 'Error: ' + (res.error || ''));
  await loadData();
}

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
  banner.textContent = '👈 Tap on the profile of your closest relative (Father, Mother, Spouse, or Sibling) directly on the tree layout';
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

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && window.isOnboardingSelectionMode) {
    cancelOnboardingSelection();
  }
});

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
  document.getElementById('ob-living').value = isDeceased(obSelectedPerson) ? 'false' : 'true';
  syncLivingUI('ob');
  document.getElementById('ob-new-form').style.display = 'block';
}

async function onboardSubmitNew() {
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
    const res = await apiPost({
      action: 'createRelationship', parent_id: parentId, child_id: childId,
      rel_type: relType, created_by: currentUserToken
    });
    if (res && res.success) ok++; else failed++;
  };

  switch (relation) {
    case 'parent': {
      // The selected relative is the user's parent.
      const relType = (relative.gender === 'Female' || relative.gender === 'F') ? 'Mother-Child' : 'Father-Child';
      await createLink(relative.person_id, userId, relType);
      break;
    }
    case 'child': {
      // The selected relative is the user's child.
      const relType = (document.getElementById('ob-gender').value === 'Female') ? 'Mother-Child' : 'Father-Child';
      await createLink(userId, relative.person_id, relType);
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
    const res = await apiPost({
      action: 'createRelationship', parent_id: parentId, child_id: newId,
      rel_type: relType, created_by: currentUserToken
    });
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

window.addEventListener('load', async () => {
  await loadData();
  checkOnboarding();
});

window.addEventListener('resize', () => {
  renderTree();
});