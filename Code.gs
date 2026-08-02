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
  - Sheet structure: each sheet (e.g., "chat", "requests") should have columns: source_key | record_id | data_json | updated_at (A-D)
  - For images, set folder sharing to "Anyone with link" after first upload or script will set sharing automatically.
  - onChange/e triggers can call notifySubscribers to push changes to configured webhook URLs.
*/

const PROP_FOLDER_ID = 'FOLDER_ID';
const PROP_SUBSCRIBERS = 'SUBSCRIBERS';
const DEFAULT_SPREADSHEET_ID = '1PryP6ZpGyNEcFRyaRx-93wLn2lJ5qq5mMUj4jyxs3fc';

function buildJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doOptions(e) {
  return ContentService.createTextOutput('');
}

function doGet(e) {
  const action = (e.parameter && e.parameter.action || '').toString().toLowerCase().trim();
  try {
    if (action === 'loadall') {
      const data = loadAllSheets();
      return buildJsonResponse({ success: true, data });
    }

    if (action === 'loadsheet' && e.parameter && e.parameter.sheet) {
      const rows = loadSheetRows(e.parameter.sheet);
      return buildJsonResponse({ success: true, sheet: e.parameter.sheet, rows });
    }

    return buildJsonResponse({ error: 'invalid_action_or_missing_params', action: action, params: e.parameter });
  } catch (err) {
    return buildJsonResponse({ error: String(err), errorType: 'GET_ERROR' });
  }
}

function doPost(e) {
  let body = {};
  let contentType = 'text/plain';
  
  try {
    if (e && e.postData && e.postData.contents) {
      contentType = e.postData.type || 'text/plain';
      const raw = String(e.postData.contents || '').trim();
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch (jsonErr) {
          body = e.parameter || {};
        }
      } else {
        body = e.parameter || {};
      }
    } else {
      body = e.parameter || {};
    }
  } catch (err) {
    return buildJsonResponse({ error: 'invalid_json', details: String(err) });
  }

  const action = (body.action || '').toString().toLowerCase().trim();
  try {
    if (action === 'write' && Array.isArray(body.data)) {
      const result = writeBatch(body.data);
      return buildJsonResponse({ success: true, ok: true, written: result });
    }

    if (action === 'uploadimage' && body.imageBase64 && body.filename) {
      const link = uploadImageToDrive(body.imageBase64, body.filename);
      return buildJsonResponse({ success: true, ok: true, url: link });
    }

    return buildJsonResponse({ error: 'invalid_action_or_missing_params', action: action, received: body });
  } catch (err) {
    return buildJsonResponse({ error: String(err), errorType: 'POST_ERROR', action: action });
  }
}

function getScriptProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || null;
}

function getSpreadsheet() {
  try {
    const spreadsheetId = (getScriptProp('SPREADSHEET_ID') || DEFAULT_SPREADSHEET_ID).trim();
    if (spreadsheetId) {
      return SpreadsheetApp.openById(spreadsheetId);
    }
  } catch (err) {
    // fallback to active spreadsheet
  }

  try {
    return SpreadsheetApp.getActiveSpreadsheet();
  } catch (err) {
    throw new Error('Tidak bisa membuka spreadsheet. Pastikan Apps Script terhubung ke Google Sheet yang benar.');
  }
}

function ensureSheetHeader(sh) {
  if (sh.getLastRow() === 0) {
    sh.appendRow(['source_key', 'record_id', 'data_json', 'updated_at']);
    return;
  }

  const firstRow = sh.getRange(1, 1, 1, 4).getValues()[0] || [];
  if (!String(firstRow[0] || '').trim()) {
    sh.getRange(1, 1, 1, 4).setValues([['source_key', 'record_id', 'data_json', 'updated_at']]);
  }
}

function findExistingRowNumber(sh, key, recordId) {
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return null;

  const values = sh.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = 0; i < values.length; i++) {
    const rowKey = String(values[i][0] || '').trim();
    const existingRecordId = String(values[i][1] || '').trim();
    if (rowKey === key && existingRecordId === recordId) return i + 2;
  }

  for (let i = 0; i < values.length; i++) {
    const existingRecordId = String(values[i][1] || '').trim();
    if (existingRecordId && existingRecordId === recordId) return i + 2;
  }

  return null;
}

