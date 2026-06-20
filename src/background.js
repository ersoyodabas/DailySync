const STATE_KEY = "syncState";
const RECORDS_KEY = "playerRecords";
const LOGS_KEY = "syncLogs";
const ERRORS_KEY = "syncErrors";
const PAGE_TIMEOUT_ALARM = "futbin-sync-page-timeout";
const PAGE_TIMEOUT_MS = 60000;
const MAX_RECORDS = 500;
const MAX_LOGS = 300;
const MAX_ERRORS = 300;
const SPECIAL_QUALITY_IMAGE_URL = "https://cdn3.futbin.com/content/fifa26/img/cards/tiny/3_gold.png?fm=png&ixlib=java-2.1.0&verzion=1&w=128&s=d72e95665680dee8e3818602d714323a";

const emptyState = {
  running: false,
  queue: [],
  currentJobIndex: -1,
  currentPage: 0,
  totalPages: 0,
  currentUrl: null,
  tabId: null,
  apiBaseUrl: "http://localhost:5055/api/",
  waitMs: 5000,
  lookups: null,
  currentPlayers: {},
  currentSkipped: 0,
  pagesAttempted: 0,
  pagesSucceeded: 0,
  failedPages: [],
  completedClubs: 0,
  savedPlayers: 0,
  skippedPlayers: 0,
  clubSaveResults: {},
  nextRunAt: null,
  status: "Hazır",
  error: null,
  updatedAt: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get([STATE_KEY, RECORDS_KEY, LOGS_KEY, ERRORS_KEY]);
  if (!saved[STATE_KEY]) await setState(emptyState);
  if (!saved[RECORDS_KEY]) await chrome.storage.local.set({ [RECORDS_KEY]: [] });
  if (!saved[LOGS_KEY]) await chrome.storage.local.set({ [LOGS_KEY]: [] });
  if (!saved[ERRORS_KEY]) await chrome.storage.local.set({ [ERRORS_KEY]: [] });
});

chrome.runtime.onStartup.addListener(resumeRunningSync);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(async (error) => {
      await failSync(error.message || String(error));
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "START_SYNC":
      return startFreshSync(message.apiBaseUrl, message.waitMs);
    case "RESUME_SYNC":
      return resumePausedSync();
    case "STOP_SYNC":
      return pauseSync();
    case "CLEAR_SYNC":
      await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);
      {
        const current = await getState();
        if (current.tabId) {
          try { await chrome.tabs.remove(current.tabId); } catch { /* Sekme zaten kapanmış olabilir. */ }
        }
      }
      await setState({ ...emptyState, apiBaseUrl: message.apiBaseUrl || emptyState.apiBaseUrl });
      await chrome.storage.local.set({ [RECORDS_KEY]: [], [LOGS_KEY]: [], [ERRORS_KEY]: [] });
      return { ok: true };
    case "GET_SNAPSHOT":
      return { ok: true, ...(await chrome.storage.local.get([STATE_KEY, RECORDS_KEY, LOGS_KEY, ERRORS_KEY])) };
    case "SYNC_PAGE_RESULT":
      return handlePageResult(message, sender);
    case "SYNC_PAGE_FAILED":
      return handleReportedPageFailure(message, sender);
    case "SYNC_PAGE_CRITICAL":
      return handleCriticalPageError(message, sender);
    case "ADVANCE_SYNC":
      return advanceFromContentTimer(message, sender);
    default:
      return { ok: false, error: "Bilinmeyen mesaj" };
  }
}

