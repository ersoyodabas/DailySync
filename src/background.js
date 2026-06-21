const STATE_KEY = "syncState";
const RECORDS_KEY = "playerRecords";
const LOGS_KEY = "syncLogs";
const ERRORS_KEY = "syncErrors";
const PAGE_TIMEOUT_ALARM = "futbin-sync-page-timeout";
const PAGE_TIMEOUT_MS = 60000;
const MAX_RECORDS = 500;
const MAX_LOGS = 300;
const MAX_ERRORS = 300;
const FUTBIN_LATEST_URL = "https://www.futbin.com/latest";
const LATEST_COIN_CARD_PAGES = 2;
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
  currentLatest: null,
  currentSkipped: 0,
  pagesAttempted: 0,
  pagesSucceeded: 0,
  failedPages: [],
  completedClubs: 0,
  operations: ["club-players"],
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
      return startFreshSync(message.apiBaseUrl, message.waitMs, message.operations, 0);
    case "RESUME_SYNC":
      return resumePausedSync();
    case "STOP_SYNC":
      return pauseSync();
    case "CLEAR_SYNC":
      await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);
      await chrome.alarms.clear("futbin-sync-loop");
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

async function startFreshSync(rawApiBaseUrl, rawWaitMs, rawOperations, runCount = 0) {
  const apiBaseUrl = normalizeApiBaseUrl(rawApiBaseUrl);
  const waitMs = Math.min(30000, Math.max(3000, Number(rawWaitMs) || 5000));
  const operations = [...new Set(Array.isArray(rawOperations) ? rawOperations : ["club-players"])]
    .filter((operation) => operation === "club-players" || operation === "coin-cards");
  if (!operations.length) throw new Error("En az bir işlem seçilmelidir.");

  const queue = [];
  let lookups = null;
  if (operations.includes("coin-cards")) {
    queue.push({
      id: "latest",
      label: "Latest Coin Cards",
      url: FUTBIN_LATEST_URL,
      operation: "coin-card-latest"
    });
  }
  if (operations.includes("club-players")) {
    const response = await apiRequest(apiBaseUrl, "sync/futbin-player-jobs");
    const jobs = Array.isArray(response?.data?.jobs) ? response.data.jobs : [];
    lookups = response?.data?.lookups || null;
    validateLookups(lookups);
    queue.push(...jobs.map((job) => ({ ...job, operation: "club-players" })));
  }
  await chrome.alarms.clear(PAGE_TIMEOUT_ALARM);
  await chrome.alarms.clear("futbin-sync-loop");

  const previous = await getState();
  if (previous.tabId) {
    try { await chrome.tabs.remove(previous.tabId); } catch { /* Eski sekme zaten kapanmış olabilir. */ }
  }

  if (queue.length === 0) {
    const state = {
      ...emptyState,
      apiBaseUrl,
      waitMs,
      operations,
      runCount,
      status: "Seçilen işlemler için bekleyen iş yok",
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
    operations,
    lookups,
    runCount,
    currentJobIndex: 0,
    currentPage: 1,
    totalPages: 1,
    currentUrl: buildJobUrl(firstJob, 1),
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
  await chrome.alarms.clear("futbin-sync-loop");
  const state = await getState();
  if (state.tabId) {
    try { await chrome.tabs.remove(state.tabId); } catch { /* Sekme zaten kapanmış olabilir. */ }
  }
  const stopped = {
    ...state,
    running: false,
    tabId: null,
    nextRunAt: null,
    status: "Durduruldu",
    updatedAt: Date.now()
  };
  await setState(stopped);
  return { ok: true, state: stopped };
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
      operation: currentJob(state).operation,
      page: state.currentPage,
      latestTotalPages: currentJob(state).operation === "coin-card-latest" ? LATEST_COIN_CARD_PAGES : undefined,
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
  if (alarm.name === "futbin-sync-loop") {
    const state = await getState();
    if (!state.running) return;
    await startFreshSync(state.apiBaseUrl, state.waitMs, state.operations, (state.runCount || 0) + 1);
    return;
  }
  if (alarm.name !== PAGE_TIMEOUT_ALARM) return;
  const state = await getState();
  if (!state.running) return;
  await handlePageFailure(`Sayfa zaman aşımına uğradı: ${state.currentUrl}`);
});

async function handlePageResult(message, sender) {
  const state = await getState();
  if (!isCurrentPageSender(state, message, sender)) return { ok: false, error: "Eski sayfa sonucu yok sayıldı." };

  const job = currentJob(state);
  const isLatestCoinCardJob = job.operation === "coin-card-latest";
  const isCoinCardJob = job.operation === "coin-cards";
  const totalPages = isLatestCoinCardJob ? LATEST_COIN_CARD_PAGES : isCoinCardJob ? 1 : state.currentPage === 1
    ? Math.max(1, Number(message.totalPages) || 1)
    : state.totalPages;
  const players = { ...(state.currentPlayers || {}) };
  let skipped = 0;
  const mappedPlayers = [];
  const pageErrors = normalizePageErrors(message.errors, job, state);
  let currentLatest = state.currentLatest;
  if (isLatestCoinCardJob) {
    const pageLatest = message.latestCoinCards || { sourceDate: null, cards: [] };
    const existingCards = Array.isArray(currentLatest?.cards) ? currentLatest.cards : [];
    const incomingCards = Array.isArray(pageLatest.cards) ? pageLatest.cards : [];
    currentLatest = {
      sourceDate: currentLatest?.sourceDate || pageLatest.sourceDate || null,
      cards: dedupeLatestCoinCards([...existingCards, ...incomingCards])
    };
    skipped += pageErrors.length;
  } else if (isCoinCardJob) {
    try {
      const card = normalizeCoinCardDetail(message.coinCard, job);
      players[String(job.id)] = card;
      mappedPlayers.push(toCoinCardDisplayPlayer(card, job));
    } catch (error) {
      skipped++;
      pageErrors.push(buildErrorEntry({ state, job, stage: "parse", message: error.message || String(error) }));
    }
  } else {
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
  }
  if (pageErrors.length) await appendErrors(pageErrors);
  await appendRecords(mappedPlayers, state.currentUrl, job);

  const updated = {
    ...state,
    totalPages,
    currentLatest,
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
    const nextUrl = buildJobUrl(currentJob(state), nextPage);
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

  return submitCurrentJobAndPrepareNext(state);
}

async function submitCurrentJobAndPrepareNext(state) {
  const job = currentJob(state);
  if (job.operation === "coin-card-latest") return submitLatestCoinCardsAndPrepareDetails(state);
  if (job.operation === "coin-cards") return submitCurrentCoinCardAndPrepareNext(state);
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
    return scheduleNextLoop(state, saved, skipped, clubSaveResults, null);
  }

  const nextJob = state.queue[nextJobIndex];
  const nextUrl = buildJobUrl(nextJob, 1);
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

async function submitLatestCoinCardsAndPrepareDetails(state) {
  const job = currentJob(state);
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = state.currentSkipped || 0;

  if (state.currentLatest) {
    await setState({
      ...state,
      nextRunAt: null,
      status: "Latest Coin Cards: API'ye kaydediliyor",
      updatedAt: Date.now()
    });
    const response = await apiRequest(state.apiBaseUrl, "futbin-sync/coin-card-latest", {
      method: "POST",
      body: JSON.stringify({
        source_date: state.currentLatest.sourceDate,
        cards: (state.currentLatest.cards || []).map(toApiLatestCoinCard)
      })
    });
    inserted = Number(response?.data?.inserted) || 0;
    updated = Number(response?.data?.updated) || 0;
    deleted = Number(response?.data?.deleted) || 0;
    skipped += Number(response?.data?.skipped) || 0;
    const responseErrors = Array.isArray(response?.data?.errors) ? response.data.errors : [];
    if (responseErrors.length) {
      await appendErrors(responseErrors.map((message) => buildErrorEntry({
        state,
        job,
        stage: "latest-after-post",
        message
      })));
    }
  }

  const jobsResponse = await apiRequest(state.apiBaseUrl, "futbin-sync/coin-card-jobs");
  const detailJobs = (Array.isArray(jobsResponse?.data?.jobs) ? jobsResponse.data.jobs : [])
    .map((detailJob) => ({ ...detailJob, operation: "coin-cards" }));
  const queue = [
    ...state.queue.slice(0, state.currentJobIndex + 1),
    ...detailJobs,
    ...state.queue.slice(state.currentJobIndex + 1)
  ];
  const clubSaveResults = {
    ...(state.clubSaveResults || {}),
    "coin-card:latest": {
      saved: inserted,
      skipped,
      inserted,
      updated,
      deleted,
      posted: state.currentLatest?.cards?.length || 0,
      savedAt: Date.now()
    }
  };
  const nextJobIndex = state.currentJobIndex + 1;

  if (nextJobIndex >= queue.length) {
    return scheduleNextLoop(state, inserted + updated, skipped, clubSaveResults, queue);
  }

  const nextJob = queue[nextJobIndex];
  const nextUrl = buildJobUrl(nextJob, 1);
  const prepared = {
    ...state,
    queue,
    currentJobIndex: nextJobIndex,
    currentPage: 1,
    totalPages: 1,
    currentUrl: nextUrl,
    currentPlayers: {},
    currentLatest: null,
    currentSkipped: 0,
    pagesAttempted: 0,
    pagesSucceeded: 0,
    failedPages: [],
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + inserted + updated,
    skippedPlayers: state.skippedPlayers + skipped,
    clubSaveResults,
    nextRunAt: Date.now() + state.waitMs,
    status: jobStatus(nextJob, nextJobIndex, queue.length, "İş sırası bekleniyor"),
    updatedAt: Date.now()
  };
  await setState(prepared);
  return { ok: true, action: "WAIT_AND_ADVANCE", nextUrl, waitMs: state.waitMs };
}

async function submitCurrentCoinCardAndPrepareNext(state) {
  const job = currentJob(state);
  const card = state.currentPlayers?.[String(job.id)];
  let saved = 0;
  let skipped = state.currentSkipped || 0;
  let inserted = 0;
  let updated = 0;
  let deleted = 0;

  if (card) {
    await setState({
      ...state,
      nextRunAt: null,
      status: `${job.label || "Coin Cards"}: API'ye kaydediliyor`,
      updatedAt: Date.now()
    });
    const response = await apiRequest(state.apiBaseUrl, `futbin-sync/coin-card-jobs/${job.id}`, {
      method: "POST",
      body: JSON.stringify(toApiCoinCard(card))
    });
    saved = Number(response?.data?.saved) || 0;
    skipped += Number(response?.data?.skipped) || 0;
    inserted = Number(response?.data?.inserted) || 0;
    updated = Number(response?.data?.updated) || 0;
    deleted = Number(response?.data?.deleted) || 0;
    const responseErrors = Array.isArray(response?.data?.errors) ? response.data.errors : [];
    if (responseErrors.length) {
      await appendErrors(responseErrors.map((message) => buildErrorEntry({
        state,
        job,
        stage: "after-post",
        message
      })));
    }
    const saveStatus = inserted > 0 ? "inserted" : updated > 0 ? "updated" : "unchanged";
    await updateRecordSaveStatus(job, saveStatus);
  }

  const resultKey = `coin-card:${job.id}`;
  const clubSaveResults = {
    ...(state.clubSaveResults || {}),
    [resultKey]: { saved, skipped, inserted, updated, deleted, posted: card ? 1 : 0, savedAt: Date.now() }
  };
  const nextJobIndex = state.currentJobIndex + 1;
  if (nextJobIndex >= state.queue.length) {
    return scheduleNextLoop(state, saved, skipped, clubSaveResults, null);
  }

  const nextJob = state.queue[nextJobIndex];
  const nextUrl = buildJobUrl(nextJob, 1);
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
    status: jobStatus(nextJob, nextJobIndex, state.queue.length, "İş sırası bekleniyor"),
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
    clubName: isCoinCardOperation(job) ? job.label : job.club_name || "Kulüp",
    leagueName: isCoinCardOperation(job) ? "Coin Cards" : job.league_name || "Lig"
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
    clubName: isCoinCardOperation(job) ? job.label : job?.club_name || "Kulüp",
    leagueName: isCoinCardOperation(job) ? "Coin Cards" : job?.league_name || "Lig"
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
  const url = new URL(endpoint, apiBaseUrl).href;
  const method = options.method || "GET";
  const body = options.body;
  let response;
  let payload = {};
  let rawText = "";

  console.groupCollapsed(`[FutbinSync API] ${method} ${url}`);
  console.log("request", {
    method,
    url,
    headers: { "Content-Type": "application/json" },
    body: parseJsonForLog(body)
  });

  try {
    response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body
    });
    rawText = await response.text();
    payload = parseJsonForLog(rawText) || {};
    console.log("response", {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: payload,
      rawText
    });
  } catch (error) {
    console.error("request failed", error);
    throw error;
  } finally {
    console.groupEnd();
  }

  if (!response.ok || payload?.result === false) {
    const error = new Error(payload?.message || `API isteği başarısız (${response.status})`);
    error.critical = payload?.error_code === "CRITICAL";
    throw error;
  }
  return payload;
}