function dedupeSheetRows(sh, key) {
  const lastRow = sh.getLastRow();
  if (lastRow <= 2) return;

  const values = sh.getRange(2, 1, lastRow - 1, 4).getValues();
  const seen = new Set();
  const rowsToDelete = [];

  values.forEach((row, index) => {
    const rowKey = String(row[0] || '').trim();
    const recordId = String(row[1] || '').trim();
    if (!recordId) return;

    const fingerprint = `${rowKey}::${recordId}`;
    if (seen.has(fingerprint)) {
      rowsToDelete.push(index + 2);
    } else {
      seen.add(fingerprint);
    }
  });

  rowsToDelete.reverse().forEach(rowNum => sh.deleteRow(rowNum));
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
  const ss = getSpreadsheet();
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
  const ss = getSpreadsheet();
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
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSpreadsheet();
  const result = [];
  entries.forEach(ent => {
    try {
      const sheetName = ent.sheet || inferSheetName(ent.key);
      const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
      const key = String(ent.key || '').trim();
      if (!key) { result.push({ key: null, ok: false, reason: 'missing_key' }); return; }
      const op = (ent.op || 'upsert').toString().toLowerCase();

      ensureSheetHeader(sh);

      if (op === 'delete') {
        const lastRow = sh.getLastRow();
        if (lastRow > 1) {
          const dataRange = sh.getRange(2, 1, lastRow - 1, 2).getValues();
          const rowsToDelete = [];
          dataRange.forEach((row, index) => {
            const rowKey = String(row[0] || '').trim();
            const recordId = String(row[1] || '').trim();
            if (rowKey === key || recordId === key) rowsToDelete.push(index + 2);
          });
          rowsToDelete.reverse().forEach(rowNum => sh.deleteRow(rowNum));
        }
        result.push({ key, ok: true, op: 'delete' });
        return;
      }

      const now = ent.updated_at || new Date().toISOString();
      const rawValue = ent.value;
      const values = Array.isArray(rawValue)
        ? rawValue
        : (rawValue === undefined || rawValue === null ? [] : [rawValue]);

      if (op === 'replace' && sh.getLastRow() > 1) {
        const rowsToDelete = Math.max(0, sh.getLastRow() - 1);
        if (rowsToDelete > 0) sh.deleteRows(2, rowsToDelete);
      }

      values.forEach(item => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const recordId = String(item.id || item.noSurat || item.username || item.roomId || item.messageId || item.key || item.record_id || `${Date.now()}-${Math.random() * 1000}`);
          let rowNum = null;

          if (op === 'upsert' || op === 'append') {
            rowNum = findExistingRowNumber(sh, key, recordId);
          }

          if (op === 'replace') {
            sh.appendRow([key, recordId, JSON.stringify(item), now]);
          } else if (op === 'upsert') {
            if (rowNum) {
              sh.getRange(rowNum, 1, 1, 4).setValues([[key, recordId, JSON.stringify(item), now]]);
            } else {
              sh.appendRow([key, recordId, JSON.stringify(item), now]);
            }
          } else if (op === 'append') {
            if (!rowNum) {
              sh.appendRow([key, recordId, JSON.stringify(item), now]);
            }
          } else {
            sh.appendRow([key, recordId, JSON.stringify(item), now]);
          }
        } else {
          const fallbackRecordId = (item && typeof item === 'string' && item.trim()) ? item : '';
          sh.appendRow([key, fallbackRecordId, JSON.stringify(item), now]);
        }
      });

      dedupeSheetRows(sh, key);
      result.push({ key, ok: true, op: op });
    } catch (err) {
      result.push({ key: ent.key || null, ok: false, reason: String(err) });
    }
  });
    return result;
  } finally {
    lock.releaseLock();
  }
}

function uploadImageToDrive(base64str, filename) {
  const folderId = getScriptProp(PROP_FOLDER_ID);
  if (!folderId) throw new Error('FOLDER_ID not configured in script properties');
  const contentType = detectContentTypeFromBase64(base64str) || 'image/jpeg';
  if (!/^image\/(jpeg|png|gif|webp)$/i.test(contentType)) throw new Error('Tipe file gambar tidak didukung.');
  const data = Utilities.base64Decode(base64str.replace(/^data:[^;]+;base64,/, ''));
  const safeFilename = String(filename || ('FOTO_' + Date.now() + '.jpg')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const blob = Utilities.newBlob(data, contentType, safeFilename);
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
