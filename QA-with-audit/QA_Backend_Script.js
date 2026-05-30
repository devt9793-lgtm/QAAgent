// ============================================================
// QA SYSTEM — GOOGLE APPS SCRIPT BACKEND v4
// Auth is handled by Vercel Blob (/api/auth)
// This script handles QA DATA ONLY — no auth needed here
// ============================================================
var FOLDER_ID       = '1lf63ycye1UjzX7D4ZONNSHdFnVLp-h1h';
var MASTER_SHEET_ID = '1cjAGAl6reeDDFbv8cWK7L1_FeljZmm5uQEPFcFV9jLA';

// ── Route GET requests ──────────────────────────────────────
function doGet(e) {
  var action  = (e.parameter.action  || '').trim();
  var project = (e.parameter.project || '').trim();
  try {
    if (action === 'ping')         return out({ ok: true, ts: Date.now() });
    if (action === 'listProjects') return out(listProjects());
    if (action === 'getProject')   return out(getProject(project));
    if (action === 'getMaster')    return out(getMasterChecklist());
    if (action === 'getInit')      return out(getInit(project));
    return out({ error: 'Unknown action: ' + action });
  } catch(err) {
    return out({ error: err.message });
  }
}

// ── Route POST requests ─────────────────────────────────────
function doPost(e) {
  try {
    var body   = JSON.parse(e.postData.contents);
    var action = body.action || '';
    if (action === 'createProject') return out(createProject(body.project));
    if (action === 'saveAllState')  return out(saveAllState(body.project, body.state));
    if (action === 'logActivity')   return out(logActivity(body.project, body.entry));
    return out({ error: 'Unknown action: ' + action });
  } catch(err) {
    return out({ error: err.message });
  }
}

function out(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ═══════════════════════════════════════════════════════════
// getInit — single call returns master + project state + list
// Called on every page load — reduces round trips from 3 to 1
// ═══════════════════════════════════════════════════════════
function getInit(projectName) {
  var master   = getMasterChecklist();
  var projects = listProjects();
  var project  = (projectName && projectName.length > 0)
    ? getProject(projectName)
    : { found: false };
  return {
    master:   master,
    projects: projects.projects,
    project:  project,
  };
}

// ═══════════════════════════════════════════════════════════
// REGISTRY — "QA Projects Registry" Google Sheet
// ═══════════════════════════════════════════════════════════
function getRegistrySheet() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files  = folder.getFilesByName('QA Projects Registry');
  if (files.hasNext()) {
    var ss = SpreadsheetApp.open(files.next());
    var sh = ss.getSheetByName('Projects');
    if (!sh) {
      sh = ss.insertSheet('Projects');
      sh.appendRow(['ProjectName', 'SheetId', 'Created', 'LastUpdated']);
      sh.setFrozenRows(1);
    }
    return sh;
  }
  var ss = SpreadsheetApp.create('QA Projects Registry');
  DriveApp.getFileById(ss.getId()).moveTo(folder);
  var sh = ss.getActiveSheet().setName('Projects');
  sh.appendRow(['ProjectName', 'SheetId', 'Created', 'LastUpdated']);
  sh.setFrozenRows(1);
  return sh;
}

// ═══════════════════════════════════════════════════════════
// LIST PROJECTS
// ═══════════════════════════════════════════════════════════
function listProjects() {
  var sh   = getRegistrySheet();
  var data = sh.getDataRange().getValues();
  var out  = [];
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) {
      out.push({
        name:        data[i][0],
        sheetId:     data[i][1],
        created:     String(data[i][2]),
        lastUpdated: String(data[i][3]),
      });
    }
  }
  return { projects: out };
}

// ═══════════════════════════════════════════════════════════
// GET PROJECT — returns state + activity for one project
// ═══════════════════════════════════════════════════════════
function getProject(projectName) {
  if (!projectName) return { found: false };

  var sh   = getRegistrySheet();
  var data = sh.getDataRange().getValues();
  var sheetId = null;

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === projectName) { sheetId = data[i][1]; break; }
  }
  if (!sheetId) return { found: false };

  var pss     = SpreadsheetApp.openById(sheetId);
  var stateSh = pss.getSheetByName('State');
  var actSh   = pss.getSheetByName('Activity');

  // Read state
  var state = {};
  if (stateSh && stateSh.getLastRow() > 1) {
    var sd = stateSh.getDataRange().getValues();
    for (var r = 1; r < sd.length; r++) {
      if (sd[r][0]) {
        try { state[sd[r][0]] = JSON.parse(sd[r][1]); } catch(e) {}
      }
    }
  }

  // Read activity (newest first, max 50)
  var activity = [];
  if (actSh && actSh.getLastRow() > 1) {
    var ad = actSh.getDataRange().getValues();
    for (var r = 1; r < ad.length; r++) {
      if (ad[r][0]) activity.push({ msg: ad[r][0], type: ad[r][1], ts: ad[r][2] });
    }
  }

  return {
    found:       true,
    projectName: projectName,
    sheetId:     sheetId,
    state:       state,
    activity:    activity.slice(0, 50),
  };
}

