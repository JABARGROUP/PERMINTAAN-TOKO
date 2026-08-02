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

function buildJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  const action = (e.parameter && e.parameter.action || '').toString().toLowerCase();
  try {
    if (action === 'loadall') {
      const data = loadAllSheets();
      return buildJsonResponse({ data });
    }

    if (action === 'loadsheet' && e.parameter.sheet) {
      const rows = loadSheetRows(e.parameter.sheet);
      return buildJsonResponse({ sheet: e.parameter.sheet, rows });
    }

    return buildJsonResponse({ error: 'invalid_action' });
  } catch (err) {
    return buildJsonResponse({ error: String(err) });
  }
}

function doPost(e) {
  if (e && e.parameter && e.parameter._postDataType === 'application/json') {
    // no-op; handled below
  }

  let body = {};
  try {
    if (e.postData && e.postData.type === 'application/json') {
      body = JSON.parse(e.postData.contents || '{}');
    } else {
      body = e.parameter || {};
    }
  } catch (err) {
    return buildJsonResponse({ error: 'invalid_json' });
  }

  const action = (body.action || '').toString().toLowerCase();
  try {
    if (action === 'write' && Array.isArray(body.data)) {
      const result = writeBatch(body.data);
      notifySubscribers({ event: 'data_written', details: { written: result } });
      return buildJsonResponse({ ok: true, written: result });
    }

    if (action === 'uploadimage' && body.imageBase64 && body.filename) {
      const link = uploadImageToDrive(body.imageBase64, body.filename);
      return buildJsonResponse({ ok: true, url: link });
    }

    return buildJsonResponse({ error: 'invalid_action_or_missing_params' });
  } catch (err) {
    return buildJsonResponse({ error: String(err) });
  }
}

function getScriptProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || null;
}

function inferSheetName(key) {
  const map = {
    STORE_USERS_DB_V7_CLEAN: 'users',
    STORE_REQUESTS_DB_V7_CLEAN: 'requests',
    STORE_CHAT_DB_V7_CLEAN: 'chat',
    STORE_CHAT_ROOM_DB_V7_CLEAN: 'chat_rooms',
    STORE_TTD_DB_V7_CLEAN: 'ttd',
    STORE_CUSTOM_TOKO_LIST_V7_CLEAN: 'stores',
    STORE_DELETED_TOKO_LIST_V7_CLEAN: 'deleted_stores',
    STORE_SYSTEM_NOTIFICATIONS_V7_CLEAN: 'notifications',
    STORE_KODE_UNIT_MAP_V7_CLEAN: 'kode_unit_map',
    STORE_FEATURE_PHOTOS_V7_CLEAN: 'feature_photos',
    STORE_DELETED_REQUESTS_V7_CLEAN: 'deleted_requests',
    STORE_DELETED_USERS_V7_CLEAN: 'deleted_users',
    STORE_FONTE_TOKEN_KEY_V7_CLEAN: 'fonte_token',
    STORE_ADMIN_REMINDER_KEY_V7_CLEAN: 'admin_reminder',
    STORE_ADMIN_SECRET_KEY_V7_CLEAN: 'admin_secret',
    STORE_ACTIVE_SESSION_V7_CLEAN: 'sessions',
    STORE_ACTIVE_THEME_V7_CLEAN: 'theme',
    STORE_ADMIN_SCRIPT_URL_V7_CLEAN: 'admin_script_url'
  };
  return map[String(key || '').trim().toUpperCase()] || 'app_storage';
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
  if (!values.length) return [];

  const firstRow = values[0] || [];
  const isHeaderRow = String(firstRow[0] || '').toLowerCase() === 'source_key';
  const dataRows = isHeaderRow ? values.slice(1) : values;

  return dataRows.map(row => ({
    source_key: row[0] || '',
    record_id: row[1] || '',
    data_json: row[2] || '',
    updated_at: row[3] || ''
  })).filter(r => String(r.source_key || r.record_id || r.data_json || '').trim() !== '');
}

function writeBatch(entries) {
  // entries: [{ sheet, key, op: 'upsert'|'delete', value, updated_at }]
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = [];
  entries.forEach(ent => {
    try {
      const sheetName = ent.sheet || inferSheetName(ent.key);
      const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
      const key = String(ent.key || '').trim();
      if (!key) { result.push({ key: null, ok: false, reason: 'missing_key' }); return; }
      const op = (ent.op || 'upsert').toString().toLowerCase();

      if (sh.getLastRow() === 0) {
        sh.appendRow(['source_key', 'record_id', 'data_json', 'updated_at']);
      } else {
        const firstRow = sh.getRange(1, 1, 1, 4).getValues()[0] || [];
        if (!String(firstRow[0] || '').trim()) {
          sh.getRange(1, 1, 1, 4).setValues([['source_key', 'record_id', 'data_json', 'updated_at']]);
        }
      }

      if (op === 'delete') {
        const lastRow = sh.getLastRow();
        if (lastRow > 1) {
          const dataRange = sh.getRange(2, 1, lastRow - 1, 1).getValues();
          for (let i = dataRange.length - 1; i >= 0; i--) {
            if (String(dataRange[i][0] || '') === key) sh.deleteRow(i + 2);
          }
        }
        result.push({ key, ok: true, op: 'delete' });
      } else {
        const now = ent.updated_at || new Date().toISOString();
        const values = Array.isArray(ent.value) ? ent.value : [ent.value];
        values.forEach(item => {
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const recordId = String(item.id || item.noSurat || item.username || item.roomId || item.messageId || `${Date.now()}-${Math.random() * 1000}`);
            sh.appendRow([key, recordId, JSON.stringify(item), now]);
          } else {
            sh.appendRow([key, '', JSON.stringify(item), now]);
          }
        });
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