function parseJsonForLog(value) {
  if (!value || typeof value !== "string") return value || null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeApiBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("API adresi HTTP veya HTTPS olmalıdır.");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  return url.href;
}

function buildJobUrl(job, page) {
  if (job?.operation === "coin-card-latest") {
    const url = new URL(job.url || FUTBIN_LATEST_URL);
    url.searchParams.set("page", String(page));
    return url.href;
  }
  if (job?.operation === "coin-cards") return job.url;
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

function isCoinCardOperation(job) {
  return job?.operation === "coin-cards" || job?.operation === "coin-card-latest";
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
  if (isCoinCardOperation(job))
    return `${job.label || "Coin Cards"} (${index + 1}/${total}) · ${suffix}`;
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
    if (job?.operation === "coin-card-latest") {
      const page = url.searchParams.get("page") || "1";
      return /(^|\.)futbin\.com$/i.test(url.hostname) &&
        url.pathname.replace(/\/+$/, "") === "/latest" &&
        page === String(state.currentPage);
    }
    if (job?.operation === "coin-cards") return sameUrl(url.href, state.currentUrl);
    return /(^|\.)futbin\.com$/i.test(url.hostname) &&
      url.searchParams.get("page") === String(state.currentPage) &&
      url.searchParams.get("club") === String(job.futbin_club_id) &&
      url.searchParams.get("league") === String(job.futbin_league_id);
  } catch { return sameUrl(value, state.currentUrl); }
}

