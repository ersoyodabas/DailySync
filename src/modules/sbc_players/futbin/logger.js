export function createFutbinLogger(context = "SbcPlayersFutbin", onLog = null) {
  const shouldSkip = (message, details) => {
    const text = `${String(message || "")} ${safeStringify(details)}`;
    return text.includes("GET_SNAPSHOT");
  };
  return {
    info(message, details = null) {
      if (shouldSkip(message, details)) return;
      console.log(`[${context}] ${message}`, details || "");
      writeLiveLog(onLog, "info", message, details);
    },
    warning(message, details = null) {
      if (shouldSkip(message, details)) return;
      console.warn(`[${context}] ${message}`, details || "");
      writeLiveLog(onLog, "warning", message, details);
    },
    error(message, details = null) {
      if (shouldSkip(message, details)) return;
      console.error(`[${context}] ${message}`, details || "");
      writeLiveLog(onLog, "error", message, details);
    }
  };
}

function writeLiveLog(onLog, level, message, details) {
  if (typeof onLog !== "function") return;
  try {
    Promise.resolve(onLog(level, message, details)).catch(() => {});
  } catch {
    // Console log akışı canlı log hatasından etkilenmemeli.
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value || "");
  } catch {
    return "";
  }
}
