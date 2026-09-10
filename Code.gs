// ============================================================
// Google Apps Script Backend - Family Tree API
// Bound to a Google Sheet with two sheets:
//   Table A: "Persons" (person_id, gikuyu_name, fathers_name, other_names, gender, is_living, birth_year, photo_url, death_year, created_by)
//   Table B: "Relationships" (relationship_id, parent_id, child_id, rel_type, spouse_link_id, created_by)
// ============================================================

var PERSONS_SHEET = 'Persons';
var RELATIONSHIPS_SHEET = 'Relationships';

// REDACTED: the spreadsheet ID is NOT stored in this file. It is read from the
// Script Property "SPREADSHEET_ID". Set it once in Project Settings > Script
// Properties (key: SPREADSHEET_ID, value: your Google Sheet ID) before running.
function getSpreadsheetId() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id || !String(id).trim()) {
    throw new Error('SPREADSHEET_ID not configured. Go to Project Settings > Script Properties and add key SPREADSHEET_ID with your Google Sheet ID.');
  }
  return String(id).trim();
}

var PERSON_HEADERS = ['person_id', 'gikuyu_name', 'fathers_name', 'other_names', 'gender', 'is_living', 'birth_year', 'photo_url', 'death_year', 'created_by'];
var RELATIONSHIP_HEADERS = ['relationship_id', 'parent_id', 'child_id', 'rel_type', 'spouse_link_id', 'created_by'];

// ---- Super-admin override ----
// The admin token is read from the Script Property "SUPERADMIN_TOKEN" so you
// can rotate it anytime with no redeploy. For a quick start it falls back to
// DEFAULT_SUPERADMIN_TOKEN below; once you set the property that value wins.
// **IMPORTANT:** delete DEFAULT_SUPERADMIN_TOKEN as soon as your Script
// Property is configured, so the secret no longer lives in source code.
var DEFAULT_SUPERADMIN_TOKEN = 'Kenya254';

function getSuperAdminToken() {
  var props = PropertiesService.getScriptProperties().getProperty('SUPERADMIN_TOKEN');
  return (props && String(props).trim()) ? String(props).trim() : DEFAULT_SUPERADMIN_TOKEN;
}

function setAdminToken(newToken) {
  if (!newToken || String(newToken).length < 8) {
    throw new Error('Token must be at least 8 characters.');
  }
  PropertiesService.getScriptProperties().setProperty('SUPERADMIN_TOKEN', String(newToken));
  return 'Admin token updated.';
}

function isSuperAdminToken(t) {
  var stored = getSuperAdminToken();
  return !!stored && stored.length >= 8 && String(stored) === String(t || '');
}

// A write is allowed when the caller either owns the record (has the creator's
// token) or presents the super-admin code, or the super-admin code IS the
// creator token passed as user_token.
function ownsOrAdmin(payload, creator) {
  var userToken = String(payload.user_token || '');
  var adminToken = String(payload.admin_token || '');
  var creatorStr = String(creator || '');
  return (userToken !== '' && userToken === creatorStr) || isSuperAdminToken(adminToken) || isSuperAdminToken(userToken);
}

// ---- Input Validation ----

var MAX_NAME_LENGTH = 100;
var MAX_FIELD_LENGTH = 200;
var VALID_GENDERS = ['Male', 'Female'];
var VALID_REL_TYPES = ['Father-Child', 'Mother-Child', 'Spouse'];

