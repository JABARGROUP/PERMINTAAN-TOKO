/* ======================================================
   GOOGLE SHEETS (APPS SCRIPT) DATABASE ADAPTER
   Replaces Supabase client with a simple Apps Script HTTP endpoint
   Expected endpoint: deploy a Google Apps Script Web App that accepts
   GET ?action=loadAll and POST with { action: 'write', data: [...] }
====================================================== */

const memoryCache = new Map();
const sessionKey = window.SESSION_KEY || 'STORE_ACTIVE_SESSION_V7_CLEAN';
const themeKey = window.THEME_KEY || 'STORE_ACTIVE_THEME_V7_CLEAN';
const ADMIN_SCRIPT_URL_STORAGE_KEY = window.ADMIN_SCRIPT_URL_KEY || 'STORE_ADMIN_SCRIPT_URL_V7_CLEAN';

let pendingWrites = new Map();
let writeTimer = null;
let isSupabaseReady = false; // kept for compatibility with app.js
let isSupabaseOnline = false;
let onDataChangeCallback = null;

const appStorage = {
  getItem(key) {
    try {
      const localValue = window.localStorage ? window.localStorage.getItem(key) : null;
      if (localValue !== null) {
        memoryCache.set(key, localValue);
        return localValue;
      }
    } catch (err) {
      // fallback to memory cache
    }

    if (!memoryCache.has(key)) return null;
    const val = memoryCache.get(key);
    return typeof val === 'string' ? val : JSON.stringify(val);
  },

  setItem(key, value) {
    const normalizedValue = normalizeDateFields(value);
    const strVal = typeof normalizedValue === 'string' ? normalizedValue : JSON.stringify(normalizedValue);
    memoryCache.set(key, strVal);
    try {
      // Persist to localStorage ONLY for session (user login/password)
      if (window.localStorage && key === sessionKey) {
        window.localStorage.setItem(key, strVal);
      }
    } catch (err) {
      console.warn('localStorage write failed:', err.message);
    }
    schedulePersist(key, parseStorageValue(strVal));
  },

  removeItem(key) {
    memoryCache.delete(key);
    try {
      if (window.localStorage && key === sessionKey) {
        window.localStorage.removeItem(key);
      }
    } catch (err) {
      console.warn('localStorage remove failed:', err.message);
    }
    scheduleDelete(key);
  },

  clear() {
    // Keep only session in localStorage
    const keepKeys = new Set([sessionKey]);
    [...memoryCache.keys()].forEach(k => {
      if (!keepKeys.has(k)) memoryCache.delete(k);
    });

    try {
      if (window.localStorage) {
        Object.keys(window.localStorage).forEach(k => {
          if (!keepKeys.has(k)) window.localStorage.removeItem(k);
        });
      }
    } catch (err) {
      console.warn('localStorage clear failed:', err.message);
    }
  }
};

function parseStorageValue(strVal) {
  try { return JSON.parse(strVal); } catch { return strVal; }
}

