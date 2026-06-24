# Futbin Club Player Sync

Chrome Manifest V3 eklentisi. Backend `GET /api/sync/futbin-player-jobs` yanıtından lig/kulüp kuyruğuyla birlikte nation, quality, rarity ve position lookup verilerini alır. Futbin `.player-row` verilerini tarayıcıda DB ID'lerine map eder ve her kulübün player tablosuna hazır verisini `POST /api/sync/futbin-player-clubs/{clubId}` üzerinden kaydeder. Web App Sync akışı EA FC Web App üzerinde oturum, dil değiştirme ve DOM okuma iskeletini içerir; backend endpoint'i `src/background.js` içindeki `WEB_APP_SYNC_ENDPOINT` sabitinden ayarlanır.

## Kurulum

1. Chrome'da `chrome://extensions` adresini açın.
2. **Geliştirici modu** seçeneğini etkinleştirin.
3. **Paketlenmemiş öğe yükle** ile bu proje klasörünü seçin.
4. Araç çubuğundan eklenti simgesine tıklayın. Chrome'un varsayılan action popup'ı açılır; taramayı buradan başlatın.

Popup'tan Local (`http://localhost:5055/api/`) veya Production (`https://api.sbcmonster.com/api/`) ortamı seçilir. Futbin taramaları pasif çalışma sekmesinde yapılır; Web App Sync ise EA Web App sekmesini aktif açar, işi bitince sekmeyi kapatır ve `.env` içindeki `WEB_APP_SYNC_TIME=20:00` gibi `HH:mm` formatındaki saate göre her gün tek tam tur çalışacak şekilde yeniden planlanır. İlerleme `chrome.storage.local` içinde tutulduğu için popup kapatılsa veya service worker uyusa da devam eder.

## Mimari

- `src/content.js`: Futbin filtrelerini doğrular, pagination ve oyuncu satırlarını ayrıştırır, 5 saniyelik sayfa geçiş zamanlayıcısını çalıştırır.
- `src/actions/webAppSync/core.js`: EA FC Web App login, dil ve ana orkestrasyon akışını çalıştırır.
- `src/actions/webAppSync/sync_rarity.js`: EA Web App rarity senkronizasyonunu çalıştırır.
- `src/actions/webAppSync/sync_sbc.js`: Rarity sync sonrasında EA Web App SBC kategori/tile/requirements senkronizasyonunu çalıştırır.
- `src/background.js`: Backend kuyruğunu, kulüp/sayfa durumunu, çalışma sekmesini ve API kayıtlarını yönetir.
- `src/popup.*`: Kontrol ve canlı monitör ekranıdır. Popup action/view kodları `src/actions/webAppSync/app.js`, `src/actions/futbinLatestCoinCards.js` ve `src/actions/futbinAllPlayers.js` dosyalarına ayrılmıştır.

Görüntüleme kayıtları son 500 oyuncuyla sınırlandırılır. Backend endpoint'leri mevcut tasarım gereği kimlik doğrulamasızdır.
