/* ======================================================
   GOOGLE SHEETS CLOUD DATABASE ENGINE
   Frontend -> Apps Script Proxy -> Google Sheets

   IMPORTANT:
   - Tidak menggunakan localStorage/sessionStorage untuk database.
   - GET memakai JSONP agar GitHub Pages tidak terkena CORS.
   - POST memakai text/plain + no-cors agar tidak memicu preflight.
   - Setelah POST, data diverifikasi ulang lewat GET/JSONP.
   - Server memakai LockService + record_id idempotent agar tidak duplikat.
====================================================== */

const memoryCache = new Map();
const DISABLE_PERSISTENCE = true;
const sessionKey = window.SESSION_KEY || 'STORE_ACTIVE_SESSION_V7_CLEAN';
const themeKey = window.THEME_KEY || 'STORE_ACTIVE_THEME_V7_CLEAN';
const ADMIN_SCRIPT_URL_STORAGE_KEY = window.ADMIN_SCRIPT_URL_KEY || 'STORE_ADMIN_SCRIPT_URL_V7_CLEAN';

let pendingWrites = new Map();
let writeTimer = null;
let isSupabaseReady = false;
let isSupabaseOnline = false;
let onDataChangeCallback = null;
let lastPushAt = 0;
let cloudSyncBusy = false;
let cloudLoadedKeys = new Set();
let cloudRowCounts = new Map();
let jsonpCounter = 0;
const PUSH_SUPPRESS_MS = 1500;
const WRITE_RETRY_MS = 2500;

const SCALAR_KEYS = new Set([
  'STORE_FEATURE_PHOTOS_V7_CLEAN',
  'STORE_FONTE_TOKEN_KEY_V7_CLEAN',
  'STORE_ADMIN_REMINDER_KEY_V7_CLEAN',
  'STORE_ADMIN_SECRET_KEY_V7_CLEAN',
  'STORE_ACTIVE_SESSION_V7_CLEAN',
  'STORE_ACTIVE_THEME_V7_CLEAN',
  'STORE_ADMIN_SCRIPT_URL_V7_CLEAN',
  'STORE_TTD_DB_V7_CLEAN',
  'STORE_KODE_UNIT_MAP_V7_CLEAN'
]);

const STORAGE_TO_SHEET = {
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

const SHEET_TO_STORAGE = Object.keys(STORAGE_TO_SHEET).reduce((out, key) => {
  out[STORAGE_TO_SHEET[key]] = key;
  return out;
}, {});

function parseStorageValue(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch (_) { return value; }
}

function normalizeDateFields(value) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const str = value.trim();
    if (!str) return '';
    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) return str.split(' ')[0];
    const match = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
    if (match) return `${match[3]}/${match[2]}/${match[1]}`;
    if (/^[0-9]+$/.test(str)) return str;
    return str;
  }

  if (Array.isArray(value)) return value.map(normalizeDateFields);

  if (typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([key, val]) => {
      if (val && typeof val === 'object') out[key] = normalizeDateFields(val);
      else out[key] = val;
    });
    return out;
  }

  return value;
}

function serializeForCache(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(normalizeDateFields(value));
}

function getRecordIdentity(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const keys = ['id', 'noSurat', 'username', 'roomId', 'messageId', 'key', 'code', 'record_id'];
  for (const key of keys) {
    const value = item[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value);
  }
  return null;
}

function setOnDataChangeCallback(fn) {
  onDataChangeCallback = typeof fn === 'function' ? fn : null;
}

function hydrateStorage(key, value) {
  memoryCache.set(key, serializeForCache(value));
}

const appStorage = {
  getItem(key) {
    if (!memoryCache.has(key)) return null;
    const value = memoryCache.get(key);
    return typeof value === 'string' ? value : JSON.stringify(value);
  },

  setItem(key, value) {
    const normalized = normalizeDateFields(value);
    const serialized = serializeForCache(normalized);
    memoryCache.set(key, serialized);

    // Saat aplikasi baru mulai, jangan kirim default lokal sebelum data Sheet selesai dimuat.
    if (isSupabaseReady && !cloudSyncBusy) {
      queueCloudWrite(key, parseStorageValue(serialized));
    }
  },

  removeItem(key) {
    memoryCache.delete(key);
    if (isSupabaseReady && !cloudSyncBusy) queueCloudDelete(key);
  },

  clear() {
    memoryCache.clear();
  },

  // Dipakai untuk hydrate data dari server tanpa memicu write balik.
  hydrate: hydrateStorage
};

