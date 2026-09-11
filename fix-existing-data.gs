// ============================================================
// DATA CLEANUP SCRIPT - Run this in Google Apps Script console
// Fixes existing relationships so children are linked to ALL parents
// ============================================================

function fixExistingRelationships() {
  var ss = SpreadsheetApp.openById(getSpreadsheetId());
  var pSheet = ss.getSheetByName('Persons');
  var rSheet = ss.getSheetByName('Relationships');
  
  var persons = sheetToJSON(PERSONS_SHEET);
  var relationships = sheetToJSON(RELATIONSHIPS_SHEET);
  
  var personMap = {};
  persons.forEach(function(p) { personMap[p.person_id] = p; });
  
  // Build spouse maps
  var spouseOf = {};      // parent_id -> [child_ids] (spouses)
  var primaryOf = {};     // child_id -> parent_id (who is primary in spouse pair)
  
  relationships.forEach(function(r) {
    if (r.rel_type && String(r.rel_type).toLowerCase() === 'spouse') {
      if (!spouseOf[r.parent_id]) spouseOf[r.parent_id] = [];
      spouseOf[r.parent_id].push(r.child_id);
      primaryOf[r.child_id] = r.parent_id;
    }
  });
  
  // Get all spouses in a cluster (handles polygamy)
  function getAllSpouses(personId) {
    var spouses = [];
    var seen = new Set();
    var cur = personId;
    
    // Find primary anchor
    while (primaryOf[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = primaryOf[cur];
    }
    
    // Get spouses of anchor
    if (spouseOf[cur]) {
      spouseOf[cur].forEach(function(id) { spouses.push(id); });
    }
    return spouses;
  }
  
  // Get all parents of a child
  function getParentsOfChild(childId) {
    return relationships
      .filter(function(r) { 
        return r.child_id === childId && /father|mother/i.test(String(r.rel_type || '')); 
      })
      .map(function(r) { return { parentId: r.parent_id, relType: r.rel_type }; });
  }
  
  // Build existing relationship lookup for deduping
  var existingRels = new Set();
  relationships.forEach(function(r) {
    var key = r.parent_id + '|' + r.child_id + '|' + r.rel_type;
    existingRels.add(key);
  });
  
  var newRelationships = [];
  var stats = { added: 0, skipped: 0, totalChildren: 0 };
  
  // For each person who has at least one parent, ensure they're linked to ALL parents in the cluster
  persons.forEach(function(person) {
    var parents = getParentsOfChild(person.person_id);
    if (parents.length === 0) return;
    
    stats.totalChildren++;
    
    // Find the father (first male parent)
    var father = parents.find(function(p) { 
      var par = personMap[p.parentId];
      return par && String(par.gender || '').toLowerCase().indexOf('male') !== -1; 
    });
    
    if (!father) {
      // No father found, just use first parent
      father = parents[0];
    }
    
    // Get all spouses of the father (all wives)
    var allParents = [father.parentId].concat(getAllSpouses(father.parentId));
    
    // Add missing relationships
    allParents.forEach(function(parentId) {
      if (parentId === person.person_id) return; // skip self
      
      var parent = personMap[parentId];
      if (!parent) return;
      
      var relType = (parent.gender === 'Female' || parent.gender === 'F') ? 'Mother-Child' : 'Father-Child';
      var key = parentId + '|' + person.person_id + '|' + relType;
      
      if (!existingRels.has(key)) {
        var relId = Utilities.getUuid();
        newRelationships.push([relId, parentId, person.person_id, relType, '', currentUserToken || 'cleanup_script']);
        existingRels.add(key);
        stats.added++;
        Logger.log('Added: ' + (parent.gikuyu_name || parentId) + ' -> ' + (person.gikuyu_name || person.person_id) + ' (' + relType + ')');
      } else {
        stats.skipped++;
      }
    });
  });
  
  // Write new relationships to sheet
  if (newRelationships.length > 0) {
    rSheet.getRange(rSheet.getLastRow() + 1, 1, newRelationships.length, 6).setValues(newRelationships);
  }
  
  Logger.log('=== CLEANUP COMPLETE ===');
  Logger.log('Total children processed: ' + stats.totalChildren);
  Logger.log('New relationships added: ' + stats.added);
  Logger.log('Already existed (skipped): ' + stats.skipped);
  
  return {
    success: true,
    stats: stats,
    newRelationshipsCount: newRelationships.length
  };
}

// ============================================================
// REMOVE DUPLICATE RELATIONSHIPS
// ============================================================
function removeDuplicateRelationships() {
  var rSheet = getSheet(RELATIONSHIPS_SHEET);
  var data = rSheet.getDataRange().getValues();
  if (data.length < 2) return { success: true, removed: 0 };
  
  var headers = data[0];
  var seen = new Set();
  var rowsToDelete = [];
  
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    var parentId = row[headers.indexOf('parent_id')];
    var childId = row[headers.indexOf('child_id')];
    var relType = row[headers.indexOf('rel_type')];
    var key = parentId + '|' + childId + '|' + relType;
    
    if (seen.has(key)) {
      rowsToDelete.push(i + 1); // 1-indexed
    } else {
      seen.add(key);
    }
  }
  
  // Delete from bottom up to preserve row indices
  rowsToDelete.sort(function(a, b) { return b - a; });
  rowsToDelete.forEach(function(rowNum) {
    rSheet.deleteRow(rowNum);
  });
  
  Logger.log('Removed ' + rowsToDelete.length + ' duplicate relationships');
  return { success: true, removed: rowsToDelete.length };
}

