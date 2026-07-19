(function () {
  const REQUEST_TYPE = "sbcmonster:webapp-api-request";
  const RESPONSE_TYPE = "sbcmonster:webapp-api-response";
  const currentScriptUrl = document.currentScript?.src || "";
  const API_BASE_URL = (() => {
    try {
      const fromScript = new URL(currentScriptUrl).searchParams.get("apiBaseUrl");
      if (fromScript) return fromScript;
    } catch {
      // Query okunamazsa global fallback denenir.
    }
    return globalThis.FutbinSyncApiConfig?.defaultBaseUrl?.() || "";
  })();
  const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

  console.info("[WebAppSync][BRIDGE] MAIN world API bridge yüklendi.", {
    apiBaseUrl: API_BASE_URL,
    href: location.href
  });

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.data?.type !== REQUEST_TYPE) return;
    const request = event.data.payload || {};
    const requestId = String(request.requestId || "");
    if (!requestId) return;
    try {
      const method = String(request.method || "GET").toUpperCase();
      const endpoint = String(request.endpoint || "").trim().replace(/^\/+/, "");
      if (!ALLOWED_METHODS.has(method) || !endpoint || endpoint.includes("://") || endpoint.includes("..")) {
        throw new Error("Geçersiz Web App API isteği.");
      }
      const url = new URL(endpoint, API_BASE_URL).href;
      const startedAt = Date.now();
      console.groupCollapsed(`[WebAppSync][FETCH][REQUEST] ${method} ${url}`);
      console.log("request", {
        requestId,
        method,
        endpoint,
        url,
        body: request.body || null
      });
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(request.body || {}),
        credentials: "omit",
        cache: "no-store"
      });
      const rawText = await response.text();
      let payload = {};
      try { payload = rawText ? JSON.parse(rawText) : {}; } catch { payload = { message: rawText }; }
      console.log("response", {
        requestId,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        elapsedMs: Date.now() - startedAt,
        body: payload,
        rawText
      });
      console.groupEnd();
      window.postMessage({
        type: RESPONSE_TYPE,
        payload: { requestId, ok: response.ok, status: response.status, response: payload }
      }, "*");
    } catch (error) {
      console.error("[WebAppSync][FETCH] İstek başarısız.", error);
      try { console.groupEnd(); } catch { /* Grup açık değilse yok say. */ }
      window.postMessage({
        type: RESPONSE_TYPE,
        payload: { requestId, ok: false, status: 0, error: error.message || String(error) }
      }, "*");
    }
  });
})();