function getCloudEndpoint() {
  if (window.APP_SHEETS_ENDPOINT) return String(window.APP_SHEETS_ENDPOINT).trim();
  const stored = (memoryCache.get(ADMIN_SCRIPT_URL_STORAGE_KEY) || '').toString().trim();
  return stored || null;
}

async function loadSupabaseConfigFromJson() {
  try {
    const resp = await fetch('./sheets-config.json?v=20260802-final', { cache: 'no-store' });
    if (!resp.ok) throw new Error('CONFIG_HTTP_' + resp.status);
    const cfg = await resp.json();
    if (cfg && cfg.SHEETS_ENDPOINT) window.APP_SHEETS_ENDPOINT = String(cfg.SHEETS_ENDPOINT).trim();
    if (cfg && cfg.SPREADSHEET_ID) window.APP_SHEETS_SPREADSHEET_ID = String(cfg.SPREADSHEET_ID).trim();
    return cfg;
  } catch (err) {
    console.warn('⚠️ Gagal membaca sheets-config.json:', err.message);
    return null;
  }
}

function mapStorageKeyToSheetName(key) {
  return STORAGE_TO_SHEET[String(key || '').trim().toUpperCase()] || 'app_storage';
}

function mapSheetNameToStorageKey(sheetName) {
  return SHEET_TO_STORAGE[String(sheetName || '').trim().toLowerCase()] || null;
}

function jsonpGet(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const callbackName = '__sheetsProxyCallback_' + Date.now() + '_' + (++jsonpCounter);
    const script = document.createElement('script');
    let finished = false;

    const cleanup = () => {
      if (script.parentNode) script.parentNode.removeChild(script);
      try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
    };

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(new Error('JSONP timeout'));
    }, timeoutMs);

    window[callbackName] = payload => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      if (!payload || payload.error || payload.success === false) {
        reject(new Error(payload && payload.error ? payload.error : 'Proxy response invalid'));
        return;
      }
      resolve(payload);
    };

    script.onerror = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error('JSONP network error'));
    };

    const join = url.includes('?') ? '&' : '?';
    script.src = url + join + 'callback=' + encodeURIComponent(callbackName) + '&_=' + Date.now();
    script.async = true;
    document.head.appendChild(script);
  });
}

async function loadAllFromSupabase() {
  const endpoint = getCloudEndpoint();
  if (!endpoint) throw new Error('Google Apps Script endpoint belum tersedia.');

  const url = endpoint.replace(/\/$/, '') + '?action=loadall';
  const payload = await jsonpGet(url);
  if (!Array.isArray(payload.data)) throw new Error('Format response loadall tidak valid.');

  cloudLoadedKeys = new Set();
  cloudRowCounts = new Map();

  payload.data.forEach(sheet => {
    const storageKey = mapSheetNameToStorageKey(sheet.sheet);
    if (!storageKey) return;

    const rows = (sheet.rows || []).map(row => {
      try { return JSON.parse(row.data_json); }
      catch (_) { return row.data_json; }
    });

    if (SCALAR_KEYS.has(storageKey)) {
      hydrateStorage(storageKey, rows.length ? rows[0] : (storageKey === 'STORE_FEATURE_PHOTOS_V7_CLEAN' ? 'true' : ''));
    } else {
      hydrateStorage(storageKey, rows);
    }
    cloudLoadedKeys.add(storageKey);
    cloudRowCounts.set(storageKey, rows.length);
  });

  if (typeof onDataChangeCallback === 'function') onDataChangeCallback(null);
  return true;
}

function queueCloudWrite(key, value) {
  const storageKey = String(key || '').trim();
  const sheet = mapStorageKeyToSheetName(storageKey);
  if (!storageKey || !sheet) return;

  pendingWrites.set(storageKey, {
    key: storageKey,
    sheet,
    op: 'replace',
    value: SCALAR_KEYS.has(storageKey) ? value : (Array.isArray(value) ? value : [value])
  });

  scheduleFlush(350);
}

