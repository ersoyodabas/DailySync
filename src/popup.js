const $ = (selector) => document.querySelector(selector);
const elements = {
  urls: $("#urls"), waitMs: $("#waitMs"), start: $("#start"), stop: $("#stop"), clear: $("#clear"),
  status: $("#status"), dot: $("#statusDot"), pageCount: $("#pageCount"), recordCount: $("#recordCount"),
  records: $("#records"), progress: $("#progressBar"), error: $("#error"),
  countdown: $("#countdown"), startLabel: $("#startLabel")
};
let currentState = {};

const DEFAULT_URLS = Array.from({ length: 5 }, (_, index) =>
  `https://www.futbin.com/26/players?page=${index + 1}&club=1&league=2216%2C13`
).join("\n");

init();
setInterval(renderCountdown, 250);

async function init() {
  const savedInput = await chrome.storage.local.get(["popupUrls", "popupWaitMs"]);
  elements.urls.value = savedInput.popupUrls || DEFAULT_URLS;
  elements.waitMs.value = String(savedInput.popupWaitMs || 5000);
  const snapshot = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
  render(snapshot.monitorState, snapshot.playerRecords || []);
}

elements.start.addEventListener("click", async () => {
  showError();
  const urls = elements.urls.value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  const waitMs = Number(elements.waitMs.value);
  await chrome.storage.local.set({ popupUrls: elements.urls.value, popupWaitMs: waitMs });
  const targetTabId = await getTargetTabId();
  const response = await chrome.runtime.sendMessage({ type: "START_MONITOR", urls, waitMs, tabId: targetTabId });
  if (!response?.ok) showError(response?.error || "Tarama başlatılamadı.");
});

elements.stop.addEventListener("click", () => chrome.runtime.sendMessage({ type: "STOP_MONITOR" }));
elements.clear.addEventListener("click", () => chrome.runtime.sendMessage({ type: "CLEAR_RECORDS" }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  Promise.all([
    changes.monitorState ? changes.monitorState.newValue : chrome.storage.local.get("monitorState").then((x) => x.monitorState),
    changes.playerRecords ? changes.playerRecords.newValue : chrome.storage.local.get("playerRecords").then((x) => x.playerRecords || [])
  ]).then(([state, records]) => render(state, records));
});

function render(state = {}, records = []) {
  currentState = state;
  const total = state.queue?.length || 0;
  const current = state.currentIndex >= 0 ? state.currentIndex + 1 : 0;
  elements.status.textContent = state.status || "Hazır";
  elements.pageCount.textContent = `${Math.min(current, total)} / ${total}`;
  elements.recordCount.textContent = records.length;
  elements.progress.style.width = total ? `${Math.min(100, current / total * 100)}%` : "0%";
  elements.dot.classList.toggle("running", Boolean(state.running));
  elements.start.disabled = Boolean(state.running);
  elements.start.classList.toggle("running", Boolean(state.running));
  elements.startLabel.textContent = state.running ? "Veriler okunuyor" : "Taramayı başlat";
  elements.stop.disabled = !state.running;
  renderCountdown();
  elements.records.innerHTML = records.length ? groupedRecordsHtml(records.slice(0, 500)) : '<tr><td colspan="28" class="empty">Henüz oyuncu verisi yok.</td></tr>';
}

function groupedRecordsHtml(records) {
  const leagues = new Map();
  for (const record of records) {
    const player = record.player || {};
    const leagueName = entityName(player.league) || player.leagueName || player.league_name || "Bilinmeyen League";
    const clubName = entityName(player.club) || player.clubName || player.club_name || "Bilinmeyen Club";
    if (!leagues.has(leagueName)) leagues.set(leagueName, new Map());
    const clubs = leagues.get(leagueName);
    if (!clubs.has(clubName)) clubs.set(clubName, []);
    clubs.get(clubName).push(record);
  }

  return [...leagues.entries()]
    .sort(([left], [right]) => groupNameSort(left, right, "Bilinmeyen League"))
    .map(([leagueName, clubs]) => {
      const leagueCount = [...clubs.values()].reduce((total, clubRecords) => total + clubRecords.length, 0);
      const clubRows = [...clubs.entries()]
        .sort(([left], [right]) => groupNameSort(left, right, "Bilinmeyen Club"))
        .map(([clubName, clubRecords]) => `${clubGroupRow(clubName, clubRecords.length)}${clubRecords.map(recordHtml).join("")}`)
        .join("");
      return `${leagueGroupRow(leagueName, leagueCount, clubs.size)}${clubRows}`;
    })
    .join("");
}