function normalizeCoinCardDetail(value, job) {
  if (!value || typeof value !== "object") throw new Error("Coin Card detay verisi okunamadı.");
  return {
    playerName: normalizeText(value.playerName) || job.label || `Coin Card #${job.id}`,
    rating: positiveNumberOrNull(value.rating),
    position: normalizeText(value.position),
    playerImgUrl: normalizeText(value.playerImgUrl) || null,
    bgCardUrl: normalizeText(value.bgCardUrl) || null,
    nationImgUrl: normalizeText(value.nationImgUrl) || null,
    minPriceCross: positiveNumberOrNull(value.minPriceCross),
    priceCross: positiveNumberOrNull(value.priceCross),
    maxPriceCross: positiveNumberOrNull(value.maxPriceCross),
    minPricePc: positiveNumberOrNull(value.minPricePc),
    pricePc: positiveNumberOrNull(value.pricePc),
    maxPricePc: positiveNumberOrNull(value.maxPricePc)
  };
}

function positiveNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function toCoinCardDisplayPlayer(card, job) {
  return {
    futbinPlayerId: Number(job.id),
    futbinPlayerLink: job.url,
    name: card.playerName,
    positionName: card.position,
    rating: card.rating,
    qualityCode: "coin",
    rarityName: "Coin Card",
    priceConsole: card.priceCross || card.pricePc || 0,
    urlImgCard: card.bgCardUrl,
    urlImgPlayer: card.playerImgUrl,
    urlImgNation: card.nationImgUrl,
    leagueName: "Coin Cards",
    clubName: card.playerName,
    active: true
  };
}

