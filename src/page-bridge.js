(() => {
  if (window.__FUTBIN_SYNC_BRIDGE__) return;
  window.__FUTBIN_SYNC_BRIDGE__ = true;

  const emit = (payload, source) => {
    window.postMessage({ channel: "FUTBIN_SYNC", type: "RAW_JSON", source, payload }, location.origin);
  };

  const parseResponse = async (response, source) => {
    try {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("json")) emit(await response.clone().json(), source);
    } catch { /* Sayfanın isteğini etkileme. */ }
  };

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    parseResponse(response, `fetch:${response.url}`);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__futbinSyncUrl = String(url);
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const type = this.getResponseHeader("content-type") || "";
        if (type.includes("json")) {
          const data = this.responseType === "json" ? this.response : JSON.parse(this.responseText);
          emit(data, `xhr:${this.__futbinSyncUrl || "unknown"}`);
        }
      } catch { /* Geçersiz JSON'u yok say. */ }
    }, { once: true });
    return originalSend.apply(this, args);
  };
})();
