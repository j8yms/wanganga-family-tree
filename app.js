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

// Drag-to-link state: any real drag suppresses the node's click (radial menu)
// for a short window so a drop never also opens the menu.
let pendingDragLink = null;
let suppressNodeClickUntil = 0;

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
    try {
      if (!localStorage.getItem('wanganga_schema_ok')) {
        await apiGet('init');
        localStorage.setItem('wanganga_schema_ok', '1');
      }
    } catch (e) { /* ignore — init is best-effort */ }
    schemaReady = true;
  }
  const data = await apiGet('getAll');
  if (!data.success) {
    showToast('Error loading data: ' + (data.error || 'Unknown'));
    return;
  }
  persons = (data.persons || []).filter(p => p.person_id && (p.gikuyu_name || p.fathers_name));
  relationships = (data.relationships || []).filter(r => r.relationship_id && r.parent_id && r.child_id && r.rel_type);
  renderTree();
}

// ============================================================
// Helpers
// ============================================================
function buildSpouseMaps() {
  const spouseOf = {};
  const spousesOf = {};
  const primaryOf = {};
  relationships.forEach(r => {
    if (r.rel_type && String(r.rel_type).toLowerCase() === 'spouse') {
      spouseOf[r.parent_id] = r.child_id;
      if (!spousesOf[r.parent_id]) spousesOf[r.parent_id] = [];
      spousesOf[r.parent_id].push(r.child_id);
      primaryOf[r.child_id] = r.parent_id;
    }
  });
  return { spouseOf, spousesOf, primaryOf };
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
    if (mom) { attachUnder[pid] = mom; }
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
// Ghost-Node / Collision Cleanup
// ============================================================
// Wives are real hierarchy nodes positioned beside their key partner, and the
// D3 tree engine computes every x-offset from leaf counts, so adjacent families
// automatically push apart (no manual ghost icons or slam-shifting needed).
// The only post-layout adjustment is snapping each wife node UP onto her key
// partner's row so the couple renders side by side while their children still
// hang vertically beneath the wife.
function snapWivesToPartnerRow(nodes) {
  nodes.forEach(n => {
    if (n.data && n.data.isWife && n.parent) {
      n.y = n.parent.y;
    }
  });
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
    if (Date.now() < suppressNodeClickUntil) return; // just finished a drag
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
    .text(((p.gikuyu_name || '') + (p.fathers_name ? ' wa ' + p.fathers_name : '')).trim());
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

  // Adaptive spacing: widen columns so long "Gikuyu wa Father" names and
  // couple blocks never crowd, and open the generation gap so labels don't
  // collide between rows.
  let longestLabel = 12 * 7.2;
  persons.forEach(p => {
    const lbl = ((p.gikuyu_name || '') + ' wa ' + (p.fathers_name || '')).trim();
    longestLabel = Math.max(longestLabel, lbl.length * 7.2);
  });
  let maxFanout = 1;
  hierarchyRoot.each(n => { if (n.children) maxFanout = Math.max(maxFanout, n.children.length); });
  const colSpace = Math.max(longestLabel + 60, 240, 240 + (maxFanout - 8) * 12);
  const rowSpace = Math.max(200, longestLabel / 3.5 + 130);

  // Polygynous union blocks: the D3 tree assigns every sibling its own
  // horizontal column (proportional to leaf counts), so wives and their child
  // clusters automatically spread apart as people are added. Separation just
  // adds a little breathing room between adjacent nodes.
  const treeLayout = d3.tree()
    .nodeSize([colSpace, rowSpace])
    .separation((a, b) => (a.parent === b.parent ? 1.25 : 1.8));

  // Congestion control: move every collapsed branch into _children so the
  // layout, links, and descendants skip it (standard d3 collapse pattern).
  hierarchyRoot.each(d => {
    if (d.children && d.children.length && collapsedClusters.has(d.data.person_id)) {
      d._children = d.children;
      d.children = null;
    }
  });

  treeLayout(hierarchyRoot);

  // Lift each wife onto her key partner's row so the couple renders side by
  // side while the children stay hanging vertically beneath the wife.
  snapWivesToPartnerRow(hierarchyRoot.descendants());
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
    .attr('class', d => (Math.abs(d.source.y - d.target.y) < 2) ? 'link marriage' : 'link')
    .attr('d', d => {
      const sx = d.source.x;
      const sy = d.source.y + (d.source.data.person_id === '__virtual__' ? 16 : 44);
      const tx = d.target.x;
      const ty = d.target.y - 44;

      // Marriage bar: wife lifted onto the key partner's row -> straight
      // horizontal line stretched between the two avatar rims.
      if (Math.abs(d.source.y - d.target.y) < 2) {
        const cy = d.source.y;
        const dir = tx >= sx ? 1 : -1;
        return 'M' + (sx + dir * 40) + ',' + cy + ' L' + (tx - dir * 40) + ',' + cy;
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
    renderAvatar(g, data, 0, pid1);
    renderLabels(g, data, 0);

    if (!isDeceased(data)) {
      g.append('circle')
        .attr('class', 'living-dot')
        .attr('cx', 24)
        .attr('cy', -26)
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
        .attr('transform', 'translate(24,28)')
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
    ? name + ' was born ' + datePhrase(person.birth_year, person.birth_qualifier, person.birth_month, person.birth_day) + (person.place_of_birth ? ' in ' + person.place_of_birth : '') + '.'
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
  if (q === 'during') return 'around ' + exact;
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

// "born by Kamau and Wanjiku" (or just one parent when only one is known).
function bornByParents(targetPerson) {
  const parents = parentsOf(targetPerson.person_id);
  const father = parents.find(p2 => String(p2.gender).toLowerCase().indexOf('male') !== -1 || /father/i.test(String(p2.gender)));
  const mother = parents.find(p2 => String(p2.gender).toLowerCase().indexOf('female') !== -1 || /mother/i.test(String(p2.gender)));
  const main = [father || parents[0], mother].filter(Boolean);
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
  } finally {
    if (saveBtn) saveBtn.disabled = false;
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
      const res = await apiPost(Object.assign({ action: 'updatePerson' }, data));
      showToast(res.success ? 'Person updated' : 'Error: ' + (res.error || ''));
    } else {
      const res = await apiPost(Object.assign({ action: 'createPerson', created_by: currentUserToken }, data));
      if (res.success) {
        const newId = res.person_id;
        let linked = true;
        if (linkParentId && linkType === 'parent') {
          const relation = document.getElementById('pf-relation').value;
          const lres = await apiPost({
            action: 'createRelationship',
            parent_id: newId,
            child_id: linkParentId,
            rel_type: relation === 'mother' ? 'Mother-Child' : 'Father-Child',
            created_by: currentUserToken
          });
          linked = lres.success;
        } else if (linkParentId && linkType === 'child') {
          const linkParent = getPerson(linkParentId);
          const lres = await apiPost({
            action: 'createRelationship',
            parent_id: linkParentId,
            child_id: newId,
            // The link type follows the PARENT being clicked: clicking a wife
            // (Mother-Child) or a father correctly clusters the child under the
            // specific mother's union block.
            rel_type: linkParent && linkParent.gender === 'Female' ? 'Mother-Child' : 'Father-Child',
            created_by: currentUserToken
          });
          linked = lres.success;
        } else if (linkParentId && linkType === 'sibling') {
          // Re-link the new person to every parent of the selected sibling, using
          // the same relationship type (Father-Child / Mother-Child) each parent had.
          const siblingParents = relationships.filter(r =>
            r.child_id === linkParentId && /father|mother/i.test(r.rel_type || ''));
          linked = true;
          for (const pr of siblingParents) {
            const lres = await apiPost({
              action: 'createRelationship',
              parent_id: pr.parent_id,
              child_id: newId,
              rel_type: pr.rel_type,
              created_by: currentUserToken
            });
            if (!lres.success) linked = false;
          }
        } else if (linkParentId && linkType === 'spouse') {
          // Anchor to the primary partner: a spouse must always be keyed on the
          // person who owns a real tree-node cluster, or they become a root and
          // jump to the very top of the tree.
          const anchor = resolvePrimaryAnchor(linkParentId);
          const lres = await apiPost({
            action: 'createRelationship',
            parent_id: anchor,
            child_id: newId,
            rel_type: 'Spouse',
            created_by: currentUserToken
          });
          linked = lres.success;
        }

        if (!linked) {
          // Roll back so an unlinked person never appears as an orphaned root.
          await apiPost({ action: 'deletePerson', person_id: newId });
          showToast('Person added, but linking to the tree failed and was reverted.');
          return;
        }
        showToast('Person added');
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
      // Follow the clicked person's gender so a wife clicked as the parent
      // creates a Mother-Child link (children cluster under her union block).
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
    return apiPost({
      action: 'createRelationship',
      parent_id: anchor,
      child_id: childId,
      rel_type: 'Spouse',
      created_by: currentUserToken
    });
  }
  if (kind === 'child') {
    const relType = (String(target.gender || '').toLowerCase() === 'female' || String(target.gender) === 'F')
      ? 'Mother-Child' : 'Father-Child';
    return apiPost({
      action: 'createRelationship',
      parent_id: target.person_id,
      child_id: source.person_id,
      rel_type: relType,
      created_by: currentUserToken
    });
  }
  // parent
  const relType = (String(source.gender || '').toLowerCase() === 'female' || String(source.gender) === 'F')
    ? 'Mother-Child' : 'Father-Child';
  return apiPost({
    action: 'createRelationship',
    parent_id: source.person_id,
    child_id: target.person_id,
    rel_type: relType,
    created_by: currentUserToken
  });
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

window.addEventListener('load', async () => {
  await loadData();
  checkOnboarding();
});

window.addEventListener('resize', () => {
  renderTree();
});