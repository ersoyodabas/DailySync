const WATCHDOG_ALARM = "futbin-sync-module-watchdog";
const WATCHDOG_STATE_KEY = "futbinSyncWatchdogState";
const WATCHDOG_INTERVAL_MINUTES = 10;
const RECOVERY_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const POST_START_SETTLE_MS = 1500;
const FINISHED_STATUS = "Finished";
const READY_STATUS = "Hazır";
const SBC_PLAYERS_PAUSED_STATUS = "SBC Players için geçici duraklatıldı.";
const API_CONFIG = globalThis.FutbinSyncApiConfig;

const WATCHED_MODULES = [
  {
    id: "important",
    title: "Important Players",
    operations: [],
    readState(response) {
      return response?.state || {};
    },
    isRunning(state) {
      return Boolean(state?.running || state?.waitingForNextRun || state?.nextRunAt);
    },
    isIntentionalStop(state) {
      const status = String(state?.status || "");
      return status === FINISHED_STATUS
        || status === READY_STATUS
        || status === SBC_PLAYERS_PAUSED_STATUS
        || Boolean(state?.pausedBySbcPlayers)
        || status.includes("durduruldu");
    },
    stoppedAt(state) {
      return validTime(state?.updatedAt)
        || validTime(state?.completedAt)
        || validTime(state?.startedAt)
        || 0;
    }
  },
  {
    id: "latest",
    title: "Latest Players",
    operations: ["coin-cards"],
    readState(response) {
      const root = response?.latestSyncState || {};
      return root.runs?.["coin-cards"] || root;
    },
    isRunning(state) {
      return Boolean(state?.running || (state?.userStarted && state?.nextRunAt));
    },
    isIntentionalStop(state) {
      const status = String(state?.status || "");
      return status === FINISHED_STATUS
        || status === READY_STATUS
        || status === "Hazır - başlatma bekleniyor"
        || status === SBC_PLAYERS_PAUSED_STATUS
        || Boolean(state?.pausedBySbcPlayers);
    },
    stoppedAt(state) {
      return validTime(state?.updatedAt)
        || validTime(state?.completedAt)
        || validTime(state?.runStartedAt)
        || 0;
    }
  }
];