function normalizeDateFields(value) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const str = value.trim();
    if (!str) return '';
    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) return str.split(' ')[0];

    const match = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
    if (match) {
      return `${match[3]}/${match[2]}/${match[1]}`;
    }

    const d = new Date(str);
    if (!isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      return `${day}/${month}/${year}`;
    }

    return str;
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDateFields);
  }

  if (typeof value === 'object') {
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      const key = String(k || '').toLowerCase();
      const shouldNormalize = /(tanggal|createdat|updatedat|updated_at|created_at|date)/i.test(key);
      out[k] = shouldNormalize ? normalizeDateFields(v) : normalizeDateFields(v);
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

function setOnDataChangeCallback(fn) { onDataChangeCallback = fn; }

async function loadSupabaseConfigFromJson() {
  // kept name for compatibility: will try to load ./sheets-config.json
  try {
    const resp = await fetch('./sheets-config.json?v=20260802', { cache: 'no-store' });
    if (!resp.ok) return;
    const cfg = await resp.json();
    if (cfg) {
      if (cfg.SHEETS_ENDPOINT) {
        window.APP_SHEETS_ENDPOINT = String(cfg.SHEETS_ENDPOINT).trim();
      }
      if (cfg.SPREADSHEET_ID) {
        window.APP_SHEETS_SPREADSHEET_ID = String(cfg.SPREADSHEET_ID).trim();
      }
      if (cfg.SHEETS_API_KEY) {
        window.APP_SHEETS_API_KEY = String(cfg.SHEETS_API_KEY).trim();
      }
    }
  } catch (err) {
    // ignore
  }
}

function getCloudEndpoint() {
  // Priority: explicit Apps Script endpoint -> built Sheets API (spreadsheetId + apiKey) -> stored admin script URL
  if (window.APP_SHEETS_ENDPOINT) return window.APP_SHEETS_ENDPOINT;
  if (window.APP_SHEETS_SPREADSHEET_ID && window.APP_SHEETS_API_KEY) {
    return { type: 'sheets_api', spreadsheetId: window.APP_SHEETS_SPREADSHEET_ID, apiKey: window.APP_SHEETS_API_KEY };
  }
  const stored = (appStorage.getItem(ADMIN_SCRIPT_URL_STORAGE_KEY) || '').trim();
  return stored || null;
}

async function initSupabaseDB(secretKey = null) {
  // Initialize by attempting to load all data from the configured Apps Script endpoint.
  const endpoint = getCloudEndpoint();
  if (!endpoint) {
    isSupabaseReady = false;
    isSupabaseOnline = false;
    updateSupabaseStatusUI(false);
    console.warn('No Google Sheets endpoint configured. Running in local-memory mode.');
    return false;
  }

  try {
    await loadAllFromSupabase();
    isSupabaseReady = true;
    isSupabaseOnline = true;
    updateSupabaseStatusUI(true);
    console.log('✅ CLOUD (Sheets) TERHUBUNG');
    return true;
  } catch (err) {
    console.warn('Cloud init failed:', err.message);
    isSupabaseReady = false;
    isSupabaseOnline = false;
    updateSupabaseStatusUI(false);
    return false;
  }
}

function mapStorageKeyToSheetName(key) {
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

function mapSheetNameToStorageKey(sheetName) {
  const map = {
    users: 'STORE_USERS_DB_V7_CLEAN',
    requests: 'STORE_REQUESTS_DB_V7_CLEAN',
    chat: 'STORE_CHAT_DB_V7_CLEAN',
    chat_rooms: 'STORE_CHAT_ROOM_DB_V7_CLEAN',
    ttd: 'STORE_TTD_DB_V7_CLEAN',
    stores: 'STORE_CUSTOM_TOKO_LIST_V7_CLEAN',
    deleted_stores: 'STORE_DELETED_TOKO_LIST_V7_CLEAN',
    notifications: 'STORE_SYSTEM_NOTIFICATIONS_V7_CLEAN',
    kode_unit_map: 'STORE_KODE_UNIT_MAP_V7_CLEAN',
    feature_photos: 'STORE_FEATURE_PHOTOS_V7_CLEAN',
    deleted_requests: 'STORE_DELETED_REQUESTS_V7_CLEAN',
    deleted_users: 'STORE_DELETED_USERS_V7_CLEAN',
    fonte_token: 'STORE_FONTE_TOKEN_KEY_V7_CLEAN',
    admin_reminder: 'STORE_ADMIN_REMINDER_KEY_V7_CLEAN',
    admin_secret: 'STORE_ADMIN_SECRET_KEY_V7_CLEAN',
    sessions: 'STORE_ACTIVE_SESSION_V7_CLEAN',
    theme: 'STORE_ACTIVE_THEME_V7_CLEAN',
    admin_script_url: 'STORE_ADMIN_SCRIPT_URL_V7_CLEAN'
  };
  return map[String(sheetName || '').trim().toLowerCase()] || null;
}

async function loadAllFromSupabase() {
  const endpoint = getCloudEndpoint();
  if (!endpoint) return;
  try {
    if (typeof endpoint === 'string') {
      const finalUrl = endpoint.endsWith('?') ? endpoint + 'action=loadall' : endpoint + '?action=loadall';
      console.log('📡 Fetching from:', finalUrl);
      const resp = await fetch(finalUrl, { cache: 'no-store', method: 'GET' });
      console.log('📡 Response status:', resp.status);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: Failed to fetch from Sheets endpoint`);
      const payload = await resp.json();
      console.log('📡 Response:', payload);
      
      if (payload.error) {
        throw new Error(`Server error: ${payload.error}. Action received: ${payload.action}`);
      }
      
      if (payload && Array.isArray(payload.data)) {
        payload.data.forEach(sheet => {
          if (!sheet || !sheet.sheet) return;
          const storageKey = mapSheetNameToStorageKey(sheet.sheet);
          if (!storageKey) return;
          const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
          const parsedRows = rows
            .map(r => {
              if (r && r.data_json !== undefined) {
                const raw = r.data_json;
                if (typeof raw === 'string') {
                  try { return JSON.parse(raw); } catch { return raw; }
                }
                return raw;
              }
              return r;
            })
            .filter(item => item !== null && item !== undefined && item !== '');

          if (parsedRows.length) {
            memoryCache.set(storageKey, serializeForCache(parsedRows));
          }
        });
        if (typeof onDataChangeCallback === 'function') onDataChangeCallback(null);
      }
    } else if (endpoint && endpoint.type === 'sheets_api') {
      // Legacy fallback: read a simple sheet named app_storage
      const sheetRange = 'app_storage!A:C';
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${endpoint.spreadsheetId}/values/${encodeURIComponent(sheetRange)}?key=${endpoint.apiKey}`;
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error('Failed to fetch from Google Sheets API');
      const payload = await resp.json();
      if (payload && Array.isArray(payload.values)) {
        payload.values.forEach(r => {
          const key = r[0];
          const val = r[1];
          if (key) memoryCache.set(key, serializeForCache(val));
        });
        if (typeof onDataChangeCallback === 'function') onDataChangeCallback(null);
      }
    }
  } catch (err) {
    console.warn('loadAllFromSupabase error:', err.message);
    throw err;
  }
}

function schedulePersist(key, parsedValue) {
  pendingWrites.set(key, normalizeDateFields(parsedValue));
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushPendingWrites, 300);
}

function scheduleDelete(key) {
  pendingWrites.set(key, { __DELETE__: true });
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushPendingWrites, 300);
}