// ═══════════════════════════════════════════════════════════
// CREATE PROJECT
// ═══════════════════════════════════════════════════════════
function createProject(projectName) {
  if (!projectName) return { error: 'No project name' };

  var regSh = getRegistrySheet();
  var data  = regSh.getDataRange().getValues();

  // Check if already exists
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === projectName) {
      return { created: false, sheetId: data[i][1], alreadyExists: true };
    }
  }

  // Create new Google Sheet for this project
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var pss    = SpreadsheetApp.create('QA \u2014 ' + projectName);
  DriveApp.getFileById(pss.getId()).moveTo(folder);

  // Info tab
  var infoSh = pss.getActiveSheet().setName('Info');
  infoSh.appendRow(['Project', projectName]);
  infoSh.appendRow(['Created', new Date().toISOString()]);
  infoSh.getRange(1,1,2,1).setFontWeight('bold');

  // State tab
  var stateSh = pss.insertSheet('State');
  stateSh.appendRow(['Key', 'Value']);
  stateSh.getRange(1,1,1,2).setFontWeight('bold').setBackground('#1a2332').setFontColor('#ffffff');
  stateSh.setFrozenRows(1);

  // Activity tab
  var actSh = pss.insertSheet('Activity');
  actSh.appendRow(['Message', 'Type', 'Timestamp']);
  actSh.getRange(1,1,1,3).setFontWeight('bold').setBackground('#1a2332').setFontColor('#ffffff');
  actSh.setColumnWidth(1, 400);
  actSh.setFrozenRows(1);

  // Register the project
  regSh.appendRow([
    projectName,
    pss.getId(),
    new Date().toISOString(),
    new Date().toISOString(),
  ]);

  return {
    created:  true,
    sheetId:  pss.getId(),
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + pss.getId(),
  };
}

// ═══════════════════════════════════════════════════════════
// SAVE ALL STATE — rewrites State tab on every checkbox change
// ═══════════════════════════════════════════════════════════
function saveAllState(projectName, stateObj) {
  if (!projectName) return { error: 'No project name' };

  var regSh = getRegistrySheet();
  var data  = regSh.getDataRange().getValues();
  var sheetId = null, regRow = -1;

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === projectName) { sheetId = data[i][1]; regRow = i + 1; break; }
  }

  // Auto-create if missing
  if (!sheetId) {
    var c = createProject(projectName);
    sheetId = c.sheetId;
    regRow  = regSh.getLastRow();
  }

  var pss     = SpreadsheetApp.openById(sheetId);
  var stateSh = pss.getSheetByName('State');

  // Rewrite entire State sheet
  stateSh.clearContents();
  stateSh.appendRow(['Key', 'Value']);
  stateSh.getRange(1,1,1,2).setFontWeight('bold').setBackground('#1a2332').setFontColor('#ffffff');

  var keys = Object.keys(stateObj || {});
  if (keys.length > 0) {
    var rows = keys.map(function(k) { return [k, JSON.stringify(stateObj[k])]; });
    stateSh.getRange(2, 1, rows.length, 2).setValues(rows);
  }

  // Update last-updated timestamp in registry
  if (regRow > 0) {
    regSh.getRange(regRow, 4).setValue(new Date().toISOString());
  }

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════
// LOG ACTIVITY — inserts at top, keeps max 50 rows
// ═══════════════════════════════════════════════════════════
function logActivity(projectName, entry) {
  if (!projectName || !entry) return { error: 'Missing params' };

  var regSh = getRegistrySheet();
  var data  = regSh.getDataRange().getValues();
  var sheetId = null;

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === projectName) { sheetId = data[i][1]; break; }
  }
  if (!sheetId) return { error: 'Project not found: ' + projectName };

  var actSh = SpreadsheetApp.openById(sheetId).getSheetByName('Activity');
  actSh.insertRowAfter(1);
  actSh.getRange(2, 1, 1, 3).setValues([[entry.msg, entry.type, entry.ts]]);

  // Keep max 52 rows (header + 50 entries + 1 buffer)
  if (actSh.getLastRow() > 52) {
    actSh.deleteRow(actSh.getLastRow());
  }

  return { ok: true };
}

// ═══════════════════════════════════════════════════════════
// GET MASTER CHECKLIST — reads from Master Sheet as CSV
// ═══════════════════════════════════════════════════════════
function getMasterChecklist() {
  var sh   = SpreadsheetApp.openById(MASTER_SHEET_ID).getSheets()[0];
  var data = sh.getDataRange().getValues();
  var csv  = data.map(function(row) {
    return row.map(function(c) {
      var s = String(c);
      if (s.indexOf(',') >= 0 || s.indexOf('"') >= 0 || s.indexOf('\n') >= 0) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    }).join(',');
  }).join('\n');
  return { csv: csv };
}