initWatchdog();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) return;
  runWatchdogCheck("alarm").catch((error) => {
    console.error("[WATCHDOG] Check failed.", error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  startWatchdog("installed").catch((error) => {
    console.error("[WATCHDOG] Initialization failed.", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  startWatchdog("startup").catch((error) => {
    console.error("[WATCHDOG] Startup initialization failed.", error);
  });
});

async function initWatchdog() {
  try {
    await startWatchdog("service-worker");
  } catch (error) {
    console.error("[WATCHDOG] Service worker initialization failed.", error);
  }
}

async function startWatchdog(reason) {
  await API_CONFIG.ready;
  await chrome.alarms.create(WATCHDOG_ALARM, {
    delayInMinutes: 1,
    periodInMinutes: WATCHDOG_INTERVAL_MINUTES
  });
  console.log("[WATCHDOG] Module recovery watchdog armed.", {
    reason,
    intervalMinutes: WATCHDOG_INTERVAL_MINUTES,
    thresholdHours: RECOVERY_THRESHOLD_MS / 60 / 60 / 1000
  });
  await runWatchdogCheck(reason);
}

async function runWatchdogCheck(reason) {
  await API_CONFIG.ready;
  const now = Date.now();
  const watchdogState = await getWatchdogState();
  for (const moduleConfig of WATCHED_MODULES) {
    try {
      await checkModule(moduleConfig, watchdogState, now, reason);
    } catch (error) {
      console.error(`[WATCHDOG] ${moduleConfig.title} watchdog check failed.`, error);
      watchdogState[moduleConfig.id] = {
        ...(watchdogState[moduleConfig.id] || {}),
        lastError: error?.message || String(error),
        lastErrorAt: now
      };
    }
  }
  await setWatchdogState(watchdogState);
}

async function checkModule(moduleConfig, watchdogState, now, reason) {
  const response = await sendModuleMessage(moduleConfig, "GET_SNAPSHOT");
  const state = moduleConfig.readState(response);
  const moduleWatch = watchdogState[moduleConfig.id] || {};

  if (moduleConfig.isRunning(state)) {
    watchdogState[moduleConfig.id] = {
      lastSeenRunningAt: now,
      lastStatus: state?.status || "",
      lastReason: reason
    };
    return;
  }

  if (moduleConfig.isIntentionalStop(state)) {
    watchdogState[moduleConfig.id] = {
      lastIntentionalStopAt: now,
      lastStatus: state?.status || "",
      lastReason: reason
    };
    return;
  }

  const stateUpdatedAt = validTime(state?.updatedAt) || 0;
  const observedKey = [
    stateUpdatedAt || "no-updated-at",
    state?.status || "",
    state?.error || "",
    state?.runStartedAt || state?.startedAt || ""
  ].join("|");
  const firstObservedAt = moduleWatch.observedKey === observedKey
    ? validTime(moduleWatch.firstObservedAt) || now
    : now;
  const stoppedSince = minNonZero(moduleConfig.stoppedAt(state), firstObservedAt) || now;
  const inactiveMs = Math.max(0, now - stoppedSince);

  if (moduleWatch.loggedStoppedKey !== observedKey) {
    console.warn(`[WATCHDOG] ${moduleConfig.title} stopped unexpectedly.`, {
      status: state?.status || "",
      error: state?.error || null,
      stoppedSince: new Date(stoppedSince).toISOString()
    });
  }

  const nextWatch = {
    ...moduleWatch,
    observedKey,
    firstObservedAt,
    loggedStoppedKey: observedKey,
    stoppedSince,
    lastInactiveMs: inactiveMs,
    lastStatus: state?.status || "",
    lastReason: reason
  };
  watchdogState[moduleConfig.id] = nextWatch;

  if (inactiveMs < RECOVERY_THRESHOLD_MS) return;

  if (
    nextWatch.lastRestartAttemptKey === observedKey
    && validTime(nextWatch.lastRestartAttemptAt)
    && stateUpdatedAt === nextWatch.lastRestartAttemptStateUpdatedAt
  ) {
    console.log(`[WATCHDOG] ${moduleConfig.title} recovery already attempted; waiting for module state update before retry.`, {
      attemptedAt: new Date(nextWatch.lastRestartAttemptAt).toISOString(),
      status: state?.status || ""
    });
    return;
  }

  console.warn("[WATCHDOG] Module has been inactive for 2 hours.", {
    module: moduleConfig.title,
    inactiveMinutes: Math.round(inactiveMs / 60000)
  });
  await restartModule(moduleConfig, watchdogState, observedKey, stateUpdatedAt);
}

async function restartModule(moduleConfig, watchdogState, observedKey, stateUpdatedAt) {
  const now = Date.now();
  watchdogState[moduleConfig.id] = {
    ...(watchdogState[moduleConfig.id] || {}),
    lastRestartAttemptAt: now,
    lastRestartAttemptKey: observedKey,
    lastRestartAttemptStateUpdatedAt: stateUpdatedAt || 0
  };
  await setWatchdogState(watchdogState);

  console.warn(`[WATCHDOG] Restarting ${moduleConfig.title}...`);
  try {
    const response = await sendModuleMessage(moduleConfig, "START_SYNC", startPayload(moduleConfig));
    if (!response?.ok) throw new Error(response?.error || "START_SYNC failed");
    await sleep(POST_START_SETTLE_MS);
    const snapshot = await sendModuleMessage(moduleConfig, "GET_SNAPSHOT");
    const state = moduleConfig.readState(snapshot);
    if (moduleConfig.isRunning(state)) {
      console.log(`[WATCHDOG] ${moduleConfig.title} started successfully.`);
      watchdogState[moduleConfig.id] = {
        lastSeenRunningAt: Date.now(),
        lastRestartSuccessAt: Date.now(),
        lastStatus: state?.status || ""
      };
      return;
    }
    console.warn(`[WATCHDOG] ${moduleConfig.title} restart was requested, but module state is not running yet.`, {
      status: state?.status || "",
      error: state?.error || null
    });
  } catch (error) {
    console.error(`[WATCHDOG] ${moduleConfig.title} restart failed.`, error);
    watchdogState[moduleConfig.id] = {
      ...(watchdogState[moduleConfig.id] || {}),
      lastRestartErrorAt: Date.now(),
      lastRestartError: error?.message || String(error)
    };
  }
}

function startPayload(moduleConfig) {
  const payload = {
    apiBaseUrl: API_CONFIG.defaultBaseUrl(),
    waitMs: API_CONFIG.number("WAIT_MS", 5000)
  };
  if (moduleConfig.operations.length) payload.operations = moduleConfig.operations;
  return payload;
}

function sendModuleMessage(moduleConfig, type, payload = {}) {
  return chrome.runtime.sendMessage({
    futbinSyncModule: moduleConfig.id,
    type,
    ...payload
  });
}

async function getWatchdogState() {
  const stored = await chrome.storage.local.get(WATCHDOG_STATE_KEY);
  const value = stored[WATCHDOG_STATE_KEY];
  return value && typeof value === "object" ? value : {};
}

function setWatchdogState(state) {
  return chrome.storage.local.set({ [WATCHDOG_STATE_KEY]: state });
}

function validTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function minNonZero(...values) {
  const valid = values.map(validTime).filter(Boolean);
  return valid.length ? Math.min(...valid) : 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
