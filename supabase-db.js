/* ======================================================
   GOOGLE SHEETS (APPS SCRIPT) DATABASE ADAPTER - CLOUD ONLY
   - Semua data LANGSUNG dari Google Sheets
   - TANPA cache lokal (no localStorage, no sessionStorage)
   - TANPA foto (disable upload image)
====================================================== */

const memoryCache = new Map();
// DISABLE semua penyimpanan lokal
const DISABLE_PERSISTENCE = true; // retained for backward compatibility; storage is memory-only
const sessionKey = window.SESSION_KEY || 'STORE_ACTIVE_SESSION_V7_CLEAN';
const themeKey = window.THEME_KEY || 'STORE_ACTIVE_THEME_V7_CLEAN';
const ADMIN_SCRIPT_URL_STORAGE_KEY = window.ADMIN_SCRIPT_URL_KEY || 'STORE_ADMIN_SCRIPT_URL_V7_CLEAN';

let pendingWrites = new Map();
let writeTimer = null;
let isSupabaseReady = false;
let isSupabaseOnline = false;
let onDataChangeCallback = null;
let lastPushAt = 0;
const PUSH_SUPPRESS_MS = 2000;

const appStorage = {
  getItem(key) {
    if (!memoryCache.has(key)) return null;
    const val = memoryCache.get(key);
    return typeof val === 'string' ? val : JSON.stringify(val);
  },

  setItem(key, value) {
    const previousCachedStr = memoryCache.get(key);
    const previousCachedValue = previousCachedStr !== undefined
      ? parseStorageValue(previousCachedStr)
      : undefined;
    const normalizedValue = normalizeDateFields(value);
    const strVal = typeof normalizedValue === 'string'
      ? normalizedValue
      : JSON.stringify(normalizedValue);

    memoryCache.set(key, strVal);
    schedulePersist(key, parseStorageValue(strVal), previousCachedValue);
  },

  removeItem(key) {
    memoryCache.delete(key);
    scheduleDelete(key);
  },

  clear() {
    memoryCache.clear();
    pendingWrites.clear();
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
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

function getRecordIdentity(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;

  const candidateKeys = ['id', 'noSurat', 'username', 'roomId', 'messageId', 'key', 'code'];
  for (const key of candidateKeys) {
    const value = item[key];
    if (value !== undefined && value !== null && value !== '') {
      return String(value);
    }
  }

  return null;
}

function getItemFingerprint(item) {
  const identity = getRecordIdentity(item);
  if (identity) return `id:${identity}`;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  try { return JSON.stringify(item); } catch { return null; }
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
  const endpoint = String(window.APP_SHEETS_ENDPOINT || '').trim();
  if (endpoint) return endpoint;

  const stored = String(appStorage.getItem(ADMIN_SCRIPT_URL_STORAGE_KEY) || '').trim();
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
function schedulePersist(key, parsedValue, previousCachedValue) {
  const normalized = normalizeDateFields(parsedValue);
  const previous = previousCachedValue === undefined
    ? undefined
    : normalizeDateFields(previousCachedValue);

  try {
    if (JSON.stringify(previous) === JSON.stringify(normalized)) {
      return;
    }

    if (Array.isArray(normalized)) {
      if (!Array.isArray(previous)) {
        pendingWrites.set(key, { __OP__: 'replace', items: normalized });
      } else {
        const previousMap = new Map();
        previous.forEach(item => {
          const fingerprint = getItemFingerprint(item);
          if (fingerprint) previousMap.set(fingerprint, item);
        });

        const nextMap = new Map();
        const newItems = [];
        const updatedItems = [];

        normalized.forEach(item => {
          const fingerprint = getItemFingerprint(item);
          if (!fingerprint) return;
          nextMap.set(fingerprint, item);

          const existing = previousMap.get(fingerprint);
          if (!existing) {
            newItems.push(item);
          } else if (JSON.stringify(existing) !== JSON.stringify(item)) {
            updatedItems.push(item);
          }
        });

        const removedItems = [];
        previousMap.forEach((item, fingerprint) => {
          if (!nextMap.has(fingerprint)) removedItems.push(item);
        });

        if (removedItems.length > 0) {
          pendingWrites.set(key, { __OP__: 'replace', items: normalized });
        } else if (newItems.length && updatedItems.length) {
          pendingWrites.set(key, {
            __OPS__: [
              { op: 'append', items: newItems },
              { op: 'upsert', items: updatedItems }
            ]
          });
        } else if (newItems.length) {
          pendingWrites.set(key, { __OP__: 'append', items: newItems });
        } else if (updatedItems.length) {
          pendingWrites.set(key, { __OP__: 'upsert', items: updatedItems });
        }
      }
    } else {
      pendingWrites.set(key, normalized);
    }
  } catch (err) {
    console.warn('schedulePersist failed:', err);
    pendingWrites.set(key, normalized);
  }

  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushPendingWrites, 100);
}
function scheduleDelete(key) {
  pendingWrites.set(key, { __DELETE__: true });
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flushPendingWrites, 100);
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

    const pendingSnapshot = Array.from(pendingWrites.entries());

    try {

        const proxyUrl = endpoint.replace(/\/$/, "");

        console.log("📡 POST:", proxyUrl);
        console.log("📦 Batch:", batch);

        const resp = await fetch(proxyUrl, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain;charset=utf-8"
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

        pendingSnapshot.forEach(([key, value]) => {
          if (pendingWrites.get(key) === value) {
            pendingWrites.delete(key);
          }
        });
        isSupabaseOnline = true;
        updateSupabaseStatusUI(true);
        try { lastPushAt = Date.now(); } catch (e) {}

    } catch (err) {

        console.error("flushPendingWrites:", err);
        pendingWrites = new Map(pendingSnapshot);
        if (writeTimer) clearTimeout(writeTimer);
        writeTimer = setTimeout(flushPendingWrites, 200);
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
                "Content-Type": "text/plain;charset=utf-8"
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
