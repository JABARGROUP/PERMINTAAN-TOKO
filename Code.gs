/*
 * PERMINTAAN TOKO - GOOGLE SHEETS PROXY
 *
 * Database tunggal: Google Sheets.
 * Frontend GitHub Pages TIDAK berbicara langsung ke Spreadsheet API.
 * Semua akses melewati Web App Apps Script ini.
 *
 * GET  : JSONP untuk membaca data tanpa masalah CORS.
 * POST : text/plain + no-cors dari browser untuk menulis data.
 *       Setelah POST, frontend melakukan verifikasi GET/JSONP.
 *
 * Deploy Web App:
 *   Execute as: Me
 *   Who has access: Anyone
 */

const PROP_SPREADSHEET_ID = 'SPREADSHEET_ID';
const PROP_FOLDER_ID = 'FOLDER_ID';
const PROP_SUBSCRIBERS = 'SUBSCRIBERS';
const DEFAULT_SPREADSHEET_ID = '1PryP6ZpGyNEcFRyaRx-93wLn2lJ5qq5mMUj4jyxs3fc';
const HEADER = ['source_key', 'record_id', 'data_json', 'updated_at'];

const SHEET_MAP = {
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

const REVERSE_SHEET_MAP = Object.keys(SHEET_MAP).reduce((acc, key) => {
  acc[SHEET_MAP[key]] = key;
  return acc;
}, {});

function getScriptProp(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

function getSpreadsheet() {
  const configuredId = String(getScriptProp(PROP_SPREADSHEET_ID) || DEFAULT_SPREADSHEET_ID).trim();
  if (configuredId) return SpreadsheetApp.openById(configuredId);

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  throw new Error('SPREADSHEET_ID belum dikonfigurasi di Script Properties.');
}

function jsonText(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonpText(callback, obj) {
  const safe = String(callback || '').replace(/[^A-Za-z0-9_.$]/g, '');
  if (!safe) return jsonText(obj);
  return ContentService
    .createTextOutput(safe + '(' + JSON.stringify(obj) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = String(p.action || '').trim().toLowerCase();
  const callback = p.callback || p.cb || '';

  try {
    let payload;

    if (action === 'ping') {
      payload = {
        success: true,
        ok: true,
        service: 'PERMINTAAN TOKO GOOGLE SHEETS PROXY',
        time: new Date().toISOString()
      };
    } else if (action === 'loadall') {
      cleanupDuplicateRowsOnce();
      payload = { success: true, ok: true, data: loadAllSheets() };
    } else if (action === 'loadsheet') {
      const sheet = String(p.sheet || '').trim();
      if (!sheet) throw new Error('sheet wajib diisi');
      payload = { success: true, ok: true, sheet: sheet, rows: loadSheetRows(sheet) };
    } else {
      payload = { success: false, ok: false, error: 'invalid_action', action: action };
    }

    return callback ? jsonpText(callback, payload) : jsonText(payload);
  } catch (err) {
    const payload = { success: false, ok: false, error: String(err), errorType: 'GET_ERROR' };
    return callback ? jsonpText(callback, payload) : jsonText(payload);
  }
}

function doPost(e) {
  let body = {};
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '';
    if (raw) {
      body = JSON.parse(raw);
    } else if (e && e.parameter) {
      body = e.parameter;
      if (typeof body.data === 'string') body.data = JSON.parse(body.data);
    }
  } catch (err) {
    return jsonText({ success: false, ok: false, error: 'invalid_json', details: String(err) });
  }

  const action = String(body.action || '').trim().toLowerCase();

  try {
    if (action === 'write' && Array.isArray(body.data)) {
      const result = writeBatch(body.data);
      return jsonText({ success: true, ok: true, written: result });
    }

    if (action === 'uploadimage' && body.imageBase64 && body.filename) {
      const url = uploadImageToDrive(body.imageBase64, body.filename);
      return jsonText({ success: true, ok: true, url: url });
    }

    return jsonText({ success: false, ok: false, error: 'invalid_action', action: action });
  } catch (err) {
    return jsonText({ success: false, ok: false, error: String(err), errorType: 'POST_ERROR', action: action });
  }
}

function ensureSheetHeader(sh) {
  if (sh.getMaxColumns() < 4) {
    sh.insertColumnsAfter(sh.getMaxColumns(), 4 - sh.getMaxColumns());
  }

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 4).setValues([HEADER]);
    return;
  }

  const first = sh.getRange(1, 1, 1, Math.min(4, sh.getLastColumn())).getValues()[0] || [];
  const valid = String(first[0] || '').trim() === 'source_key' &&
                String(first[1] || '').trim() === 'record_id' &&
                String(first[2] || '').trim() === 'data_json' &&
                String(first[3] || '').trim() === 'updated_at';

  if (!valid) {
    migrateLegacySheet(sh);
  }
}

function repairCanonicalSheet(sh) {
  ensureSheetHeader(sh);
  if (sh.getLastRow() <= 1) return;

  const values = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  const keep = [];
  const seen = new Set();

  values.forEach(row => {
    const sourceKey = String(row[0] || '').trim();
    const recordId = String(row[1] || '').trim();
    const dataJson = row[2];

    if (!sourceKey && !recordId && !String(dataJson || '').trim()) return;

    // Semua data_json yang dibuat aplikasi harus JSON valid.
    // Baris seperti "data_json" adalah sisa header/korupsi lama dan dibuang.
    let parsedOk = false;
    try {
      JSON.parse(String(dataJson));
      parsedOk = true;
    } catch (_) {}

    if (!parsedOk) return;

    const safeRecordId = recordId || ('hash-' + digestId(String(dataJson)));
    const fp = rowFingerprint(sourceKey, safeRecordId);
    if (seen.has(fp)) return;

    seen.add(fp);
    keep.push([
      sourceKey,
      safeRecordId,
      String(dataJson),
      row[3] || new Date().toISOString()
    ]);
  });

  sh.getRange(2, 1, sh.getLastRow() - 1, 4).clearContent();
  if (keep.length) {
    sh.getRange(2, 1, keep.length, 4).setValues(keep);
  }
}

function migrateLegacySheet(sh) {
  const values = sh.getDataRange().getValues();
  if (!values.length) {
    sh.clear();
    sh.getRange(1, 1, 1, 4).setValues([HEADER]);
    return;
  }

  const header = (values[0] || []).map(v => String(v || '').trim().toLowerCase());
  const dataJsonCol = header.findIndex(v => v === 'data_json');

  const converted = [];
  const old = values.slice(1);

  old.forEach((row, i) => {
    // Legacy sheet yang sudah memiliki kolom data_json tetapi header lain
    // tetap dipertahankan sebagai payload JSON asli.
    if (dataJsonCol >= 0) {
      const raw = row[dataJsonCol];
      if (raw === null || raw === undefined || String(raw).trim() === '') return;

      try {
        const parsed = JSON.parse(String(raw));
        const recordId = getRecordId(parsed);
        converted.push([
          String(row[0] || 'legacy').trim() || 'legacy',
          recordId,
          JSON.stringify(parsed),
          row[3] || new Date().toISOString()
        ]);
        return;
      } catch (_) {
        // Jika bukan JSON valid, jangan masukkan data rusak ke database.
        return;
      }
    }

    const nonEmpty = row.some(v => v !== null && v !== undefined && String(v).trim() !== '');
    if (!nonEmpty) return;

    const payload = row.length === 1 ? row[0] : row;
    const recordId = getRecordId(payload);
    converted.push([
      'legacy',
      recordId,
      JSON.stringify(payload),
      new Date().toISOString()
    ]);
  });

  sh.clear();
  sh.getRange(1, 1, 1, 4).setValues([HEADER]);
  if (converted.length) {
    sh.getRange(2, 1, converted.length, 4).setValues(converted);
  }
}

function cleanupDuplicateRowsOnce() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('DEDUP_DONE_V4') === '1') return;

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getSpreadsheet();
    Object.keys(SHEET_MAP).forEach(key => {
      const sh = ss.getSheetByName(SHEET_MAP[key]);
      if (sh) {
        repairCanonicalSheet(sh);
        dedupeRowsInSheet(sh);
      }
    });
    SpreadsheetApp.flush();
    props.setProperty('DEDUP_DONE_V4', '1');
  } finally {
    lock.releaseLock();
  }
}

