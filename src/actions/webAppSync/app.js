(function () {
  const actions = window.FutbinSyncActions = window.FutbinSyncActions || {};
  let logSequence = 0;
  let logQueue = Promise.resolve();
  let toastQueue = Promise.resolve();
  let apiLoaderSequence = 0;
  const apiLoaderTokens = new Set();

  window.FutbinSyncWebAppLog = function (step, message, details) {
    if (!isEaPage() || !chrome?.runtime?.sendMessage) return Promise.resolve();
    logSequence += 1;
    const payload = {
      type: "WEB_APP_SYNC_LOG",
      sequence: logSequence,
      step,
      message,
      details: details === undefined ? null : details,
      pageUrl: location.href,
      requestedAt: Date.now()
    };
    if (shouldShowWebAppToast(step, message, details)) {
      enqueueWebAppToast(step, message, details);
    }
    logQueue = logQueue
      .then(() => chrome.runtime.sendMessage(payload))
      .catch(() => {});
    return logQueue;
  };

  window.FutbinSyncWebAppApiLoader = {
    show(message = "API isteği gönderiliyor...", details = null) {
      const token = ++apiLoaderSequence;
      apiLoaderTokens.add(token);
      renderApiLoader(message, details);
      return token;
    },
    hide(token) {
      if (token != null) apiLoaderTokens.delete(token);
      if (apiLoaderTokens.size === 0) hideApiLoader();
    },
    async wrap(message, task, details = null) {
      const token = this.show(message, details);
      try {
        return await task();
      } finally {
        this.hide(token);
      }
    }
  };

  if (isEaPage()) {
    window.FutbinSyncWebAppLog("INIT", "Web App Sync action dosyası yüklendi.", {
      url: location.href,
      readyState: document.readyState
    });
  }

  actions["web-app-sync"] = {
    defaultTitle: "Web App Sync",
    logTitle: "WEB APP SYNC LOGS",
    statLabel: "Web App",
    hasSyncContent: true,
    stateForView: (state) => state.runs?.["web-app-sync"] || state,
    jobMatches: (job) => job?.operation === "web-app-sync",
    entryMatches: (entry) => entry?.runnerId === "web-app-sync" || entry?.job?.operation === "web-app-sync",
    saveResultMatches: (key) => String(key).startsWith("web-app-sync"),
    currentPlayers(state) {
      const snapshot = state.currentPlayers?.["web-app-sync"];
      return (Number(snapshot?.raritySync?.savedCount) || 0) +
        (Number(snapshot?.sbcSync?.savedCount) || 0);
    },
    skippedCount(state) {
      return Object.entries(state.clubSaveResults || {})
        .filter(([key]) => this.saveResultMatches(key))
        .reduce((total, [, result]) => total + (Number(result?.skipped) || 0), 0);
    },
    currentJobLabel({ activeJob, viewState, currentJobNumber, totalJobs }) {
      if (activeJob) return activeJob.label || "EA Web App";
      if (!viewState.running || !totalJobs) return "İş bekleniyor";
      return currentJobNumber >= totalJobs ? "Bu sekme tamamlandı" : "Sırada bekliyor";
    },
    renderRecords({ records, errors, state, elements, helpers }) {
      const webAppRecords = records.filter((record) => this.entryMatches(record));
      const webAppErrors = errors.filter((entry) => this.entryMatches(entry));
      elements.records.innerHTML = helpers.renderCycleGroups(webAppRecords, webAppErrors, state, (cycleRecords, cycleErrors) =>
        renderWebAppRecords(cycleRecords, cycleErrors, helpers)) ||
        '<div class="empty">Bu sekmede henüz Web App Sync verisi yok.</div>';
    },
    modalHandler: createEaModalHandler()
  };

  if (isEaPage()) {
    window.FutbinSyncWebAppLog("MODAL", "EA sayfası algılandı; modal watcher başlatılıyor.");
    startEaModalMonitoring(actions["web-app-sync"].modalHandler);
  }

  function createEaModalHandler() {
    const lastClickAt = new WeakMap();
    let monitoring = false;

    return {
      modals: [
        {
          name: "livemessage",
          buttonSelector: ".view-modal-container.form-modal .ut-livemessage-footer > button:nth-child(2)"
        },
        {
          name: "ea-alert",
          containerSelector: ".view-modal-container.form-modal .ea-dialog-view-type--alert",
          buttonSelector: ".ut-st-button-group button, button.btn-standard"
        }
      ],
      async monitorModals() {
        if (monitoring) return;
        monitoring = true;
        try {
          let detectedButtonCount = 0;
          for (const modal of this.modals) {
            const buttons = findModalButtons(modal);
            detectedButtonCount += buttons.length;
            for (const button of buttons) {
              if (!isSafeModalButton(button, modal)) continue;
              if (Date.now() - (lastClickAt.get(button) || 0) < 1500) continue;
              lastClickAt.set(button, Date.now());
              window.FutbinSyncWebAppLog("MODAL", `"${modal.name}" modalı kapatılıyor.`, {
                buttonText: normalizeModalText(button.textContent),
                buttonClass: button.className
              });
              await clickModalButton(button);
            }
          }
          if (detectedButtonCount) {
            window.FutbinSyncWebAppLog("MODAL", "Modal taraması tamamlandı.", {
              detectedButtonCount
            });
          }
        } finally {
          monitoring = false;
        }
      },
      startMonitoring() {
        if (this.observer || !document.body) return;

        this.observer = new MutationObserver(() => {
          this.monitorModals();
        });
        this.observer.observe(document.body, {
          childList: true,
          subtree: true
        });
        this.intervalId = window.setInterval(() => {
          this.monitorModals();
        }, 500);
        this.monitorModals();
        window.FutbinSyncWebAppLog("MODAL", "Modal izleme aktif.", {
          observer: "MutationObserver",
          fallbackIntervalMs: 500,
          registeredModals: this.modals.map((modal) => modal.name)
        });
      },
      stopMonitoring() {
        this.observer?.disconnect();
        this.observer = null;
        if (this.intervalId) window.clearInterval(this.intervalId);
        this.intervalId = null;
        window.FutbinSyncWebAppLog("MODAL", "Modal izleme durduruldu.");
      }
    };
  }

  function startEaModalMonitoring(handler) {
    const start = () => handler.startMonitoring();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  function findModalButtons(modal) {
    if (!modal.containerSelector) {
      return [...document.querySelectorAll(modal.buttonSelector)];
    }
    return [...document.querySelectorAll(modal.containerSelector)]
      .flatMap((container) => [...container.querySelectorAll(modal.buttonSelector)]);
  }

  function isSafeModalButton(button, modal) {
    if (!button || button.disabled || button.offsetParent === null) return false;
    if (modal.name === "livemessage") return true;

    const container = button.closest(".ea-dialog-view-type--alert");
    if (!container) return false;
    const buttons = [...container.querySelectorAll("button")].filter((item) => !item.disabled);
    const text = normalizeModalText(button.textContent);
    const safeLabels = ["ok", "okay", "tamam", "continue", "devam", "close", "kapat"];
    return buttons.length === 1 || safeLabels.includes(text);
  }

  async function clickModalButton(button) {
    window.FutbinSyncWebAppLog("MODAL", "Modal butonu tıklama eventleri gönderiliyor.");
    button.scrollIntoView({ block: "center", inline: "nearest" });
    button.focus();
    for (const eventName of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      button.dispatchEvent(new MouseEvent(eventName, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0
      }));
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    window.FutbinSyncWebAppLog("MODAL", "Modal butonu tıklama işlemi tamamlandı.");
  }

  function normalizeModalText(value) {
    return String(value || "").trim().toLocaleLowerCase("tr-TR").replace(/\s+/g, " ");
  }

  function isEaPage() {
    return location.hostname === "signin.ea.com" ||
      (location.hostname === "www.ea.com" && location.pathname.includes("/ultimate-team/web-app"));
  }

  function shouldShowWebAppToast(step, message, details) {
    return Boolean(step || message || details);
  }

  function enqueueWebAppToast(step, message, details) {
    toastQueue = toastQueue
      .then(() => showWebAppToast(step, message, details))
      .catch(() => {});
  }

  function showWebAppToast(step, message, details) {
    return new Promise((resolve) => {
      const container = ensureWebAppToastContainer();
      const toast = document.createElement("div");
      const type = getWebAppToastType(step, message, details);
      toast.className = `futbin-sync-webapp-toast ${type}`;
      toast.innerHTML = `
        <div class="futbin-sync-webapp-toast-step">${escapeToastHtml(step || "LOG")}</div>
        <div class="futbin-sync-webapp-toast-message">${escapeToastHtml(message || "")}</div>
        ${renderToastDetails(details)}
      `;
      container.appendChild(toast);

      requestAnimationFrame(() => {
        toast.classList.add("show");
      });

      const visibleMs = getWebAppToastDuration(type, step);
      window.setTimeout(() => {
        toast.classList.remove("show");
        window.setTimeout(() => {
          toast.remove();
          resolve();
        }, 260);
      }, visibleMs);
    });
  }

  function ensureWebAppToastContainer() {
    const id = "futbin-sync-webapp-toast-container";
    let container = document.getElementById(id);
    if (container) return container;

    injectWebAppToastStyle();
    container = document.createElement("div");
    container.id = id;
    document.documentElement.appendChild(container);
    return container;
  }

  function injectWebAppToastStyle() {
    const id = "futbin-sync-webapp-toast-style";
    if (document.getElementById(id)) return;

    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      #futbin-sync-webapp-toast-container {
        position: fixed;
        top: 24px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        width: min(560px, calc(100vw - 32px));
        pointer-events: none;
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .futbin-sync-webapp-toast {
        width: 100%;
        box-sizing: border-box;
        padding: 13px 16px;
        border-radius: 14px;
        border: 1px solid rgba(255, 255, 255, 0.16);
        color: #f8fafc;
        background: rgba(15, 23, 42, 0.96);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.36);
        backdrop-filter: blur(10px);
        opacity: 0;
        transform: translateY(-14px) scale(0.98);
        transition: opacity 220ms ease, transform 220ms ease;
      }

      .futbin-sync-webapp-toast.show {
        opacity: 1;
        transform: translateY(0) scale(1);
      }

      .futbin-sync-webapp-toast.success {
        border-color: rgba(34, 197, 94, 0.55);
        background: linear-gradient(135deg, rgba(20, 83, 45, 0.98), rgba(15, 23, 42, 0.96));
      }

      .futbin-sync-webapp-toast.warning {
        border-color: rgba(245, 158, 11, 0.6);
        background: linear-gradient(135deg, rgba(120, 53, 15, 0.98), rgba(15, 23, 42, 0.96));
      }

      .futbin-sync-webapp-toast.error {
        border-color: rgba(248, 113, 113, 0.7);
        background: linear-gradient(135deg, rgba(127, 29, 29, 0.98), rgba(15, 23, 42, 0.96));
      }

      .futbin-sync-webapp-toast-step {
        margin-bottom: 4px;
        font-size: 11px;
        line-height: 1.2;
        letter-spacing: 0.08em;
        font-weight: 800;
        color: rgba(226, 232, 240, 0.78);
        text-transform: uppercase;
      }

      .futbin-sync-webapp-toast-message {
        font-size: 14px;
        line-height: 1.35;
        font-weight: 700;
      }

      .futbin-sync-webapp-toast-details {
        margin-top: 7px;
        font-size: 12px;
        line-height: 1.35;
        color: rgba(226, 232, 240, 0.78);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function renderApiLoader(message, details) {
    injectWebAppApiLoaderStyle();
    const loader = ensureWebAppApiLoaderElement();
    loader.querySelector(".futbin-sync-api-loader-message").textContent = message || "API isteği gönderiliyor...";
    loader.querySelector(".futbin-sync-api-loader-count").textContent = String(apiLoaderTokens.size);
    const endpoint = details?.endpoint ? `${details.method || "API"} ${details.endpoint}` : "";
    loader.querySelector(".futbin-sync-api-loader-endpoint").textContent = endpoint;
    loader.classList.add("show");
  }

  function hideApiLoader() {
    const loader = document.getElementById("futbin-sync-api-loader");
    if (!loader) return;
    loader.classList.remove("show");
  }

  function ensureWebAppApiLoaderElement() {
    let loader = document.getElementById("futbin-sync-api-loader");
    if (loader) return loader;

    loader = document.createElement("div");
    loader.id = "futbin-sync-api-loader";
    loader.innerHTML = `
      <div class="futbin-sync-api-loader-panel">
        <div class="futbin-sync-api-loader-spinner" aria-hidden="true"></div>
        <div class="futbin-sync-api-loader-copy">
          <div class="futbin-sync-api-loader-title">FutbinSync API</div>
          <div class="futbin-sync-api-loader-message">API isteği gönderiliyor...</div>
          <div class="futbin-sync-api-loader-endpoint"></div>
        </div>
        <div class="futbin-sync-api-loader-count">1</div>
      </div>
    `;
    document.documentElement.appendChild(loader);
    return loader;
  }

  function injectWebAppApiLoaderStyle() {
    const id = "futbin-sync-api-loader-style";
    if (document.getElementById(id)) return;

    const style = document.createElement("style");
    style.id = id;
    style.textContent = `
      #futbin-sync-api-loader {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        padding: 24px;
        background: rgba(2, 6, 23, 0.58);
        backdrop-filter: blur(2px);
        opacity: 0;
        pointer-events: none;
        transition: opacity 180ms ease;
      }

      #futbin-sync-api-loader.show {
        opacity: 1;
        pointer-events: auto;
      }

      .futbin-sync-api-loader-panel {
        display: flex;
        align-items: center;
        gap: 12px;
        width: min(390px, calc(100vw - 32px));
        box-sizing: border-box;
        padding: 16px 17px;
        border-radius: 12px;
        border: 1px solid rgba(94, 234, 212, 0.34);
        color: #f8fafc;
        background: rgba(10, 18, 30, 0.96);
        box-shadow: 0 18px 48px rgba(0, 0, 0, 0.38);
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        transform: translateY(12px) scale(0.98);
        transition: transform 180ms ease;
      }

      #futbin-sync-api-loader.show .futbin-sync-api-loader-panel {
        transform: translateY(0) scale(1);
      }

      .futbin-sync-api-loader-spinner {
        width: 30px;
        height: 30px;
        flex: 0 0 auto;
        border-radius: 999px;
        border: 3px solid rgba(148, 163, 184, 0.28);
        border-top-color: #5eead4;
        border-right-color: #60a5fa;
        animation: futbin-sync-api-spin 780ms linear infinite;
      }

      .futbin-sync-api-loader-copy {
        min-width: 0;
        flex: 1;
      }

      .futbin-sync-api-loader-title {
        font-size: 11px;
        line-height: 1.2;
        font-weight: 800;
        color: rgba(226, 232, 240, 0.72);
        text-transform: uppercase;
      }

      .futbin-sync-api-loader-message {
        margin-top: 2px;
        font-size: 13px;
        line-height: 1.3;
        font-weight: 750;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .futbin-sync-api-loader-endpoint {
        margin-top: 3px;
        font-size: 11px;
        line-height: 1.25;
        color: rgba(203, 213, 225, 0.72);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .futbin-sync-api-loader-count {
        min-width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 999px;
        background: rgba(96, 165, 250, 0.18);
        color: #bfdbfe;
        font-size: 12px;
        font-weight: 800;
      }

      @keyframes futbin-sync-api-spin {
        to { transform: rotate(360deg); }
      }
    `;
    document.documentElement.appendChild(style);
  }

  function getWebAppToastType(step, message, details) {
    const source = `${step || ""} ${message || ""} ${details?.message || ""} ${details?.error || ""}`.toLocaleLowerCase("tr-TR");
    if (source.includes("[critical]") ||
      source.includes("hata") ||
      source.includes("başarısız") ||
      source.includes("bulunamadı") ||
      source.includes("timeout")) {
      return "error";
    }
    if (source.includes("atlandı") || source.includes("yok")) return "warning";
    if (source.includes("başarı") ||
      source.includes("tamamlandı") ||
      source.includes("bulundu") ||
      source.includes("kaydedildi") ||
      source.includes("post edildi")) {
      return "success";
    }
    return "info";
  }

  function getWebAppToastDuration(type, step) {
    if (type === "error") return 5200;
    const normalizedStep = String(step || "").toUpperCase();
    if (normalizedStep === "WAIT" || normalizedStep === "CLICK" || normalizedStep === "INPUT") return 1200;
    if (normalizedStep === "RARITY_FOUND") return 2200;
    if (type === "success" || type === "warning") return 1800;
    return 1400;
  }

  function renderToastDetails(details) {
    if (!details || typeof details !== "object") return "";
    const detailParts = [];
    if (details.selector) detailParts.push(`Selector: ${details.selector}`);
    if (details.text) detailParts.push(`Text: ${details.text}`);
    if (details.url) detailParts.push(`URL: ${details.url}`);
    if (details.language || details.lang) detailParts.push(`Dil: ${details.language || details.lang}`);
    if (details.targetLanguage) detailParts.push(`Hedef dil: ${details.targetLanguage}`);
    if (Number.isFinite(Number(details.optionCount))) detailParts.push(`Seçenek: ${Number(details.optionCount)}`);
    if (Number.isFinite(Number(details.savedCount))) detailParts.push(`Yeni: ${Number(details.savedCount)}`);
    if (Number.isFinite(Number(details.skippedExisting))) detailParts.push(`Mevcut: ${Number(details.skippedExisting)}`);
    if (Number.isFinite(Number(details.elapsedMs))) detailParts.push(`Süre: ${Number(details.elapsedMs)} ms`);
    if (Number.isFinite(Number(details.timeout))) detailParts.push(`Timeout: ${Number(details.timeout)} ms`);
    if (details.name) detailParts.push(`Ad: ${details.name}`);
    if (details.message) detailParts.push(`Mesaj: ${details.message}`);
    if (!detailParts.length) return "";
    return `<div class="futbin-sync-webapp-toast-details">${escapeToastHtml(detailParts.join(" · "))}</div>`;
  }

  function escapeToastHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function renderWebAppRecords(records, errors = [], helpers) {
    const rows = [
      renderWebAppHeader(),
      ...errors.map((entry) => helpers.renderErrorRecord(entry)),
      ...records.map((record) => renderWebAppRecord(record, helpers))
    ];
    return `<div class="sync-player-group web-app-sync-group">${rows.join("")}</div>`;
  }

  function renderWebAppHeader() {
    return `<div class="club-player-header sync-header web-app-sync-header">
      <span>LANG</span><span>RARITY</span><span>SBC</span><span>SKIPPED</span><span>POST</span>
    </div>`;
  }

  function renderWebAppRecord(record, helpers) {
    const snapshot = record.player || {};
    const raritySync = snapshot.raritySync || {};
    const sbcSync = snapshot.sbcSync || {};
    const activeLangs = String(raritySync.lang || "en").split(",").map((lang) => lang.trim()).filter(Boolean);
    const rarityNames = (Array.isArray(raritySync.rarities) ? raritySync.rarities : [])
      .map((rarity) => {
        const name = rarity?.name && typeof rarity.name === "object" ? rarity.name : {};
        return activeLangs.map((lang) => name[lang]).find(Boolean) || Object.values(name).find(Boolean);
      })
      .filter(Boolean)
      .join(", ") || "Yeni kayıt yok";
    const skipped = (Number(raritySync.skippedExisting) || 0) +
      (Number(raritySync.skippedPlaceholder) || 0) +
      (Number(sbcSync.skippedCount) || 0);
    const sbcText = `${Number(sbcSync.savedCount) || 0}/${Number(sbcSync.tileCount) || 0}`;
    const postText = record.saveStatus || "okundu";

    return `<article class="player-data-row sync-row web-app-sync-row" title="${helpers.escapeHtml(snapshot.sourceUrl || "")}">
      ${helpers.cell(sbcSync.lang || raritySync.lang || snapshot.loadedElement?.text || "en", "position-cell")}
      ${helpers.cell(rarityNames, "player-cell")}
      ${helpers.cell(sbcText, "rating-cell")}
      ${helpers.cell(skipped, "league-cell")}
      ${helpers.cell(postText, "club-cell")}
    </article>`;
  }
})();
