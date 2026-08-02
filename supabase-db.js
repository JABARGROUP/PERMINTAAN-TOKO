/* ======================================================
   GOOGLE SHEETS (APPS SCRIPT) DATABASE ADAPTER
   Replaces Supabase client with a simple Apps Script HTTP endpoint
   Expected endpoint: deploy a Google Apps Script Web App that accepts
   GET ?action=loadAll and POST with { action: 'write', data: [...] }
====================================================== */

const memoryCache = new Map();
// When true, do not persist any cache to sessionStorage/localStorage
const DISABLE_PERSISTENCE = true;
const sessionKey = window.SESSION_KEY || 'STORE_ACTIVE_SESSION_V7_CLEAN';
const themeKey = window.THEME_KEY || 'STORE_ACTIVE_THEME_V7_CLEAN';
const ADMIN_SCRIPT_URL_STORAGE_KEY = window.ADMIN_SCRIPT_URL_KEY || 'STORE_ADMIN_SCRIPT_URL_V7_CLEAN';

let pendingWrites = new Map();
let writeTimer = null;
let isSupabaseReady = false; // kept for compatibility with app.js
let isSupabaseOnline = false;
let onDataChangeCallback = null;
// Timestamp of last successful push; used to suppress immediate pulls
let lastPushAt = 0;
const PUSH_SUPPRESS_MS = 3000; // suppress pulls for 3 seconds after push

