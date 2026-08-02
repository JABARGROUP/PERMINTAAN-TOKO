/* ======================================================
   GOOGLE SHEETS (APPS SCRIPT) DATABASE ADAPTER
   Replaces Supabase client with a simple Apps Script HTTP endpoint
   Expected endpoint: deploy a Google Apps Script Web App that accepts
   GET ?action=loadAll and POST with { action: 'write', data: [...] }
====================================================== */

const memoryCache = new Map();
const sessionKey = window.SESSION_KEY || 'STORE_ACTIVE_SESSION_V7_CLEAN';
const themeKey = window.THEME_KEY || 'STORE_ACTIVE_THEME_V7_CLEAN';
const ADMIN_SCRIPT_URL_KEY = window.ADMIN_SCRIPT_URL_KEY || 'STORE_ADMIN_SCRIPT_URL_V7_CLEAN';

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
    const strVal = String(value);
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

function serializeForCache(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
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
  const stored = (appStorage.getItem(ADMIN_SCRIPT_URL_KEY) || '').trim();
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

async function loadAllFromSupabase() {
  const endpoint = getCloudEndpoint();
  if (!endpoint) return;
  try {
    if (typeof endpoint === 'string') {
      const resp = await fetch(`${endpoint}?action=loadAll`, { cache: 'no-store' });
      if (!resp.ok) throw new Error('Failed to fetch from Sheets endpoint');
      const payload = await resp.json();
      if (payload && Array.isArray(payload.data)) {
        payload.data.forEach(row => {
          if (row && row.key) memoryCache.set(row.key, serializeForCache(row.value));
        });
        if (typeof onDataChangeCallback === 'function') onDataChangeCallback(null);
      }
    } else if (endpoint && endpoint.type === 'sheets_api') {
      // Read from Google Sheets API: expects a sheet named 'app_storage' with columns: key,value,updated_at
      const sheetRange = 'app_storage!A:C';
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${endpoint.spreadsheetId}/values/${encodeURIComponent(sheetRange)}?key=${endpoint.apiKey}`;
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error('Failed to fetch from Google Sheets API');
      const payload = await resp.json();
      // payload.values is array of rows
      if (payload && Array.isArray(payload.values)) {
        payload.values.forEach(r => {
          // expect [key, value, updated_at]
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
  pendingWrites.set(key, parsedValue);
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
    if (v && v.__DELETE__) {
      batch.push({ key: k, op: 'delete' });
    } else {
      batch.push({ key: k, op: 'upsert', value: v });
    }
  }
  pendingWrites.clear();

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'write', data: batch })
    });
    if (!resp.ok) throw new Error('Cloud write failed');
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
