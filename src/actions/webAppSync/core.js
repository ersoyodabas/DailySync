let webAppCollectionInProgress = false;
const WEB_APP_RARITY_PHASE_KEY = "webAppRaritySyncPhase";
const WEB_APP_FLOW_STATE_KEY = "webAppSyncFlowState";
const WEB_APP_LANGUAGE_CONFIG = {
  en: {
    label: "EN",
    settingsText: "settings",
    optionText: "English",
    languageName: "İngilizce"
  },
  tr: {
    label: "TR",
    settingsText: "ayarlar",
    optionText: "Türkçe",
    languageName: "Türkçe"
  }
};
const webAppLog = (step, message, details) => {
  if (typeof window.FutbinSyncWebAppLog === "function") {
    return window.FutbinSyncWebAppLog(step, message, details);
  }
  return Promise.resolve();
};

const WEB_APP_SELECTORS = {
  loaded: "body > main > section > nav > button.ut-tab-bar-item.icon-settings",
  loginButton: "#Login > div.ut-content > div > button.btn-standard.primary",
  emailInput: "#email",
  passwordInput: "#password",
  loginNextButton: "#logInBtn",
  authenticated: [
    "body > main > section > nav > button.ut-tab-bar-item.icon-settings"
  ],
  loginButtons: [
    "a[href*='signin']",
    "a[href*='login']",
    "button",
    "[role='button']"
  ],
  languageButtons: [
    "[data-language]",
    "[data-locale]",
    "button",
    "[role='button']"
  ],
  navigationTargets: [
    { key: "club", labels: ["Club", "Kulüp"] },
    { key: "squad", labels: ["Squad", "Kadro"] },
    { key: "transfers", labels: ["Transfers", "Transferler"] }
  ],
  sampleRows: [
    ".ut-player-card",
    ".ut-item-card",
    ".listFUTItem",
    "[class*='player'][class*='card']"
  ]
};

window.FutbinSyncWebAppCore = {
  ensureHomePageLanguage,
  findVisibleElement,
  futClick,
  getLoadedSettingsState,
  isElementVisible,
  normalize,
  sleep,
  waitForVisibleElement,
  webAppLog
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "COLLECT_SYNC_PAGE" || message.operation !== "web-app-sync") return;
  webAppLog("MESSAGE", "COLLECT_SYNC_PAGE mesajı alındı.", {
    page: message.page,
    operation: message.operation,
    url: location.href
  });
  if (webAppCollectionInProgress) {
    webAppLog("MESSAGE", "Devam eden Web App Sync olduğu için yinelenen mesaj atlandı.");
    sendResponse({ ok: true, duplicate: true });
    return;
  }
  webAppCollectionInProgress = true;
  runWebAppSync(message).finally(() => {
    webAppCollectionInProgress = false;
    webAppLog("FLOW", "Web App Sync çalışma kilidi kaldırıldı.");
  });
  sendResponse({ ok: true });
});

async function runWebAppSync(message) {
  try {
    await webAppLog("FLOW", "Web App Sync işlemi başladı.");
    await waitForDocumentReady();
    webAppLog("FLOW", "Document hazır.", { readyState: document.readyState });
    let loadedButton = await ensureSignedIn();
    await webAppLog("LOGIN", "Login kontrolü tamamlandı; Home Page yüklendi.");
    loadedButton = await ensureInitialEnglishHomePageIfNeeded(loadedButton, message);
    const raritySyncModule = window.FutbinSyncWebAppModules?.syncRarity;
    if (typeof raritySyncModule !== "function") {
      throw new Error("[CRITICAL] sync_rarity modülü yüklenmedi.");
    }
    const sbcSyncModule = window.FutbinSyncWebAppModules?.syncSbc;
    if (typeof sbcSyncModule !== "function") {
      throw new Error("[CRITICAL] sync_sbc modülü yüklenmedi.");
    }
    const syncFlow = await runWebAppLanguageSyncFlow(loadedButton, raritySyncModule, sbcSyncModule, message);
    loadedButton = syncFlow.loadedButton || loadedButton;
    const raritySync = syncFlow.raritySync;
    const sbcSync = syncFlow.sbcSync;
    await clearWebAppFlowState();
    await clearRarityPhaseState();
    const loadedState = getLoadedSettingsState();
    const loadedText = loadedState?.text || normalize(loadedButton?.innerText || loadedButton?.textContent).toLowerCase();
    await webAppLog("COMPLETE", `Web App Sync tamamlandı. Rarity kayıt: ${raritySync.savedCount}, SBC kayıt: ${sbcSync.savedCount}.`, {
      selector: WEB_APP_SELECTORS.loaded,
      text: loadedText,
      languages: raritySync.lang,
      rarityCount: raritySync.rarities.length,
      savedCount: raritySync.savedCount,
      scannedCount: raritySync.optionCount,
      skippedExisting: raritySync.skippedExisting,
      skippedPlaceholder: raritySync.skippedPlaceholder,
      sbcSync
    });
    window.FutbinSyncActions?.["web-app-sync"]?.modalHandler?.stopMonitoring();

    await webAppLog("RESULT", "Durdurma/tamamlanma sonucu background servisine gönderiliyor.");
    await chrome.runtime.sendMessage({
      type: "WEB_APP_SYNC_COMPLETE",
      page: Number(message.page) || 1,
      pageUrl: location.href,
      webAppSync: {
        capturedAt: Date.now(),
        sourceUrl: location.href,
        session: readSessionSummary(),
        loadedElement: {
          selector: WEB_APP_SELECTORS.loaded,
          text: loadedText
        },
        raritySync,
        sbcSync,
        locales: []
      },
      reason: "web-app-sync-complete"
    });
    await webAppLog("RESULT", "Web App Sync işlemlerinin tamamı başarıyla tamamlandı.");
  } catch (error) {
    await webAppLog("ERROR", "Web App Sync kritik hata ile sonlandı.", {
      message: error.message || String(error),
      stack: error.stack
    });
    await chrome.runtime.sendMessage({
      type: "SYNC_PAGE_CRITICAL",
      page: Number(message.page) || 1,
      pageUrl: location.href,
      error: error.message?.includes("[CRITICAL]") ? error.message : `[CRITICAL] ${error.message || error}`
    }).catch(() => {});
  }
}

