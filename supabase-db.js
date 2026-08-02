/* ======================================================
   SUPABASE DATABASE ENGINE
   Menggantikan localStorage + Firebase + Cloud Sync
====================================================== */

let APP_SUPABASE_URL = 'https://ducrykojvabaoioigbgc.supabase.co';
let APP_SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_H2w50rrXQWKqZM2fKZJXBw_sRsEpwNf';

async function loadSupabaseConfigFromJson() {
  try {
    const response = await fetch('./supabase-config.json?v=20260801_supabase_fix_3', { cache: 'no-store' });
    if (!response.ok) return;
    const config = await response.json();
    if (config.SUPABASE_URL) APP_SUPABASE_URL = String(config.SUPABASE_URL).trim();
    if (config.SUPABASE_PUBLISHABLE_KEY) APP_SUPABASE_PUBLISHABLE_KEY = String(config.SUPABASE_PUBLISHABLE_KEY).trim();
    if (config.SUPABASE_SECRET_KEY) {
      window.APP_SUPABASE_SECRET_KEY = String(config.SUPABASE_SECRET_KEY).trim();
    }
    if (config.SUPABASE_JWKS_URL) {
      window.APP_SUPABASE_JWKS_URL = String(config.SUPABASE_JWKS_URL).trim();
    }
  } catch (err) {
    console.warn('Supabase config JSON tidak terbaca:', err.message);
  }
}

let supabaseClient = null;
let isSupabaseReady = false;
let isSupabaseOnline = false;
let pendingWrites = new Map();
let writeTimer = null;
let realtimeChannel = null;
let onDataChangeCallback = null;

/** In-memory cache — digunakan sebagai fallback, tetapi data utama disimpan di localStorage */
const memoryCache = new Map();

/** Session & tema disimpan di localStorage agar tidak hilang saat reload */
const sessionKey = window.SESSION_KEY || 'STORE_ACTIVE_SESSION_V7_CLEAN';
const themeKey = window.THEME_KEY || 'STORE_ACTIVE_THEME_V7_CLEAN';