function queueCloudDelete(key) {
  const storageKey = String(key || '').trim();
  const sheet = mapStorageKeyToSheetName(storageKey);
  if (!storageKey || !sheet) return;

  pendingWrites.set(storageKey, { key: storageKey, sheet, op: 'delete' });
  scheduleFlush(350);
}

function scheduleFlush(delay = 350) {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushPendingWrites().catch(err => console.warn('flushPendingWrites:', err.message));
  }, delay);
}

async function postNoCors(payload) {
  const endpoint = getCloudEndpoint();
  if (!endpoint) throw new Error('Endpoint kosong');

  // text/plain adalah simple request sehingga browser tidak melakukan OPTIONS preflight.
  // mode no-cors berarti response POST tidak dibaca; keberhasilan diverifikasi via JSONP GET.
  await fetch(endpoint.replace(/\/$/, ''), {
    method: 'POST',
    mode: 'no-cors',
    cache: 'no-store',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload),
    keepalive: true
  });
}


function stableCloudValue(value) {
  if (value === undefined) return '__UNDEFINED__';
  if (value === null) return null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableCloudValue);
  const out = {};
  Object.keys(value).sort().forEach(k => { out[k] = stableCloudValue(value[k]); });
  return out;
}

function sameCloudValue(a, b) {
  try {
    return JSON.stringify(stableCloudValue(a)) === JSON.stringify(stableCloudValue(b));
  } catch (_) {
    return String(a) === String(b);
  }
}

function verifyWriteSnapshot(snapshot) {
  const failures = [];

  (snapshot || []).forEach(entry => {
    const key = String(entry && entry.key || '').trim();
    if (!key) return;

    const actualRaw = appStorage.getItem(key);
    const actual = actualRaw === null ? null : parseStorageValue(actualRaw);

    if (String(entry.op || '').toLowerCase() === 'delete') {
      if (actualRaw !== null) failures.push(key + ':delete');
      return;
    }

    const expected = SCALAR_KEYS.has(key)
      ? entry.value
      : (Array.isArray(entry.value) ? entry.value : [entry.value]);

    if (!sameCloudValue(actual, expected)) {
      failures.push(key + ':verify');
    }
  });

  if (failures.length) {
    throw new Error('WRITE TIDAK TERVERIFIKASI: ' + failures.join(', '));
  }
}

async function flushPendingWrites() {
  if (!isSupabaseReady || cloudSyncBusy || pendingWrites.size === 0) return false;

  cloudSyncBusy = true;
  const snapshot = Array.from(pendingWrites.values());
  pendingWrites.clear();

  try {
    console.log('📤 Mengirim batch ke Google Sheets:', snapshot.length);
    await postNoCors({ action: 'write', data: snapshot });

    // Apps Script dapat membutuhkan sedikit waktu untuk commit.
    await new Promise(resolve => setTimeout(resolve, 900));
    await loadAllFromSupabase();

    // GET berhasil saja belum membuktikan data benar-benar tersimpan.
    verifyWriteSnapshot(snapshot);

    isSupabaseOnline = true;
    updateSupabaseStatusUI(true);
    lastPushAt = Date.now();
    console.log('✅ WRITE + VERIFIKASI GOOGLE SHEETS BERHASIL');
    return true;
  } catch (err) {
    snapshot.forEach(item => pendingWrites.set(item.key, item));
    isSupabaseOnline = false;
    updateSupabaseStatusUI(false);
    console.error('❌ Gagal sinkronisasi Google Sheets:', err.message);
    scheduleFlush(WRITE_RETRY_MS);
    return false;
  } finally {
    cloudSyncBusy = false;
    if (pendingWrites.size) scheduleFlush(WRITE_RETRY_MS);
  }
}

async function pushToSupabaseNow() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  return flushPendingWrites();
}

async function pullFromSupabase() {
  if (lastPushAt && Date.now() - lastPushAt < PUSH_SUPPRESS_MS) return true;

  try {
    await loadAllFromSupabase();
    isSupabaseOnline = true;
    updateSupabaseStatusUI(true);
    return true;
  } catch (err) {
    isSupabaseOnline = false;
    updateSupabaseStatusUI(false);
    console.warn('⚠️ Pull Google Sheets gagal:', err.message);
    return false;
  }
}