function validatePersonInput(payload, isUpdate) {
  var errors = [];
  if (!isUpdate) {
    if (!payload.gikuyu_name || !String(payload.gikuyu_name).trim()) errors.push('gikuyu_name is required');
    if (!payload.fathers_name || !String(payload.fathers_name).trim()) errors.push('fathers_name is required');
  }
  if (payload.gikuyu_name && String(payload.gikuyu_name).length > MAX_NAME_LENGTH) errors.push('gikuyu_name too long (max ' + MAX_NAME_LENGTH + ')');
  if (payload.fathers_name && String(payload.fathers_name).length > MAX_NAME_LENGTH) errors.push('fathers_name too long (max ' + MAX_NAME_LENGTH + ')');
  if (payload.other_names && String(payload.other_names).length > MAX_NAME_LENGTH) errors.push('other_names too long (max ' + MAX_NAME_LENGTH + ')');
  if (payload.gender && VALID_GENDERS.indexOf(payload.gender) === -1) errors.push('gender must be Male or Female');
  if (payload.birth_year && !/^\d{4}$/.test(String(payload.birth_year).trim())) errors.push('birth_year must be YYYY format');
  if (payload.death_year && !/^\d{4}$/.test(String(payload.death_year).trim())) errors.push('death_year must be YYYY format');
  if (payload.base64Image && String(payload.base64Image).length > 50 * 1024 * 1024) errors.push('Image too large (max 50MB)');
  return errors;
}

function validateRelationshipInput(payload) {
  var errors = [];
  if (!payload.parent_id) errors.push('parent_id is required');
  if (!payload.child_id) errors.push('child_id is required');
  if (payload.rel_type && VALID_REL_TYPES.indexOf(payload.rel_type) === -1) errors.push('rel_type must be one of: ' + VALID_REL_TYPES.join(', '));
  if (payload.parent_id && payload.child_id && payload.parent_id === payload.child_id) errors.push('parent_id and child_id cannot be the same');
  return errors;
}

// ---- Helpers ----

function generateUUID() {
  return Utilities.getUuid();
}

function getSheet(name) {
  var ss = SpreadsheetApp.openById(getSpreadsheetId());
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === PERSONS_SHEET) {
      sheet.appendRow(PERSON_HEADERS);
    } else if (name === RELATIONSHIPS_SHEET) {
      sheet.appendRow(RELATIONSHIP_HEADERS);
    }
  }
  return sheet;
}

// One-time migration: append any missing headers to the right of existing columns
function ensureSchema() {
  var pSheet = getSheet(PERSONS_SHEET);
  var pCount = pSheet.getLastColumn();
  for (var i = 0; i < PERSON_HEADERS.length; i++) {
    if (i >= pCount) {
      pSheet.getRange(1, i + 1).setValue(PERSON_HEADERS[i]);
    }
  }
  var rSheet = getSheet(RELATIONSHIPS_SHEET);
  var rCount = rSheet.getLastColumn();
  for (var j = 0; j < RELATIONSHIP_HEADERS.length; j++) {
    if (j >= rCount) {
      rSheet.getRange(1, j + 1).setValue(RELATIONSHIP_HEADERS[j]);
    }
  }
}

function sheetToJSON(sheetName) {
  var sheet = getSheet(sheetName);
  var data = sheet.getDataRange().getValues();
  if (data.length < 1) return [];
  var headers = data[0];
  var result = [];
  for (var i = 1; i < data.length; i++) {
    var row = {};
    for (var j = 0; j < headers.length; j++) {
      row[headers[j]] = data[i][j];
    }
    result.push(row);
  }
  return result;
}

function findRowIndex(sheet, columnName, value) {
  var data = sheet.getDataRange().getValues();
  var headers = data[0];
  var colIndex = headers.indexOf(columnName);
  if (colIndex === -1) return -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][colIndex]) === String(value)) {
      return i + 1; // 1-indexed row number
    }
  }
  return -1;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---- Photo Storage (Google Drive) ----

// Creates the public photo folder on first use so picture <img> tags can render cross-origin
function initPhotoFolder() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("PHOTO_FOLDER_ID");
  if (!folderId) {
    var folder = DriveApp.createFolder("Gikuyu_Family_Tree_Photos");
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    props.setProperty("PHOTO_FOLDER_ID", folder.getId());
  }
  return props.getProperty("PHOTO_FOLDER_ID");
}