function loadAllSheets() {
  const ss = getSpreadsheet();
  return ss.getSheets()
    .filter(sh => REVERSE_SHEET_MAP[sh.getName()])
    .map(sh => ({
      sheet: sh.getName(),
      rows: loadSheetRows(sh.getName())
    }));
}

function loadSheetRows(sheetName) {
  const ss = getSpreadsheet();
  const sh = ss.getSheetByName(sheetName);
  if (!sh) return [];

  repairCanonicalSheet(sh);

  if (sh.getLastRow() < 2) return [];

  const values = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  const seen = new Set();
  const out = [];

  values.forEach(row => {
    const sourceKey = String(row[0] || '').trim();
    const recordId = String(row[1] || '').trim();
    const dataJson = String(row[2] || '');

    if (!sourceKey && !recordId && !dataJson.trim()) return;

    try {
      JSON.parse(dataJson);
    } catch (_) {
      return;
    }

    const safeRecordId = recordId || ('hash-' + digestId(dataJson));
    const fp = rowFingerprint(sourceKey, safeRecordId);
    if (seen.has(fp)) return;

    seen.add(fp);
    out.push({
      source_key: sourceKey,
      record_id: safeRecordId,
      data_json: dataJson,
      updated_at: row[3] || ''
    });
  });

  return out;
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function digestId(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(value), Utilities.Charset.UTF_8);
  return bytes.map(b => {
    const n = b < 0 ? b + 256 : b;
    return ('0' + n.toString(16)).slice(-2);
  }).join('');
}

