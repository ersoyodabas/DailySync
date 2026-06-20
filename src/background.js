const STATE_KEY = "monitorState";
const RECORDS_KEY = "playerRecords";
const NEXT_ALARM = "futbin-sync-next";
const MAX_RECORDS = 500;

const emptyState = {
  running: false,
  queue: [],
  currentIndex: -1,
  currentUrl: null,
  tabId: null,
  waitMs: 5000,
  nextRunAt: null,
  status: "Hazır",
  updatedAt: null
};

chrome.runtime.onInstalled.addListener(async () => {
  const saved = await chrome.storage.local.get([STATE_KEY, RECORDS_KEY]);
  if (!saved[STATE_KEY]) await chrome.storage.local.set({ [STATE_KEY]: emptyState });
  if (!saved[RECORDS_KEY]) await chrome.storage.local.set({ [RECORDS_KEY]: [] });
});

chrome.runtime.onStartup.addListener(async () => {
  await resumeMonitor();
});

async function resumeMonitor() {
  const state = await getState();
  if (!state.running || !state.currentUrl) return;

  let tab;
  try { tab = await chrome.tabs.get(state.tabId); } catch { /* Oturumda sekme kimliği değişmiş olabilir. */ }
  if (!tab) {
    const tabs = await chrome.tabs.query({ url: ["https://www.futbin.com/*", "https://futbin.com/*"] });
    tab = tabs.find((candidate) => sameUrl(candidate.url, state.currentUrl));
  }
  if (!tab) {
    await stopMonitor("Tarayıcı yeniden açıldı; çalışma sekmesi bulunamadı");
    return;
  }

  await setState({ ...state, tabId: tab.id, status: "Tarama kaldığı yerden sürüyor", updatedAt: Date.now() });
  if (sameUrl(tab.url, state.currentUrl)) {
    chrome.tabs.sendMessage(tab.id, { type: "COLLECT_NOW" }).catch(() => {});
    const nextRunAt = Date.now() + state.waitMs;
    await setState({ ...state, tabId: tab.id, status: "Veriler okunuyor", nextRunAt, updatedAt: Date.now() });
    await chrome.alarms.create(NEXT_ALARM, { when: nextRunAt });
  } else {
    await chrome.tabs.update(tab.id, { url: state.currentUrl });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "START_MONITOR":
      return startMonitor(message.urls, message.waitMs);
    case "STOP_MONITOR":
      await stopMonitor("Kullanıcı tarafından durduruldu");
      return { ok: true };
    case "CLEAR_RECORDS":
      await chrome.storage.local.set({ [RECORDS_KEY]: [] });
      return { ok: true };
    case "GET_SNAPSHOT":
      return { ok: true, ...(await chrome.storage.local.get([STATE_KEY, RECORDS_KEY])) };
    case "PLAYER_DATA":
      return savePlayerData(message, sender);
    default:
      return { ok: false, error: "Bilinmeyen mesaj" };
  }
}

function validateUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("En az bir URL girin.");
  return urls.map((value) => {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !/(^|\.)futbin\.com$/i.test(url.hostname)) {
      throw new Error(`Yalnızca futbin.com HTTPS adreslerine izin verilir: ${value}`);
    }
    return url.href;
  });
}

async function startMonitor(rawUrls, rawWaitMs) {
  const queue = validateUrls(rawUrls);
  const waitMs = Math.min(60000, Math.max(1500, Number(rawWaitMs) || 5000));
  await chrome.alarms.clear(NEXT_ALARM);

  const tab = await chrome.tabs.create({ url: "about:blank", active: false });

  const state = {
    running: true,
    queue,
    currentIndex: 0,
    currentUrl: queue[0],
    tabId: tab.id,
    waitMs,
    nextRunAt: null,
    status: `Sayfa açılıyor (1/${queue.length})`,
    updatedAt: Date.now()
  };
  await setState(state);
  await chrome.tabs.update(tab.id, { url: queue[0], active: false });
  return { ok: true, state };
}

