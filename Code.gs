/*
  Google Apps Script Web App for syncing app data to Google Sheets and uploading images to Google Drive.
  - Deploy as Web App (Execute as: Me, Who has access: Anyone)
  - Configure SCRIPT_PROPERTIES: FOLDER_ID (Drive folder), SUBSCRIBERS (JSON array of webhook URLs)
  - Supports:
    GET  ?action=loadAll               => returns all sheets data as [{sheet, rows:[{key,value,updated_at}]}]
    GET  ?action=loadSheet&sheet=name => returns sheet rows
    POST { action:'write', data:[{sheet, key, op:'upsert'|'delete', value, updated_at}] }
    POST { action:'uploadImage', filename, imageBase64 } => stores image to configured folder, returns public link

  Notes:
  - Sheet structure: each sheet (e.g., "chat", "requests") should have columns: key | value | updated_at (A,B,C)
  - For images, set folder sharing to "Anyone with link" after first upload or script will set sharing automatically.
  - onChange/e triggers can call notifySubscribers to push changes to configured webhook URLs.
*/

const PROP_FOLDER_ID = 'FOLDER_ID';
const PROP_SUBSCRIBERS = 'SUBSCRIBERS';

function doGet(e) {
  const action = (e.parameter && e.parameter.action || '').toString().toLowerCase();
  try {
    if (action === 'loadall') {
      const data = loadAllSheets();
      return ContentService.createTextOutput(JSON.stringify({ data })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'loadsheet' && e.parameter.sheet) {
      const rows = loadSheetRows(e.parameter.sheet);
      return ContentService.createTextOutput(JSON.stringify({ sheet: e.parameter.sheet, rows })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ error: 'invalid_action' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  let body = {};
  try {
    if (e.postData && e.postData.type === 'application/json') {
      body = JSON.parse(e.postData.contents || '{}');
    } else {
      body = e.parameter || {};
    }
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'invalid_json' })).setMimeType(ContentService.MimeType.JSON);
  }

  const action = (body.action || '').toString().toLowerCase();
  try {
    if (action === 'write' && Array.isArray(body.data)) {
      const result = writeBatch(body.data);
      // notify subscribers that data changed
      notifySubscribers({ event: 'data_written', details: { written: result } });
      return ContentService.createTextOutput(JSON.stringify({ ok: true, written: result })).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === 'uploadimage' && body.imageBase64 && body.filename) {
      const link = uploadImageToDrive(body.imageBase64, body.filename);
      return ContentService.createTextOutput(JSON.stringify({ ok: true, url: link })).setMimeType(ContentService.MimeType.JSON);
    }

    return ContentService.createTextOutput(JSON.stringify({ error: 'invalid_action_or_missing_params' })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: String(err) })).setMimeType(ContentService.MimeType.JSON);
  }
}

function getScriptProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || null;
}

function loadAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  const out = [];
  sheets.forEach(sh => {
    const name = sh.getName();
    const rows = loadSheetRows(name);
    out.push({ sheet: name, rows });
  });
  return out;
}

function loadSheetRows(sheetName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(sheetName);
  if (!sh) return [];
  const values = sh.getDataRange().getValues();
  // Expect header or raw rows: attempt to map rows to {key,value,updated_at}
  const out = [];
  values.forEach((r, idx) => {
    const key = (r[0] || '').toString();
    const value = (r[1] !== undefined ? r[1] : '');
    const updated_at = (r[2] !== undefined ? r[2] : '');
    if (!key) return; // skip empty key rows
    out.push({ key: key.toString(), value: value, updated_at: updated_at });
  });
  return out;
}

function writeBatch(entries) {
  // entries: [{ sheet, key, op: 'upsert'|'delete', value, updated_at }]
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = [];
  entries.forEach(ent => {
    try {
      const sheetName = ent.sheet || 'app_storage';
      const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
      const key = String(ent.key || '').trim();
      if (!key) { result.push({ key: null, ok: false, reason: 'missing_key' }); return; }
      const op = (ent.op || 'upsert').toString().toLowerCase();
      if (op === 'delete') {
        // find row(s) with key in column A and delete
        const range = sh.getRange(1,1,sh.getLastRow(),1);
        const vals = range.getValues().map(r => String(r[0] || ''));
        for (let i = vals.length -1; i >=0; i--) {
          if (vals[i] === key) sh.deleteRow(i+1);
        }
        result.push({ key, ok: true, op: 'delete' });
      } else {
        // upsert: find first row with key, update value & timestamp, else append
        const lastRow = sh.getLastRow();
        let foundRow = -1;
        if (lastRow >= 1) {
          const keys = sh.getRange(1,1,lastRow,1).getValues().map(r=>String(r[0]||''));
          for (let i=0;i<keys.length;i++) {
            if (keys[i] === key) { foundRow = i+1; break; }
          }
        }
        const now = ent.updated_at || new Date().toISOString();
        if (foundRow !== -1) {
          sh.getRange(foundRow,2).setValue(ent.value);
          sh.getRange(foundRow,3).setValue(now);
        } else {
          sh.appendRow([key, ent.value, now]);
        }
        result.push({ key, ok: true, op: 'upsert' });
      }
    } catch (err) {
      result.push({ key: ent.key || null, ok: false, reason: String(err) });
    }
  });
  return result;
}

function uploadImageToDrive(base64str, filename) {
  const folderId = getScriptProp(PROP_FOLDER_ID);
  if (!folderId) throw new Error('FOLDER_ID not configured in script properties');
  const contentType = detectContentTypeFromBase64(base64str) || 'image/jpeg';
  const data = Utilities.base64Decode(base64str.replace(/^data:[^;]+;base64,/, ''));
  const blob = Utilities.newBlob(data, contentType, filename);
  const folder = DriveApp.getFolderById(folderId);
  const file = folder.createFile(blob);
  // make file viewable by anyone with link
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* ignore */ }
  const url = 'https://drive.google.com/uc?export=view&id=' + file.getId();
  return url;
}

function detectContentTypeFromBase64(s) {
  if (!s) return null;
  const m = s.match(/^data:([^;]+);base64,/);
  if (m && m[1]) return m[1];
  return null;
}

function notifySubscribers(payload) {
  try {
    const subStr = getScriptProp(PROP_SUBSCRIBERS);
    if (!subStr) return;
    let subs = [];
    try { subs = JSON.parse(subStr); } catch (e) { subs = [subStr]; }
    subs.forEach(url => {
      try {
        UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true });
      } catch (e) { /* ignore */ }
    });
  } catch (err) { /* ignore */ }
}

// Helper to set script property (use from the Script Editor console)
function setFolderId(id) { PropertiesService.getScriptProperties().setProperty(PROP_FOLDER_ID, id); }
function setSubscribers(jsonArrayOrString) { PropertiesService.getScriptProperties().setProperty(PROP_SUBSCRIBERS, typeof jsonArrayOrString === 'string' ? jsonArrayOrString : JSON.stringify(jsonArrayOrString)); }

// Optional onChange trigger to notify subscribers when spreadsheet changes
function onChange(e) {
  // e is change event object; notify subscribers that sheet changed
  notifySubscribers({ event: 'sheet_changed', details: { changeType: e.changeType || null, authMode: e.authMode || null } });
}
