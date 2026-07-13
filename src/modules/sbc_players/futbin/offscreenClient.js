const OFFSCREEN_URL = "src/offscreen.html";
const PARSE_TIMEOUT_MS = 15000;

export async function parseFutbinSbcHtml(operation, payload) {
  await ensureSbcPlayersOffscreenParser();
  const startedAt = Date.now();
  const parsed = await withTimeout(
    chrome.runtime.sendMessage({
      type: "SBC_PLAYERS_PARSE_FUTBIN_HTML",
      operation,
      ...payload
    }),
    PARSE_TIMEOUT_MS,
    `Futbin HTML parser timeout (${Math.round(PARSE_TIMEOUT_MS / 1000)} sn): ${operation}`
  );
  console.log("[SBC_PLAYERS][OFFSCREEN_PARSE_COMPLETED]", {
    operation,
    elapsedMilliseconds: Date.now() - startedAt,
    ok: parsed?.ok,
    playerCount: parsed?.players?.length ?? null,
    recordCount: parsed?.records?.length ?? null,
    boxCount: parsed?.boxes?.length ?? null
  });
  if (!parsed?.ok) throw new Error(parsed?.error || `Futbin HTML parse edilemedi: ${operation}`);
  return parsed;
}

function withTimeout(promise, timeoutMs, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

async function ensureSbcPlayersOffscreenParser() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (contexts.length) return;
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["DOM_SCRAPING"],
      justification: "SBC Players Futbin HTML cevaplarını ayrıştırmak"
    });
  } catch (error) {
    const current = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
    if (current.length) return;
    throw error;
  }
}
