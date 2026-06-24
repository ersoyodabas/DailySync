const $ = (selector) => document.querySelector(selector);
const LOCAL_API_BASE_URL = "http://localhost:5055/api/";
const elements = {
  apiEnvironmentButtons: [...document.querySelectorAll(".environment-button")],
  waitMs: $("#waitMs"),
  start: $("#start"),
  stop: $("#stop"),
  clear: $("#clear"),
  status: $("#status"),
  dot: $("#statusDot"),
  progress: $("#progressBar"),
  countdown: $("#countdown"),
  clubCount: $("#clubCount"),
  pageCount: $("#pageCount"),
  recordCount: $("#recordCount"),
  insertedCount: $("#insertedCount"),
  updatedCount: $("#updatedCount"),
  deletedCount: $("#deletedCount"),
  skippedCount: $("#skippedCount"),
  logCount: $("#logCount"),
  logTitle: $("#logTitle"),
  errorLogs: $("#errorLogs"),
  logs: $("#logs"),
  records: $("#records"),
  error: $("#error"),
  currentClub: $("#currentClub"),
  contentTabs: [...document.querySelectorAll(".content-tab")],
  contentTabCheckboxes: [...document.querySelectorAll(".content-tab-checkbox")],
  listTitle: $("#listTitle"),
  runCount: $("#runCount")
};

let currentState = {};
let currentRootState = {};
let currentRecords = [];
let currentLogs = [];
let currentErrors = [];
let currentContentTab = "web-app-sync";
let currentListTab = "web-app-sync";
let selectedApiBaseUrl = LOCAL_API_BASE_URL;
const collapsedCoinSections = new Set();
const collapsedCycleGroups = new Set();
const expandedCycleGroups = new Set();
const collapsedLeagueGroups = new Set();
const collapsedClubGroups = new Set();
const actionRegistry = window.FutbinSyncActions || {};
init();
setInterval(renderCountdown, 250);

async function init() {
  const settings = await chrome.storage.local.get(["syncApiBaseUrl", "syncWaitMs", "syncListTab", "syncContentTab", "syncActiveContentTabs"]);
  setApiEnvironment(settings.syncApiBaseUrl || LOCAL_API_BASE_URL);
  setActiveContentTabs(settings.syncActiveContentTabs);
  elements.waitMs.value = String(settings.syncWaitMs || 5000);
  setContentTab(settings.syncContentTab || contentNameForList(settings.syncListTab) || "web-app-sync");
  const snapshot = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
  render(snapshot.syncState || {}, snapshot.playerRecords || [], snapshot.syncLogs || [], snapshot.syncErrors || []);
}

elements.start.addEventListener("click", async () => {
  showError();
  const operations = allSyncOperations();
  if (!operations.length) {
    showError("En az bir senkronizasyon işlemi seçilmelidir.");
    return;
  }
  if (currentState.queue?.length && !currentState.running && currentState.currentJobIndex >= 0) {
    const confirmed = confirm("Mevcut ilerleme silinip Backend'den yeni kulüp kuyruğu alınacak. Devam edilsin mi?");
    if (!confirmed) return;
  }
  await saveSettings();
  const response = await chrome.runtime.sendMessage({
    type: "START_SYNC",
    apiBaseUrl: selectedApiBaseUrl,
    waitMs: Number(elements.waitMs.value),
    operations
  });
  if (!response?.ok) showError(response?.error || "Tarama başlatılamadı.");
  else {
    elements.start.style.display = "none";
    elements.stop.style.display = "";
    elements.stop.removeAttribute("hidden");
  }
});

elements.stop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP_SYNC", operations: allSyncOperations() });
  elements.start.style.display = "";
  elements.stop.style.display = "none";
});

elements.clear.addEventListener("click", async () => {
  if (!confirm("Tarama ilerlemesi ve gösterilen oyuncular temizlensin mi?")) return;
  await chrome.runtime.sendMessage({ type: "CLEAR_SYNC", apiBaseUrl: selectedApiBaseUrl });
});

elements.apiEnvironmentButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    setApiEnvironment(button.dataset.apiBaseUrl);
    await saveSettings();
  });
});
elements.waitMs.addEventListener("change", saveSettings);