function toApiLatestCoinCard(card) {
  return {
    player_name: card.playerName,
    rating: card.rating,
    position: card.position,
    url: card.url,
    player_img_url: card.playerImgUrl,
    bg_card_url: card.bgCardUrl,
    nation_img_url: card.nationImgUrl,
    min_price_cross: card.minPriceCross,
    price_cross: card.priceCross,
    max_price_cross: card.maxPriceCross,
    min_price_pc: card.minPricePc,
    price_pc: card.pricePc,
    max_price_pc: card.maxPricePc
  };
}

function dedupeLatestCoinCards(cards) {
  const merged = new Map();
  for (const card of cards || []) {
    const key = normalizeText(card?.url).toLowerCase();
    if (!key) continue;
    merged.set(key, card);
  }
  return [...merged.values()];
}

function toApiCoinCard(card) {
  return {
    player_name: card.playerName,
    rating: card.rating,
    position: card.position,
    player_img_url: card.playerImgUrl,
    bg_card_url: card.bgCardUrl,
    nation_img_url: card.nationImgUrl,
    min_price_cross: card.minPriceCross,
    price_cross: card.priceCross,
    max_price_cross: card.maxPriceCross,
    min_price_pc: card.minPricePc,
    price_pc: card.pricePc,
    max_price_pc: card.maxPricePc
  };
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
    id: `${job.operation || "club-players"}:${job.id || job.club_id}:${player.futbinPlayerId}`,
    capturedAt: Date.now(),
    pageUrl,
    job,
    leagueName: player.leagueName || job.league_name,
    clubName: player.clubName || job.club_name,
    saveStatus: null,
    player
  }));
  const merged = new Map(current.map((record) => [record.id, record]));
  for (const record of incoming) merged.set(record.id, record);
  await chrome.storage.local.set({ [RECORDS_KEY]: [...merged.values()].reverse().slice(0, MAX_RECORDS) });
}

