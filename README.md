# Futbin Club Player Sync

Chrome Manifest V3 eklentisi. Backend `GET /api/sync/futbin-player-jobs` yanıtından lig/kulüp kuyruğuyla birlikte nation, quality, rarity ve position lookup verilerini alır. Futbin `.player-row` verilerini tarayıcıda DB ID'lerine map eder ve her kulübün player tablosuna hazır verisini `POST /api/sync/futbin-player-clubs/{clubId}` üzerinden kaydeder.

## Kurulum

1. Chrome'da `chrome://extensions` adresini açın.
2. **Geliştirici modu** seçeneğini etkinleştirin.
3. **Paketlenmemiş öğe yükle** ile bu proje klasörünü seçin.
4. Araç çubuğundan eklenti simgesine tıklayın. Chrome'un varsayılan action popup'ı açılır; taramayı buradan başlatın.

Popup'tan Local (`http://localhost:5055/api/`) veya Production (`https://api.sbcmonster.com/api/`) ortamı seçilir. Tarama pasif bir çalışma sekmesinde yapılır; ilerleme `chrome.storage.local` içinde tutulduğu için popup kapatılsa veya service worker uyusa da devam eder.

## Mimari

- `src/content.js`: Futbin filtrelerini doğrular, pagination ve oyuncu satırlarını ayrıştırır, 5 saniyelik sayfa geçiş zamanlayıcısını çalıştırır.
- `src/background.js`: Backend kuyruğunu, kulüp/sayfa durumunu, çalışma sekmesini ve API kayıtlarını yönetir.
- `src/popup.*`: Kontrol ve canlı monitör ekranıdır.

Görüntüleme kayıtları son 500 oyuncuyla sınırlandırılır. Backend endpoint'leri mevcut tasarım gereği kimlik doğrulamasızdır.