async function runWebAppLanguageSyncFlow(initialLoadedButton, raritySyncModule, sbcSyncModule, message) {
  const runStartedAt = Number(message?.runStartedAt) || null;
  const flowState = await loadWebAppFlowState(runStartedAt) || {};
  let loadedButton = initialLoadedButton;
  const rarityResults = { ...(flowState.rarityResults || flowState.raritySync?.phases || {}) };
  const sbcResults = { ...(flowState.sbcResults || flowState.sbcSync?.phases || {}) };

  if (!rarityResults.en) {
    await saveWebAppFlowState({
      runStartedAt,
      stage: "en_rarity_ready",
      rarityResults,
      sbcResults
    });
    loadedButton = await ensureHomePageLanguage(loadedButton, "en");
    loadedButton = await waitForHomePageReadyForRarity("en");
    await saveWebAppFlowState({
      runStartedAt,
      stage: "en_rarity_running",
      rarityResults,
      sbcResults
    });
    await webAppLog("RARITY_FLOW", "EN Home Page hazır. EN rarity sync başlıyor.");
    rarityResults.en = await raritySyncModule("en");
    await saveWebAppFlowState({
      runStartedAt,
      stage: "en_rarity_completed",
      rarityResults,
      sbcResults
    });
    await webAppLog("RARITY_FLOW", "EN rarity sync tamamlandı.", summarizeRarityResult(rarityResults.en));
  } else {
    await webAppLog("RARITY_FLOW", "EN rarity sync bu run içinde zaten tamamlanmış; tekrar çalıştırılmadı.", summarizeRarityResult(rarityResults.en));
  }

  if (!sbcResults.en) {
    await saveWebAppFlowState({
      runStartedAt,
      stage: "en_sbc_ready",
      rarityResults,
      sbcResults
    });
    loadedButton = await ensureHomePageLanguage(loadedButton, "en");
    loadedButton = await waitForHomePageReadyForSbc("en");
    await saveWebAppFlowState({
      runStartedAt,
      stage: "en_sbc_running",
      rarityResults,
      sbcResults
    });
    await webAppLog("SBC_FLOW", "EN Home Page hazır. EN SBC sync başlıyor.");
    sbcResults.en = await sbcSyncModule("en");
    await saveWebAppFlowState({
      runStartedAt,
      stage: "en_sbc_completed",
      rarityResults,
      sbcResults
    });
    await webAppLog("SBC_FLOW", "EN SBC sync tamamlandı.", summarizeSbcResult(sbcResults.en));
  } else {
    await webAppLog("SBC_FLOW", "EN SBC sync bu run içinde zaten tamamlanmış; tekrar çalıştırılmadı.", summarizeSbcResult(sbcResults.en));
  }

  const enNewRarityCount = Number(rarityResults.en?.savedCount) || 0;
  const enNewSbcCount = Number(sbcResults.en?.insertedCount) || 0;
  const shouldRunTurkish = enNewRarityCount > 0 || enNewSbcCount > 0;

  if (!shouldRunTurkish) {
    await webAppLog("FLOW", "EN rarity ve EN SBC tarafında yeni kayıt yok. TR diline geçilmeyecek; Web App Sync tamamlanacak.", {
      enNewRarityCount,
      enNewSbcCount,
      currentSettingsText: getLoadedSettingsState()?.text || null
    });
    return {
      loadedButton,
      raritySync: combineRarityResults(rarityResults),
      sbcSync: combineSbcResults(sbcResults)
    };
  }

  await webAppLog("FLOW", "EN tarafında yeni kayıt algılandı. TR diline geçilip rarity ve SBC sync tekrar çalıştırılacak.", {
    enNewRarityCount,
    enNewSbcCount
  });

  if (!rarityResults.tr) {
    await saveWebAppFlowState({
      runStartedAt,
      stage: "tr_rarity_ready",
      rarityResults,
      sbcResults
    });
    loadedButton = await ensureHomePageLanguage(loadedButton, "tr");
    loadedButton = await waitForHomePageReadyForRarity("tr");
    await saveWebAppFlowState({
      runStartedAt,
      stage: "tr_rarity_running",
      rarityResults,
      sbcResults
    });
    await webAppLog("RARITY_FLOW", "TR Home Page hazır. TR rarity sync başlıyor.");
    rarityResults.tr = await raritySyncModule("tr");
    await saveWebAppFlowState({
      runStartedAt,
      stage: "tr_rarity_completed",
      rarityResults,
      sbcResults
    });
    await webAppLog("RARITY_FLOW", "TR rarity sync tamamlandı.", summarizeRarityResult(rarityResults.tr));
  } else {
    await webAppLog("RARITY_FLOW", "TR rarity sync bu run içinde zaten tamamlanmış; tekrar çalıştırılmadı.", summarizeRarityResult(rarityResults.tr));
  }

  if (!sbcResults.tr) {
    await saveWebAppFlowState({
      runStartedAt,
      stage: "tr_sbc_ready",
      rarityResults,
      sbcResults
    });
    loadedButton = await ensureHomePageLanguage(loadedButton, "tr");
    loadedButton = await waitForHomePageReadyForSbc("tr");
    await saveWebAppFlowState({
      runStartedAt,
      stage: "tr_sbc_running",
      rarityResults,
      sbcResults
    });
    await webAppLog("SBC_FLOW", "TR Home Page hazır. TR SBC sync başlıyor.");
    sbcResults.tr = await sbcSyncModule("tr");
    await saveWebAppFlowState({
      runStartedAt,
      stage: "tr_sbc_completed",
      rarityResults,
      sbcResults
    });
    await webAppLog("SBC_FLOW", "TR SBC sync tamamlandı.", summarizeSbcResult(sbcResults.tr));
  } else {
    await webAppLog("SBC_FLOW", "TR SBC sync bu run içinde zaten tamamlanmış; tekrar çalıştırılmadı.", summarizeSbcResult(sbcResults.tr));
  }

  return {
    loadedButton,
    raritySync: combineRarityResults(rarityResults),
    sbcSync: combineSbcResults(sbcResults)
  };
}

async function ensureInitialEnglishHomePageIfNeeded(loadedButton, message) {
  let loadedState = getLoadedSettingsState();
  if (!loadedState && loadedButton) {
    const buttonText = normalize(loadedButton.innerText || loadedButton.textContent).toLowerCase();
    if (buttonText === "settings" || buttonText === "ayarlar") {
      loadedState = {
        state: "loaded",
        selector: WEB_APP_SELECTORS.loaded,
        element: loadedButton,
        text: buttonText
      };
    }
  }
  if (!loadedState) return loadedButton;

  const runStartedAt = Number(message?.runStartedAt) || null;
  const phaseState = await loadRarityPhaseState();
  const flowState = await loadWebAppFlowState(runStartedAt);
  const isSameRunPhase = Boolean(
    phaseState &&
    runStartedAt &&
    Number(phaseState.runStartedAt) === runStartedAt
  );
  const isTurkishRarityPhaseResume = Boolean(
    isSameRunPhase &&
    phaseState.phase === "tr" &&
    phaseState.results?.en
  );
  const isTurkishFlowResume = Boolean(
    flowState &&
    runStartedAt &&
    Number(flowState.runStartedAt) === runStartedAt &&
    String(flowState.stage || "").startsWith("tr_")
  );

  await webAppLog("LANGUAGE", "İlk Home Page dil durumu kontrol ediliyor.", {
    selector: WEB_APP_SELECTORS.loaded,
    text: loadedState.text,
    runStartedAt,
    storedPhase: phaseState?.phase || null,
    storedFlowStage: flowState?.stage || null,
    sameRunPhase: isSameRunPhase,
    turkishRarityPhaseResume: isTurkishRarityPhaseResume,
    turkishFlowResume: isTurkishFlowResume
  });

  if (loadedState.text !== "ayarlar") {
    await webAppLog("LANGUAGE", "İlk Home Page İngilizce algılandı; başlangıç dil değişikliği gerekmiyor.", {
      text: loadedState.text
    });
    return loadedState.element;
  }

  if (isTurkishRarityPhaseResume) {
    await webAppLog("LANGUAGE", "Türkçe Home Page, EN rarity sonrası TR fazı olarak algılandı; tekrar İngilizceye çevrilmeyecek.", {
      storedPhase: phaseState.phase,
      enPhaseCompleted: true
    });
    return loadedState.element;
  }

  if (isTurkishFlowResume) {
    await webAppLog("LANGUAGE", "Türkçe Home Page, Web App Sync TR fazı olarak algılandı; tekrar İngilizceye çevrilmeyecek.", {
      storedFlowStage: flowState.stage
    });
    return loadedState.element;
  }

  await webAppLog("LANGUAGE", "İlk Home Page Türkçe açıldı. EN rarity sync öncesi İngilizce dile geçiliyor.", {
    detectedText: loadedState.text,
    targetLanguage: "en"
  });
  await clearRarityPhaseState();
  return ensureHomePageLanguage(loadedState.element, "en");
}

async function ensureHomePageLanguage(loadedButton, targetLang) {
  const targetConfig = WEB_APP_LANGUAGE_CONFIG[targetLang] || WEB_APP_LANGUAGE_CONFIG.en;
  let loadedState = getLoadedSettingsState();
  if (!loadedState && loadedButton) {
    const buttonText = normalize(loadedButton.innerText || loadedButton.textContent).toLowerCase();
    if (buttonText === "settings" || buttonText === "ayarlar") {
      loadedState = {
        state: "loaded",
        selector: WEB_APP_SELECTORS.loaded,
        element: loadedButton,
        text: buttonText
      };
    }
  }
  if (!loadedState) {
    const freshButton = await waitForWebAppLoaded(120000);
    loadedState = getLoadedSettingsState() || {
      state: "loaded",
      selector: WEB_APP_SELECTORS.loaded,
      element: freshButton,
      text: normalize(freshButton?.innerText || freshButton?.textContent).toLowerCase()
    };
  }

  const currentText = loadedState.text;
  webAppLog("LANGUAGE", "Home Page dili Settings elementi üzerinden kontrol ediliyor.", {
    selector: WEB_APP_SELECTORS.loaded,
    text: currentText,
    targetLanguage: targetLang
  });

  if (currentText === targetConfig.settingsText) {
    await webAppLog("LANGUAGE", `${targetConfig.label} dili algılandı. Dil değişikliği gerekmiyor.`, {
      detectedText: currentText,
      language: targetLang
    });
    return loadedState.element;
  }

  if (currentText !== "settings" && currentText !== "ayarlar") {
    throw new Error(`[CRITICAL] Home Page dili tespit edilemedi. Settings elementi metni: ${currentText || "(boş)"}`);
  }

  const detectedLang = currentText === "ayarlar" ? "tr" : "en";
  const detectedConfig = WEB_APP_LANGUAGE_CONFIG[detectedLang];
  await webAppLog("LANGUAGE", `${detectedConfig.label} dili algılandı. ${targetConfig.label} diline geçiliyor.`, {
    detectedText: currentText,
    detectedLanguage: detectedLang,
    targetLanguage: targetLang
  });
  await changeLanguage(loadedState.element, targetLang);
  return waitForHomePageAfterLanguageChange(targetLang);
}

