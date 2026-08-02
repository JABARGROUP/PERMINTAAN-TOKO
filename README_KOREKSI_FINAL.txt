PERMINTAAN TOKO - GOOGLE SHEETS PROXY FINAL
============================================
Tanggal: 02/08/2026

ARSITEKTUR
----------
GitHub Pages -> Google Apps Script Web App (Proxy) -> Google Sheets

Google Sheets menjadi database utama. Browser hanya menyimpan data aplikasi di memory selama halaman aktif;
tidak menggunakan localStorage/sessionStorage sebagai database.

PERBAIKAN UTAMA
---------------
1. CORS:
   - GET menggunakan JSONP.
   - POST menggunakan text/plain + no-cors sehingga tidak memicu OPTIONS preflight.
   - Setelah POST, frontend membaca ulang data melalui JSONP untuk verifikasi.
2. Tidak ada lagi addHeader() pada ContentService Apps Script.
3. Tidak ada lagi duplicate let/const/function di supabase-db.js.
4. Firebase/Firestore legacy di app.js dibersihkan dari mesin database utama.
5. Urutan startup diperbaiki: config -> load Sheet -> seed key yang benar-benar belum ada.
6. Semua perubahan data memakai replace/upsert yang idempotent.
7. Apps Script menggunakan LockService untuk mencegah dua write bersamaan merusak data.
8. record_id dibuat stabil dari id/noSurat/username/messageId/dll atau hash data.
9. Duplicate record dalam sheet dibersihkan satu kali saat load pertama versi ini.
10. Delete/edit/add bekerja melalui Google Sheets.
11. Nomor surat tidak lagi memakai requests.length + 1; generator mencari nomor terakhir agar tidak bentrok setelah data dihapus.
12. Polling tidak menarik data dari server saat ada write yang masih antre.

STRUKTUR SHEET
--------------
Setiap sheet database memakai 4 kolom:
source_key | record_id | data_json | updated_at

Sheet aplikasi yang dipakai:
users
requests
chat
chat_rooms
ttd
stores
deleted_stores
notifications
kode_unit_map
feature_photos
deleted_requests
deleted_users
fonte_token
admin_reminder
admin_secret
sessions
theme
admin_script_url

WAJIB SETELAH UPLOAD Code.gs
------------------------------
1. Buka project Google Apps Script yang menjadi proxy.
2. Ganti seluruh isi Code.gs dengan Code.gs dari paket ini.
3. Deploy -> Manage deployments.
4. Edit deployment Web app / buat deployment baru.
5. Execute as: Me.
6. Who has access: Anyone.
7. URL deployment yang dipakai paket ini sudah diset ke deployment /exec yang diberikan pengguna.
8. Jika nanti deployment dibuat ulang dan URL berubah, ganti SHEETS_ENDPOINT di sheets-config.json.
9. Reload GitHub Pages dengan hard refresh (Ctrl+F5).

SPREADSHEET
-----------
Code.gs sudah memiliki DEFAULT_SPREADSHEET_ID yang sama dengan sheets-config.json.
Tetap disarankan mengatur Script Property:
SPREADSHEET_ID = ID spreadsheet tujuan.

PEMBERSIHAN DUPLIKAT
--------------------
Versi ini melakukan cleanup duplikat satu kali menggunakan Script Property DEDUP_DONE_V2.
Setelah itu semua write baru dibuat idempotent berdasarkan record_id.
Jika ingin menjalankan cleanup ulang setelah mengganti database:
- hapus Script Property DEDUP_DONE_V2 dari project Apps Script,
- lalu reload aplikasi.

CATATAN
-------
POST memakai no-cors sehingga browser memang tidak membaca response POST secara langsung.
Itu disengaja. Keberhasilan write diverifikasi dengan GET/JSONP sesudah POST.
Jangan mengganti POST menjadi application/json karena akan menghidupkan CORS preflight lagi.

ENDPOINT DEPLOYMENT SAAT INI
---------------------------
https://script.google.com/macros/s/AKfycbwGhyK4a4CRlgskSyEsNrafRzfM8aj_K2df5uvT0k-5wWXoz_lK3Daah9ZIt_rtXj8umA/exec
