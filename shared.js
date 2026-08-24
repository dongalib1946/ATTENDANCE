(function () {
  const endpoint = "/.netlify/functions/attendance";
  let callbackId = 0;
  const ACTION_OPTIONS = {
    qr: { timeoutMs: 8000, retries: 2 },
    roster: { timeoutMs: 30000, retries: 1 },
    settings: { timeoutMs: 8000, retries: 1 },
    adminStatus: { timeoutMs: 12000, retries: 1 },
    updateSettings: { timeoutMs: 12000, retries: 1 },
    log: { timeoutMs: 18000, retries: 0 }
  };

  async function call(action, params = {}, options = {}) {
    const requestOptions = Object.assign({}, ACTION_OPTIONS[action] || {}, options);
    const retries = Number(requestOptions.retries || 0);
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const appsScriptUrl = getAppsScriptUrl();
        if (appsScriptUrl) {
          return await sendJsonp(action, params, requestOptions.timeoutMs);
        }
        if (isGitHubPages()) {
          throw new Error("GitHub Pages에서 사용하려면 config.js에 Apps Script 웹 앱 URL을 입력해 주세요.");
        }
        return await sendFetch(action, params, requestOptions.timeoutMs);
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt >= retries) break;
        await wait(500 + attempt * 900);
      }
    }

    throw lastError;
  }

  async function sendFetch(action, params, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(Object.assign({ action }, params)),
        signal: controller.signal
      });
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error("서버 연결이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.");
        timeoutError.retryable = true;
        throw timeoutError;
      }
      error.retryable = true;
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error("서버 응답을 해석하지 못했습니다.");
    }

    if (!response.ok) {
      const apiError = new Error((payload && payload.message) || "서버 요청에 실패했습니다.");
      apiError.retryable = response.status === 429 || response.status >= 500;
      throw apiError;
    }

    return payload;
  }

  function sendJsonp(action, params, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const callbackName = `__attendanceCallback${Date.now()}${callbackId += 1}`;
      const script = document.createElement("script");
      const timeoutId = setTimeout(() => {
        cleanup();
        const error = new Error("Apps Script 연결이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.");
        error.retryable = true;
        reject(error);
      }, timeoutMs);

      window[callbackName] = (payload) => {
        cleanup();
        resolve(payload);
      };

      script.onerror = () => {
        cleanup();
        const error = new Error("Apps Script에 연결하지 못했습니다.");
        error.retryable = true;
        reject(error);
      };

      script.src = buildJsonpUrl(action, params, callbackName);
      script.async = true;
      document.head.appendChild(script);

      function cleanup() {
        clearTimeout(timeoutId);
        script.remove();
        delete window[callbackName];
      }
    });
  }

  function buildJsonpUrl(action, params, callbackName) {
    const url = new URL(getAppsScriptUrl());
    const payload = Object.assign({ action }, params);
    if (action === "qr" && !payload.siteUrl) {
      payload.siteUrl = getSiteBaseUrl();
    }

    Object.entries(payload).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    });
    url.searchParams.set("callback", callbackName);
    url.searchParams.set("_", String(Date.now()));
    return url.toString();
  }

  function getAppsScriptUrl() {
    const config = window.ATTENDANCE_CONFIG || {};
    const url = String(config.appsScriptUrl || "").trim();
    if (!url || url.includes("PASTE_YOUR_APPS_SCRIPT_URL_HERE")) return "";
    return url;
  }

  function isGitHubPages() {
    return window.location.hostname.endsWith("github.io");
  }

  function getSiteBaseUrl() {
    return new URL(".", window.location.href).href.replace(/\/$/, "");
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  window.AttendanceApi = { call };
})();