elements.contentTabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    setContentTab(tab.dataset.content);
    chrome.storage.local.set({
      syncOperations: allSyncOperations(),
      syncContentTab: tab.dataset.content,
      syncListTab: currentListTab
    });
    render(currentRootState, currentRecords, currentLogs, currentErrors);
  });
});

elements.contentTabCheckboxes.forEach((checkbox) => {
  checkbox.addEventListener("change", async () => {
    await saveSettings();
    render(currentRootState, currentRecords, currentLogs, currentErrors);
  });
});

function setListTab(listName, title) {
  currentListTab = listName || "web-app-sync";
  if (elements.listTitle) {
    elements.listTitle.textContent = title || currentAction().defaultTitle || "Web App Sync";
  }
}

function setContentTab(contentName) {
  const selectedTab = elements.contentTabs.find((tab) => tab.dataset.content === contentName) ||
    elements.contentTabs.find((tab) => tab.dataset.content === "web-app-sync") ||
    elements.contentTabs[0];
  const selectedContent = selectedTab?.dataset.content || "web-app-sync";
  currentContentTab = selectedContent;
  setListTab(selectedTab?.dataset.list || "web-app-sync", selectedTab?.textContent?.trim());

  elements.contentTabs.forEach((tab) => {
    const isSelected = tab.dataset.content === selectedContent;
    tab.classList.toggle("view-active", isSelected);
    tab.setAttribute("aria-selected", String(isSelected));
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes.syncState && !changes.playerRecords && !changes.syncLogs && !changes.syncErrors)) return;
  Promise.all([
    changes.syncState ? changes.syncState.newValue : chrome.storage.local.get("syncState").then((x) => x.syncState),
    changes.playerRecords ? changes.playerRecords.newValue : chrome.storage.local.get("playerRecords").then((x) => x.playerRecords || []),
    changes.syncLogs ? changes.syncLogs.newValue : chrome.storage.local.get("syncLogs").then((x) => x.syncLogs || []),
    changes.syncErrors ? changes.syncErrors.newValue : chrome.storage.local.get("syncErrors").then((x) => x.syncErrors || [])
  ]).then(([state, records, logs, errors]) => render(state, records, logs, errors));
});

elements.logs.addEventListener("click", (event) => {
  const link = event.target.closest(".request-log-link");
  if (!link) return;
  event.preventDefault();
  const url = safeFutbinUrl(link.dataset.url);
  if (url) chrome.tabs.create({ url, active: true });
});

elements.records.addEventListener("click", (event) => {
  const cycleToggle = event.target.closest(".cycle-group-toggle");
  if (cycleToggle) {
    const cycleKey = cycleToggle.dataset.cycleKey;
    const group = cycleToggle.closest(".cycle-group");
    const willCollapse = !group.classList.contains("collapsed");
    group.classList.toggle("collapsed", willCollapse);
    cycleToggle.setAttribute("aria-expanded", String(!willCollapse));
    if (willCollapse) {
      collapsedCycleGroups.add(cycleKey);
      expandedCycleGroups.delete(cycleKey);
    } else {
      expandedCycleGroups.add(cycleKey);
      collapsedCycleGroups.delete(cycleKey);
    }
    return;
  }
  if (currentAction().handleRecordClick?.(event, actionContext())) return;
  openSyncRow(event);
});
elements.records.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  openSyncRow(event);
});

function openSyncRow(event) {
  const row = event.target.closest(".sync-player-group .sync-row[data-futbin-url]");
  if (!row) return;
  event.preventDefault();
  const url = safeFutbinUrl(row.dataset.futbinUrl);
  if (url) chrome.tabs.create({ url, active: true });
}

async function saveSettings() {
  await chrome.storage.local.set({
    syncApiBaseUrl: selectedApiBaseUrl,
    syncWaitMs: Number(elements.waitMs.value),
    syncOperations: allSyncOperations(),
    syncContentTab: currentContentTab,
    syncListTab: currentListTab,
    syncActiveContentTabs: activeContentTabs()
  });
}