async function startFreshSync(rawApiBaseUrl, rawWaitMs) {
  const apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl);
  const waitMs = Math.min(30000, Math.max(3000, Number(rawWaitMs) || 5000));
  const response = await apiRequest(apiBaseUrl, "sync/futbin-player-jobs");
  const queue = Array.isArray(response?.data?.jobs) ? response.data.jobs : [];
  const lookups = response?.data?.lookups || null;
  validateLookups(lookups);
  await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);

  const previous = await getState();
  if (previous.tabId) {
    try { await chrome.tabs.remove(previous.tabId); } catch { /* Eski sekme zaten kapanmış olabilir. */ }
  }

  if (queue.length === 0) {
    const state = {
      ...emptyState,
      apiBaseUrl,
      waitMs,
      status: "Senkronizasyon bekleyen kulüp yok",
      updatedAt: Date.now()
    };
    await setState(state);
    return { ok: true, state };
  }

  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const firstJob = queue[0];
  const state = {
    ...emptyState,
    running: true,
    queue,
    lookups,
    currentJobIndex: 0,
    currentPage: 1,
    totalPages: 1,
    currentUrl: buildPageUrl(firstJob, 1),
    tabId: tab.id,
    apiBaseUrl,
    waitMs,
    status: jobStatus(firstJob, 0, queue.length, "Sayfa açılıyor"),
    updatedAt: Date.now()
  };
  await setState(state);
  await navigateToCurrentPage(state);
  return { ok: true, state };
}

async function resumePausedSync() {
  const state = await getState();
  if (state.running) return { ok: true, state };
  if (!state.queue?.length || state.currentJobIndex < 0 || state.currentJobIndex >= state.queue.length) {
    throw new Error("Devam ettirilecek tarama bulunamadı.");
  }

  let tab;
  try { tab = state.tabId ? await chrome.tabs.get(state.tabId) : null; } catch { /* Yeni sekme oluştur. */ }
  if (!tab) tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const resumed = {
    ...state,
    running: true,
    tabId: tab.id,
    error: null,
    nextRunAt: null,
    status: jobStatus(currentJob(state), state.currentJobIndex, state.queue.length, "Tarama sürdürülüyor"),
    updatedAt: Date.now()
  };
  await setState(resumed);
  await navigateToCurrentPage(resumed);
  return { ok: true, state: resumed };
}

async function resumeRunningSync() {
  const state = await getState();
  if (!state.running) return;
  let tab;
  try { tab = state.tabId ? await chrome.tabs.get(state.tabId) : null; } catch { /* Yeni sekme oluştur. */ }
  if (!tab) tab = await chrome.tabs.create({ url: "about:blank", active: false });
  const resumed = { ...state, tabId: tab.id, nextRunAt: null, updatedAt: Date.now() };
  await setState(resumed);
  await navigateToCurrentPage(resumed);
}

async function pauseSync() {
  await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);
  const state = await getState();
  const paused = {
    ...state,
    running: false,
    nextRunAt: null,
    status: "Kullanıcı tarafından durduruldu; devam etmeye hazır",
    updatedAt: Date.now()
  };
  await setState(paused);
  return { ok: true, state: paused };
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const state = await getState();
  if (!state.running || tabId !== state.tabId || !matchesCurrentFutbinPage(tab.url, state)) return;
  await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "COLLECT_SYNC_PAGE",
      job: currentJob(state),
      page: state.currentPage,
      expectedUrl: state.currentUrl,
      waitMs: state.waitMs
    });
  } catch {
    await handlePageFailure(`İçerik script'i çalışmadı: ${state.currentUrl}`);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.running && state.tabId === tabId) await failSync("Çalışma sekmesi kapatıldı");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== PAGE_TIMEOUT_ALARM) return;
  const state = await getState();
  if (!state.running) return;
  await handlePageFailure(`Sayfa zaman aşımına uğradı: ${state.currentUrl}`);
});