async function changeLanguage(settingsButton, targetLang) {
  const targetConfig = WEB_APP_LANGUAGE_CONFIG[targetLang] || WEB_APP_LANGUAGE_CONFIG.en;
  await webAppLog("LANGUAGE", `${targetConfig.languageName} diline geçmek için Settings/Ayarlar açılıyor.`, {
    targetLanguage: targetLang
  });
  await futClick(settingsButton);

  const settingsActions = await waitForVisibleElement("div.ut-app-settings-actions", 30000);
  if (!settingsActions) {
    throw new Error("[CRITICAL] Dil değişikliği için Settings aksiyon paneli yüklenmedi.");
  }

  const languageButton = findVisibleElement("div.ut-app-settings-actions > div:nth-child(1) > button.more");
  if (!languageButton) {
    throw new Error("[CRITICAL] Dil seçim butonu bulunamadı.");
  }
  await webAppLog("LANGUAGE", "Dil seçim ekranı açılıyor.");
  await futClick(languageButton);

  const languageCell = await waitForLanguageOption(targetConfig.optionText, 30000);
  if (!languageCell) {
    throw new Error(`[CRITICAL] ${targetConfig.optionText} dil seçeneği bulunamadı.`);
  }

  await webAppLog("LANGUAGE", `${targetConfig.optionText} dil seçeneğine tıklanıyor.`, {
    optionText: normalize(languageCell.textContent),
    targetLanguage: targetLang
  });
  await futClick(languageCell);
  await webAppLog("LANGUAGE", `${targetConfig.optionText} seçildi. Home Page'in yeniden yüklenmesi bekleniyor.`);
}

async function waitForLanguageOption(targetText, timeout = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const languageCells = [...document.querySelectorAll(".ut-language-table-cell-view")]
      .filter(isElementVisible);
    const target = languageCells.find((cell) =>
      normalize(cell.querySelector("span")?.textContent || cell.textContent) === targetText);
    if (target) return target;
    await sleep(100);
  }
  return null;
}

async function waitForHomePageAfterLanguageChange(targetLang) {
  const targetConfig = WEB_APP_LANGUAGE_CONFIG[targetLang] || WEB_APP_LANGUAGE_CONFIG.en;
  const timeout = 60000;
  const interval = 1000;
  const startedAt = Date.now();
  let checkCount = 0;

  while (Date.now() - startedAt < timeout) {
    checkCount += 1;
    const loadedState = getLoadedSettingsState();
    if (loadedState?.text === targetConfig.settingsText) {
      await webAppLog("LANGUAGE", `${targetConfig.label} dili algılandı; ${targetConfig.languageName} Home Page yüklendi.`, {
        checkCount,
        elapsedMs: Date.now() - startedAt,
        text: loadedState.text,
        language: targetLang
      });
      return loadedState.element;
    }

    webAppLog("LANGUAGE", `${targetConfig.languageName} Home Page henüz yüklenmedi; yeniden kontrol edilecek.`, {
      checkCount,
      nextCheckInMs: interval,
      detectedText: loadedState?.text || null,
      targetLanguage: targetLang,
      remainingMs: Math.max(0, timeout - (Date.now() - startedAt))
    });
    await sleep(interval);
  }

  throw new Error(`[CRITICAL] Dil değişikliği sonrası ${targetConfig.languageName} Home Page 1 dakika içinde yüklenmedi.`);
}

async function waitForHomePageReadyForRarity(targetLang, timeout = 120000) {
  const targetConfig = WEB_APP_LANGUAGE_CONFIG[targetLang] || WEB_APP_LANGUAGE_CONFIG.en;
  const interval = 1000;
  const settleDelay = 700;
  const startedAt = Date.now();
  let checkCount = 0;

  await webAppLog("RARITY_FLOW", `${targetConfig.label} rarity sync başlamadan önce Home Page hazır olma durumu kontrol ediliyor.`, {
    targetLanguage: targetLang,
    settingsSelector: WEB_APP_SELECTORS.loaded,
    loaderSelector: "body > div.ut-click-shield.showing",
    timeout
  });

  while (Date.now() - startedAt < timeout) {
    checkCount += 1;
    const loadedState = getLoadedSettingsState();

    if (loadedState?.text === targetConfig.settingsText) {
      await sleep(settleDelay);
      const stableLoadedState = getLoadedSettingsState();
      if (stableLoadedState?.text === targetConfig.settingsText) {
        await webAppLog("RARITY_FLOW", `${targetConfig.label} Home Page yüklendi ve stabilize oldu. Rarity sync başlatılabilir.`, {
          checkCount,
          elapsedMs: Date.now() - startedAt,
          settingsText: stableLoadedState.text,
          targetLanguage: targetLang,
          loaderActive: isClickShieldActive()
        });
        return stableLoadedState.element;
      }
    }

    await webAppLog("RARITY_FLOW", `${targetConfig.label} Home Page henüz rarity sync için hazır değil; yeniden kontrol edilecek.`, {
      checkCount,
      nextCheckInMs: interval,
      detectedSettingsText: loadedState?.text || null,
      loaderActive: isClickShieldActive(),
      targetLanguage: targetLang,
      remainingMs: Math.max(0, timeout - (Date.now() - startedAt))
    });
    await sleep(interval);
  }

  throw new Error(`[CRITICAL] ${targetConfig.languageName} Home Page rarity sync için ${Math.round(timeout / 1000)} saniye içinde hazır olmadı.`);
}

async function waitForHomePageReadyForSbc(targetLang, timeout = 120000) {
  const targetConfig = WEB_APP_LANGUAGE_CONFIG[targetLang] || WEB_APP_LANGUAGE_CONFIG.en;
  const interval = 1000;
  const settleDelay = 700;
  const startedAt = Date.now();
  let checkCount = 0;

  await webAppLog("SBC_FLOW", `${targetConfig.label} SBC sync başlamadan önce Home Page hazır olma durumu kontrol ediliyor.`, {
    targetLanguage: targetLang,
    settingsSelector: WEB_APP_SELECTORS.loaded,
    loaderSelector: "body > div.ut-click-shield.showing",
    timeout
  });

  while (Date.now() - startedAt < timeout) {
    checkCount += 1;
    const loadedState = getLoadedSettingsState();

    if (loadedState?.text === targetConfig.settingsText) {
      await sleep(settleDelay);
      const stableLoadedState = getLoadedSettingsState();
      if (stableLoadedState?.text === targetConfig.settingsText) {
        await webAppLog("SBC_FLOW", `${targetConfig.label} Home Page yüklendi ve stabilize oldu. SBC sync başlatılabilir.`, {
          checkCount,
          elapsedMs: Date.now() - startedAt,
          settingsText: stableLoadedState.text,
          targetLanguage: targetLang,
          loaderActive: isClickShieldActive()
        });
        return stableLoadedState.element;
      }
    }

    await webAppLog("SBC_FLOW", `${targetConfig.label} Home Page henüz SBC sync için hazır değil; yeniden kontrol edilecek.`, {
      checkCount,
      nextCheckInMs: interval,
      detectedSettingsText: loadedState?.text || null,
      loaderActive: isClickShieldActive(),
      targetLanguage: targetLang,
      remainingMs: Math.max(0, timeout - (Date.now() - startedAt))
    });
    await sleep(interval);
  }

  throw new Error(`[CRITICAL] ${targetConfig.languageName} Home Page SBC sync için ${Math.round(timeout / 1000)} saniye içinde hazır olmadı.`);
}

async function loadRarityPhaseState() {
  const values = await chrome.storage.local.get([WEB_APP_RARITY_PHASE_KEY]);
  const phaseState = values[WEB_APP_RARITY_PHASE_KEY];
  return phaseState && typeof phaseState === "object" ? phaseState : null;
}