function selectedOperations() {
  if (!isContentTabActive(currentContentTab)) return [];
  return currentTabOperations();
}

function currentTabOperations() {
  return (selectedContentTab()?.dataset.operations || "")
    .split(",")
    .map((operation) => operation.trim())
    .filter(Boolean);
}

function allSyncOperations() {
  return [...new Set(elements.contentTabs.flatMap((tab) =>
    (isContentTabActive(tab.dataset.content) ? tab.dataset.operations || "" : "")
      .split(",")
      .map((operation) => operation.trim())
      .filter(Boolean)
  ))];
}

function setActiveContentTabs(activeTabs) {
  const activeSet = Array.isArray(activeTabs)
    ? new Set(activeTabs)
    : new Set(elements.contentTabs
      .filter((tab) => tab.dataset.operations)
      .map((tab) => tab.dataset.content));
  elements.contentTabCheckboxes.forEach((checkbox) => {
    const hasOperation = contentTabHasOperation(checkbox.dataset.contentActive);
    checkbox.checked = hasOperation && activeSet.has(checkbox.dataset.contentActive);
    checkbox.disabled = !hasOperation;
  });
}

function activeContentTabs() {
  return elements.contentTabCheckboxes
    .filter((checkbox) => checkbox.checked && contentTabHasOperation(checkbox.dataset.contentActive))
    .map((checkbox) => checkbox.dataset.contentActive);
}

function isContentTabActive(contentName) {
  return elements.contentTabCheckboxes.some((checkbox) =>
    checkbox.dataset.contentActive === contentName && checkbox.checked && contentTabHasOperation(contentName));
}

function contentTabByName(contentName) {
  return elements.contentTabs.find((tab) => tab.dataset.content === contentName);
}

function contentTabHasOperation(contentName) {
  return Boolean(contentTabByName(contentName)?.dataset.operations);
}

function selectedContentTab() {
  return contentTabByName(currentContentTab);
}

function contentNameForList(listName) {
  return elements.contentTabs.find((tab) => tab.dataset.list === listName)?.dataset.content;
}