async function handlePageResult(message, sender) {
  const state = await getState();
  if (!isCurrentPageSender(state, message, sender)) return { ok: false, error: "Eski sayfa sonucu yok sayıldı." };

  const job = currentJob(state);
  const totalPages = state.currentPage === 1
    ? Math.max(1, Number(message.totalPages) || 1)
    : state.totalPages;
  const players = { ...(state.currentPlayers || {}) };
  let skipped = 0;
  const mappedPlayers = [];
  const pageErrors = normalizePageErrors(message.errors, job, state);
  for (const rawPlayer of message.players || []) {
    try {
      const player = mapPlayer(rawPlayer, state.lookups);
      if (!player) {
        skipped++;
        continue;
      }
      players[String(player.futbinPlayerId)] = player;
      mappedPlayers.push(player);
    } catch (error) {
      skipped++;
      pageErrors.push(buildErrorEntry({
        state,
        job,
        stage: "map",
        message: error.message || String(error),
        player: rawPlayer
      }));
    }
  }
  if (pageErrors.length) await appendErrors(pageErrors);
  await appendRecords(mappedPlayers, state.currentUrl, job);

  const updated = {
    ...state,
    totalPages,
    currentPlayers: players,
    currentSkipped: (state.currentSkipped || 0) + skipped,
    pagesAttempted: state.pagesAttempted + 1,
    pagesSucceeded: state.pagesSucceeded + 1,
    status: jobStatus(job, state.currentJobIndex, state.queue.length, `${state.currentPage}/${totalPages} sayfa okundu`),
    updatedAt: Date.now()
  };
  await setState(updated);
  return finishOrScheduleNextPage(updated);
}

async function handleCriticalPageError(message, sender) {
  const state = await getState();
  if (!isCurrentPageSender(state, message, sender)) return { ok: false };
  await failSync(message.error || "[CRITICAL] Futbin sayfası doğrulanamadı.");
  return { ok: false, critical: true };
}

async function handleReportedPageFailure(message, sender) {
  const state = await getState();
  if (!isCurrentPageSender(state, message, sender)) return { ok: false, error: "Eski sayfa hatası yok sayıldı." };
  return recordPageFailure(state, message.error || `Sayfa yüklenemedi: ${message.pageUrl}`);
}

async function handlePageFailure(error) {
  const state = await getState();
  if (!state.running) return;
  const action = await recordPageFailure(state, error);
  if (action?.nextUrl) await performAdvance(action.nextUrl);
}

async function recordPageFailure(state, error) {
  const failed = {
    ...state,
    pagesAttempted: state.pagesAttempted + 1,
    failedPages: [...(state.failedPages || []), { page: state.currentPage, url: state.currentUrl, error }],
    status: `${error}; sonraki adıma geçiliyor`,
    updatedAt: Date.now()
  };
  await setState(failed);
  return finishOrScheduleNextPage(failed);
}

async function finishOrScheduleNextPage(state) {
  if (state.currentPage < state.totalPages) {
    const nextPage = state.currentPage + 1;
    const nextUrl = buildPageUrl(currentJob(state), nextPage);
    const waiting = {
      ...state,
      currentPage: nextPage,
      currentUrl: nextUrl,
      nextRunAt: Date.now() + state.waitMs,
      status: jobStatus(currentJob(state), state.currentJobIndex, state.queue.length, `${nextPage}. sayfa bekleniyor`),
      updatedAt: Date.now()
    };
    await setState(waiting);
    return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: state.waitMs };
  }

  return submitCurrentClubAndPrepareNext(state);
}