async function flushPendingWrites() {
  const endpoint = getCloudEndpoint();
  if (!endpoint || pendingWrites.size === 0) return;

  const batch = [];
  for (const [k, v] of pendingWrites) {
    const sheet = mapStorageKeyToSheetName(k);
    if (v && v.__DELETE__) {
      batch.push({ key: k, sheet, op: 'delete' });
    } else {
      batch.push({ key: k, sheet, op: 'upsert', value: v });
    }
  }
  pendingWrites.clear();

  try {
    console.log('📡 Flushing writes to:', endpoint);
    console.log('📡 Batch:', batch);
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'write', data: batch })
    });
    console.log('📡 Write response status:', resp.status);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: Cloud write failed`);
    const result = await resp.json();
    console.log('📡 Write response:', result);
    if (result.error) {
      throw new Error(`Server error: ${result.error}`);
    }
    isSupabaseOnline = true;
    updateSupabaseStatusUI(true);
  } catch (err) {
    console.warn('flushPendingWrites error:', err.message);
    isSupabaseOnline = false;
    updateSupabaseStatusUI(false);
  }
}

async function pushToSupabaseNow() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  await flushPendingWrites();
}

async function pullFromSupabase() {
  try {
    await loadAllFromSupabase();
    isSupabaseOnline = true;
    updateSupabaseStatusUI(true);
    return true;
  } catch (err) {
    isSupabaseOnline = false;
    updateSupabaseStatusUI(false);
    return false;
  }
}

function startSupabaseKeepalive() {
  // No-op keepalive; optionally could ping endpoint periodically.
}

async function seedSupabaseDefaults(defaults) {
  // Write defaults to memory and schedule persist; actual cloud seeding
  // depends on the configured Apps Script implementation.
  Object.entries(defaults || {}).forEach(([k, v]) => {
    if (!memoryCache.has(k)) {
      memoryCache.set(k, serializeForCache(v));
      schedulePersist(k, v);
    }
  });
}

async function uploadPhotoToSupabaseStorage(file, fileName) {
  const endpoint = getCloudEndpoint();
  if (!endpoint || typeof endpoint !== 'string') {
    console.warn('No Apps Script upload endpoint configured.');
    return null;
  }

  function readFileAsDataURL(f) {
    return new Promise((resolve, reject) => {
      try {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = (e) => reject(e);
        reader.readAsDataURL(f);
      } catch (err) {
        reject(err);
      }
    });
  }

  try {
    const name = fileName || (file && file.name) || `photo_${Date.now()}`;
    const dataUrl = await readFileAsDataURL(file);
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'uploadImage', filename: name, imageBase64: dataUrl })
    });
    if (!resp.ok) throw new Error('Upload failed');
    const payload = await resp.json();
    return payload && payload.url ? payload.url : null;
  } catch (err) {
    console.warn('uploadPhotoToSupabaseStorage error:', err.message);
    return null;
  }
}

function updateSupabaseStatusUI(isOnline) {
  const badge = document.getElementById('cloudStatusBadge');
  if (!badge) return;
  if (isOnline) {
    badge.style.background = 'rgba(16, 185, 129, 0.18)';
    badge.style.color = '#10b981';
    badge.style.borderColor = 'rgba(16, 185, 129, 0.35)';
    badge.innerHTML = '<span class="material-symbols-rounded" style="font-size: 15px;">cloud_done</span> CLOUD ONLINE';
  } else {
    badge.style.background = 'rgba(239, 68, 68, 0.18)';
    badge.style.color = '#ef4444';
    badge.style.borderColor = 'rgba(239, 68, 68, 0.35)';
    badge.innerHTML = '<span class="material-symbols-rounded" style="font-size: 15px;">cloud_off</span> CLOUD OFFLINE';
  }
}

function toggleAdminSecretKeyField() { /* kept for compatibility */ }

window.initSupabaseDB = initSupabaseDB;
window.pushToSupabaseNow = pushToSupabaseNow;
window.pullFromSupabase = pullFromSupabase;
window.startSupabaseKeepalive = startSupabaseKeepalive;
window.seedSupabaseDefaults = seedSupabaseDefaults;
window.uploadPhotoToSupabaseStorage = uploadPhotoToSupabaseStorage;
window.toggleAdminSecretKeyField = toggleAdminSecretKeyField;
window.appStorage = appStorage;