function getRecordId(item) {
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const keys = ['id', 'noSurat', 'username', 'roomId', 'messageId', 'key', 'code', 'record_id'];
    for (let i = 0; i < keys.length; i++) {
      const v = item[keys[i]];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
  }
  return 'hash-' + digestId(stableStringify(item));
}

function parseEntryItems(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function rowFingerprint(sourceKey, recordId) {
  return String(sourceKey || '').trim() + '::' + String(recordId || '').trim();
}

function dedupeRowsInSheet(sh) {
  if (sh.getLastRow() <= 2) return;
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues();
  const seen = new Set();
  const deleteRows = [];

  values.forEach((row, index) => {
    const sourceKey = String(row[0] || '').trim();
    const recordId = String(row[1] || '').trim();
    if (!sourceKey || !recordId) return;
    const fp = rowFingerprint(sourceKey, recordId);
    if (seen.has(fp)) deleteRows.push(index + 2);
    else seen.add(fp);
  });

  deleteRows.reverse().forEach(rowNum => sh.deleteRow(rowNum));
}

function findRowsByIdentity(sh, key, recordId) {
  if (sh.getLastRow() <= 1) return [];
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  const out = [];
  values.forEach((row, i) => {
    const sourceKey = String(row[0] || '').trim();
    const id = String(row[1] || '').trim();
    if ((sourceKey === key && id === recordId) || id === recordId) out.push(i + 2);
  });
  return out;
}

function writeBatch(entries) {
  if (!Array.isArray(entries) || !entries.length) return [];

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const ss = getSpreadsheet();
    const results = [];

    entries.forEach(ent => {
      const key = String(ent && ent.key || '').trim();
      if (!key) {
        results.push({ key: null, ok: false, reason: 'missing_key' });
        return;
      }

      const sheetName = String(ent.sheet || SHEET_MAP[key] || 'app_storage').trim();
      const sh = ss.getSheetByName(sheetName) || ss.insertSheet(sheetName);
      ensureSheetHeader(sh);
      repairCanonicalSheet(sh);

      const op = String(ent.op || 'upsert').toLowerCase().trim();
      const now = ent.updated_at || new Date().toISOString();

      if (op === 'delete') {
        if (sh.getLastRow() > 1) {
          const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
          const deleteRows = [];
          rows.forEach((row, i) => {
            const sourceKey = String(row[0] || '').trim();
            const recordId = String(row[1] || '').trim();
            if (sourceKey === key || recordId === key) deleteRows.push(i + 2);
          });
          deleteRows.reverse().forEach(r => sh.deleteRow(r));
        }
        repairCanonicalSheet(sh);
        results.push({ key, sheet: sheetName, op: 'delete', ok: true });
        return;
      }

      const items = parseEntryItems(ent.value);
      const unique = new Map();
      items.forEach(item => {
        const recordId = getRecordId(item);
        unique.set(recordId, item);
      });

      if (op === 'replace') {
        const oldRows = Math.max(0, sh.getLastRow() - 1);
        if (oldRows) sh.deleteRows(2, oldRows);

        const output = Array.from(unique.entries()).map(([recordId, item]) => [
          key,
          recordId,
          JSON.stringify(item),
          now
        ]);

        if (output.length) {
          sh.getRange(2, 1, output.length, 4).setValues(output);
        }

        results.push({ key, sheet: sheetName, op: 'replace', ok: true, count: output.length });
        return;
      }

      if (op === 'upsert' || op === 'append') {
        const lastRow = sh.getLastRow();
        const existing = new Map();
        if (lastRow > 1) {
          const rows = sh.getRange(2, 1, lastRow - 1, 4).getValues();
          rows.forEach((row, i) => {
            const sourceKey = String(row[0] || '').trim();
            const recordId = String(row[1] || '').trim();
            if (!recordId) return;
            if (!existing.has(rowFingerprint(sourceKey, recordId))) existing.set(rowFingerprint(sourceKey, recordId), i + 2);
          });
        }

        const appendRows = [];
        unique.forEach((item, recordId) => {
          const fp = rowFingerprint(key, recordId);
          const rowNum = existing.get(fp);
          const rowValues = [[key, recordId, JSON.stringify(item), now]];

          if (op === 'upsert' && rowNum) {
            sh.getRange(rowNum, 1, 1, 4).setValues(rowValues);
          } else if (!rowNum) {
            appendRows.push(rowValues[0]);
          }
        });

        if (appendRows.length) {
          const start = sh.getLastRow() + 1;
          sh.getRange(start, 1, appendRows.length, 4).setValues(appendRows);
        }

        dedupeRowsInSheet(sh);
        results.push({ key, sheet: sheetName, op, ok: true, count: unique.size });
        return;
      }

      results.push({ key, sheet: sheetName, op, ok: false, reason: 'unsupported_operation' });
    });

    SpreadsheetApp.flush();
    return results;
  } finally {
    lock.releaseLock();
  }
}