async function submitCurrentClubAndPrepareNext(state) {
  const job = currentJob(state);
  const players = Object.values(state.currentPlayers || {});
  let saved = 0;
  let skipped = state.currentSkipped || 0;
  let inserted = 0;
  let updated = 0;
  const validationErrors = [];
  const validPlayers = [];

  for (const player of players) {
    const errors = validateMappedPlayer(player);
    if (errors.length) {
      skipped++;
      validationErrors.push(buildErrorEntry({
        state,
        job,
        stage: "before-post",
        message: `${player?.name || "Oyuncu"} post edilmedi: ${errors.join(", ")}`,
        player
      }));
      continue;
    }
    validPlayers.push(player);
  }

  if (validationErrors.length) await appendErrors(validationErrors);

  if (validPlayers.length > 0) {
    const saving = { ...state, nextRunAt: null, status: `${job.league_name} → ${job.club_name}: API'ye kaydediliyor`, updatedAt: Date.now() };
    await setState(saving);
    const response = await apiRequest(state.apiBaseUrl, `sync/futbin-player-clubs/${job.club_id}`, {
      method: "POST",
      body: JSON.stringify({
        league_id: job.league_id,
        pages_attempted: state.pagesAttempted,
        pages_succeeded: state.pagesSucceeded,
        players: validPlayers.map(toApiPlayer)
      })
    });
    saved = Number(response?.data?.saved) || 0;
    skipped += Number(response?.data?.skipped) || 0;
    inserted = Number(response?.data?.inserted) || 0;
    updated = Number(response?.data?.updated) || 0;
    const responseErrors = Array.isArray(response?.data?.errors) ? response.data.errors : [];
    if (responseErrors.length) {
      await appendErrors(responseErrors.map((message) => buildErrorEntry({
        state,
        job,
        stage: "after-post",
        message
      })));
    }
  }

  const clubSaveResults = {
    ...(state.clubSaveResults || {}),
    [String(job.club_id)]: {
      saved,
      skipped,
      inserted,
      updated,
      posted: validPlayers.length,
      savedAt: Date.now()
    }
  };

  const nextJobIndex = state.currentJobIndex + 1;
  if (nextJobIndex >= state.queue.length) {
    const completed = {
      ...state,
      running: false,
      completedClubs: state.completedClubs + 1,
      savedPlayers: state.savedPlayers + saved,
      skippedPlayers: state.skippedPlayers + skipped,
      clubSaveResults,
      nextRunAt: null,
      status: `Tamamlandı (${state.queue.length}/${state.queue.length} kulüp)`,
      updatedAt: Date.now()
    };
    await setState(completed);
    return { ok: true, action: "COMPLETE" };
  }

  const nextJob = state.queue[nextJobIndex];
  const nextUrl = buildPageUrl(nextJob, 1);
  const prepared = {
    ...state,
    currentJobIndex: nextJobIndex,
    currentPage: 1,
    totalPages: 1,
    currentUrl: nextUrl,
    currentPlayers: {},
    currentSkipped: 0,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    failedPages: [],
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + saved,
    skippedPlayers: state.skippedPlayers + skipped,
    clubSaveResults,
    nextRunAt: Date.now() + state.waitMs,
    status: jobStatus(nextJob, nextJobIndex, state.queue.length, "Kulüp sırası bekleniyor"),
    updatedAt: Date.now()
  };
  await setState(prepared);
  return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: state.waitMs };
}

async function advanceFromContentTimer(message, sender) {
  const state = await getState();
  if (!state.running || sender.tab?.id !== state.tabId || message.url !== state.currentUrl) return { ok: false };
  await performAdvance(message.url);
  return { ok: true };
}

async function performAdvance(url) {
  const state = await getState();
  if (!state.running || url !== state.currentUrl) return;
  const opening = { ...state, nextRunAt: null, status: jobStatus(currentJob(state), state.currentJobIndex, state.queue.length, "Sayfa açılıyor"), updatedAt: Date.now() };
  await setState(opening);
  await navigateToCurrentPage(opening);
}

async function navigateToCurrentPage(state) {
  await appendPageLog(state);
  await chrome.alarms.create(PAGE_TIMEOUT_ALARM, { when: Date.now() + PAGE_TIMEOUT_MS });
  try {
    const tab = await chrome.tabs.get(state.tabId);
    if (matchesCurrentFutbinPage(tab.url, state)) {
      await chrome.tabs.reload(state.tabId);
    } else {
      await chrome.tabs.update(state.tabId, { url: state.currentUrl, active: false });
    }
  } catch {
    await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);
    await failSync("Çalışma sekmesine erişilemedi");
  }
}

async function appendPageLog(state) {
  if (!state.currentUrl) return;
  const job = currentJob(state);
  const stored = await chrome.storage.local.get(LOGS_KEY);
  const logs = stored[LOGS_KEY] || [];
  const entry = {
    id: crypto.randomUUID(),
    requestedAt: Date.now(),
    url: state.currentUrl,
    page: state.currentPage,
    clubId: job.club_id,
    clubName: job.club_name || "Kulüp",
    leagueName: job.league_name || "Lig"
  };
  await chrome.storage.local.set({ [LOGS_KEY]: [entry, ...logs].slice(0, MAX_LOGS) });
}

function normalizePageErrors(errors, job, state) {
  if (!Array.isArray(errors)) return [];
  return errors.map((entry) => buildErrorEntry({
    state,
    job,
    stage: entry?.stage || "parse",
    message: entry?.message || String(entry || "Oyuncu verisi okunamadı."),
    player: entry?.player || null
  }));
}

