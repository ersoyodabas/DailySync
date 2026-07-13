const statusElement = document.querySelector("#status");
const statusDot = document.querySelector("#statusDot");
const nextCheck = document.querySelector("#nextCheck");
const dailyLogs = document.querySelector("#dailyLogs");
const logCount = document.querySelector("#logCount");
const progressSection = document.querySelector("#progressSection");
const progressSummary = document.querySelector("#progressSummary");
const stepProgress = document.querySelector("#stepProgress");
let currentState = {};
let currentSnapshot = {};
let loading = false;
let deletingDate = null;
let refreshIntervalMs = 1500;

load("GET_SNAPSHOT");
setInterval(renderCountdown, 1000);
setInterval(() => load("GET_SNAPSHOT_PASSIVE"), refreshIntervalMs);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const relevantKeys = ["webAppSyncState", "webAppSyncLogs", "webAppOnlyDailyRunLogs"];
  if (!relevantKeys.some((key) => changes[key])) return;
  for (const key of relevantKeys) {
    if (changes[key]) currentSnapshot[key] = changes[key].newValue;
  }
  renderSnapshot(currentSnapshot);
});

async function load(type = "GET_SNAPSHOT_PASSIVE") {
  if (loading) return;
  loading = true;
  let snapshot = null;
  try {
    snapshot = await chrome.runtime.sendMessage({ futbinSyncModule: "webapp", type });
  } catch (error) {
    statusElement.textContent = `Popup güncellenemedi: ${error.message || error}`;
    return;
  } finally {
    loading = false;
  }
  currentSnapshot = snapshot || {};
  renderSnapshot(currentSnapshot);
}

function renderSnapshot(snapshot) {
  const state = snapshot.webAppSyncState?.runs?.["web-app-sync"] || snapshot.webAppSyncState || {};
  currentState = state;
  const logs = Array.isArray(snapshot.webAppOnlyDailyRunLogs) ? snapshot.webAppOnlyDailyRunLogs : [];
  statusElement.textContent = state.status || "Otomatik kontrol aktif";
  statusDot.classList.toggle("running", Boolean(state.running));
  renderCountdown();
  renderProgress(state, snapshot.webAppSyncLogs || []);
  renderLogs(logs);
}

const STEP_TITLES = [
  "Web App ve oturum kontrolü",
  "İngilizce dil kontrolü",
  "İngilizce rarity sync",
  "İngilizce SBC sync",
  "Türkçe sync kararı",
  "Türkçe dil geçişi",
  "Türkçe rarity sync",
  "Türkçe SBC sync",
  "Sekme kapatma ve final log"
];

function renderProgress(state, logs) {
  const runStartedAt = Number(state.runStartedAt) || 0;
  progressSection.hidden = !runStartedAt;
  if (!runStartedAt) return;

  const latestByStep = new Map();
  const substepsByParent = new Map();
  const seenSubsteps = new Set();
  for (const entry of logs) {
    if (Number(entry.runStartedAt) !== runStartedAt) continue;
    const progress = entry.details?.progress;
    const stepId = Number(progress?.stepId);
    if (stepId >= 1 && stepId <= STEP_TITLES.length && !latestByStep.has(stepId)) {
      latestByStep.set(stepId, progress);
    }
    const substep = entry.details?.substep;
    const parentStepId = Number(substep?.parentStepId);
    const substepKey = `${parentStepId}:${substep?.key || entry.message}`;
    if (parentStepId >= 1 && parentStepId <= STEP_TITLES.length && !seenSubsteps.has(substepKey)) {
      seenSubsteps.add(substepKey);
      const items = substepsByParent.get(parentStepId) || [];
      items.push(substep);
      substepsByParent.set(parentStepId, items);
    }
  }

  if (state.running && !latestByStep.size) {
    latestByStep.set(1, { stepId: 1, status: "progressing", title: "Web App açılıyor" });
  }
  const finished = [...latestByStep.values()].filter((step) => step.status === "completed" || step.status === "skipped").length;
  progressSummary.textContent = `${finished} / ${STEP_TITLES.length}`;
  stepProgress.innerHTML = STEP_TITLES.flatMap((defaultTitle, index) => {
    const stepId = index + 1;
    const progress = latestByStep.get(stepId) || {};
    const status = progress.status || "pending";
    const label = { pending: "Bekliyor", progressing: "Devam ediyor", completed: "Tamamlandı", skipped: "Atlandı", failed: "Hata" }[status] || status;
    const parent = `<article class="step ${escapeHtml(status)}">
      <span class="step-marker">${stepId}</span>
      <div><strong>${escapeHtml(progress.title || defaultTitle)}</strong>${progress.detail ? `<small>${escapeHtml(progress.detail)}</small>` : ""}</div>
      <b>${escapeHtml(label)}</b>
    </article>`;
    const substeps = (substepsByParent.get(stepId) || []).reverse().map((substep) => {
      const subStatus = substep.status || "pending";
      const subLabel = { pending: "Bekliyor", progressing: "İstek sürüyor", completed: "Tamamlandı", failed: "Hata" }[subStatus] || subStatus;
      return `<article class="step api-substep ${escapeHtml(subStatus)}">
        <span class="step-marker">↳</span>
        <div><strong>${escapeHtml(substep.title || "API işlemi")}</strong>${substep.detail ? `<small>${escapeHtml(substep.detail)}</small>` : ""}</div>
        <b>${escapeHtml(subLabel)}</b>
      </article>`;
    });
    return [parent, ...substeps];
  }).join("");
}

