# FutbinSync Proje Dokümantasyonu

Bu doküman FutbinSync projesindeki bütün proje dosyaları incelenerek hazırlanmıştır. `.git` içeriği proje kaynak dosyası olmadığı için kapsam dışında bırakılmıştır.

Son inceleme: 2026-06-22

## Kısa özet

FutbinSync, Chrome Manifest V3 tabanlı bir extension’dır. Futbin sayfalarını arka planda açar, oyuncu/kart verilerini content script ile okur, background service worker’da normalize eder ve backend API’ye gönderir. Popup ekranı da çalışma durumunu, okunan kayıtları, request loglarını ve hataları canlı gösterir.

Mevcut yapıda iki bağımsız sync runner vardır:

- `coin-cards`: Futbin Latest Coin Cards akışını ve coin card detaylarını işler.
- `club-players`: Backend’den gelen lig/kulüp kuyruğuna göre Futbin oyuncu sayfalarını işler.

`Web App Sync` popup tab’ı şu anda placeholder’dır; sync içeriği/runner’ı yoktur.

## Dosya envanteri

| Dosya | Görev |
|---|---|
| `manifest.json` | Chrome extension manifest’i. Permission, host permission, background worker, popup ve content script tanımlarını içerir. |
| `README.md` | Kısa kurulum ve mimari açıklaması. |
| `test-stop.js` | İçeriği sadece yorum satırı olan yardımcı/test dosyası. Aktif runtime görevi yok. |
| `src/background.js` | Extension’ın ana orchestration katmanı. Runner state, Chrome tab yönetimi, alarm yönetimi, backend API çağrıları, veriyi normalize edip POST etme ve storage yazımları burada. |
| `src/content.js` | Futbin sayfasında çalışan content script. DOM’dan club player, latest coin card ve coin card detay verilerini okur. |
| `src/popup.html` | Popup UI iskeleti. Environment seçimi, content tab’ları, Start/Stop/Clear ve monitor alanları. |
| `src/popup.css` | Popup layout/stil tanımları. 800x600 sabit popup düzeni, tablo, log ve coin card satır görünümleri. |
| `src/popup.js` | Popup davranışları. Start/Stop/Clear mesajları, storage dinleme, tab filtreleme, canlı durum/kayıt/log render işlemleri. |

## Manifest ve izinler

`manifest.json` extension’ı şu şekilde tanımlar:

- Manifest version: `3`
- Extension adı: `Futbin Player Monitor`
- Version: `0.3.0`
- Permissions:
  - `storage`
  - `tabs`
  - `alarms`
- Host permissions:
  - `https://www.futbin.com/*`
  - `https://futbin.com/*`
  - `http://localhost:5055/*`
  - `https://api.sbcmonster.com/*`
- Background:
  - `src/background.js`
  - `type: module`
- Popup:
  - `src/popup.html`
- Content script:
  - `src/content.js`
  - Futbin domainlerinde `document_start` zamanında yüklenir.

## Ana runtime mimarisi

```text
Popup
  ├─ START_SYNC / STOP_SYNC / CLEAR_SYNC mesajları
  └─ chrome.storage.local değişikliklerini dinler

Background service worker
  ├─ Runner state yönetimi
  ├─ Chrome tab açma/güncelleme
  ├─ Chrome alarms ile timeout ve loop
  ├─ Backend API GET/POST
  └─ Content script sonuçlarını işler

Content script
  ├─ Futbin DOM parse
  ├─ SYNC_PAGE_RESULT / SYNC_PAGE_FAILED / SYNC_PAGE_CRITICAL
  └─ ADVANCE_SYNC zamanlaması
```

## Runner modeli

`src/background.js` içinde runner tanımı:

```js
const RUNNER_IDS = ["coin-cards", "club-players"];
const RUNNER_OPERATIONS = {
  "coin-cards": ["coin-cards"],
  "club-players": ["club-players"]
};
```

Her runner kendi state’ini, tab’ını ve alarmını taşır. Bu sayede `coin-cards` ve `club-players` aynı anda çalışabilir, birbirinin sayfa geçişini veya API request’ini beklemez.

Runner bazlı ayrılan alanlar:

- `runnerId`
- `running`
- `queue`
- `currentJobIndex`
- `currentPage`
- `totalPages`
- `currentUrl`
- `tabId`
- `lookups`
- `currentPlayers`
- `currentLatest`
- `newlyInsertedCoinCardIds`
- `currentSkipped`
- `pagesAttempted`
- `pagesSucceeded`
- `failedPages`
- `savedPlayers`
- `skippedPlayers`
- `clubSaveResults`
- `nextRunAt`
- `status`
- `error`
- `runCount`

