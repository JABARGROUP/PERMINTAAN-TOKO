# Setup GitHub & Fix CORS Issue untuk Google Sheets Sync

## 🔴 MASALAH SAAT INI
- Data tidak masuk ke Google Sheets karena CORS error
- Browser memblokir fetch ke Apps Script karena tidak ada `Access-Control-Allow-Origin` header

## ✅ SOLUSI STEP-BY-STEP

### STEP 1: Redeploy Apps Script dengan CORS Headers ⚠️ **CRITICAL**

Ini adalah **LANGKAH PALING PENTING**. Tanpa redeploy, data tidak akan masuk ke Sheets.

1. **Buka Google Apps Script:**
   - Go to: https://script.google.com/
   - Cari proyek "PERMINTAAN-TOKO" atau sejenisnya
   - Buka file `Code.gs`

2. **Periksa apakah sudah ada fungsi `buildJsonResponse`:**
   - Cari di Code.gs: `function buildJsonResponse(obj)`
   - Jika **BELUM ADA**, salin kode ini ke **awal file** (sebelum `doGet`):

```javascript
function buildJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON)
    .setHeader('Access-Control-Allow-Origin', '*')
    .setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    .setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}
```

3. **Update `doGet` dan `doPost`:**
   - Ganti semua `ContentService.createTextOutput(JSON.stringify(...))` dengan `buildJsonResponse(...)`
   - Atau copy-paste Code.gs dari proyek ini ke Google Apps Script Anda

4. **Redeploy:**
   - Klik: **Deploy** → **New deployment** → **Web app**
   - Set: Execute as: Me, Who has access: Anyone
   - Klik **Deploy**
   - Salin URL deployment yang baru dan update di `sheets-config.json`

5. **Copy URL deployment baru:**
   - Dari dialog "Deployment", lihat URL `https://script.google.com/macros/s/...`
   - Update di `sheets-config.json`:
```json
{
  "SHEETS_ENDPOINT": "https://script.google.com/macros/s/[URL_BARU]/exec"
}
```

---

### STEP 2: Verifikasi Data Masuk ke Sheets

Setelah redeploy, lakukan ini:

1. Buka aplikasi di browser: http://127.0.0.1:8000/
2. Lakukan **Ctrl+Shift+R** (hard refresh)
3. **Login** dengan kredensial test
4. **Coba buat permintaan baru** atau input data
5. **Buka Google Sheets** dan lihat apakah data muncul di sheet `requests`, `users`, dll

Jika MASIH tidak muncul, cek:
- F12 Console → ada error CORS?
- Console → "CLOUD (Sheets) TERHUBUNG" tapi tetap error?
- Check di Google Sheets apakah sheet-nya ada (users, requests, chat, dll)

---

### STEP 3: Upload Semua File ke GitHub

#### 3a. Setup Git (Jika belum punya repo)

```powershell
# Buka PowerShell di folder proyek
cd "d:\Users\baut.adhi.wismantoro\.gemini\antigravity\scratch\aplikasi-permintaan-toko"

# Initialize git repo
git init

# Add semua file
git add .

# Commit pertama
git commit -m "Initial commit: Google Sheets migration"
```

#### 3b. Push ke GitHub

```powershell
# Set remote URL (ganti dengan URL repo Anda)
git remote add origin https://github.com/[USERNAME]/[REPO_NAME].git

# Push ke main branch
git branch -M main
git push -u origin main
```

#### 3c. File-file yang diupload:

✅ **UPLOAD SEMUA INI:**
- `index.html` - UI utama
- `app.js` - Logika aplikasi
- `styles.css` - Styling
- `supabase-db.js` - Google Sheets adapter
- `Code.gs` - Apps Script backend *(SIMPAN TERPISAH ATAU DI FOLDER `appscript/`)*
- `sheets-config.json` - Konfigurasi endpoint
- `.gitignore` - File yang tidak perlu di-push

❌ **JANGAN UPLOAD:**
- Node_modules (jika ada)
- `.env` atau file secret
- Deployment links yang sudah expired

#### 3d. Buat `.gitignore`

File `.gitignore`:
```
node_modules/
.env
.DS_Store
*.log
```

---

### STEP 4: Verifikasi CORS Fix Bekerja

Setelah redeploy, cek di console browser:

✅ **Jika berhasil:**
```
✅ CLOUD (Sheets) TERHUBUNG
```

❌ **Jika masih error:**
```
Access to fetch has been blocked by CORS policy...
```
→ Berarti Apps Script belum di-redeploy dengan benar. Ulangi STEP 1.

---

## 📋 CHECKLIST

- [ ] Redeploy Apps Script dengan CORS headers
- [ ] Update `sheets-config.json` dengan URL baru
- [ ] Hard refresh browser (Ctrl+Shift+R)
- [ ] Test login & input data
- [ ] Verifikasi data muncul di Google Sheets
- [ ] Initialize git repo
- [ ] Push ke GitHub
- [ ] Verifikasi semua file ada di GitHub

---

## 🆘 Jika Masih Ada Error

**Error CORS masih ada?**
- Berarti Apps Script belum di-redeploy. Ulangi STEP 1, khususnya Step 4 (Redeploy).

**Error "loadTokenOrDropdown is not defined"?**
- Ini mungkin warning minor, abaikan jika tidak memblokir fungsionalitas.

**Data masuk ke Sheets tapi kosong?**
- Cek struktur sheet: harus ada kolom `source_key | record_id | data_json | updated_at`
- Atau hubungi untuk debugging lebih lanjut.

---

## 📝 Struktur Google Sheets yang Benar

Setiap sheet harus punya header:
```
source_key | record_id | data_json | updated_at
---
STORE_USERS_DB_V7_CLEAN | USR-ADMIN | {"id":"USR-ADMIN",...} | 2026-08-02T10:30:00Z
```

Sheets yang harus ada:
- `users`
- `requests`
- `chat`
- `chat_rooms`
- `ttd`
- `stores`
- `notifications`
- `sessions`
- `theme`
- `admin_script_url`
- Dll (lihat Code.gs untuk daftar lengkap)

---

Kalau sudah selesai semua step ini, coba login dan test fitur. Kirimkan hasilnya! 🚀