function setApiEnvironment(apiBaseUrl) {
  selectedApiBaseUrl = apiBaseUrl || LOCAL_API_BASE_URL;
  elements.apiEnvironmentButtons.forEach((button) => {
    const isActive = button.dataset.apiBaseUrl === selectedApiBaseUrl;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function currentAction() {
  return actionRegistry[currentListTab] || actionRegistry["web-app-sync"];
}

function actionContext() {
  return {
    elements,
    helpers: actionHelpers(),
    collapsedCoinSections,
    collapsedLeagueGroups,
    collapsedClubGroups
  };
}

function actionHelpers() {
  return {
    assetCell,
    cell,
    consolePlatformIcon,
    cycleKeyForEntry,
    escapeHtml,
    imageCell,
    isCoinCardEntry,
    isCoinCardJob,
    pcPlatformIcon,
    playstationIcon,
    priceCell,
    priceRangeCell,
    processedDateCell,
    renderCycleGroups,
    renderErrorRecord,
    safeFutbinUrl,
    syncRowLinkAttributes
  };
}

function render(state = {}, records = [], logs = [], errors = []) {
  currentRootState = state;
  const action = currentAction();
  const helpers = actionHelpers();
  const viewState = action.stateForView(state);
  const nonSkippedErrors = errors.filter((entry) => !isSkippedErrorEntry(entry));
  const displayLogs = logs.filter((entry) => action.entryMatches(entry, helpers));
  const displayErrors = nonSkippedErrors.filter((entry) => action.entryMatches(entry, helpers));
  currentState = viewState;
  currentRecords = records;
  currentLogs = logs;
  currentErrors = nonSkippedErrors;
  const visibleQueue = (viewState.queue || []).filter((job) => action.jobMatches(job, helpers));
  const currentJob = viewState.queue?.[viewState.currentJobIndex];
  const activeJob = action.jobMatches(currentJob, helpers) ? currentJob : null;
  const completedVisibleJobs = visibleQueue
    .filter((job) => (viewState.queue || []).indexOf(job) < viewState.currentJobIndex)
    .length;
  const currentJobNumber = activeJob
    ? visibleQueue.findIndex((job) => job === activeJob) + 1
    : Math.min(completedVisibleJobs, visibleQueue.length);
  const totalJobs = visibleQueue.length;
  const currentPlayers = action.currentPlayers(viewState, activeJob);
  if (elements.logTitle) elements.logTitle.textContent = action.logTitle || "REQUEST URL LOGS";

  elements.status.textContent = !action.hasSyncContent
    ? "İçerik henüz hazır değil"
    : activeJob
      ? viewState.status || "Hazır"
      : viewState.running && totalJobs
        ? currentJobNumber >= totalJobs
          ? "Bu sekmedeki işler tamamlandı"
          : "Bu sekmedeki işler sırada bekliyor"
        : viewState.nextRunAt
          ? viewState.status || "Planlı çalışma bekleniyor"
          : "Hazır";
  elements.dot.classList.toggle("running", Boolean(viewState.running && action.hasSyncContent));
  elements.progress.style.width = totalJobs ? `${Math.min(100, currentJobNumber / totalJobs * 100)}%` : "0%";
  elements.clubCount.textContent = `${Math.min(currentJobNumber, totalJobs)} / ${totalJobs}`;
  elements.pageCount.textContent = activeJob ? `${viewState.currentPage || 0} / ${viewState.totalPages || 0}` : "0 / 0";
  elements.recordCount.textContent = currentPlayers;
  if (elements.runCount) elements.runCount.textContent = viewState.runCount || 0;

  const saveTotals = Object.entries(viewState.clubSaveResults || {}).reduce((totals, [key, result]) => {
    if (!action.saveResultMatches(key)) return totals;

    return {
      inserted: totals.inserted + (Number(result?.inserted) || 0),
      updated: totals.updated + (Number(result?.updated) || 0),
      deleted: totals.deleted + (Number(result?.deleted) || 0)
    };
  }, { inserted: 0, updated: 0, deleted: 0 });
  if (elements.clubCount.nextElementSibling) {
    elements.clubCount.nextElementSibling.textContent = action.statLabel || "Content";
  }

  elements.insertedCount.textContent = saveTotals.inserted;
  elements.updatedCount.textContent = saveTotals.updated;
  elements.deletedCount.textContent = saveTotals.deleted;
  elements.skippedCount.textContent = action.skippedCount(viewState, activeJob);
  elements.currentClub.textContent = action.currentJobLabel({ activeJob, viewState, currentJobNumber, totalJobs });
  if (viewState.running || viewState.userStarted) {
    elements.start.style.display = "none";
    elements.stop.style.display = "";
    elements.stop.removeAttribute("hidden");
  } else {
    elements.start.style.display = "";
    elements.stop.style.display = "none";
  }
  elements.start.disabled = Boolean(viewState.running || viewState.userStarted) || !allSyncOperations().length;
  elements.stop.disabled = !viewState.running && !viewState.userStarted;
  elements.apiEnvironmentButtons.forEach((button) => { button.disabled = Boolean(viewState.running || viewState.userStarted); });
  elements.contentTabCheckboxes.forEach((checkbox) => {
    const hasOperation = contentTabHasOperation(checkbox.dataset.contentActive);
    checkbox.disabled = !hasOperation;
  });
  elements.waitMs.disabled = Boolean(viewState.running || viewState.userStarted);
  showError(viewState.error || "");
  renderCountdown();
  action.renderRecords({
    records,
    errors: displayErrors,
    state: viewState,
    elements,
    helpers,
    collapsedCoinSections,
    collapsedLeagueGroups,
    collapsedClubGroups
  });
  renderLogs(displayLogs, displayErrors);
}

function isSkippedErrorEntry(entry) {
  const message = String(entry?.message || "").toLocaleLowerCase("tr-TR");
  return message.includes("atlandı") || message.includes("atlandi");
}

function isCoinCardJob(job) {
  return String(job?.operation || "").startsWith("coin-card");
}

function isCoinCardEntry(entry) {
  return Boolean(
    isCoinCardJob(entry?.job) ||
    String(entry?.url || "").includes("coin-card") ||
    String(entry?.leagueName || "").toLocaleLowerCase("tr-TR") === "coin cards"
  );
}

function canResume(state) {
  return Boolean(!state.running && state.queue?.length && state.currentJobIndex >= 0 && state.currentJobIndex < state.queue.length && !String(state.status || "").startsWith("Tamamlandı"));
}

function renderCountdown() {
  if (!currentAction().hasSyncContent) {
    elements.countdown.textContent = "İçerik yok";
    return;
  }
  if (currentListTab === "web-app-sync") {
    const isActive = isContentTabActive("web-app-sync");
    const isRunningOrStarted = currentState.running || currentState.userStarted;
    if (!isActive || !isRunningOrStarted) {
      elements.countdown.textContent = "Bekliyor";
      return;
    }
  }
  if (currentState.nextRunAt) {
    const remaining = Math.max(0, currentState.nextRunAt - Date.now());
    if (remaining <= 0) {
      elements.countdown.textContent = "Şimdi…";
      return;
    }
    const totalSeconds = Math.ceil(remaining / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    elements.countdown.textContent = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    return;
  }
  if (!currentState.running && !currentState.userStarted) {
    elements.countdown.textContent = canResume(currentState) ? "Devam etmeye hazır" : "Bekliyor";
    return;
  }
  elements.countdown.textContent = "İşleniyor…";
}

function renderCycleGroups(records, errors = [], state = {}, renderBody) {
  if (!records.length && !errors.length) return "";
  const currentKey = cycleKeyFromState(state);
  const groups = cycleGroups(records, errors);

  return groups.map((group) => {
    const isCollapsed = cycleGroupCollapsed(group.key, currentKey);
    const countText = `${group.records.length} kayıt${group.errors.length ? ` · ${group.errors.length} hata` : ""}`;
    const body = renderBody(group.records, group.errors);
    return `<div class="cycle-group sync-player-group${isCollapsed ? " collapsed" : ""}">
      <div class="league-group sync-group-header cycle-group-header">
        <button class="group-toggle cycle-group-toggle" type="button" data-cycle-key="${escapeHtml(group.key)}" aria-expanded="${String(!isCollapsed)}">
          <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"></path></svg>
          <span class="sync-group-entity"><strong>${escapeHtml(group.label)}</strong></span>
          ${group.key === currentKey ? '<span class="cycle-current-badge">Aktif tur</span>' : ""}
          <span class="group-count">${escapeHtml(countText)}</span>
        </button>
      </div>
      <div class="cycle-group-body">${body}</div>
    </div>`;
  }).join("");
}

function cycleGroups(records = [], errors = []) {
  const groups = new Map();
  const addEntry = (entry, type) => {
    const key = cycleKeyForEntry(entry);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: cycleLabelForEntry(entry, key),
        records: [],
        errors: [],
        sortAt: cycleTimeForEntry(entry)
      });
    }
    groups.get(key)[type].push(entry);
  };
  records.forEach((record) => addEntry(record, "records"));
  errors.forEach((entry) => addEntry(entry, "errors"));
  return [...groups.values()].sort((left, right) => right.sortAt - left.sortAt);
}

function cycleGroupCollapsed(cycleKey, currentKey) {
  if (expandedCycleGroups.has(cycleKey)) return false;
  if (collapsedCycleGroups.has(cycleKey)) return true;
  return cycleKey !== currentKey;
}

function cycleKeyFromState(state = {}) {
  return cycleKeyFromTime(state.runStartedAt || state.updatedAt || Date.now(), state.runCount);
}

function cycleKeyForEntry(entry = {}) {
  return cycleKeyFromTime(cycleTimeForEntry(entry), entry.runCount);
}

function cycleTimeForEntry(entry = {}) {
  return Number(entry.runStartedAt || entry.capturedAt || entry.processedAt || entry.occurredAt || entry.requestedAt || Date.now());
}

function cycleKeyFromTime(value, runCount = null) {
  const time = Number(value) || Date.now();
  const count = Number(runCount) || 0;
  return count > 0 ? `${count}:${time}` : String(time);
}

function cycleLabelForEntry(entry = {}, key = "") {
  const runCount = Number(entry.runCount) || 0;
  const date = new Date(cycleTimeForEntry(entry) || Number(String(key).split(":").pop()));
  if (Number.isNaN(date.getTime())) return "Çalışma turu";
  const prefix = runCount > 0 ? `${runCount}. çalışma turu` : "Çalışma turu";
  return `${prefix} · ${new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date)}`;
}

function renderErrorRecord(entry) {
  const context = [entry.stage, entry.page ? `Sayfa ${entry.page}` : ""].filter(Boolean).join(" · ");
  const label = context || "Hatalı kayıt";
  const message = entry.message || "Oyuncu verisi okunamadı.";
  const futbinUrl = safeFutbinUrl(entry.url);
  return `<article class="player-data-row sync-row has-error${futbinUrl ? " is-clickable" : ""}"${syncRowLinkAttributes(futbinUrl)} title="${escapeHtml(message)}">
      <div class="grid-cell warning-cell"><span class="warning-mark">!</span></div>
      ${cell(label, "player-cell error-label-cell")}
      <div class="grid-cell error-message-cell">${escapeHtml(message)}</div>
    </article>`;
}

function syncRowLinkAttributes(url) {
  return url ? ` role="link" tabindex="0" data-futbin-url="${escapeHtml(url)}"` : "";
}

function renderLogs(logs, errors = []) {
  elements.logCount.textContent = `${logs.length} kayıt`;
  renderErrorLogs(errors);
  if (!logs.length) {
    elements.logs.innerHTML = '<div class="logs-empty">Henüz request gönderilmedi.</div>';
    return;
  }
  elements.logs.innerHTML = logs.map((entry) => {
    const time = new Date(entry.requestedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    if (entry.logType === "web-app-detail") {
      const sequence = entry.sequence ? `#${String(entry.sequence).padStart(3, "0")} ` : "";
      const details = formatLogDetails(entry.details);
      return `<div class="request-log-link" title="${escapeHtml(details || entry.message || "")}">
        <span class="request-log-time">${escapeHtml(time)}</span>
        <span class="request-log-body"><b>${escapeHtml(`${sequence}${entry.step || "FLOW"}`)}</b><small>${escapeHtml(entry.message || "")}${details ? ` · ${escapeHtml(details)}` : ""}</small></span>
      </div>`;
    }
    const label = `${entry.leagueName || "Lig"} → ${entry.clubName || "Kulüp"} · Sayfa ${entry.page || "—"}`;
    return `<a class="request-log-link" href="#" data-url="${escapeHtml(entry.url || "")}" title="${escapeHtml(entry.url || "")}">
      <span class="request-log-time">${escapeHtml(time)}</span>
      <span class="request-log-body"><b>${escapeHtml(label)}</b><small>${escapeHtml(entry.url || "")}</small></span>
    </a>`;
  }).join("");
}

function formatLogDetails(details) {
  if (details === null || details === undefined || details === "") return "";
  if (typeof details === "string") return details;
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function renderErrorLogs(errors = []) {
  if (!errors.length) {
    elements.errorLogs.hidden = true;
    elements.errorLogs.innerHTML = "";
    return;
  }
  elements.errorLogs.hidden = false;
  elements.errorLogs.innerHTML = `
    <div class="error-logs-head"><span>ERRORS</span><small>${errors.length} hata</small></div>
    <div class="error-logs-list">
      ${errors.map((entry) => {
    const time = new Date(entry.occurredAt || entry.requestedAt || Date.now()).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const context = [entry.leagueName, entry.clubName, entry.page ? `Sayfa ${entry.page}` : "", entry.stage].filter(Boolean).join(" · ");
    return `<div class="error-log-item" title="${escapeHtml(entry.message || "")}">
          <span class="error-log-time">${escapeHtml(time)}</span>
          <span class="error-log-body"><b>${escapeHtml(context || "Player error")}</b><small>${escapeHtml(entry.message || "")}</small></span>
        </div>`;
  }).join("")}
    </div>`;
}

function safeFutbinUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && /(^|\.)futbin\.com$/i.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function cell(value, className = "") {
  const text = value === null || value === undefined || value === "" ? "—" : String(value);
  return `<div class="grid-cell ${className}" title="${escapeHtml(text)}">${escapeHtml(text)}</div>`;
}

function assetCell(value, imageUrl, className = "") {
  const text = value === null || value === undefined || value === "" ? "" : String(value);
  const image = imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy">` : '<span class="compact-placeholder">—</span>';
  return `<div class="grid-cell icon-cell ${className}" title="${escapeHtml(text || "—")}">${image}${text ? `<small>${escapeHtml(text)}</small>` : ""}</div>`;
}

function imageCell(imageUrl, description, className = "") {
  const title = description === null || description === undefined || description === "" ? "—" : String(description);
  const image = imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" loading="lazy">` : '<span class="compact-placeholder">—</span>';
  return `<div class="grid-cell icon-cell ${className}" title="${escapeHtml(title)}">${image}</div>`;
}

function priceCell(value) {
  const text = formatPrice(value);
  return `<div class="grid-cell price-cell" title="${escapeHtml(text)}"><span>${escapeHtml(text)}</span>${coinIcon()}</div>`;
}

function priceRangeCell(value, minValue, maxValue) {
  const priceText = formatPrice(value);
  const rangeText = formatRange(minValue, maxValue);
  const title = rangeText === "—" ? priceText : `${priceText} · ${rangeText}`;
  return `<div class="grid-cell price-cell price-range-cell" title="${escapeHtml(title)}">
    <span class="price-main"><span>${escapeHtml(priceText)}</span>${coinIcon()}</span>
    <small>${escapeHtml(rangeText)}</small>
  </div>`;
}

function formatRange(minValue, maxValue) {
  const minText = formatPrice(minValue);
  const maxText = formatPrice(maxValue);
  return minText === "—" && maxText === "—" ? "—" : `${minText} - ${maxText}`;
}

function formatPrice(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";

  if (Math.abs(number) >= 1_000_000) return `${trimPriceDecimal(number / 1_000_000)} M`;
  if (Math.abs(number) >= 1_000) return `${trimPriceDecimal(number / 1_000)} K`;
  return new Intl.NumberFormat("tr-TR").format(number);
}

function trimPriceDecimal(value) {
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function processedDateCell(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) {
    return '<div class="grid-cell processed-date-cell"><span>—</span></div>';
  }
  const dateText = new Intl.DateTimeFormat("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(date);
  const timeText = new Intl.DateTimeFormat("tr-TR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
  return `<div class="grid-cell processed-date-cell" title="${escapeHtml(`${dateText} ${timeText}`)}">
    <span>${escapeHtml(dateText)}</span><b>${escapeHtml(timeText)}</b>
  </div>`;
}

function coinIcon() {
  return '<svg class="coin-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/></svg>';
}

function playstationIcon() {
  return '<svg class="playstation-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9.1 3.5v13.2l3.1 1V6.8c0-.8.4-1.3 1-1 .8.2 1.2.9 1.2 1.7v4.3c2.1 1 3.7 0 3.7-2.6 0-2.7-1-3.9-3.8-4.9-1.9-.7-3.7-.9-5.2-.8Z"/><path d="M12.8 16.6v2.1l5.8-2.1c.7-.3.8-.7.2-.9-.7-.2-1.9-.2-2.7.1l-3.3.8Zm-1.7-.6-2.3.8c-.7.2-.8.6-.2.8.6.2 1.7.2 2.5-.1v2l-.5.2c-2.5.9-5.2.5-6.3-.4-1-.9-.2-2 2.2-2.9l4.6-1.6V16Z"/></svg>';
}

function consolePlatformIcon() {
  return '<svg class="platform-header-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8h10a4 4 0 0 1 3.8 5.2l-1.2 3.6a2 2 0 0 1-3.2.9L14.5 16h-5l-1.9 1.7a2 2 0 0 1-3.2-.9l-1.2-3.6A4 4 0 0 1 7 8Z"/><path d="M8 11v4M6 13h4M16 12h.01M18 14h.01"/></svg>';
}

function pcPlatformIcon() {
  return '<svg class="platform-header-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function showError(message = "") {
  elements.error.hidden = !message;
  elements.error.textContent = message;
}