async function saveRarityPhaseState(phaseState) {
  await chrome.storage.local.set({
    [WEB_APP_RARITY_PHASE_KEY]: {
      ...phaseState,
      updatedAt: Date.now()
    }
  });
}

async function clearRarityPhaseState() {
  await chrome.storage.local.remove(WEB_APP_RARITY_PHASE_KEY);
}

async function loadWebAppFlowState(runStartedAt = null) {
  const values = await chrome.storage.local.get([WEB_APP_FLOW_STATE_KEY]);
  const flowState = values[WEB_APP_FLOW_STATE_KEY];
  if (!flowState || typeof flowState !== "object") return null;
  if (runStartedAt && Number(flowState.runStartedAt) !== Number(runStartedAt)) {
    await clearWebAppFlowState();
    return null;
  }
  return flowState;
}

async function saveWebAppFlowState(flowState) {
  await chrome.storage.local.set({
    [WEB_APP_FLOW_STATE_KEY]: {
      ...flowState,
      updatedAt: Date.now()
    }
  });
}

async function clearWebAppFlowState() {
  await chrome.storage.local.remove(WEB_APP_FLOW_STATE_KEY);
}

function summarizeRarityResult(result) {
  return {
    lang: result?.lang || null,
    optionCount: Number(result?.optionCount) || 0,
    savedCount: Number(result?.savedCount) || 0,
    skippedExisting: Number(result?.skippedExisting) || 0,
    skippedPlaceholder: Number(result?.skippedPlaceholder) || 0
  };
}

function combineRarityResults(results) {
  const phases = {
    en: results.en || null,
    tr: results.tr || null
  };
  const completedPhases = Object.values(phases).filter(Boolean);
  const rarities = completedPhases.flatMap((result) => Array.isArray(result.rarities) ? result.rarities : []);
  const completedAt = Math.max(...completedPhases.map((result) => Number(result.completedAt) || 0), Date.now());
  return {
    lang: completedPhases.map((result) => result.lang).filter(Boolean).join(",") || "en,tr",
    dbCount: completedPhases.reduce((sum, result) => sum + (Number(result.dbCount) || 0), 0),
    dbLocalizedCount: completedPhases.reduce((sum, result) => sum + (Number(result.dbLocalizedCount) || 0), 0),
    optionCount: completedPhases.reduce((sum, result) => sum + (Number(result.optionCount) || 0), 0),
    skippedExisting: completedPhases.reduce((sum, result) => sum + (Number(result.skippedExisting) || 0), 0),
    skippedPlaceholder: completedPhases.reduce((sum, result) => sum + (Number(result.skippedPlaceholder) || 0), 0),
    savedCount: completedPhases.reduce((sum, result) => sum + (Number(result.savedCount) || 0), 0),
    rarities,
    apiMessage: completedPhases.map((result) => result.apiMessage).filter(Boolean).join(" | ") || null,
    phases,
    completedAt
  };
}

function summarizeSbcResult(result) {
  return {
    lang: result?.lang || null,
    categoryCount: Number(result?.categoryCount) || 0,
    processedCategoryCount: Number(result?.processedCategoryCount) || 0,
    tileCount: Number(result?.tileCount) || 0,
    savedCount: Number(result?.savedCount) || 0,
    insertedCount: Number(result?.insertedCount) || 0,
    updatedCount: Number(result?.updatedCount) || 0,
    skippedCount: Number(result?.skippedCount) || 0,
    postedCount: Number(result?.postedCount) || 0,
    failedCount: Number(result?.failedCount) || 0
  };
}

function combineSbcResults(results) {
  const phases = {
    en: results.en || null,
    tr: results.tr || null
  };
  const completedPhases = Object.values(phases).filter(Boolean);
  const sum = (field) => completedPhases.reduce((total, result) => total + (Number(result[field]) || 0), 0);
  return {
    lang: completedPhases.map((result) => result.lang).filter(Boolean).join(",") || "en,tr",
    dbCount: sum("dbCount"),
    categoryCount: sum("categoryCount"),
    processedCategoryCount: sum("processedCategoryCount"),
    tileCount: sum("tileCount"),
    savedCount: sum("savedCount"),
    insertedCount: sum("insertedCount"),
    updatedCount: sum("updatedCount"),
    skippedCount: sum("skippedCount"),
    postedCount: sum("postedCount"),
    failedCount: sum("failedCount"),
    deletedCount: sum("deletedCount"),
    tileDeletedCount: sum("tileDeletedCount"),
    updatedSortCount: sum("updatedSortCount"),
    phases,
    completedAt: Math.max(...completedPhases.map((result) => Number(result.completedAt) || 0), Date.now())
  };
}

async function ensureSignedIn() {
  if (isEaJunoLoginPage()) {
    webAppLog("LOGIN", "EA Juno login URL'si algılandı; kimlik bilgisi ekranı doğrudan işlenecek.", {
      url: location.href,
      emailSelector: WEB_APP_SELECTORS.emailInput,
      nextSelector: WEB_APP_SELECTORS.loginNextButton
    });

    const authState = await waitForWebAppAuthState(120000);
    if (!authState) {
      throw new Error("[CRITICAL] EA Juno login sayfasında email veya şifre inputu algılanamadı.");
    }
    webAppLog("LOGIN", "EA Juno login adımı algılandı.", {
      state: authState.state,
      selector: authState.selector
    });
    return completeEaLogin(authState);
  }

  const loadedBeforeEntryCheck = getLoadedSettingsState() || getLoadedSettingsStateLoose();
  if (loadedBeforeEntryCheck) {
    await webAppLog("LOGIN", "Settings/Ayarlar elementi zaten ekranda. Login akışı başlatılmayacak.", {
      text: loadedBeforeEntryCheck.text,
      selector: loadedBeforeEntryCheck.selector,
      detection: loadedBeforeEntryCheck.detection || "visible"
    });
    return loadedBeforeEntryCheck.element;
  }

  webAppLog("LOGIN", "Mevcut oturum veya giriş ekranı birlikte izleniyor.");
  const entryState = await waitForWebAppEntryState(120000);
  if (!entryState) {
    throw new Error("[CRITICAL] Web App yüklenme veya login ekranı algılanamadı.");
  }

  webAppLog("LOGIN", "Web App başlangıç durumu algılandı.", {
    state: entryState.state,
    selector: entryState.selector,
    text: entryState.text || null
  });

  const loadedAfterEntryCheck = getLoadedSettingsState() || getLoadedSettingsStateLoose();
  if (loadedAfterEntryCheck) {
    await webAppLog("LOGIN", "Settings/Ayarlar elementi algılandı. Login butonu tıklanmayacak.", {
      entryState: entryState.state,
      text: loadedAfterEntryCheck.text,
      selector: loadedAfterEntryCheck.selector,
      detection: loadedAfterEntryCheck.detection || "visible"
    });
    return loadedAfterEntryCheck.element;
  }

  if (entryState.state === "loaded") {
    await webAppLog("LOGIN", "Platformda oturum zaten açık. Email ve şifre adımları atlandı.", {
      text: entryState.text
    });
    return entryState.element;
  }

  if (entryState.state === "email" || entryState.state === "password") {
    await webAppLog("LOGIN", "Login ekranı algılandı. Email ve şifre işlemleri başlatılıyor.");
    return completeEaLogin(entryState);
  }

  const loginButton = entryState.element;
  if (!loginButton) {
    webAppLog("LOGIN", "Login butonu bulunamadı; Web App yüklenmesi bekleniyor.");
    return waitForWebAppLoaded();
  }

  const loadedBeforeLoginClick = getLoadedSettingsState() || getLoadedSettingsStateLoose();
  if (loadedBeforeLoginClick) {
    await webAppLog("LOGIN", "Login butonuna tıklamadan hemen önce Settings/Ayarlar görüldü. Tıklama iptal edildi.", {
      text: loadedBeforeLoginClick.text,
      selector: loadedBeforeLoginClick.selector,
      detection: loadedBeforeLoginClick.detection || "visible"
    });
    return loadedBeforeLoginClick.element;
  }

  webAppLog("LOGIN", "EA Web App login butonuna tıklanıyor.");
  await futClick(loginButton);
  webAppLog("LOGIN", "Login butonu sonrası oturum durumu yeniden kontrol ediliyor.");

  const nextState = await waitForWebAppAuthState(120000);
  if (!nextState) {
    throw new Error("[CRITICAL] Login butonu sonrası Settings/Ayarlar veya kimlik bilgisi ekranı algılanamadı.");
  }

  webAppLog("LOGIN", "Login butonu sonrası ekran durumu algılandı.", {
    state: nextState.state,
    selector: nextState.selector,
    text: nextState.text || null
  });

  if (nextState.state === "loaded") {
    await webAppLog("LOGIN", "Mevcut oturum doğrulandı. Email ve şifre adımları atlandı.", {
      text: nextState.text
    });
    return nextState.element;
  }

  return completeEaLogin(nextState);
}