const appStorage = {
  getItem(key) {
    try {
      if (!DISABLE_PERSISTENCE) {
        const storedValue = window.sessionStorage ? window.sessionStorage.getItem(key) : null;
        if (storedValue !== null) {
          memoryCache.set(key, storedValue);
          return storedValue;
        }
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
      // Persist session to sessionStorage only if persistence enabled
      if (!DISABLE_PERSISTENCE && window.sessionStorage && key === sessionKey) {
        window.sessionStorage.setItem(key, strVal);
      }
    } catch (err) {
      console.warn('storage write failed:', err.message);
    }
    schedulePersist(key, parseStorageValue(strVal));
  },

  removeItem(key) {
    memoryCache.delete(key);
    try {
      if (!DISABLE_PERSISTENCE && window.sessionStorage && key === sessionKey) {
        window.sessionStorage.removeItem(key);
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
      if (!DISABLE_PERSISTENCE && window.sessionStorage) {
        Object.keys(window.sessionStorage).forEach(k => {
          if (!keepKeys.has(k)) window.sessionStorage.removeItem(k);
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

    // If already in dd/mm/yyyy format, keep as-is (strip time if present)
    if (/^\d{2}\/\d{2}\/\d{4}/.test(str)) return str.split(' ')[0];

    // yyyy-mm-dd or yyyy/mm/dd -> convert to dd/mm/yyyy
    const match = str.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
    if (match) {
      return `${match[3]}/${match[2]}/${match[1]}`;
    }

    // Avoid converting pure-numeric strings (IDs, numbers) into dates
    if (/^[0-9]+$/.test(str)) return str;

    // If string contains non-numeric characters, try parsing as a date
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
      if (shouldNormalize) {
        out[k] = normalizeDateFields(v);
      } else {
        // For non-date keys, recurse but avoid forcing string->date conversions
        if (typeof v === 'object' && v !== null) {
          out[k] = normalizeDateFields(v);
        } else {
          out[k] = v;
        }
      }
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

    const finalUrl =
        endpoint.replace(/\/$/, "") +
        "?action=loadall";

    console.log("📡 GET:", finalUrl);

    const resp = await fetch(finalUrl, {
        method: "GET",
        cache: "no-store"
    });

    if (!resp.ok)
        throw new Error("HTTP " + resp.status);

    const payload = await resp.json();

    if (payload.error)
        throw new Error(payload.error);

    if (!Array.isArray(payload.data))
        return;

    payload.data.forEach(sheet => {

        const storageKey =
            mapSheetNameToStorageKey(sheet.sheet);

        if (!storageKey) return;

        const rows = (sheet.rows || []).map(r => {

            try {
                return JSON.parse(r.data_json);
            } catch {
                return r.data_json;
            }

        });

        memoryCache.set(storageKey, serializeForCache(rows));

    });

    if (typeof onDataChangeCallback === "function")
        onDataChangeCallback(null);

}
function schedulePersist(key, parsedValue) {
  const normalized = normalizeDateFields(parsedValue);

  // Helper to update memoryCache stored string
  function setCache(k, v) {
    memoryCache.set(k, serializeForCache(v));
  }

  try {
    // If value is an array, try to append only new rows instead of replacing
    if (Array.isArray(normalized)) {
      const cachedStr = memoryCache.get(key);
      const cached = cachedStr ? parseStorageValue(cachedStr) : [];

      if (!Array.isArray(cached) || cached.length === 0) {
        if (!normalized || normalized.length === 0) return; // nothing to do
        // No cache — set full array and append all rows
        setCache(key, normalized);
        pendingWrites.set(key, { __OP__: 'append', items: normalized });
      } else {
        // Try object-based diff (by `id` field)
        const first = normalized[0];
        const isObjects = typeof first === 'object' && first !== null;
        if (isObjects) {
          const cachedMap = new Map();
          cached.forEach(it => { if (it && (it.id || it.id === 0)) cachedMap.set(String(it.id), it); });

          const newItems = [];
          const updatedItems = [];

          normalized.forEach(it => {
            const id = it && (it.id || it.id === 0) ? String(it.id) : null;
            if (!id) return;
            const existing = cachedMap.get(id);
            if (!existing) newItems.push(it);
            else if (JSON.stringify(existing) !== JSON.stringify(it)) updatedItems.push(it);
          });

          if (newItems.length === 0 && updatedItems.length === 0) {
            return; // no changes
          }

          // merge into cached representation
          const merged = [...cached];
          const idxById = new Map();
          merged.forEach((it, idx) => { if (it && (it.id || it.id === 0)) idxById.set(String(it.id), idx); });
          newItems.forEach(it => merged.push(it));
          updatedItems.forEach(it => {
            const id = String(it.id);
            if (idxById.has(id)) merged[idxById.get(id)] = it;
            else merged.push(it);
          });

          setCache(key, merged);

          // schedule append and/or upsert
          if (newItems.length && updatedItems.length) {
            pendingWrites.set(key, { __OPS__: [ { op: 'append', items: newItems }, { op: 'upsert', items: updatedItems } ] });
          } else if (newItems.length) {
            pendingWrites.set(key, { __OP__: 'append', items: newItems });
          } else {
            pendingWrites.set(key, { __OP__: 'upsert', items: updatedItems });
          }
        } else {
          // primitive arrays: append tail if length increased
          if (normalized.length > cached.length) {
            const tail = normalized.slice(cached.length);
            setCache(key, [...cached, ...tail]);
            pendingWrites.set(key, { __OP__: 'append', items: tail });
          } else if (JSON.stringify(normalized) !== JSON.stringify(cached)) {
            // fallback: replace whole array
            setCache(key, normalized);
            pendingWrites.set(key, normalized);
          } else {
            return; // identical
          }
        }
      }
    } else {
      // Non-array values: write only if changed
      const cachedStr = memoryCache.get(key);
      const cached = cachedStr ? parseStorageValue(cachedStr) : cachedStr;
      if (JSON.stringify(cached) === JSON.stringify(normalized)) return;
      setCache(key, normalized);
      pendingWrites.set(key, normalized);
    }
  } catch (err) {
    // On error fall back to simple persist
    pendingWrites.set(key, normalized);
  }

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

    for (const [key, value] of pendingWrites.entries()) {
      const sheet = mapStorageKeyToSheetName(key);
      if (!value) continue;

      if (value && value.__DELETE__) {
        batch.push({ key, sheet, op: 'delete' });
        continue;
      }

      if (value && value.__OPS__ && Array.isArray(value.__OPS__)) {
        value.__OPS__.forEach(opItem => {
          const opName = opItem.op || 'upsert';
          batch.push({ key, sheet, op: opName, value: opItem.items });
        });
        continue;
      }

      if (value && value.__OP__) {
        const opName = value.__OP__;
        batch.push({ key, sheet, op: opName, value: value.items });
        continue;
      }

      if (Array.isArray(value)) {
        batch.push({ key, sheet, op: 'replace', value });
        continue;
      }

      // default: upsert single object/value
      batch.push({ key, sheet, op: 'upsert', value });
    }

    pendingWrites.clear();

    try {

        const proxyUrl = endpoint.replace(/\/$/, "");

        console.log("📡 POST:", proxyUrl);
        console.log("📦 Batch:", batch);

        const resp = await fetch(proxyUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                action: "write",
                data: batch
            })
        });

        console.log("📡 Status:", resp.status);

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}`);
        }

        const result = await resp.json();

        console.log("📡 Response:", result);

        if (result.error) {
            throw new Error(result.error);
        }

          isSupabaseOnline = true;
          updateSupabaseStatusUI(true);
          // record last successful push time to avoid immediate pull overwrite
          try { lastPushAt = Date.now(); } catch (e) {}

    } catch (err) {

        console.error("flushPendingWrites:", err);

        isSupabaseOnline = false;
        updateSupabaseStatusUI(false);

    }

}
async function pushToSupabaseNow() {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  await flushPendingWrites();
}

async function pullFromSupabase() {
  // if we just pushed, skip immediate pull to avoid overwriting local new data
  try {
    if (lastPushAt && (Date.now() - lastPushAt) < PUSH_SUPPRESS_MS) {
      console.log('pullFromSupabase: skipped due to recent push');
      return true;
    }
  } catch (e) {}
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

    if (!endpoint || typeof endpoint !== "string") {
        console.warn("No Apps Script endpoint configured.");
        return null;
    }

    function readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    try {

        const dataUrl = await readFileAsDataURL(file);

        const resp = await fetch(endpoint.replace(/\/$/, ""), {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                action: "uploadImage",
                filename: fileName || file.name,
                imageBase64: dataUrl
            })
        });

        if (!resp.ok)
            throw new Error("HTTP " + resp.status);

        const json = await resp.json();

        if (json.error)
            throw new Error(json.error);

        return json.url;

    } catch (err) {

        console.error(err);
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