async function updateRecordSaveStatus(job, saveStatus) {
  const recordId = `${job.operation}:${job.id}:`;
  const stored = await chrome.storage.local.get(RECORDS_KEY);
  const records = stored[RECORDS_KEY] || [];
  const updated = records.map((r) => r.id.startsWith(recordId) ? { ...r, saveStatus } : r);
  await chrome.storage.local.set({ [RECORDS_KEY]: updated });
}

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return { ...emptyState, ...(stored[STATE_KEY] || {}) };
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state }).catch(() => {});
}

async function scheduleNextLoop(state, totalSaved, totalSkipped, clubSaveResults, queue) {
  const isClubPlayersActive = state.operations.includes("club-players");
  const waitMs = isClubPlayersActive ? 2 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const loopNumber = (state.runCount || 0) + 1;
  const targetTime = Date.now() + waitMs;

  const waiting = {
    ...state,
    queue: queue || state.queue,
    completedClubs: state.completedClubs + 1,
    savedPlayers: state.savedPlayers + (totalSaved || 0),
    skippedPlayers: state.skippedPlayers + (totalSkipped || 0),
    clubSaveResults,
    currentLatest: null,
    nextRunAt: targetTime,
    status: `Döngü bitti. ${loopNumber}. döngü bekleniyor...`,
    updatedAt: Date.now()
  };
  await setState(waiting);
  await chrome.alarms.create("futbin-sync-loop", { when: targetTime });

  return { ok: true, action: "WAIT_AND_ADVANCE", waitMs };
}