async function collectLanguageSnapshot(language) {
  webAppLog("LOCALE", `${language} dili için snapshot akışı başladı.`);
  await ensureLanguage(language);
  await waitForAppShell();
  const navigation = await visitConfiguredScreens(language);
  const snapshot = {
    language,
    url: location.href,
    capturedAt: Date.now(),
    navigation,
    data: readCurrentScreenData(language)
  };
  webAppLog("LOCALE", `${language} snapshot akışı tamamlandı.`, {
    title: snapshot.data.title,
    rowCount: snapshot.data.rowCount,
    url: snapshot.url
  });
  return snapshot;
}

async function ensureLanguage(language) {
  const currentLanguage = readDocumentLanguage();
  webAppLog("LOCALE", "Sayfa dili kontrol ediliyor.", {
    requestedLanguage: language,
    currentLanguage
  });
  if (currentLanguage.startsWith(language)) {
    webAppLog("LOCALE", "Sayfa zaten istenen dilde.", { language });
    return { changed: false, currentLanguage };
  }

  if (!await tryClickLanguage(language)) {
    webAppLog("LOCALE", "Dil değiştirme kontrolü bulunamadı.", {
      requestedLanguage: language,
      currentLanguage
    });
    return {
      changed: false,
      reason: "language-control-not-found",
      currentLanguage
    };
  }

  webAppLog("LOCALE", "Dil değiştirme kontrolü tıklandı; arayüz bekleniyor.", { language });
  await sleep(1000);
  await waitForAppShell();
  const changedLanguage = readDocumentLanguage();
  webAppLog("LOCALE", "Dil değiştirme adımı tamamlandı.", {
    requestedLanguage: language,
    currentLanguage: changedLanguage
  });
  return { changed: true, currentLanguage: changedLanguage };
}

async function visitConfiguredScreens(language) {
  const visited = [];
  for (const target of WEB_APP_SELECTORS.navigationTargets) {
    webAppLog("NAV", "Navigasyon hedefi aranıyor.", {
      language,
      key: target.key,
      labels: target.labels
    });
    const clicked = await clickByLabels(target.labels);
    if (clicked) {
      webAppLog("NAV", "Navigasyon hedefi tıklandı; ekran bekleniyor.", {
        language,
        key: target.key
      });
      await sleep(1200);
      const result = {
        key: target.key,
        language,
        clicked: true,
        url: location.href,
        title: readVisibleTitle()
      };
      visited.push(result);
      webAppLog("NAV", "Navigasyon hedefi tamamlandı.", result);
    } else {
      const result = {
        key: target.key,
        language,
        clicked: false,
        reason: "navigation-target-not-found"
      };
      visited.push(result);
      webAppLog("NAV", "Navigasyon hedefi bulunamadı.", result);
    }
  }
  return visited;
}

function readCurrentScreenData(language) {
  const rows = WEB_APP_SELECTORS.sampleRows
    .flatMap((selector) => [...document.querySelectorAll(selector)])
    .slice(0, 100)
    .map((node, index) => ({
      index: index + 1,
      text: normalize(node.textContent),
      ariaLabel: normalize(node.getAttribute("aria-label")),
      className: normalize(node.className),
      imageUrl: node.querySelector("img")?.currentSrc || node.querySelector("img")?.src || null
    }))
    .filter((item) => item.text || item.ariaLabel || item.imageUrl);

  return {
    language,
    title: readVisibleTitle(),
    documentLanguage: readDocumentLanguage(),
    url: location.href,
    rows,
    rowCount: rows.length
  };
}

function readSessionSummary() {
  return {
    signedIn: isSignedIn(),
    documentLanguage: readDocumentLanguage(),
    title: document.title,
    url: location.href
  };
}

function isSignedIn() {
  return WEB_APP_SELECTORS.authenticated.some((selector) => document.querySelector(selector)) &&
    !textExists(["Log In", "Sign In", "Giriş Yap", "Oturum Aç"]);
}

async function waitForAppShell() {
  await waitForWebAppLoaded();
}

async function waitForWebAppLoaded(timeout = 180000) {
  webAppLog("LOAD", "Web App Settings/Ayarlar butonu bekleniyor.", {
    selector: WEB_APP_SELECTORS.loaded,
    timeout
  });
  const loaded = await waitForLoadedSettingsButton(timeout);
  if (!loaded) {
    throw new Error(`[CRITICAL] EA Web App henüz loaded olmadı. Beklenen selector/metin: ${WEB_APP_SELECTORS.loaded} (Settings/Ayarlar)`);
  }
  webAppLog("LOAD", "Web App tamamen yüklendi.", {
    selector: WEB_APP_SELECTORS.loaded,
    text: normalize(loaded.textContent),
    url: location.href
  });
  return loaded;
}

async function completeEaLogin(initialState = null) {
  await webAppLog("LOGIN", "EA login işlemi başladı.");

  const loadedBeforeCredentials = getLoadedSettingsState();
  if (loadedBeforeCredentials) {
    webAppLog("LOGIN", "Kimlik bilgileri işlenmeden önce açık oturum algılandı; login adımları atlandı.", {
      text: loadedBeforeCredentials.text
    });
    return loadedBeforeCredentials.element;
  }

  const credentials = await loadWebAppCredentials();
  webAppLog("LOGIN", "Kimlik bilgileri yüklendi.", {
    emailPresent: Boolean(credentials.email),
    passwordPresent: Boolean(credentials.password)
  });

  const loadedAfterCredentials = getLoadedSettingsState();
  if (loadedAfterCredentials) {
    webAppLog("LOGIN", "Kimlik bilgileri yüklenirken açık oturum ekranı geldi; login adımları iptal edildi.", {
      text: loadedAfterCredentials.text
    });
    return loadedAfterCredentials.element;
  }

  if (initialState?.state !== "password") {
    webAppLog("LOGIN", "Email inputu bekleniyor.", { selector: WEB_APP_SELECTORS.emailInput });
    const emailInput = initialState?.state === "email"
      ? initialState.element
      : await waitForVisibleElement(WEB_APP_SELECTORS.emailInput, 120000);
    if (!emailInput) throw new Error(`[CRITICAL] EA login email elementi bulunamadı: ${WEB_APP_SELECTORS.emailInput}`);
    await focusWebAppDocument();
    await submitEmailStep(emailInput, credentials.email);
  } else {
    webAppLog("LOGIN", "Sayfa doğrudan şifre adımında açıldı; email adımı atlandı.");
  }

  webAppLog("LOGIN", "Şifre inputu bekleniyor.", { selector: WEB_APP_SELECTORS.passwordInput });
  const passwordInput = initialState?.state === "password"
    ? initialState.element
    : await waitForVisibleElement(WEB_APP_SELECTORS.passwordInput, 120000);
  if (!passwordInput) throw new Error(`[CRITICAL] EA login password elementi bulunamadı: ${WEB_APP_SELECTORS.passwordInput}`);
  webAppLog("LOGIN", "Şifre inputu bulundu; tıklanıp odaklanıyor.");
  await clickAndFocusInput(passwordInput);
  webAppLog("LOGIN", "Şifre inputu temizleniyor.");
  await clearInputValue(passwordInput);
  webAppLog("LOGIN", "Şifre inputu temizlendi; 500 ms bekleniyor.");
  await sleep(500);
  webAppLog("LOGIN", "Şifre inputa set ediliyor.");
  await setInputValue(passwordInput, credentials.password);
  await waitUntil(
    () => String(passwordInput.value || "") === String(credentials.password),
    5000,
    100,
    "[CRITICAL] EA login şifresi inputa set edilemedi."
  );
  await webAppLog("LOGIN", "Şifre inputa yazıldı ve doğrulandı.");
  await sleep(500);

  const signInButton = await waitForVisibleElement(WEB_APP_SELECTORS.loginNextButton, 30000);
  if (!signInButton) throw new Error(`[CRITICAL] EA sign in butonu bulunamadı: ${WEB_APP_SELECTORS.loginNextButton}`);
  await webAppLog("LOGIN", "Şifre hazır. Sign In butonuna tıklanıyor.");
  await futClick(signInButton);
  webAppLog("LOGIN", "Sign In tıklandı; hata kontrolü için 2 saniye bekleniyor.");
  await sleep(2000);

  if (document.querySelector(".otkinput-iserror")) {
    webAppLog("LOGIN", "Şifre hata göstergesi algılandı; şifre yeniden girilecek.", {
      selector: ".otkinput-iserror"
    });
    const retryPasswordInput = await waitForVisibleElement(WEB_APP_SELECTORS.passwordInput, 5000);
    const retrySignInButton = findVisibleElement(WEB_APP_SELECTORS.loginNextButton);
    if (!retryPasswordInput) {
      throw new Error(`[CRITICAL] Hatalı şifre sonrası password elementi bulunamadı: ${WEB_APP_SELECTORS.passwordInput}`);
    }
    if (!retrySignInButton) {
      throw new Error(`[CRITICAL] Hatalı şifre sonrası sign in butonu bulunamadı: ${WEB_APP_SELECTORS.loginNextButton}`);
    }

    await clickAndFocusInput(retryPasswordInput);
    await clearInputValue(retryPasswordInput);
    webAppLog("LOGIN", "Retry öncesi şifre inputu temizlendi; 500 ms bekleniyor.");
    await sleep(500);
    await setInputValue(retryPasswordInput, credentials.password);
    await waitUntil(
      () => String(retryPasswordInput.value || "") === String(credentials.password),
      5000,
      100,
      "[CRITICAL] EA login şifresi tekrar inputa set edilemedi."
    );
    webAppLog("LOGIN", "Retry şifresi set edildi ve doğrulandı.");
    await sleep(500);
    webAppLog("LOGIN", "Sign In butonuna ikinci kez tıklanıyor.");
    await futClick(retrySignInButton);
  }

  webAppLog("LOAD", "Login tamamlandı; Settings/Ayarlar elementi 2 dakika boyunca saniyede bir kontrol edilecek.");
  const loadedButton = await waitForSettingsAfterLogin();
  await webAppLog("LOGIN", "Login başarılı. Home Page ve Settings/Ayarlar elementi yüklendi.");
  return loadedButton;
}