function renderCountdown() {
  if (currentState.running) {
    nextCheck.textContent = "Senkronizasyon çalışıyor · İngilizce ve Türkçe taranıyor";
    return;
  }
  if (!currentState.nextRunAt) {
    nextCheck.textContent = "Sonraki otomatik kontrol bekleniyor";
    return;
  }
  const remainingMs = Math.max(0, Number(currentState.nextRunAt) - Date.now());
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const countdown = [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
  nextCheck.textContent = `Sonraki sync ${formatTargetClock(currentState.nextRunAt)} · ${countdown} kaldı`;
}

function formatTargetClock(value) {
  const local = new Date(Number(value));
  const date = [local.getDate(), local.getMonth() + 1, local.getFullYear()]
    .map((part, index) => index < 2 ? String(part).padStart(2, "0") : String(part))
    .join(".");
  const time = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
  return `${date} ${time}`;
}

function renderLogs(logs) {
  const visibleLogs = logs
    .filter((entry) => entry?.status === "success")
    .sort((left, right) => String(right?.date || "").localeCompare(String(left?.date || "")))
    .slice(0, 3);
  logCount.textContent = `${visibleLogs.length} kayıt`;
  if (!visibleLogs.length) {
    dailyLogs.innerHTML = "<p>Henüz başarı kaydı yok.</p>";
    return;
  }
  dailyLogs.innerHTML = visibleLogs.map((entry) => `
    <article data-date="${escapeHtml(entry.date)}">
      <div><strong>${escapeHtml(entry.date)}</strong><span class="log-actions"><em>Başarılı</em><button type="button" class="delete-log" data-date="${escapeHtml(entry.date)}" aria-label="${escapeHtml(entry.date)} kaydını sil" ${deletingDate === entry.date ? "disabled" : ""}>${deletingDate === entry.date ? "…" : "Sil"}</button></span></div>
      <small>${escapeHtml(entry.completedAtLocal || formatLocal(entry.completedAt))}</small>
      <p>Rarity ${number(entry.rarity?.saved)} kayıt · SBC ${number(entry.sbc?.saved)} kayıt · ${number(entry.sbc?.tiles)} tile</p>
    </article>`).join("");
}

dailyLogs.addEventListener("click", async (event) => {
  const button = event.target.closest(".delete-log");
  if (!button || deletingDate) return;
  const date = button.dataset.date;
  deletingDate = date;
  renderLogs(currentSnapshot.webAppOnlyDailyRunLogs || []);
  try {
    const response = await chrome.runtime.sendMessage({ futbinSyncModule: "webapp", type: "DELETE_DAILY_RUN_LOG", date });
    if (!response?.ok) throw new Error(response?.error || "Kayıt silinemedi.");
    currentSnapshot.webAppOnlyDailyRunLogs = response.logs || [];
    if (response.state) {
      currentSnapshot.webAppSyncState = { ...(currentSnapshot.webAppSyncState || {}), runs: { ...(currentSnapshot.webAppSyncState?.runs || {}), "web-app-sync": response.state } };
    }
  } catch (error) {
    statusElement.textContent = `Günlük kayıt silinemedi: ${error.message || error}`;
  } finally {
    deletingDate = null;
    await load("GET_SNAPSHOT_PASSIVE");
  }
});

function formatLocal(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function number(value) {
  return Number(value) || 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;"
  })[character]);
}