function groupNameSort(left, right, unknownLabel) {
  if (left === unknownLabel) return 1;
  if (right === unknownLabel) return -1;
  return String(left).localeCompare(String(right), "tr");
}

function leagueGroupRow(name, playerCount, clubCount) {
  return `<tr class="league-group"><td colspan="28"><span class="group-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8.5 5.8 1.2 3.7h4.6l1.2-3.7M5.1 11h3.7l1.4 4.3-3 2.2M18.9 11h-3.7l-1.4 4.3 3 2.2M10.2 15.3h3.6"/></svg></span><strong>${escapeHtml(String(name))}</strong><span class="group-count">${clubCount} kulüp · ${playerCount} oyuncu</span></td></tr>`;
}

function clubGroupRow(name, playerCount) {
  return `<tr class="club-group"><td colspan="28"><span class="group-branch"></span><span class="group-icon club"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 7v5c0 5 3.4 8 8 9 4.6-1 8-4 8-9V7l-8-4Z"/><path d="M9 12h6M12 9v6"/></svg></span><strong>${escapeHtml(String(name))}</strong><span class="group-count">${playerCount} oyuncu</span></td></tr>`;
}

function renderCountdown() {
  if (!currentState.running) {
    elements.countdown.textContent = "Bekliyor";
    elements.startLabel.textContent = "Taramayı başlat";
    return;
  }
  if (!currentState.nextRunAt) {
    elements.countdown.textContent = "Sayfa yükleniyor…";
    elements.startLabel.textContent = "Sayfa yükleniyor";
    return;
  }
  const remainingMs = Math.max(0, currentState.nextRunAt - Date.now());
  const seconds = Math.ceil(remainingMs / 1000);
  elements.countdown.textContent = remainingMs > 0 ? `${seconds} saniye` : "Şimdi geçiliyor…";
  elements.startLabel.textContent = remainingMs > 0 ? `Veriler okunuyor · ${seconds} sn` : "Sonraki sayfaya geçiliyor";
}

function recordHtml(record) {
  const player = record.player || {};
  const values = [
    player.id ?? player.playerId,
    player.name || player.playerName || player.commonName,
    player.revision,
    player.rating ?? player.overall,
    player.position,
    player.prices?.playstation ?? player.price,
    player.prices?.pc,
    player.futbinRating,
    entityName(player.club),
    entityName(player.nation),
    entityName(player.league),
    player.strongFoot,
    player.skillMoves,
    player.weakFoot,
    player.stats?.pace ?? player.pace,
    player.stats?.shooting ?? player.shooting,
    player.stats?.passing ?? player.passing,
    player.stats?.dribbling ?? player.dribbling,
    player.stats?.defending ?? player.defending,
    player.stats?.physicality ?? player.physicality,
    player.popularity,
    player.inGameStats,
    player.height?.cm ?? player.height?.text ?? player.height,
    player.height?.weightKg,
    player.height?.bodyType,
    player.height?.accelerate,
    record.source,
    record.pageUrl
  ];
  return `<tr>${values.map((value, index) => tableCell(value, index)).join("")}</tr>`;
}

function entityName(value) {
  return value && typeof value === "object" ? value.name || value.id : value;
}

function tableCell(value, index) {
  const text = value === null || value === undefined || value === "" ? "—" : String(value);
  const classes = [index === 1 ? "player-name" : "", [0, 3, 5, 6, 7, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].includes(index) ? "number" : ""].filter(Boolean).join(" ");
  return `<td class="${classes}" title="${escapeHtml(text)}">${escapeHtml(text)}</td>`;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function showError(message = "") {
  elements.error.hidden = !message;
  elements.error.textContent = message;
}

async function getTargetTabId() {
  const saved = await chrome.storage.local.get("monitorTargetTabId");
  if (Number.isInteger(saved.monitorTargetTabId)) {
    try {
      const tab = await chrome.tabs.get(saved.monitorTargetTabId);
      if (tab?.id) return tab.id;
    } catch { /* Kayıtlı sekme kapanmış olabilir. */ }
  }

  const normalWindows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return normalWindows.flatMap((window) => window.tabs || []).find((tab) => tab.active)?.id;
}