const appStorage = {
  getItem(key) {
    try {
      const localValue = window.localStorage ? window.localStorage.getItem(key) : null;
      if (localValue !== null) {
        memoryCache.set(key, localValue);
        return localValue;
      }
    } catch (err) {
      // fall through to memory cache
    }

    if (!memoryCache.has(key)) return null;
    const val = memoryCache.get(key);
    return typeof val === 'string' ? val : JSON.stringify(val);
  },

  setItem(key, value) {
    const strVal = String(value);
    memoryCache.set(key, strVal);
    try {
      if (window.localStorage) {
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
      if (window.localStorage) {
        window.localStorage.removeItem(key);
      }
    } catch (err) {
      console.warn('localStorage remove failed:', err.message);
    }
    scheduleDelete(key);
  },

  clear() {
    const keepKeys = new Set([sessionKey, themeKey]);
    [...memoryCache.keys()].forEach(k => {
      if (!keepKeys.has(k)) {
        memoryCache.delete(k);
      }
    });

    try {
      if (window.localStorage) {
        Object.keys(window.localStorage).forEach(k => {
          if (!keepKeys.has(k) && (String(k).startsWith('STORE_') || String(k).startsWith('FIREBASE_'))) {
            window.localStorage.removeItem(k);
          }
        });
      }
    } catch (err) {
      console.warn('localStorage clear failed:', err.message);
    }
  }
};

function parseStorageValue(strVal) {
  try {
    return JSON.parse(strVal);
  } catch {
    return strVal;
  }
}

function serializeForCache(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function getSupabaseClient() {
  return supabaseClient;
}

function isDbReady() {
  return isSupabaseReady;
}

function setOnDataChangeCallback(fn) {
  onDataChangeCallback = fn;
}

async function initSupabaseDB(secretKey = null) {
  if (typeof supabase === 'undefined' || !supabase.createClient) {
    console.error('Supabase JS library belum dimuat!');
    updateSupabaseStatusUI(false);
    return false;
  }

  const apiKey = (secretKey && secretKey.trim()) ? secretKey.trim() : APP_SUPABASE_PUBLISHABLE_KEY;

  try {
    if (supabaseClient) {
      if (realtimeChannel) {
        await supabaseClient.removeChannel(realtimeChannel);
        realtimeChannel = null;
      }
    }

    supabaseClient = supabase.createClient(APP_SUPABASE_URL, apiKey, {
      realtime: { params: { eventsPerSecond: 10 } }
    });

    try {
      await loadAllFromSupabase();
      setupRealtimeSubscription();
      isSupabaseReady = true;
      isSupabaseOnline = true;
      updateSupabaseStatusUI(true);
      console.log('✅ SUPABASE TERHUBUNG');
      return true;
    } catch (dbErr) {
      const msg = String(dbErr?.message || dbErr || '');
      const isMissingTable = /does not exist|relation .*app_storage|app_storage.*not exist|permission/i.test(msg);

      if (isMissingTable) {
        console.warn('⚠️ TABEL app_storage belum dibuat di Supabase. Aplikasi tetap berjalan di mode local-memory.');
        isSupabaseReady = false;
        isSupabaseOnline = false;
        updateSupabaseStatusUI(false);
        return false;
      }

      throw dbErr;
    }
  } catch (err) {
    console.error('⚠️ SUPABASE GAGAL TERHUBUNG:', err.message);
    isSupabaseReady = false;
    isSupabaseOnline = false;
    updateSupabaseStatusUI(false);
    return false;
  }
}

async function loadAllFromSupabase() {
  if (!supabaseClient) return;

  const { data, error } = await supabaseClient
    .from('app_storage')
    .select('key, value');

  if (error) {
    const msg = String(error?.message || error || '');
    const isMissingTable = /does not exist|relation .*app_storage|app_storage.*not exist|permission/i.test(msg);
    if (isMissingTable) {
      console.warn('Tabel app_storage belum dibuat di Supabase, skip sync ke cloud.');
      return;
    }
    throw error;
  }

  if (Array.isArray(data)) {
    data.forEach(row => {
      memoryCache.set(row.key, serializeForCache(row.value));
    });
  }
}

function setupRealtimeSubscription() {
  if (!supabaseClient) return;

  try {
    realtimeChannel = supabaseClient
      .channel('app_storage_changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_storage' },
        payload => {
          const row = payload.new || payload.old;
          if (!row || !row.key) return;

          if (payload.eventType === 'DELETE') {
            memoryCache.delete(row.key);
          } else {
            memoryCache.set(row.key, serializeForCache(row.value));
          }

          if (typeof onDataChangeCallback === 'function') {
            onDataChangeCallback(row.key);
          }
        }
      )
      .subscribe();
  } catch (err) {
    console.warn('Realtime subscription dibatalkan:', err.message);
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
  if (!supabaseClient || pendingWrites.size === 0) return;

  const batch = new Map(pendingWrites);
  pendingWrites.clear();

  for (const [key, val] of batch) {
    try {
      if (val && val.__DELETE__) {
        await supabaseClient.from('app_storage').delete().eq('key', key);
      } else {
        await supabaseClient.from('app_storage').upsert({
          key,
          value: val,
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' });
      }
    } catch (err) {
      console.warn('Supabase write error:', key, err.message);
      isSupabaseOnline = false;
      updateSupabaseStatusUI(false);
    }
  }

  isSupabaseOnline = true;
  updateSupabaseStatusUI(true);
}

async function pushToSupabaseNow() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await flushPendingWrites();
}

async function pullFromSupabase() {
  if (!supabaseClient) return false;
  try {
    await loadAllFromSupabase();
    isSupabaseOnline = true;
    updateSupabaseStatusUI(true);
    return true;
  } catch (err) {
    console.warn('Supabase pull error:', err.message);
    isSupabaseOnline = false;
    updateSupabaseStatusUI(false);
    return false;
  }
}

let supabaseKeepaliveTimer = null;

function startSupabaseKeepalive() {
  if (supabaseKeepaliveTimer) return;

  const pingSupabase = async () => {
    if (!supabaseClient) {
      await initSupabaseDB();
      return;
    }

    try {
      const { error } = await supabaseClient.from('app_storage').select('key').limit(1);
      if (error) throw error;
      isSupabaseOnline = true;
      updateSupabaseStatusUI(true);
    } catch (err) {
      console.warn('Supabase keepalive failed:', err.message);
      isSupabaseOnline = false;
      updateSupabaseStatusUI(false);
    }
  };

  pingSupabase();
  supabaseKeepaliveTimer = setInterval(pingSupabase, 24 * 60 * 60 * 1000);
}

async function seedSupabaseDefaults(defaults) {
  if (!supabaseClient) return;

  const { data } = await supabaseClient.from('app_storage').select('key').limit(1);
  if (data && data.length > 0) return;

  const rows = Object.entries(defaults).map(([key, value]) => ({
    key,
    value: parseStorageValue(typeof value === 'string' ? value : JSON.stringify(value)),
    updated_at: new Date().toISOString()
  }));

  if (rows.length) {
    await supabaseClient.from('app_storage').upsert(rows, { onConflict: 'key' });
    rows.forEach(r => memoryCache.set(r.key, serializeForCache(r.value)));
  }
}

async function uploadPhotoToSupabaseStorage(file) {
  if (!supabaseClient) return null;

  try {
    const ext = (file.name && file.name.split('.').pop()) || 'jpg';
    const fileName = `FOTO_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;

    const { error } = await supabaseClient.storage
      .from('photos')
      .upload(fileName, file, { cacheControl: '3600', upsert: false });

    if (error) throw error;

    const { data } = supabaseClient.storage.from('photos').getPublicUrl(fileName);
    return data?.publicUrl || null;
  } catch (err) {
    console.warn('Supabase Storage upload error:', err.message);
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
    badge.innerHTML = '<span class="material-symbols-rounded" style="font-size: 15px;">cloud_done</span> SUPABASE ONLINE';
  } else {
    badge.style.background = 'rgba(239, 68, 68, 0.18)';
    badge.style.color = '#ef4444';
    badge.style.borderColor = 'rgba(239, 68, 68, 0.35)';
    badge.innerHTML = '<span class="material-symbols-rounded" style="font-size: 15px;">cloud_off</span> SUPABASE OFFLINE';
  }
}

function toggleAdminSecretKeyField() {
  // Secret key is now managed only in the user management settings panel.
  // The login form no longer asks for the key to keep the flow simple.
}

window.initSupabaseDB = initSupabaseDB;
window.pushToSupabaseNow = pushToSupabaseNow;
window.pullFromSupabase = pullFromSupabase;
window.startSupabaseKeepalive = startSupabaseKeepalive;
window.seedSupabaseDefaults = seedSupabaseDefaults;
window.uploadPhotoToSupabaseStorage = uploadPhotoToSupabaseStorage;
window.toggleAdminSecretKeyField = toggleAdminSecretKeyField;
window.appStorage = appStorage;