Storage’da aggregate root state de üretilir. Popup, seçili tab’a göre `state.runs["coin-cards"]` veya `state.runs["club-players"]` alt state’ini okur.

## Background akışı

### Başlatma

Popup `START_SYNC` gönderir. Background `startParallelSync()` ile operasyonları runner’lara böler.

Akış:

1. Operasyonlar normalize edilir.
2. Operasyona göre runner ID bulunur.
3. Her runner için `startFreshSync()` çağrılır.
4. Runner zaten çalışıyorsa ve loop restart zamanı gelmediyse yeniden başlatılmaz.
5. Runner kendi queue’sunu hazırlar.
6. Runner kendi Chrome tab’ını açar.
7. İlk Futbin URL’sine navigate eder.

Önemli davranış: Bir runner hata alırsa diğer runner mümkünse çalışmaya devam eder.

### Coin Cards queue

`coin-cards` runner önce `Latest Coin Cards` job’ı oluşturur:

- URL: `https://www.futbin.com/latest`
- Operation: `coin-card-latest`

Latest kaydedildikten sonra backend’den coin card detay job’ları alınır:

- `GET futbin-sync/coin-card-jobs`
- Detay job’ları `operation: "coin-cards"` olarak queue’ya eklenir.

### Club Players queue

`club-players` runner backend’den lig/kulüp kuyruğunu alır:

- `GET sync/futbin-player-jobs`

Beklenen response içinde:

- `data.jobs`
- `data.lookups`
  - `nations`
  - `qualities`
  - `rarities`
  - `positions`

Lookup verileri zorunludur; eksikse sync hata alır.

### Sayfa yükleme

Background Futbin tab’ı tamamlanınca:

1. `chrome.tabs.onUpdated` tetiklenir.
2. Tab ID’ye göre ilgili runner bulunur.
3. URL beklenen Futbin sayfası mı kontrol edilir.
4. Content script’e `COLLECT_SYNC_PAGE` mesajı gönderilir.

Her runner’ın timeout alarmı ayrıdır:

- `futbin-sync-page-timeout:coin-cards`
- `futbin-sync-page-timeout:club-players`

### Page result işleme

Content script sonucu background’a döner:

- `SYNC_PAGE_RESULT`
- `SYNC_PAGE_FAILED`
- `SYNC_PAGE_CRITICAL`

Background sonucu tab ID üzerinden ilgili runner’a bağlar. Eski veya yanlış tab’dan gelen sonuçlar yok sayılır.

### Sonraki sayfa / sonraki job

`finishOrScheduleNextPage()`:

- Aynı job’da sonraki sayfa varsa `nextRunAt = Date.now() + waitMs`
- Yoksa ilgili job API’ye kaydedilir ve sıradaki job’a geçilir.

Content script, background’dan dönen `WAIT_AND_ADVANCE` cevabına göre `ADVANCE_SYNC` mesajını gecikmeli gönderir.

### Loop davranışı

Runner queue’su bitince `scheduleNextLoop()` çağrılır.

Mevcut sabitler:

```js
const COIN_CARDS_SYNC_LOOP_MINUTES = 5;
const CLUB_PLAYERS_SYNC_LOOP_MINUTES = 120;
```

Not: Daha önce konuşulan 60 dakika beklentisi varsa, coin cards için bu sabit şu an kodda `5` görünüyor. Süreyi değiştirmek için `src/background.js` içindeki `COIN_CARDS_SYNC_LOOP_MINUTES` değeri güncellenmelidir.

Runner bazlı loop alarmları:

- `futbin-sync-loop:coin-cards`
- `futbin-sync-loop:club-players`

## Content script akışı

`src/content.js`, Futbin sayfasında çalışır ve background’dan `COLLECT_SYNC_PAGE` mesajı bekler.

### Koruma

`collectionInProgress` ile aynı sayfada duplicate collection engellenir.

### Genel dispatch

`collectAndPublish()` operasyon tipine göre dallanır:

- `coin-card-latest` → `collectLatestCoinCardsAndPublish()`
- `coin-cards` → `collectCoinCardAndPublish()`
- diğerleri → club player row parse

### Club player parse

`parsePlayerRow()` şu alanları üretir:

- `futbinPlayerId`
- `futbinPlayerLink`
- `name`
- `fullName`
- `rating`
- `priceConsole`
- `pricePc`
- `nationName`
- `leagueName`
- `clubName`
- `nationImageUrl`
- `leagueImageUrl`
- `clubImageUrl`
- `positionName`
- `alternativePositions`
- `cardImageUrl`
- `playerImageUrl`

