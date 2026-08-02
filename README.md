# Aplikasi Permintaan Toko

Aplikasi web untuk manajemen permintaan barang toko dengan penyimpanan data menggunakan **Google Sheets** dan **Apps Script**.

## 🎯 Fitur Utama

- ✅ Manajemen permintaan barang toko (create, read, update, delete)
- ✅ Manajemen user & akses berbasis role (ADMIN, DM, SERVICE, TOKO)
- ✅ Chat real-time antar user dalam aplikasi
- ✅ Upload foto pendukung ke Google Drive
- ✅ Export data ke Excel
- ✅ Generate PDF permintaan
- ✅ Notifikasi sistem
- ✅ Tanda tangan digital (TTD)
- ✅ Penyimpanan lokal hanya untuk login/password
- ✅ Data utama tersimpan di Google Sheets (cloud sync)

## 🛠️ Tech Stack

- **Frontend:** HTML5, CSS3, JavaScript (Vanilla)
- **Backend:** Google Apps Script (Cloud)
- **Database:** Google Sheets
- **Storage:** Google Drive (untuk foto)
- **Deployment:** GitHub Pages atau Static Hosting

## 📦 File-file Utama

```
aplikasi-permintaan-toko/
├── index.html              # UI markup
├── app.js                  # Logika aplikasi utama
├── styles.css              # Styling
├── supabase-db.js          # Google Sheets adapter
├── sheets-config.json      # Konfigurasi endpoint
├── Code.gs                 # Google Apps Script (backend)
├── .gitignore
├── README.md               # File ini
└── SETUP_GITHUB_AND_FIX_CORS.md  # Panduan setup
```

## 🚀 Quick Start

### Prerequisites
- Browser modern (Chrome, Firefox, Edge, Safari)
- Koneksi internet
- Google Account (untuk Google Sheets & Drive)
- Apps Script deployment aktif

### Setup Lokal (Development)

1. **Clone repo:**
```bash
git clone https://github.com/[USERNAME]/aplikasi-permintaan-toko.git
cd aplikasi-permintaan-toko
```

2. **Update konfigurasi:**
   - Edit `sheets-config.json` dengan Apps Script endpoint URL Anda

3. **Buka di browser:**
   - Lokal: `file:///[path]/index.html`
   - Atau gunakan simple server: `python -m http.server 8000`
   - Akses: `http://localhost:8000`

### Deploy ke GitHub Pages

1. **Push ke GitHub:**
```bash
git add .
git commit -m "Deploy ke GitHub Pages"
git push origin main
```

2. **Enable GitHub Pages:**
   - Go to Settings → Pages
   - Set source: main branch
   - Custom domain (optional)

3. **Akses aplikasi:**
   - `https://[username].github.io/aplikasi-permintaan-toko/`

## 🔐 Keamanan

⚠️ **PENTING:** File berikut berisi informasi sensitif, JANGAN di-commit:
- `sheets-config.json` (kalau berisi API key)
- Environment variables dengan secret keys

Gunakan `.gitignore` untuk mengabaikan file sensitif.

## 🔄 Sinkronisasi Data (Cloud Sync)

Data otomatis tersinkronisasi dengan Google Sheets:
- Setiap perubahan di aplikasi → dikirim ke Sheets
- Setiap user membuka aplikasi → ambil data terbaru dari Sheets
- Offline support: Perubahan di-queue, dikirim saat online kembali

## 📝 Struktur Database (Google Sheets)

Setiap sheet mewakili satu koleksi data:

| Sheet | Deskripsi |
|-------|-----------|
| `users` | Data pengguna (login, role, area) |
| `requests` | Permintaan barang toko |
| `chat` | Pesan chat antar user |
| `chat_rooms` | Ruang chat (grup) |
| `ttd` | Tanda tangan digital |
| `stores` | Data toko |
| `notifications` | Notifikasi sistem |
| `sessions` | Session login aktif |
| `theme` | Preferensi tema user |
| `admin_script_url` | URL Apps Script (tersimpan di Sheets) |

**Struktur baris sheet:**
```
source_key | record_id | data_json | updated_at
```

## 👥 User Roles

| Role | Deskripsi | Akses |
|------|-----------|--------|
| **ADMIN** | Administrator pusat | Semua fitur, manajemen user |
| **DM** | Distribution Manager | Lihat & setujui permintaan all area |
| **SERVICE** | Service supervisor | Diperiksa permintaan di area mereka |
| **TOKO** | Toko / Sales | Buat permintaan barang |

## 🐛 Troubleshooting

### CORS Error pada Apps Script
**Solusi:** Redeploy Apps Script dengan CORS headers. Lihat `SETUP_GITHUB_AND_FIX_CORS.md`

### Data tidak masuk ke Sheets
1. Cek Apps Script sudah di-redeploy? 
2. Cek sheets-config.json sudah update URL?
3. Cek Console browser (F12) ada error apa?

### Login tidak bisa
- Bersihkan localStorage browser
- Coba dengan Ctrl+Shift+Delete (Clear cache)
- Pastikan `sheets-config.json` endpoint valid

## 📄 Lisensi

Privat - Untuk penggunaan internal perusahaan

## 📧 Support

Untuk pertanyaan atau bug report, hubungi tim development.

---

**Last Updated:** 2 Agustus 2026  
**Version:** 1.0.0 (Google Sheets Migration)
