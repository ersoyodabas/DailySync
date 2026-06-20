# Futbin Player Monitor

Chrome Manifest V3 eklentisi. Popup'ta girilen Futbin URL'lerini sırayla açar; sayfadaki `.player-row` satırlarını ayrıntılı oyuncu JSON'una dönüştürür. Ayrıca JSON ağ yanıtları ve gömülü JSON scriptleri de izlenir. Bulunan veriler hem sayfanın DevTools konsoluna hem eklenti service worker konsoluna JSON olarak yazılır ve popup'ta gösterilir.

## Kurulum

1. Chrome'da `chrome://extensions` adresini açın.
2. **Geliştirici modu** seçeneğini etkinleştirin.
3. **Paketlenmemiş öğe yükle** ile bu proje klasörünü seçin.
4. Araç çubuğundan eklenti simgesine tıklayın. Chrome'un varsayılan action popup'ı açılır; taramayı buradan başlatın.

Varsayılan kuyruk, `club=1&league=2216,13` filtresiyle sayfa 1–5 adreslerini içerir. Tarama, popup'ın yönlendirme sırasında kapanmaması için pasif bir çalışma sekmesini sırayla bu adreslere yönlendirir. Popup kullanıcı tarafından kapatılsa bile işlem arka planda aktif kalır ve popup yeniden açıldığında aynı durum gösterilir.

## Mimari

- `src/page-bridge.js`: Sayfanın ana JavaScript ortamında `fetch` ve XHR JSON yanıtlarını gözlemler.
- `src/content.js`: Ham JSON içinden oyuncuya benzeyen nesneleri bulur, DOM/script yedeğini çalıştırır ve sonuçları iletir.
- `src/background.js`: URL kuyruğunu, çalışma sekmesini, kayıtları ve zamanlamayı yönetir.
- `src/popup.*`: Kontrol ve canlı monitör ekranıdır.

Kayıtlar `chrome.storage.local` içinde tutulur ve son 500 benzersiz kayıtla sınırlandırılır. URL erişimi güvenlik için `https://*.futbin.com/*` ile kısıtlıdır.