Kritik DOM eksiklerinde `[CRITICAL]` hata üretilir.

### Latest coin card parse

`parseLatestCoinCardRow()` şu alanları üretir:

- `playerName`
- `url`
- `playerImgUrl`
- `bgCardUrl`
- `nationImgUrl`
- `rating`
- `position`
- `minPriceCross`
- `priceCross`
- `maxPriceCross`
- `minPricePc`
- `pricePc`
- `maxPricePc`

Coin card fiyat alanları eksikse kayıt “atlandı” mesajıyla hata listesine girer. Popup bu tür “atlandı/atlandi” mesajlarını error panelinde göstermemek üzere filtreler.

### Coin card detay parse

`parseCoinCardDetail()` detay sayfasından şunları okur:

- oyuncu adı
- rating
- position
- player image URL
- card background URL
- nation image URL
- console price/range
- PC price/range

## Popup davranışı

Popup üç content tab gösterir:

- `Web App Sync`
  - Şimdilik içerik yoktur.
  - `data-operations=""`
  - Liste alanında placeholder gösterir.
- `Futbin Latest Coin Cards`
  - `data-operations="coin-cards"`
  - Coin card runner state’ini gösterir.
- `Futbin All Players`
  - `data-operations="club-players"`
  - Club player runner state’ini gösterir.

Start butonu `allSyncOperations()` ile tanımlı bütün operasyonları gönderir. Yani Web App Sync seçili olsa bile tanımlı sync operasyonları:

- `coin-cards`
- `club-players`

aynı anda başlatılır.

Stop butonu bütün runner’ları durdurur.

Clear butonu:

- runner state’lerini sıfırlar
- açık çalışma tab’larını kapatır
- records/logs/errors storage alanlarını temizler

Resume butonu kaldırılmıştır.

## Popup render filtreleri

Popup seçili tab’a göre kayıt/log/stat filtreler:

- Coin Cards tab:
  - `job.operation` değeri `coin-card` ile başlayan kayıtlar
  - `leagueName === "Coin Cards"` olan log/error kayıtları
- All Players tab:
  - coin card olmayan kayıtlar
- Web App Sync tab:
  - sync içeriği yok, records/log/errors göstermez

Skipped error filtrelemesi:

```js
message.includes("atlandı") || message.includes("atlandi")
```

Bu mesajlar `syncErrors` içinde saklanabilir ama popup error panelinde gösterilmez.

## Backend API kontratı

Kullanılan endpoint’ler:

| Method | Endpoint | Kullanım |
|---|---|---|
| GET | `sync/futbin-player-jobs` | Club player kuyruğu ve lookup verilerini alır. |
| POST | `sync/futbin-player-clubs/{clubId}` | Bir kulübün normalize edilmiş player listesini kaydeder. |
| GET | `futbin-sync/coin-card-jobs` | Coin card detay job’larını alır. |
| POST | `futbin-sync/coin-card-latest` | Latest coin cards listesini kaydeder. |
| POST | `futbin-sync/coin-card-jobs/{job.id}` | Tek coin card detayını kaydeder. |

API base URL popup’tan seçilir:

- Local: `http://localhost:5055/api/`
- Prod: `https://api.sbcmonster.com/api/`

## Chrome storage alanları

| Key | Açıklama |
|---|---|
| `syncState` | Aggregate state ve runner state’leri. |
| `playerRecords` | Popup’ta gösterilecek son kayıtlar. Maksimum 500. |
| `syncLogs` | Request URL logları. Maksimum 300. |
| `syncErrors` | Error kayıtları. Maksimum 300. |
| `syncApiBaseUrl` | Popup environment seçimi. |
| `syncWaitMs` | Sayfalar/job’lar arası bekleme. |
| `syncContentTab` | Popup’ta son seçili content tab. |
| `syncListTab` | Popup’ta son seçili liste tipi. |
| `syncOperations` | Eski/uyumluluk ayarı; popup hâlâ kaydediyor. |

## State yazma güvenliği

Paralel runner yapısı nedeniyle aynı anda birden fazla async işlem storage’a yazabilir. Bunu azaltmak için background’da iki queue vardır:

- `stateWriteQueue`: `syncState` yazımlarını sıralar.
- `storageWriteQueue`: `playerRecords`, `syncLogs`, `syncErrors` gibi listeleri sıralar.

Bu yapı runner’ların request akışını bekletmez; sadece storage write anında veri ezilmesini önlemeye çalışır.

## URL doğrulama

Background, content script sonucunu kabul etmeden önce:

