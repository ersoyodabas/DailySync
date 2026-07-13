(function (global) {
  let envCache = null;
  let readyPromise = null;

  function parseEnv(text) {
    const values = {};
    String(text || "").split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      const separator = trimmed.indexOf("=");
      if (separator < 0) return;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
      if (key) values[key] = value;
    });
    return values;
  }

  function envUrl() {
    try {
      return global.chrome?.runtime?.getURL ? global.chrome.runtime.getURL(".env") : null;
    } catch {
      return null;
    }
  }

  function loadSync() {
    if (envCache) return envCache;
    const url = envUrl();
    if (!url || typeof XMLHttpRequest === "undefined") {
      return envCache || {};
    }
    try {
      const request = new XMLHttpRequest();
      request.open("GET", `${url}?t=${Date.now()}`, false);
      request.send(null);
      envCache = request.status >= 200 && request.status < 300 ? parseEnv(request.responseText) : {};
    } catch {
      envCache = {};
    }
    return envCache;
  }

  async function load() {
    if (envCache) return envCache;
    const url = envUrl();
    if (!url) {
      envCache = {};
      return envCache;
    }
    const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
    envCache = parseEnv(await response.text());
    return envCache;
  }

  function env() {
    return envCache || loadSync();
  }

  function get(key, fallback = "") {
    const value = env()[key];
    return value === undefined || value === null || value === "" ? fallback : value;
  }

  function number(key, fallback) {
    const value = Number(get(key));
    return Number.isFinite(value) ? value : fallback;
  }

  function normalizeBaseUrl(value) {
    try {
      const url = new URL(value);
      return url.href.endsWith("/") ? url.href : `${url.href}/`;
    } catch {
      return "";
    }
  }

  function baseUrlFor(environment) {
    void environment;
    return normalizeBaseUrl(get("API_BASE_URL"));
  }

  function defaultBaseUrl() {
    return normalizeBaseUrl(get("API_BASE_URL"));
  }

  function allowedBaseUrl(value) {
    void value;
    return defaultBaseUrl();
  }

  readyPromise = load().catch(() => {
    envCache = envCache || {};
    return envCache;
  });

  global.FutbinSyncApiConfig = Object.freeze({
    ready: readyPromise,
    load,
    get,
    number,
    defaultBaseUrl,
    baseUrlFor,
    normalizeBaseUrl,
    allowedBaseUrl,
    isLocal: () => false,
    isProduction: () => false
  });
})(globalThis);