async function initSupabaseDB() {
  const endpoint = getCloudEndpoint();
  if (!endpoint) {
    updateSupabaseStatusUI(false);
    console.warn('❌ SHEETS_ENDPOINT belum tersedia.');
    return false;
  }

  try {
    await loadAllFromSupabase();
    isSupabaseReady = true;
    isSupabaseOnline = true;
    updateSupabaseStatusUI(true);
    console.log('✅ GOOGLE SHEETS PROXY TERHUBUNG');
    return true;
  } catch (err) {
    isSupabaseReady = false;
    isSupabaseOnline = false;
    updateSupabaseStatusUI(false);
    console.error('❌ Koneksi Google Sheets gagal:', err.message);
    return false;
  }
}

async function seedSupabaseDefaults(defaults) {
  if (!isSupabaseReady) return;

  Object.entries(defaults || {}).forEach(([key, value]) => {
    const rowCount = cloudRowCounts.get(key);
    const parsedDefault = parseStorageValue(value);
    const defaultIsEmpty = Array.isArray(parsedDefault) ? parsedDefault.length === 0 :
      (parsedDefault && typeof parsedDefault === 'object' ? Object.keys(parsedDefault).length === 0 : String(parsedDefault ?? '') === '');

    // Sheet kosong dianggap belum terinisialisasi hanya jika default memang berisi data.
    if (cloudLoadedKeys.has(key) && (rowCount > 0 || defaultIsEmpty)) return;
    if (!memoryCache.has(key)) hydrateStorage(key, value);
    queueCloudWrite(key, parseStorageValue(appStorage.getItem(key)) ?? parsedDefault);
  });

  await pushToSupabaseNow();
}

function startSupabaseKeepalive() {
  // Satu interval saja. Tidak ada POST otomatis berulang.
  if (window.__sheetsKeepaliveStarted) return;
  window.__sheetsKeepaliveStarted = true;
  setInterval(() => {
    if (!cloudSyncBusy && pendingWrites.size === 0) pullFromSupabase().catch(() => {});
  }, 15000);
}

async function uploadPhotoToSupabaseStorage(file, fileName) {
  // Foto tetap nonaktif sesuai konfigurasi aplikasi saat ini.
  console.warn('⚠️ Upload foto dinonaktifkan.');
  return null;
}

function updateSupabaseStatusUI(isOnline) {
  const badge = document.getElementById('cloudStatusBadge');
  if (!badge) return;

  if (isOnline) {
    badge.style.background = 'rgba(16, 185, 129, 0.18)';
    badge.style.color = '#10b981';
    badge.style.borderColor = 'rgba(16, 185, 129, 0.35)';
    badge.innerHTML = '<span class="material-symbols-rounded" style="font-size:15px">cloud_done</span> CLOUD ONLINE';
  } else {
    badge.style.background = 'rgba(239, 68, 68, 0.18)';
    badge.style.color = '#ef4444';
    badge.style.borderColor = 'rgba(239, 68, 68, 0.35)';
    badge.innerHTML = '<span class="material-symbols-rounded" style="font-size:15px">cloud_off</span> CLOUD OFFLINE';
  }
}

// Public API untuk app.js.
window.initSupabaseDB = initSupabaseDB;
window.loadSupabaseConfigFromJson = loadSupabaseConfigFromJson;
window.pushToSupabaseNow = pushToSupabaseNow;
window.pullFromSupabase = pullFromSupabase;
window.startSupabaseKeepalive = startSupabaseKeepalive;
window.seedSupabaseDefaults = seedSupabaseDefaults;
window.uploadPhotoToSupabaseStorage = uploadPhotoToSupabaseStorage;
window.queueCloudWrite = queueCloudWrite;
window.queueCloudDelete = queueCloudDelete;
window.hasPendingCloudWrites = () => pendingWrites.size > 0 || cloudSyncBusy;
window.mapStorageKeyToSheetName = mapStorageKeyToSheetName;
window.setOnDataChangeCallback = setOnDataChangeCallback;
window.appStorage = appStorage;