function uploadImageToDrive(base64str, filename) {
  const folderId = getScriptProp(PROP_FOLDER_ID);
  if (!folderId) throw new Error('FOLDER_ID belum dikonfigurasi.');
  const contentType = detectContentTypeFromBase64(base64str) || 'image/jpeg';
  const clean = String(base64str).replace(/^data:[^;]+;base64,/, '');
  const blob = Utilities.newBlob(Utilities.base64Decode(clean), contentType, filename);
  const folder = DriveApp.getFolderById(folderId);
  const file = folder.createFile(blob);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (_) {}
  return 'https://drive.google.com/uc?export=view&id=' + file.getId();
}

function detectContentTypeFromBase64(value) {
  const m = String(value || '').match(/^data:([^;]+);base64,/);
  return m ? m[1] : null;
}

function notifySubscribers(payload) {
  const raw = getScriptProp(PROP_SUBSCRIBERS);
  if (!raw) return;
  let urls = [];
  try { urls = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [raw]; }
  catch (_) { urls = [raw]; }
  urls.filter(Boolean).forEach(url => {
    try {
      UrlFetchApp.fetch(String(url), {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      });
    } catch (_) {}
  });
}

function onChange(e) {
  notifySubscribers({
    event: 'sheet_changed',
    details: { changeType: e && e.changeType || null }
  });
}

function setSpreadsheetId(id) {
  PropertiesService.getScriptProperties().setProperty(PROP_SPREADSHEET_ID, String(id || '').trim());
}

function setFolderId(id) {
  PropertiesService.getScriptProperties().setProperty(PROP_FOLDER_ID, String(id || '').trim());
}

function setSubscribers(value) {
  const normalized = typeof value === 'string' ? value : JSON.stringify(value || []);
  PropertiesService.getScriptProperties().setProperty(PROP_SUBSCRIBERS, normalized);
}