async function stopMonitor(status = "Tamamlandı") {
  await chrome.alarms.clear(NEXT_ALARM);
  const state = await getState();
  await setState({ ...state, running: false, nextRunAt: null, status, updatedAt: Date.now() });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const state = await getState();
  if (!state.running || tabId !== state.tabId || !sameUrl(tab.url, state.currentUrl)) return;

  const nextRunAt = Date.now() + state.waitMs;
  await setState({ ...state, status: "Veriler okunuyor", nextRunAt, updatedAt: Date.now() });
  chrome.tabs.sendMessage(tabId, { type: "COLLECT_NOW" }).catch(() => {});
  await chrome.alarms.create(NEXT_ALARM, { when: nextRunAt });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.running && state.tabId === tabId) await stopMonitor("Çalışma sekmesi kapatıldı");
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== NEXT_ALARM) return;
  const state = await getState();
  if (!state.running) return;

  const nextIndex = state.currentIndex + 1;
  if (nextIndex >= state.queue.length) {
    await stopMonitor(`Tamamlandı (${state.queue.length}/${state.queue.length})`);
    return;
  }

  const nextUrl = state.queue[nextIndex];
  await setState({
    ...state,
    currentIndex: nextIndex,
    currentUrl: nextUrl,
    nextRunAt: null,
    status: `Sayfa açılıyor (${nextIndex + 1}/${state.queue.length})`,
    updatedAt: Date.now()
  });

  try {
    await chrome.tabs.update(state.tabId, { url: nextUrl, active: false });
  } catch {
    await stopMonitor("Çalışma sekmesine erişilemedi");
  }
});

async function savePlayerData(message, sender) {
  if (!sender.tab?.id || !Array.isArray(message.players) || message.players.length === 0) {
    return { ok: true, added: 0 };
  }

  const now = Date.now();
  const incoming = message.players.map((player) => ({
    id: crypto.randomUUID(),
    capturedAt: now,
    pageUrl: message.pageUrl || sender.tab.url,
    source: message.source || "unknown",
    player
  }));

  console.groupCollapsed(`[Futbin Sync] ${incoming.length} oyuncu (${message.source})`);
  console.log(JSON.stringify(incoming, null, 2));
  console.groupEnd();

  const stored = await chrome.storage.local.get(RECORDS_KEY);
  const current = stored[RECORDS_KEY] || [];
  const merged = [...current];
  const indexes = new Map(merged.map((record, index) => [recordFingerprint(record), index]));
  let added = 0;
  let changed = false;
  for (const record of incoming) {
    const fingerprint = recordFingerprint(record);
    const existingIndex = indexes.get(fingerprint);
    if (existingIndex === undefined) {
      merged.unshift(record);
      added += 1;
      changed = true;
      indexes.clear();
      merged.forEach((item, index) => indexes.set(recordFingerprint(item), index));
    } else if (informationScore(record.player) > informationScore(merged[existingIndex].player)) {
      merged[existingIndex] = record;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ [RECORDS_KEY]: merged.slice(0, MAX_RECORDS) });
  return { ok: true, added };
}

function informationScore(player) {
  try { return JSON.stringify(player || {}).length; } catch { return 0; }
}

function recordFingerprint(record) {
  const player = record.player || {};
  return [record.pageUrl, player.id ?? player.playerId ?? player.name ?? JSON.stringify(player).slice(0, 160)].join("|");
}

function sameUrl(left, right) {
  try {
    const a = new URL(left); const b = new URL(right);
    a.hash = ""; b.hash = "";
    return a.href === b.href;
  } catch { return left === right; }
}

async function getState() {
  const stored = await chrome.storage.local.get(STATE_KEY);
  return stored[STATE_KEY] || emptyState;
}

async function setState(state) {
  await chrome.storage.local.set({ [STATE_KEY]: state });
  chrome.runtime.sendMessage({ type: "STATE_CHANGED", state }).catch(() => {});
}
