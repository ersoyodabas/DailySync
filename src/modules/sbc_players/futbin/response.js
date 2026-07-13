export function futbinSuccess(data, statusCode = 200, rawContent = null, elapsedMilliseconds = 0, requestUrl = null, responseHeaders = null) {
  return {
    isSuccess: true,
    statusCode,
    data,
    errorMessage: null,
    rawContent,
    requestUrl,
    responseHeaders,
    elapsedMilliseconds
  };
}

export function futbinFailure(errorMessage, statusCode = 500, rawContent = null, elapsedMilliseconds = 0, requestUrl = null, exception = null) {
  return {
    isSuccess: false,
    statusCode,
    data: null,
    errorMessage: errorMessage || "Futbin request failed",
    exception,
    rawContent,
    requestUrl,
    responseHeaders: null,
    elapsedMilliseconds
  };
}