function buildErrorEntry({ state, job, stage, message, player }) {
  const playerLabel = player?.name || player?.futbinPlayerId || player?.futbin_player_id;
  return {
    id: crypto.randomUUID(),
    occurredAt: Date.now(),
    stage,
    message: playerLabel ? `${message} [player=${playerLabel}]` : message,
    url: state?.currentUrl || null,
    page: state?.currentPage || null,
    clubId: job?.club_id,
    clubName: job?.club_name || "Kulüp",
    leagueName: job?.league_name || "Lig"
  };
}

async function appendErrors(entries) {
  const normalized = (Array.isArray(entries) ? entries : [entries]).filter(Boolean);
  if (!normalized.length) return;
  const stored = await chrome.storage.local.get(ERRORS_KEY);
  const errors = stored[ERRORS_KEY] || [];
  await chrome.storage.local.set({ [ERRORS_KEY]: [...normalized, ...errors].slice(0, MAX_ERRORS) });
}

async function failSync(error) {
  await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);
  const state = await getState();
  await setState({
    ...state,
    running: false,
    nextRunAt: null,
    status: error,
    error,
    updatedAt: Date.now()
  });
}

async function apiRequest(apiBaseUrl, endpoint, options = {}) {
  const response = await fetch(new URL(endpoint, apiBaseUrl).href, {
    method: options.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: options.body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.result === false) {
    const error = new Error(payload?.message || `API isteği başarısız (${response.status})`);
    error.critical = payload?.error_code === "CRITICAL";
    throw error;
  }
  return payload;
}

function normalizeApiBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("API adresi HTTP veya HTTPS olmalıdır.");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

function buildPageUrl(job, page) {
  const url = new URL(job.url || "https://www.futbin.com/players");
  url.searchParams.set("page", String(page));
  url.searchParams.set("club", String(job.futbin_club_id));
  url.searchParams.set("league", String(job.futbin_league_id));
  url.searchParams.set("sort", "Player_Rating");
  url.searchParams.set("eUnt", "1");
  url.searchParams.set("order", "asc");
  return url.href;
}

function currentJob(state) {
  return state.queue?.[state.currentJobIndex] || {};
}

function isCurrentPageSender(state, message, sender) {
  return Boolean(
    state.running &&
    sender.tab?.id === state.tabId &&
    Number(message.page) === state.currentPage &&
    matchesCurrentFutbinPage(message.pageUrl, state)
  );
}

function jobStatus(job, index, total, suffix) {
  return `${job?.league_name || "Lig"} → ${job?.club_name || "Kulüp"} (${index + 1}/${total}) · ${suffix}`;
}

function sameUrl(left, right) {
  try {
    const a = new URL(left); const b = new URL(right);
    a.hash = ""; b.hash = "";
    return a.href === b.href;
  } catch { return left === right; }
}

function matchesCurrentFutbinPage(value, state) {
  try {
    const url = new URL(value);
    const job = currentJob(state);
    return /(^|\.)futbin\.com$/i.test(url.hostname) &&
      url.searchParams.get("page") === String(state.currentPage) &&
      url.searchParams.get("club") === String(job.futbin_club_id) &&
      url.searchParams.get("league") === String(job.futbin_league_id);
  } catch { return sameUrl(value, state.currentUrl); }
}

function toApiPlayer(player) {
  return {
    name: player.name,
    full_name: player.fullName,
    quality_id: player.qualityId,
    rarity_id: player.rarityId,
    rating: player.rating,
    fixed_name: player.fixedName,
    futbin_player_id: player.futbinPlayerId,
    futbin_player_link: player.futbinPlayerLink,
    futbin_squat_link: player.futbinSquatLink,
    position_id: player.positionId,
    url: player.url,
    url_img_player: player.urlImgPlayer,
    price_console: player.priceConsole,
    price_pc: player.pricePc,
    url_img_card: player.urlImgCard,
    url_img_nation: player.urlImgNation,
    url_img_league: player.urlImgLeague,
    url_img_club: player.urlImgClub,
    nation_id: player.nationId,
    alternative_positions: player.alternativePositions,
    active: player.active
  };
}

function validateMappedPlayer(player) {
  const errors = [];
  if (!player) return ["player boş"];
  if (!player.name) errors.push("player.name okunamadı");
  if (!Number.isInteger(Number(player.futbinPlayerId)) || Number(player.futbinPlayerId) <= 0) errors.push("player.futbin_player_id okunamadı");
  if (!Number.isInteger(Number(player.qualityId)) || Number(player.qualityId) <= 0) errors.push("player.quality_id okunamadı");
  if (!Number.isInteger(Number(player.rarityId)) || Number(player.rarityId) <= 0) errors.push("player.rarity_id okunamadı");
  if (!Number.isInteger(Number(player.rating)) || Number(player.rating) <= 0) errors.push("player.rating okunamadı");
  if (!Number.isInteger(Number(player.positionId)) || Number(player.positionId) <= 0) errors.push("player.position_id okunamadı");
  if (!Number.isInteger(Number(player.nationId)) || Number(player.nationId) <= 0) errors.push("player.nation_id okunamadı");
  if (!Number.isFinite(Number(player.priceConsole)) || Number(player.priceConsole) < 0) errors.push("player.price_console okunamadı");
  if (!Number.isFinite(Number(player.pricePc)) || Number(player.pricePc) < 0) errors.push("player.price_pc okunamadı");
  if (!player.urlImgCard) errors.push("player.url_img_card okunamadı");
  if (!player.urlImgNation) errors.push("player.url_img_nation okunamadı");
  if (!player.urlImgLeague) errors.push("player.url_img_league okunamadı");
  if (!player.urlImgClub) errors.push("player.url_img_club okunamadı");
  return errors;
}

function validateLookups(lookups) {
  if (!lookups || !Array.isArray(lookups.nations) || !Array.isArray(lookups.qualities) ||
      !Array.isArray(lookups.rarities) || !Array.isArray(lookups.positions)) {
    throw new Error("API oyuncu lookup verilerini döndürmedi.");
  }
}

function mapPlayer(row, lookups) {
  validateLookups(lookups);
  const name = normalizeText(row?.name);
  const nationName = normalizeText(row?.nationName);
  const positionName = normalizeText(row?.positionName);
  if (!name || !nationName || !positionName) {
    throw new Error(`[CRITICAL] Oyuncu map alanları eksik. Futbin ID: ${row?.futbinPlayerId || "—"}`);
  }
  if (nationName.localeCompare("New Caledonia", undefined, { sensitivity: "accent" }) === 0) return null;

  let nation = lookups.nations.find((item) =>
    sameLookupText(item.futbin_name, nationName) || lookupNameEquals(item.name, nationName));
  nation ||= lookups.nations.find((item) => lookupNameContains(item.name, nationName));
  if (!nation) throw new Error(`[CRITICAL] Ulus veritabanında bulunamadı! Oyuncu: ${name}, Ulus: ${nationName}`);

  const position = lookups.positions.find((item) => lookupNameEquals(item.name, positionName));
  if (!position) throw new Error(`[CRITICAL] Pozisyon veritabanında bulunamadı! Oyuncu: ${name}, Pozisyon: ${positionName}`);

  const cardImageUrl = normalizeText(row?.cardImageUrl);
  const fileName = cardImageUrl.split("/").pop()?.split("?")[0] || "";
  const parts = fileName.replace(/\.png$/i, "").split("_");
  const rarityFutbinId = Number(parts[0]);
  if (!cardImageUrl || parts.length < 2 || !Number.isInteger(rarityFutbinId)) {
    throw new Error(`[CRITICAL] Kart görsel adı parse edilemedi! Oyuncu: ${name}, Dosya: ${fileName}`);
  }

  const rarity = lookups.rarities.find((item) =>
    item.futbin_id !== null && item.futbin_id !== undefined && Number(item.futbin_id) === rarityFutbinId);
  if (!rarity) throw new Error(`Rarity bulunamadı! Oyuncu: ${name}, Futbin Rarity ID: ${rarityFutbinId}`);
  const cardQualityCode = normalizeText(parts[1]).toLowerCase();
  const baseRarity = rarityFutbinId === 0 || rarityFutbinId === 1;
  const qualityCode = baseRarity && ["bronze", "silver", "gold"].includes(cardQualityCode)
    ? cardQualityCode
    : "special";
  const quality = lookups.qualities.find((item) => sameLookupText(item.code, qualityCode));
  if (!quality) throw new Error(`Quality bulunamadı! Oyuncu: ${name}, Quality Code: ${qualityCode}`);

  const mapped = {
    name,
    fullName: name,
    qualityId: Number(quality.id),
    qualityCode,
    qualityIconUrl: quality.icon_url || null,
    qualityImageUrl: baseRarity ? cardImageUrl : SPECIAL_QUALITY_IMAGE_URL,
    rarityId: Number(rarity.id),
    rarityFutbinId,
    rarityCardName: rarityFutbinId === 0
      ? "Common"
      : rarityFutbinId === 1
        ? "Rare"
        : formatCardName(parts.slice(1).join("_")),
    rarityCode: rarityFutbinId === 0 ? "common" : rarityFutbinId === 1 ? "rare" : rarity.code || null,
    rarityName: rarityFutbinId === 0
      ? "Common"
      : rarityFutbinId === 1
        ? "Rare"
        : rarity.name?.tr || rarity.name?.en || rarity.code || String(rarityFutbinId),
    rating: Number(row.rating),
    fixedName: null,
    futbinPlayerId: Number(row.futbinPlayerId),
    futbinPlayerLink: row.futbinPlayerLink,
    futbinSquatLink: null,
    positionId: Number(position.id),
    positionName,
    url: null,
    urlImgPlayer: row.playerImageUrl || null,
    priceConsole: Number(row.priceConsole) || 0,
    pricePc: Number(row.pricePc) || 0,
    urlImgCard: cardImageUrl,
    urlImgNation: row.nationImageUrl || null,
    urlImgLeague: row.leagueImageUrl || null,
    urlImgClub: row.clubImageUrl || null,
    nationId: Number(nation.id),
    nationName,
    alternativePositions: row.alternativePositions || null,
    active: true
  };

  const validationErrors = validateMappedPlayer(mapped);
  if (validationErrors.length) throw new Error(validationErrors.join(", "));

  return mapped;
}

function lookupNameEquals(names, value) {
  return sameLookupText(names?.en, value) || sameLookupText(names?.tr, value);
}

function formatCardName(value) {
  return normalizeText(value)
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function lookupNameContains(names, value) {
  const valueNormalized = stripPunctuation(value);
  const valueTokens = valueNormalized.split(" ").filter(Boolean);
  return [names?.en, names?.tr].some((candidate) => {
    if (!candidate) return false;
    const dbNormalized = stripPunctuation(candidate);
    const dbTokens = dbNormalized.split(" ").filter(Boolean);
    return (dbTokens.length > 0 && dbTokens.every((token) => valueTokens.includes(token))) ||
      (String(candidate).includes(".") && valueNormalized.includes(dbNormalized));
  });
}

function sameLookupText(left, right) {
  if (!left || !right) return false;
  return normalizeText(left).localeCompare(normalizeText(right), undefined, { sensitivity: "accent" }) === 0;
}

function stripPunctuation(value) {
  return normalizeText(value).replace(/[^\p{L}\p{N}_\s]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

async function appendRecords(players, pageUrl, job) {
  if (!players.length) return;
  const stored = await chrome.storage.local.get(RECORDS_KEY);
  const current = stored[RECORDS_KEY] || [];
  const incoming = players.map((player) => ({
    id: `${job.club_id}:${player.futbinPlayerId}`,
    capturedAt: Date.now(),
    pageUrl,
    job,
    player
  }));
  const merged = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) merged.set(record.id, record);
  await chrome.storage.local.set({ [RECORDS_KEY]: [...merged.values()].reverse().slice(0, MAX_RECORDS) });
}

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return { ...emptyState, ...(stored[STATE_KEY] || {}) };
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state }).catch(() => {});
}