async function waitForSettingsAfterLogin() {
  const timeout = 120000;
  const interval = 1000;
  const startedAt = Date.now();
  let checkCount = 0;

  while (Date.now() - startedAt < timeout) {
    checkCount += 1;
    const loadedState = getLoadedSettingsState();
    if (loadedState) {
      webAppLog("LOAD", ".icon-settings elementi login sonrasında bulundu ve loader kapalı.", {
        selector: WEB_APP_SELECTORS.loaded,
        text: loadedState.text,
        checkCount,
        elapsedMs: Date.now() - startedAt
      });
      return loadedState.element;
    }

    webAppLog("LOAD", "Settings/Ayarlar henüz görünmüyor; yeniden kontrol edilecek.", {
      checkCount,
      nextCheckInMs: interval,
      remainingMs: Math.max(0, timeout - (Date.now() - startedAt))
    });
    await sleep(interval);
  }

  throw new Error(`[CRITICAL] Login sonrası Settings/Ayarlar elementi 2 dakika içinde yüklenmedi: ${WEB_APP_SELECTORS.loaded}`);
}

async function submitEmailStep(initialInput, email) {
  const expectedEmail = normalize(email).toLowerCase();
  let emailInput = initialInput;

  for (let attempt = 1; attempt <= 3; attempt++) {
    emailInput = findVisibleElement(WEB_APP_SELECTORS.emailInput) || emailInput;
    const confirmedEmailInput = await setAndConfirmEmail(emailInput, email);
    const emailNextButton = await waitForVisibleElement(WEB_APP_SELECTORS.loginNextButton, 30000);
    if (!emailNextButton) {
      throw new Error(`[CRITICAL] EA login Next butonu görünür değil: ${WEB_APP_SELECTORS.loginNextButton}`);
    }

    const emailBeforeNext = normalize(confirmedEmailInput.value).toLowerCase();
    if (!emailBeforeNext || emailBeforeNext !== expectedEmail) {
      throw new Error("[CRITICAL] Email inputu Next tıklamasından önce boşaldı veya değişti; Next tıklanmadı.");
    }

    webAppLog("LOGIN", "Email Next butonuna tıklanıyor.", { attempt });
    await futClick(emailNextButton);
    const transition = await waitForEmailStepTransition(5000);
    if (transition === "password") {
      await webAppLog("LOGIN", "Email yazıldı ve doğrulandı. Şifre ekranına geçildi.", { attempt });
      return;
    }
    if (transition === "navigating") {
      webAppLog("LOGIN", "Email Next sonrası sayfa yönlendirmesi başladı.", { attempt });
      return;
    }

    webAppLog("LOGIN", "Email ekranı hâlâ görünür; email ve Next yeniden denenecek.", {
      attempt,
      errorVisible: Boolean(document.querySelector(".otkinput-iserror"))
    });
    await focusWebAppDocument();
  }

  throw new Error("[CRITICAL] Email ekranı Next tıklamasından sonra değişmedi; Settings bekleme aşamasına geçilmedi.");
}

async function waitForEmailStepTransition(timeout = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (findVisibleElement(WEB_APP_SELECTORS.passwordInput)) return "password";
    if (!findVisibleElement(WEB_APP_SELECTORS.emailInput)) return "navigating";
    await sleep(100);
  }
  return "email";
}

async function focusWebAppDocument() {
  webAppLog("INPUT", "Web App sekmesi ve penceresi odaklanıyor.");
  const response = await chrome.runtime.sendMessage({ type: "FOCUS_WEB_APP_TAB" });
  if (!response?.ok) {
    throw new Error(`[CRITICAL] Web App sekmesi odaklanamadı: ${response?.error || "Bilinmeyen hata"}`);
  }
  window.focus();
  await sleep(500);
  await clickPageBody();
  webAppLog("INPUT", "Web App document odaklama adımı tamamlandı.", {
    documentHasFocus: document.hasFocus()
  });
}

async function setAndConfirmEmail(initialInput, email) {
  const expectedEmail = normalize(email).toLowerCase();
  let input = initialInput;

  for (let attempt = 1; attempt <= 3; attempt++) {
    input = findVisibleElement(WEB_APP_SELECTORS.emailInput) || input;
    webAppLog("LOGIN", "Email inputuna yazma denemesi başlıyor.", { attempt });
    await realClickAndFocusInput(input);
    await setEmailInputValue(input, email);
    await sleep(750);

    const currentInput = findVisibleElement(WEB_APP_SELECTORS.emailInput) || input;
    const currentEmail = normalize(currentInput.value).toLowerCase();
    const stable = currentEmail === expectedEmail;
    webAppLog("LOGIN", "Email stabilite kontrolü tamamlandı.", {
      attempt,
      stable,
      hasValue: Boolean(currentEmail),
      isActiveElement: document.activeElement === currentInput
    });
    if (stable) return currentInput;

    await focusWebAppDocument();
    input = currentInput;
  }

  throw new Error("[CRITICAL] EA login email bilgisi inputta stabil kalmadı; Next tıklanmadı.");
}

async function setEmailInputValue(input, email) {
  const inputPrototype = Object.getPrototypeOf(input);
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(inputPrototype, "value")?.set ||
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

  input.focus();
  if (nativeInputValueSetter) nativeInputValueSetter.call(input, "");
  else input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await sleep(250);

  if (nativeInputValueSetter) nativeInputValueSetter.call(input, String(email));
  else input.value = String(email);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(250);

  const writtenEmail = normalize(input.value).toLowerCase();
  const expectedEmail = normalize(email).toLowerCase();
  webAppLog("INPUT", "Email önceki native-setter yöntemiyle yazıldı.", {
    hasValue: Boolean(writtenEmail),
    matchesExpected: writtenEmail === expectedEmail,
    isActiveElement: document.activeElement === input
  });
  if (!writtenEmail || writtenEmail !== expectedEmail) {
    throw new Error("[CRITICAL] Native setter email değerini inputa yazamadı.");
  }
}