- runner `running` mi?
- sender tab ID runner tab ID ile aynı mı?
- mesajdaki page doğru mu?
- URL beklenen Futbin URL’si mi?

kontrol eder.

Club player URL doğrulamasında:

- `page`
- `club`
- `league`

parametreleri kontrol edilir.

Coin card latest için:

- hostname Futbin mi?
- path `/latest` mi?
- page doğru mu?

Coin card detay için:

- URL birebir beklenen URL ile aynı mı?

kontrol edilir.

## Veri mapping kuralları

### Club players

Futbin DOM verisi background’da backend lookup ID’lerine map edilir:

- nation name → `nationId`
- position name → `positionId`
- card image filename → rarity/quality bilgisi
- base rarity için quality: `bronze`, `silver`, `gold`
- özel kartlar için quality: `special`

`New Caledonia` oyuncuları özel olarak yok sayılır.

Validation zorunlu alanları:

- player name
- Futbin player ID
- quality ID
- rarity ID
- rating
- position ID
- nation ID
- console/PC price
- card/nation/league/club image URL

### Coin cards

Coin card için console ve PC fiyatlarının tamamı zorunludur:

- Cross Price
- Cross Range Min
- Cross Range Max
- PC Price
- PC Range Min
- PC Range Max

Eksik fiyatlı kartlar skip/error olarak kaydedilir.

## UI notları

Popup sabit ölçülüdür:

- genişlik: 800px
- yükseklik: 600px

Sol bölüm kayıt listesi, sağ bölüm kontrol ve monitor panelidir.

Coin card kayıtları:

- “Yeni Kartlar”
- “Güncellenen Kartlar”

olarak iki collapsible section’da gösterilir.

Club player kayıtları lig/kulüp bazında gruplanır.

## Mesaj tipleri

Popup → Background:

- `START_SYNC`
- `STOP_SYNC`
- `CLEAR_SYNC`
- `GET_SNAPSHOT`

Background → Content:

- `COLLECT_SYNC_PAGE`

Content → Background:

- `SYNC_PAGE_RESULT`
- `SYNC_PAGE_FAILED`
- `SYNC_PAGE_CRITICAL`
- `ADVANCE_SYNC`

## Bilinen teknik notlar

1. `RESUME_SYNC` background’da hâlâ handler olarak duruyor; popup’tan kaldırılmış durumda.
2. `Web App Sync` UI tab’ı mevcut ama henüz operasyonu yok.
3. `test-stop.js` aktif runtime parçası değil.
4. Current code’da coin cards loop süresi `5` dakika görünüyor. İstenen üretim davranışı 60 dakika ise sabit güncellenmeli.
5. Backend endpoint’lerinde manifest/README düzeyinde auth bilgisi yok; README “kimlik doğrulamasız” olduğunu söylüyor.
6. Futbin DOM selector’ları sayfa markup değişirse kırılabilir; özellikle player row, card bg image ve price range selector’ları kritik.
7. Content script `document_start` yükleniyor ama veri toplamadan önce row bekleme mekanizması kullanıyor.

## Geliştirme / bakım önerileri

- Coin card loop süresini production davranışına göre netleştir:
  - `COIN_CARDS_SYNC_LOOP_MINUTES`
- `RESUME_SYNC` kullanılmayacaksa background handler’ı ve `resumePausedSync()` temizlenebilir.
- `Web App Sync` gerçek bir akış olacaksa yeni runner eklenmeli:
  - `RUNNER_IDS`
  - `RUNNER_OPERATIONS`
  - popup tab `data-operations`
  - backend endpoint kontratı
- Backend response shape’leri için küçük schema validator eklenebilir.
- Futbin DOM parse fonksiyonları için fixture tabanlı unit test iyi olur.
- Storage schema migration notu eklenebilir; eski tek-state yapıdan yeni `runs` yapısına geçiş `normalizeRootState()` ile yumuşatılıyor.

## Hızlı kurulum

1. Chrome’da `chrome://extensions` aç.
2. Developer Mode’u aktif et.
3. “Load unpacked” ile `FutbinSync` klasörünü seç.
4. Popup’tan Local veya Prod seç.
5. Start’a bas.

Start sonrası mevcut runnable sync’ler aynı anda başlar:

- Coin Cards
- Club Players

## Hızlı dosya haritası

```text
FutbinSync/
├── README.md
├── FUTBINSYNC_PROJECT.md
├── manifest.json
├── test-stop.js
└── src/
    ├── background.js
    ├── content.js
    ├── popup.css
    ├── popup.html
    └── popup.js
```

