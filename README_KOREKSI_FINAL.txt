PERMINTAAN TOKO — GOOGLE SHEETS PROXY V2
============================================

PERBAIKAN V2
------------
1. Memperbaiki crash:
   SyntaxError: Unexpected token 'd', "data_json" is not valid JSON
   Session corrupt sekarang tidak menghentikan aplikasi.
2. Apps Script sekarang memperbaiki/membersihkan row database yang data_json-nya tidak valid.
   Row sisa header seperti "data_json" tidak lagi dimuat sebagai session/user/request.
3. Migrasi legacy sheet lebih aman: kolom data_json lama dipertahankan sebagai payload JSON jika valid.
4. WRITE + VERIFIKASI sekarang benar-benar membandingkan data yang dikirim dengan data yang kembali dari Google Sheets.
   Jadi log "WRITE + VERIFIKASI GOOGLE SHEETS BERHASIL" tidak lagi muncul hanya karena GET berhasil.
5. Edit/tambah menggunakan replace/upsert idempotent berdasarkan record_id.
6. Hapus key menghapus semua row untuk storage key tersebut; penghapusan item individual dilakukan dengan replace array setelah item dikeluarkan.
7. LockService tetap digunakan untuk mencegah write bersamaan membuat duplikat.
8. Endpoint tetap deployment yang diberikan:
   https://script.google.com/macros/s/AKfycbwGhyK4a4CRlgskSyEsNrafRzfM8aj_K2df5uvT0k-5wWXoz_lK3Daah9ZIt_rtXj8umA/exec

WAJIB
-----
A. Ganti Code.gs pada project Google Apps Script dengan Code.gs dari ZIP ini.
B. Deploy versi baru pada Web App yang sama.
   Execute as: Me
   Who has access: Anyone
C. Jangan mengubah POST frontend menjadi application/json.
D. Upload seluruh file frontend ke GitHub Pages.
E. Lakukan Ctrl+F5 / hard refresh.

PENTING UNTUK DATA LAMA
-----------------------
Versi V2 otomatis memperbaiki sheet database yang dikenal saat load.
Jika ada data lama yang rusak (misalnya row hanya berisi "data_json"), row rusak tersebut akan dibuang.
Data valid tetap dipertahankan.

STRUKTUR
--------
GitHub Pages
  -> JSONP GET / text/plain POST
  -> Google Apps Script Web App
  -> Google Sheets

Google Sheets adalah database utama.
Browser hanya memory cache selama halaman aktif.

SHEET DATABASE
--------------
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

FORMAT
------
source_key | record_id | data_json | updated_at

SETELAH DEPLOY
--------------
1. Buka GitHub Pages.
2. Ctrl+F5.
3. Login.
4. Buka Console.
5. Saat tambah/edit/hapus, log yang benar harus:
   Mengirim batch ke Google Sheets: N
   WRITE + VERIFIKASI GOOGLE SHEETS BERHASIL

Jika muncul:
   WRITE TIDAK TERVERIFIKASI: ...
maka data benar-benar belum dianggap tersimpan dan frontend akan retry.

Jika endpoint Apps Script masih menjalankan Code.gs lama, V2 tidak dapat memperbaiki server sampai deployment dibuat ke versi Code.gs baru.