async function realClickAndFocusInput(input) {
  input.scrollIntoView({ block: "center", inline: "nearest" });
  await sleep(300);

  const rect = input.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  webAppLog("INPUT", "Email inputuna gerçek mouse tıklaması gönderiliyor.", {
    id: input.id || null,
    x: Math.round(x),
    y: Math.round(y)
  });

  const response = await chrome.runtime.sendMessage({
    type: "REAL_MOUSE_CLICK",
    x,
    y
  });
  if (!response?.ok) {
    throw new Error(`[CRITICAL] Email inputuna gerçek mouse tıklaması gönderilemedi: ${response?.error || "Bilinmeyen hata"}`);
  }

  await waitUntil(
    () => document.activeElement === input,
    5000,
    100,
    "[CRITICAL] Gerçek mouse tıklaması sonrası email inputunda cursor oluşmadı."
  );
  if (typeof input.setSelectionRange === "function") {
    const cursorPosition = String(input.value || "").length;
    input.setSelectionRange(cursorPosition, cursorPosition);
  }
  webAppLog("INPUT", "Email inputu gerçek tıklama ile odaklandı; cursor hazır.", {
    id: input.id || null,
    isActiveElement: document.activeElement === input
  });
}

async function clickPageBody() {
  const body = document.body;
  if (!body) {
    throw new Error("[CRITICAL] Email öncesi tıklanacak document.body bulunamadı.");
  }

  const rect = body.getBoundingClientRect();
  const clientX = Math.max(1, Math.min(window.innerWidth - 1, rect.left + Math.min(20, rect.width / 2)));
  const clientY = Math.max(1, Math.min(window.innerHeight - 1, rect.top + Math.min(20, rect.height / 2)));
  const mouseOptions = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
    button: 0,
    buttons: 1
  };

  body.focus();
  for (const eventName of [
    "pointerover", "pointerenter", "mouseover", "mouseenter",
    "pointerdown", "mousedown", "pointerup", "mouseup", "click"
  ]) {
    body.dispatchEvent(new MouseEvent(eventName, mouseOptions));
  }
  body.click();
  await sleep(300);

  webAppLog("INPUT", "Sayfa body tıklaması tamamlandı.", {
    activeElement: document.activeElement?.tagName || null
  });
}

async function clickAndFocusInput(input) {
  webAppLog("INPUT", "Input görünür alana getiriliyor ve tıklanıyor.", {
    id: input.id || null,
    name: input.name || null,
    type: input.type || null
  });
  input.scrollIntoView({ block: "center", inline: "nearest" });

  input.focus();
  input.click();
  if (typeof input.setSelectionRange === "function") {
    const cursorPosition = String(input.value || "").length;
    input.setSelectionRange(cursorPosition, cursorPosition);
  }
  await sleep(300);
  webAppLog("INPUT", "Input tıklama/odaklama adımı tamamlandı.", {
    id: input.id || null,
    isActiveElement: document.activeElement === input
  });
}

async function clearInputValue(input) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

  webAppLog("INPUT", "Input değeri native setter ile temizleniyor.", {
    id: input.id || null,
    type: input.type || null
  });
  input.focus();
  if (nativeInputValueSetter) nativeInputValueSetter.call(input, "");
  else input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  webAppLog("INPUT", "Input temizlendi; input/change eventleri gönderildi.", {
    id: input.id || null,
    isEmpty: input.value === ""
  });
}

async function loadEnvConfig() {
  try {
    const url = chrome.runtime.getURL(".env");
    const response = await fetch(url);
    const text = await response.text();
    const env = {};
    text.split("\n").forEach((line) => {
      const [key, ...rest] = line.split("=");
      if (key && key.trim() && !key.trim().startsWith("#")) {
        env[key.trim()] = rest.join("=").trim().replace(/^['"]|['"]$/g, "");
      }
    });
    return env;
  } catch (error) {
    webAppLog("ERROR", ".env dosyası okunamadı.", {
      message: error.message || String(error)
    });
    return {};
  }
}

async function loadWebAppCredentials() {
  const env = await loadEnvConfig();
  if (env.EA_EMAIL && env.EA_PASSWORD) {
    return { email: env.EA_EMAIL, password: env.EA_PASSWORD };
  }

  const values = await chrome.storage.local.get([
    "webAppEmail",
    "webAppPassword",
    "syncWebAppEmail",
    "syncWebAppPassword",
    "eaEmail",
    "eaPassword"
  ]);
  const email = normalize(values.webAppEmail || values.syncWebAppEmail || values.eaEmail);
  const password = String(values.webAppPassword || values.syncWebAppPassword || values.eaPassword || "");
  if (!email || !password) {
    throw new Error("[CRITICAL] EA login bilgileri .env veya chrome.storage.local içinde bulunamadı. Beklenen anahtarlar: webAppEmail/webAppPassword veya EA_EMAIL/EA_PASSWORD");
  }
  return { email, password };
}

async function setInputValue(input, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;

  webAppLog("INPUT", "Input değeri set ediliyor.", {
    id: input.id || null,
    name: input.name || null,
    type: input.type || null,
    nativeSetterAvailable: Boolean(nativeInputValueSetter)
  });
  input.focus();
  await sleep(200);
  input.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    data: String(value),
    inputType: "insertText"
  }));
  if (nativeInputValueSetter) nativeInputValueSetter.call(input, value);
  else input.value = value;
  input.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    data: String(value),
    inputType: "insertText"
  }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(500);

  if (String(input.value || "") !== String(value)) {
    throw new Error(`[CRITICAL] ${input.id || input.name || "Login input"} alanına değer yazılamadı.`);
  }
  webAppLog("INPUT", "Input değeri set edildi ve doğrulandı.", {
    id: input.id || null,
    type: input.type || null
  });
}

async function tryClickLanguage(language) {
  const labels = language === "tr"
    ? ["Türkçe", "Turkish", "TR"]
    : ["English", "İngilizce", "EN"];
  const control = findClickableByText(labels, WEB_APP_SELECTORS.languageButtons);
  if (!control) return false;
  return futClick(control);
}

async function clickByLabels(labels) {
  const control = findClickableByText(labels, ["button", "a", "[role='button']", ".ut-navigation-button-control"]);
  if (!control) return false;
  return futClick(control);
}

function findClickableByText(labels, selectors) {
  const normalizedLabels = labels.map((label) => normalize(label).toLocaleLowerCase("tr-TR"));
  const nodes = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]);
  return nodes.find((node) => {
    const text = normalize(`${node.textContent || ""} ${node.getAttribute("aria-label") || ""} ${node.getAttribute("title") || ""}`)
      .toLocaleLowerCase("tr-TR");
    return normalizedLabels.some((label) => text.includes(label));
  }) || null;
}

function textExists(labels) {
  const bodyText = normalize(document.body?.textContent).toLocaleLowerCase("tr-TR");
  return labels.some((label) => bodyText.includes(normalize(label).toLocaleLowerCase("tr-TR")));
}

function readVisibleTitle() {
  const titleNode = [...document.querySelectorAll("h1,h2,h3,.title,.ut-title")]
    .find((node) => normalize(node.textContent));
  return normalize(titleNode?.textContent || document.title);
}

function readDocumentLanguage() {
  return normalize(document.documentElement.lang || navigator.language || "");
}

function waitForDocumentReady() {
  if (document.readyState === "interactive" || document.readyState === "complete") return Promise.resolve();
  return new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
}

async function waitForElement(selector, timeout = 5000) {
  const start = Date.now();
  webAppLog("WAIT", "Element bekleniyor.", { selector, timeout });
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) {
      webAppLog("WAIT", "Element bulundu.", {
        selector,
        elapsedMs: Date.now() - start
      });
      return el;
    }
    await sleep(100);
  }
  webAppLog("WAIT", "Element bekleme süresi doldu.", { selector, timeout });
  return null;
}

async function waitForVisibleElement(selector, timeout = 5000) {
  const startedAt = Date.now();
  webAppLog("WAIT", "Görünür element bekleniyor.", { selector, timeout });
  while (Date.now() - startedAt < timeout) {
    const element = findVisibleElement(selector);
    if (element) {
      webAppLog("WAIT", "Görünür element bulundu.", {
        selector,
        elapsedMs: Date.now() - startedAt
      });
      return element;
    }
    await sleep(100);
  }
  webAppLog("WAIT", "Görünür element bekleme süresi doldu.", { selector, timeout });
  return null;
}

function findVisibleElement(selector) {
  return [...document.querySelectorAll(selector)].find(isElementVisible) || null;
}

function isElementVisible(element) {
  if (!element || !(element instanceof Element)) return false;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" &&
    style.visibility !== "hidden" &&
    Number(style.opacity || 1) !== 0 &&
    rect.width > 0 &&
    rect.height > 0;
}