// Accepts a base64 data-URL (or raw base64) + mimeType, stores the file in Drive,
// and returns a directly-embeddable public image URL.
function handleImageUpload(base64Image, mimeType, filename) {
  if (!base64Image || !mimeType) return "";
  var folderId = PropertiesService.getScriptProperties().getProperty("PHOTO_FOLDER_ID");
  if (!folderId) folderId = initPhotoFolder();
  var folder = DriveApp.getFolderById(folderId);
  var rawData = String(base64Image).split(",")[1] || String(base64Image);
  var fileData = Utilities.base64Decode(rawData);
  var blob = Utilities.newBlob(fileData, mimeType, filename);
  var file = folder.createFile(blob);
  return "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w400";
}

// ---- GET Handler (JSON API only) ----
// The SPA is hosted on GitHub Pages (index.html + styles.css + app.js).
// This Apps Script is used exclusively as the backend JSON API.
function doGet(e) {
  var action = e && e.parameter && e.parameter.action;

  if (!action) {
    return jsonResponse({ success: false, error: 'This endpoint is the Family Tree API. Use ?action=getAll' });
  }

  try {
    switch (action) {
      case 'init':
        // One-time setup: add new columns and ensure the photo folder exists
        ensureSchema();
        initPhotoFolder();
        return jsonResponse({
          success: true,
          message: 'Schema ensured and photo folder ready'
        });

      case 'getAll':
        var persons = sheetToJSON(PERSONS_SHEET);
        var relationships = sheetToJSON(RELATIONSHIPS_SHEET);
        return jsonResponse({ success: true, persons: persons, relationships: relationships });

      case 'getPersons':
        return jsonResponse({ success: true, persons: sheetToJSON(PERSONS_SHEET) });

      case 'getRelationships':
        return jsonResponse({ success: true, relationships: sheetToJSON(RELATIONSHIPS_SHEET) });

      case 'search':
        var query = (e.parameter.query || '').toLowerCase();
        if (!query) return jsonResponse({ success: true, results: [] });
        var allPersons = sheetToJSON(PERSONS_SHEET);
        var results = allPersons.filter(function(p) {
          var haystack = ((p.gikuyu_name || '') + ' ' + (p.fathers_name || '') + ' ' + (p.other_names || '')).toLowerCase();
          return haystack.indexOf(query) !== -1;
        });
        return jsonResponse({ success: true, results: results });

      case 'getPerson':
        var pid = e.parameter.person_id;
        var allP = sheetToJSON(PERSONS_SHEET);
        var found = allP.filter(function(p) { return p.person_id === pid; });
        return jsonResponse({ success: true, person: found.length > 0 ? found[0] : null });

      default:
        return jsonResponse({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// ---- POST Handler ----

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var action = payload.action;

    switch (action) {

      // ---- SECURE CREATE PERSON ----
      case 'createPerson':
        var createErrors = validatePersonInput(payload, false);
        if (createErrors.length > 0) return jsonResponse({ success: false, error: createErrors.join('; ') });
        var sheet = getSheet(PERSONS_SHEET);
        var newId = generateUUID();
        var uploadedUrl = "";
        if (payload.base64Image && payload.mimeType) {
          uploadedUrl = handleImageUpload(payload.base64Image, payload.mimeType, (payload.gikuyu_name || "photo") + "_" + newId);
        }
        sheet.appendRow([
          newId,
          payload.gikuyu_name || '',
          payload.fathers_name || '',
          payload.other_names || '',
          payload.gender || 'Male',
          payload.is_living !== undefined ? payload.is_living : true,
          payload.birth_year || '',
          uploadedUrl,
          payload.death_year || '',
          payload.created_by || 'Anonymous'
        ]);
        return jsonResponse({ success: true, person_id: newId });

      // ---- UPDATE PERSON ----
      case 'updatePerson':
        var updateErrors = validatePersonInput(payload, true);
        if (updateErrors.length > 0) return jsonResponse({ success: false, error: updateErrors.join('; ') });
        var pSheet = getSheet(PERSONS_SHEET);
        var rowNum = findRowIndex(pSheet, 'person_id', payload.person_id);
        if (rowNum === -1) return jsonResponse({ success: false, error: 'Person not found' });
        var headers = pSheet.getRange(1, 1, 1, pSheet.getLastColumn()).getValues()[0];

        var uCreatorIndex = headers.indexOf('created_by') + 1;
        var uCreator = uCreatorIndex > 0 ? pSheet.getRange(rowNum, uCreatorIndex).getValue() : '';
        if (!ownsOrAdmin(payload, uCreator)) {
          return jsonResponse({ success: false, error: 'Unauthorized: You can only edit entries you created.' });
        }

        if (payload.base64Image && payload.mimeType) {
          payload.photo_url = handleImageUpload(payload.base64Image, payload.mimeType, (payload.gikuyu_name || "photo") + "_" + payload.person_id);
        }

        var fields = ['gikuyu_name', 'fathers_name', 'other_names', 'gender', 'is_living', 'birth_year', 'photo_url', 'death_year'];
        for (var i = 0; i < fields.length; i++) {
          if (payload[fields[i]] !== undefined) {
            var col = headers.indexOf(fields[i]) + 1;
            if (col > 0) {
              pSheet.getRange(rowNum, col).setValue(payload[fields[i]]);
            }
          }
        }
        return jsonResponse({ success: true });

      // ---- MERGE PERSON ----
      case 'mergePerson':
        var mSheet = getSheet(PERSONS_SHEET);
        var mRow = findRowIndex(mSheet, 'person_id', payload.existing_person_id);
        if (mRow === -1) return jsonResponse({ success: false, error: 'Existing person not found' });
        var mHeaders = mSheet.getRange(1, 1, 1, mSheet.getLastColumn()).getValues()[0];

        var mCreatorIndex = mHeaders.indexOf('created_by') + 1;
        var mCreator = mCreatorIndex > 0 ? mSheet.getRange(mRow, mCreatorIndex).getValue() : '';
        var mIsOwnerOrAdmin = ownsOrAdmin(payload, mCreator);
        var mRowValues = mSheet.getRange(mRow, 1, 1, mSheet.getLastColumn()).getValues()[0];

        // Non-owners (e.g. a relative claiming a profile) may only FILL IN blank
        // fields; they cannot overwrite existing information. Owner/admin can.
        if (payload.base64Image && payload.mimeType) {
          var mPhotoIndex = mHeaders.indexOf('photo_url') + 1;
          var mHasPhoto = mPhotoIndex > 0 && String(mRowValues[mPhotoIndex - 1] || '') !== '';
          if (mIsOwnerOrAdmin || !mHasPhoto) {
            payload.photo_url = handleImageUpload(payload.base64Image, payload.mimeType, "merged_" + payload.existing_person_id);
          } else {
            delete payload.photo_url;
          }
        }

        var mFields = ['gikuyu_name', 'fathers_name', 'other_names', 'gender', 'is_living', 'birth_year', 'photo_url', 'death_year'];
        for (var m = 0; m < mFields.length; m++) {
          if (payload[mFields[m]] !== undefined && payload[mFields[m]] !== '' && payload[mFields[m]] !== null) {
            var mCol = mHeaders.indexOf(mFields[m]) + 1;
            if (mCol > 0) {
              var mCurrent = mRowValues[mCol - 1];
              var mBlank = mCurrent === '' || mCurrent === null || mCurrent === undefined;
              if (mIsOwnerOrAdmin || mBlank) {
                mSheet.getRange(mRow, mCol).setValue(payload[mFields[m]]);
              }
            }
          }
        }
        return jsonResponse({ success: true, person_id: payload.existing_person_id, claimed: !mIsOwnerOrAdmin });

      // ---- SECURE DELETE PERSON ----
      case 'deletePerson':
        var dSheet = getSheet(PERSONS_SHEET);
        var dRow = findRowIndex(dSheet, 'person_id', payload.person_id);
        if (dRow === -1) return jsonResponse({ success: false, error: 'Person not found' });

        var pHeaders = dSheet.getRange(1, 1, 1, dSheet.getLastColumn()).getValues()[0];
        var pCreatorIndex = pHeaders.indexOf('created_by') + 1;
        if (pCreatorIndex <= 0) return jsonResponse({ success: false, error: 'Ownership column missing. Run init to migrate the schema.' });
        var originalCreator = dSheet.getRange(dRow, pCreatorIndex).getValue();
        if (!ownsOrAdmin(payload, originalCreator)) {
          return jsonResponse({ success: false, error: 'Unauthorized: You can only delete entries you created.' });
        }

        dSheet.deleteRow(dRow);

        // Remove accompanying relationships matching the original node
        var rSheet = getSheet(RELATIONSHIPS_SHEET);
        var rData = rSheet.getDataRange().getValues();
        var rHeaders = rData[0];
        var pidCol = rHeaders.indexOf('parent_id');
        var cidCol = rHeaders.indexOf('child_id');

        var rowsToDelete = [];
        for (var r = rData.length - 1; r >= 1; r--) {
          if (String(rData[r][pidCol]) === payload.person_id || String(rData[r][cidCol]) === payload.person_id) {
            rowsToDelete.push(r + 1);
          }
        }
        for (var d = 0; d < rowsToDelete.length; d++) {
          rSheet.deleteRow(rowsToDelete[d]);
        }
        return jsonResponse({ success: true });

      // ---- SECURE CREATE RELATIONSHIP ----
      case 'createRelationship':
        var relErrors = validateRelationshipInput(payload);
        if (relErrors.length > 0) return jsonResponse({ success: false, error: relErrors.join('; ') });
        var relSheet = getSheet(RELATIONSHIPS_SHEET);
        var relId = generateUUID();
        relSheet.appendRow([
          relId,
          payload.parent_id || '',
          payload.child_id || '',
          payload.rel_type || 'Father-Child',
          payload.spouse_link_id || '',
          payload.created_by || 'Anonymous'
        ]);
        return jsonResponse({ success: true, relationship_id: relId });

      // ---- SECURE DELETE RELATIONSHIP ----
      case 'deleteRelationship':
        var drSheet = getSheet(RELATIONSHIPS_SHEET);
        var drRow = findRowIndex(drSheet, 'relationship_id', payload.relationship_id);
        if (drRow === -1) return jsonResponse({ success: false, error: 'Relationship not found' });

        var drHeaders = drSheet.getRange(1, 1, 1, drSheet.getLastColumn()).getValues()[0];
        var drCreatorIndex = drHeaders.indexOf('created_by') + 1;
        if (drCreatorIndex <= 0) return jsonResponse({ success: false, error: 'Ownership column missing. Run init to migrate the schema.' });
        var relCreator = drSheet.getRange(drRow, drCreatorIndex).getValue();
        if (!ownsOrAdmin(payload, relCreator)) {
          return jsonResponse({ success: false, error: 'Unauthorized: You can only remove connections you created.' });
        }

        drSheet.deleteRow(drRow);
        return jsonResponse({ success: true });

      // ---- SEARCH (POST) ----
      case 'search':
        var q = (payload.query || '').toLowerCase();
        var allPersons2 = sheetToJSON(PERSONS_SHEET);
        var res = allPersons2.filter(function(p) {
          var h = ((p.gikuyu_name || '') + ' ' + (p.fathers_name || '') + ' ' + (p.other_names || '')).toLowerCase();
          return h.indexOf(q) !== -1;
        });
        return jsonResponse({ success: true, results: res });

      // ---- ADMIN CODE CHECK (no writes) ----
      case 'ping':
        return jsonResponse({ success: true, is_admin: isSuperAdminToken(payload.admin_token || '') });

      // ---- SET ADMIN TOKEN (requires current admin) ----
      case 'setAdminToken':
        if (!isSuperAdminToken(payload.admin_token || '')) {
          return jsonResponse({ success: false, error: 'Unauthorized: must provide current admin token.' });
        }
        if (!payload.new_token || String(payload.new_token).length < 8) {
          return jsonResponse({ success: false, error: 'New token must be at least 8 characters.' });
        }
        setAdminToken(payload.new_token);
        return jsonResponse({ success: true, message: 'Admin token updated.' });

      default:
        return jsonResponse({ success: false, error: 'Unknown action: ' + action });
    }
  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}