// ============================================================
// FIX ORPHANED SPOUSES (spouses not linked to primary anchor)
// ============================================================
function fixOrphanedSpouses() {
  var relationships = sheetToJSON(RELATIONSHIPS_SHEET);
  var persons = sheetToJSON(PERSONS_SHEET);
  var personMap = {};
  persons.forEach(function(p) { personMap[p.person_id] = p; });
  
  // Find spouse relationships where child_id is not pointing to primary anchor
  var spouseRels = relationships.filter(function(r) {
    return r.rel_type && String(r.rel_type).toLowerCase() === 'spouse';
  });
  
  var primaryOf = {};
  spouseRels.forEach(function(r) {
    primaryOf[r.child_id] = r.parent_id;
  });
  
  var rSheet = getSheet(RELATIONSHIPS_SHEET);
  var data = rSheet.getDataRange().getValues();
  var headers = data[0];
  var parentIdCol = headers.indexOf('parent_id');
  var childIdCol = headers.indexOf('child_id');
  var relTypeCol = headers.indexOf('rel_type');
  var relIdCol = headers.indexOf('relationship_id');
  
  var fixed = 0;
  
  for (var i = data.length - 1; i >= 1; i--) {
    var row = data[i];
    if (String(row[relTypeCol]).toLowerCase() !== 'spouse') continue;
    
    var parentId = row[parentIdCol];
    var childId = row[childIdCol];
    
    // Find primary anchor for this spouse pair
    var cur = parentId;
    var seen = new Set();
    while (primaryOf[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = primaryOf[cur];
    }
    var anchor = cur;
    
    // If this relationship doesn't use the anchor as parent, fix it
    if (parentId !== anchor) {
      var rowNum = i + 1;
      rSheet.getRange(rowNum, parentIdCol + 1).setValue(anchor);
      fixed++;
      Logger.log('Fixed spouse link: ' + parentId + ' -> ' + anchor + ' (spouse: ' + childId + ')');
    }
  }
  
  Logger.log('Fixed ' + fixed + ' orphaned spouse relationships');
  return { success: true, fixed: fixed };
}

// ============================================================
// RUN ALL FIXES
// ============================================================
function runAllFixes() {
  Logger.log('=== STARTING FULL TREE CLEANUP ===');
  
  var result1 = removeDuplicateRelationships();
  Logger.log('Step 1 - Remove duplicates: ' + result1.removed + ' removed');
  
  var result2 = fixOrphanedSpouses();
  Logger.log('Step 2 - Fix orphaned spouses: ' + result2.fixed + ' fixed');
  
  var result3 = fixExistingRelationships();
  Logger.log('Step 3 - Link children to all parents: ' + result3.stats.added + ' added');
  
  Logger.log('=== ALL FIXES COMPLETE ===');
  return {
    duplicatesRemoved: result1.removed,
    spousesFixed: result2.fixed,
    relationshipsAdded: result3.stats.added,
    totalChildrenProcessed: result3.stats.totalChildren
  };
}

// ============================================================
// PREVIEW WHAT WOULD CHANGE (dry run)
// ============================================================
function previewFixes() {
  var persons = sheetToJSON(PERSONS_SHEET);
  var relationships = sheetToJSON(RELATIONSHIPS_SHEET);
  
  var personMap = {};
  persons.forEach(function(p) { personMap[p.person_id] = p; });
  
  var spouseOf = {};
  var primaryOf = {};
  relationships.forEach(function(r) {
    if (r.rel_type && String(r.rel_type).toLowerCase() === 'spouse') {
      if (!spouseOf[r.parent_id]) spouseOf[r.parent_id] = [];
      spouseOf[r.parent_id].push(r.child_id);
      primaryOf[r.child_id] = r.parent_id;
    }
  });
  
  function getAllSpouses(personId) {
    var spouses = [];
    var seen = new Set();
    var cur = personId;
    while (primaryOf[cur] && !seen.has(cur)) {
      seen.add(cur);
      cur = primaryOf[cur];
    }
    if (spouseOf[cur]) {
      spouseOf[cur].forEach(function(id) { spouses.push(id); });
    }
    return spouses;
  }
  
  function getParentsOfChild(childId) {
    return relationships
      .filter(function(r) { 
        return r.child_id === childId && /father|mother/i.test(String(r.rel_type || '')); 
      })
      .map(function(r) { return { parentId: r.parent_id, relType: r.rel_type }; });
  }
  
  var existingRels = new Set();
  relationships.forEach(function(r) {
    var key = r.parent_id + '|' + r.child_id + '|' + r.rel_type;
    existingRels.add(key);
  });
  
  var wouldAdd = [];
  
  persons.forEach(function(person) {
    var parents = getParentsOfChild(person.person_id);
    if (parents.length === 0) return;
    
    var father = parents.find(function(p) { 
      var par = personMap[p.parentId];
      return par && String(par.gender || '').toLowerCase().indexOf('male') !== -1; 
    }) || parents[0];
    
    var allParents = [father.parentId].concat(getAllSpouses(father.parentId));
    
    allParents.forEach(function(parentId) {
      if (parentId === person.person_id) return;
      var parent = personMap[parentId];
      if (!parent) return;
      
      var relType = (parent.gender === 'Female' || parent.gender === 'F') ? 'Mother-Child' : 'Father-Child';
      var key = parentId + '|' + person.person_id + '|' + relType;
      
      if (!existingRels.has(key)) {
        wouldAdd.push({
          parent: parent.gikuyu_name + ' ' + parent.fathers_name,
          child: person.gikuyu_name + ' ' + person.fathers_name,
          relType: relType
        });
      }
    });
  });
  
  Logger.log('=== DRY RUN PREVIEW ===');
  Logger.log('Would add ' + wouldAdd.length + ' new relationships:');
  wouldAdd.forEach(function(r) {
    Logger.log('  ' + r.parent + ' -> ' + r.child + ' (' + r.relType + ')');
  });
  
  return { wouldAdd: wouldAdd, count: wouldAdd.length };
}