async function waitForLoadedSettingsButton(timeout = 5000) {
  const startedAt = Date.now();
  let lastDetectedText = "";

  while (Date.now() - startedAt < timeout) {
    const loadedState = getLoadedSettingsState();
    if (loadedState) {
      lastDetectedText = loadedState.text;
      webAppLog("LOAD", ".icon-settings bulundu, metni doğrulandı ve loader kapalı.", {
        selector: WEB_APP_SELECTORS.loaded,
        text: lastDetectedText,
        elapsedMs: Date.now() - startedAt,
        loaderActive: isClickShieldActive()
      });
      return loadedState.element;
    }

    const possibleButton = document.querySelector(WEB_APP_SELECTORS.loaded);
    if (possibleButton) {
      lastDetectedText = normalize(possibleButton.innerText || possibleButton.textContent).toLowerCase();
    }
    await sleep(100);
  }

  webAppLog("LOAD", ".icon-settings yüklenme veya loader kapanma kontrolü timeout oldu.", {
    selector: WEB_APP_SELECTORS.loaded,
    lastDetectedText,
    loaderActive: isClickShieldActive(),
    timeout
  });
  return null;
}

async function waitForWebAppEntryState(timeout = 120000) {
  const startedAt = Date.now();
  const loginButtonGraceMs = 5000;
  let loginButtonCandidate = null;
  let loginButtonDetectedAt = 0;
  webAppLog("WAIT", "Settings/Ayarlar hedefi ve login ekranı paralel izleniyor.", {
    timeout,
    loginButtonGraceMs
  });

  while (Date.now() - startedAt < timeout) {
    const loadedState = getLoadedSettingsState() || getLoadedSettingsStateLoose();
    if (loadedState) return loadedState;

    const passwordInput = findVisibleElement(WEB_APP_SELECTORS.passwordInput);
    if (passwordInput) {
      return {
        state: "password",
        selector: WEB_APP_SELECTORS.passwordInput,
        element: passwordInput
      };
    }

    const emailInput = findVisibleElement(WEB_APP_SELECTORS.emailInput);
    if (emailInput) {
      return {
        state: "email",
        selector: WEB_APP_SELECTORS.emailInput,
        element: emailInput
      };
    }

    const loginButton = findVisibleElement(WEB_APP_SELECTORS.loginButton);
    if (loginButton) {
      if (loginButtonCandidate !== loginButton) {
        loginButtonCandidate = loginButton;
        loginButtonDetectedAt = Date.now();
        webAppLog("WAIT", "Login butonu görüldü; mevcut oturum yüklenebilir diye Settings/Ayarlar için bekleniyor.", {
          graceMs: loginButtonGraceMs
        });
      }
      if (Date.now() - loginButtonDetectedAt >= loginButtonGraceMs) {
        const loadedBeforeLoginCandidate = getLoadedSettingsState() || getLoadedSettingsStateLoose();
        if (loadedBeforeLoginCandidate) return loadedBeforeLoginCandidate;

        return {
          state: "login-button",
          selector: WEB_APP_SELECTORS.loginButton,
          element: loginButton
        };
      }
    } else {
      loginButtonCandidate = null;
      loginButtonDetectedAt = 0;
    }

    await sleep(100);
  }

  webAppLog("WAIT", "Web App başlangıç durumu bekleme süresi doldu.", { timeout });
  return null;
}

async function waitForWebAppAuthState(timeout = 120000) {
  const startedAt = Date.now();
  webAppLog("WAIT", "Login butonu sonrası Settings/Ayarlar, email veya şifre ekranı bekleniyor.", {
    timeout
  });

  while (Date.now() - startedAt < timeout) {
    const loadedState = getLoadedSettingsState();
    if (loadedState) return loadedState;

    const passwordInput = findVisibleElement(WEB_APP_SELECTORS.passwordInput);
    if (passwordInput) {
      return {
        state: "password",
        selector: WEB_APP_SELECTORS.passwordInput,
        element: passwordInput
      };
    }

    const emailInput = findVisibleElement(WEB_APP_SELECTORS.emailInput);
    if (emailInput) {
      return {
        state: "email",
        selector: WEB_APP_SELECTORS.emailInput,
        element: emailInput
      };
    }

    await sleep(100);
  }

  webAppLog("WAIT", "Login sonrası oturum durumu bekleme süresi doldu.", { timeout });
  return null;
}

function getLoadedSettingsState() {
  if (isClickShieldActive()) return null;
  const loadedButton = findVisibleElement(WEB_APP_SELECTORS.loaded);
  const loadedText = normalize(loadedButton?.innerText || loadedButton?.textContent).toLowerCase();
  if (!loadedButton || (loadedText !== "settings" && loadedText !== "ayarlar")) return null;

  return {
    state: "loaded",
    selector: WEB_APP_SELECTORS.loaded,
    element: loadedButton,
    text: loadedText
  };
}

function getLoadedSettingsStateLoose() {
  if (isClickShieldActive()) return null;
  const loadedButton = document.querySelector(WEB_APP_SELECTORS.loaded);
  const loadedText = normalize(loadedButton?.innerText || loadedButton?.textContent).toLowerCase();
  if (!loadedButton || (loadedText !== "settings" && loadedText !== "ayarlar")) return null;

  return {
    state: "loaded",
    selector: WEB_APP_SELECTORS.loaded,
    element: loadedButton,
    text: loadedText,
    detection: "dom-text"
  };
}

function isClickShieldActive() {
  return Boolean(document.querySelector("body > div.ut-click-shield.showing"));
}

function isEaJunoLoginPage() {
  return location.hostname === "signin.ea.com" &&
    location.pathname.startsWith("/p/juno/login");
}

async function futClick(selectorOrObject) {
  let res = false;
  await waitForClickShieldToDisappear("before-click");

  const object = typeof selectorOrObject === "string"
    ? document.querySelector(selectorOrObject)
    : selectorOrObject;

  const isClickable =
    object &&
    object instanceof Element &&
    !object.disabled &&
    object.offsetParent !== null &&
    object.style.pointerEvents !== "none";

  if (isClickable) {
    try {
      webAppLog("CLICK", "Element tıklanıyor.", {
        selector: typeof selectorOrObject === "string" ? selectorOrObject : null,
        tagName: object.tagName,
        id: object.id || null,
        className: normalize(object.className),
        text: normalize(object.innerText || object.textContent).slice(0, 120)
      });
      const events = [
        "pointerover", "pointerenter", "mouseover", "mouseenter",
        "pointerdown", "mousedown", "pointerup", "mouseup", "click"
      ];
      for (const evt of events) {
        object.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window }));
      }
      res = true;
      webAppLog("CLICK", "Tıklama eventleri başarıyla gönderildi.", {
        id: object.id || null,
        tagName: object.tagName
      });
    } catch (error) {
      webAppLog("ERROR", "Tıklama sırasında hata oluştu.", {
        message: error.message || String(error)
      });
    }
  } else {
    webAppLog("CLICK", "Element geçersiz veya tıklanamaz olduğu için tıklanmadı.", {
      selector: typeof selectorOrObject === "string" ? selectorOrObject : null
    });
  }

  await waitForClickShieldToDisappear("after-click");

  webAppLog("CLICK", "Tıklama işlemi tamamlandı.", { success: res });
  return res;
}

async function waitForClickShieldToDisappear(reason = "click", timeout = 60000) {
  const selector = "body > div.ut-click-shield.showing";
  const startedAt = Date.now();
  if (!isClickShieldActive()) return true;

  await webAppLog("CLICK", "Loader/click shield aktif; tıklama için kapanması bekleniyor.", {
    selector,
    reason,
    timeout
  });

  while (Date.now() - startedAt < timeout) {
    if (!isClickShieldActive()) {
      await webAppLog("CLICK", "Loader/click shield kapandı; tıklamaya devam edilebilir.", {
        selector,
        reason,
        elapsedMs: Date.now() - startedAt
      });
      return true;
    }
    await sleep(100);
  }

  throw new Error(`[CRITICAL] Loader/click shield ${Math.round(timeout / 1000)} saniye içinde kapanmadı: ${selector}`);
}

function waitUntil(predicate, timeoutMs, intervalMs, timeoutMessage) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      let matched = false;
      try {
        matched = Boolean(predicate());
      } catch {
        matched = false;
      }
      if (matched) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error(timeoutMessage));
      }
    }, intervalMs);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}
