const crypto = require("node:crypto");

const DEFAULT_INTERVAL_MINUTES = 60;
const ALLOWED_INTERVALS = [30, 60, 180, 360];
const DEFAULT_APPS_SCRIPT_TIMEOUT_MS = 8000;
const ROSTER_CACHE_TTL_MS = 5 * 60 * 1000;
const ROSTER_STALE_TTL_MS = 12 * 60 * 60 * 1000;
const SETTINGS_CACHE_TTL_MS = 60 * 1000;
const SCHEDULE_CACHE_TTL_MS = 30 * 1000;
const RECENT_LOGS_CACHE_TTL_MS = 5 * 1000;

let rosterCache = {
  students: null,
  expiresAt: 0,
  staleUntil: 0
};
let settingsCache = {
  settings: null,
  expiresAt: 0
};
let scheduleCache = {
  payload: null,
  expiresAt: 0
};
let recentLogsCache = {
  payload: null,
  expiresAt: 0
};

exports.handler = async function handler(event) {
  try {
    const body = parseBody(event);
    const action = body.action || "";

    if (action === "qr") {
      const settings = await getPublicSettings();
      return json(getQrPayload(event, settings));
    }

    if (action === "roster") {
      return json(await getRosterPayload());
    }

    if (action === "schedule") {
      return json(await getSchedulePayload(isForceRefresh(body.refresh)));
    }

    if (action === "recentLogs") {
      return json(await getRecentLogsPayload(isForceRefresh(body.refresh)));
    }

    if (action === "log") {
      const settings = await getPublicSettings();
      const token = String(body.token || "").trim();
      if (!isTokenValid(token, settings)) {
        return json({ ok: false, message: "QR 코드가 만료되었습니다. 모니터의 최신 QR을 다시 스캔해 주세요." }, 400);
      }

      const result = await callAppsScript({
        action: "log",
        floor: body.floor,
        name: body.name,
        kind: body.kind
      }, { timeoutMs: 15000 });
      if (result.ok) {
        recentLogsCache = { payload: null, expiresAt: 0 };
      }
      return json(result);
    }

    if (action === "adminStatus") {
      requireAdmin(body.adminPin);
      const settings = await getPublicSettings();
      return json({
        ok: true,
        configured: {
          googleAppsScriptUrl: Boolean(process.env.GOOGLE_APPS_SCRIPT_URL),
          proxySecret: Boolean(process.env.ATTENDANCE_PROXY_SECRET),
          qrSecret: Boolean(process.env.ATTENDANCE_QR_SECRET),
          adminPin: Boolean(getAdminPin()),
          siteUrl: Boolean(process.env.ATTENDANCE_SITE_URL),
          timezone: Boolean(process.env.ATTENDANCE_TIMEZONE),
          refreshTimes: Boolean(process.env.ATTENDANCE_QR_REFRESH_TIMES)
        },
        settings
      });
    }

    if (action === "updateSettings") {
      requireAdmin(body.adminPin);
      const intervalMinutes = normalizeInterval(body.intervalMinutes);
      const result = await callAppsScript({
        action: "updateSettings",
        qrIntervalMinutes: intervalMinutes
      });
      if (!result.ok) return json(result, 400);
      const settings = normalizeSettings(result.settings);
      settingsCache = {
        settings,
        expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS
      };
      return json({ ok: true, settings });
    }

    return json({ ok: false, message: "알 수 없는 요청입니다." }, 400);
  } catch (error) {
    return json({ ok: false, message: error.message }, error.statusCode || 500);
  }
};

function parseBody(event) {
  if (event.httpMethod === "GET") {
    return event.queryStringParameters || {};
  }

  if (!event.body) return {};

  try {
    return JSON.parse(event.body);
  } catch (error) {
    throw new Error("요청 형식이 올바르지 않습니다.");
  }
}

async function getPublicSettings() {
  if (settingsCache.settings && Date.now() < settingsCache.expiresAt) {
    return settingsCache.settings;
  }

  try {
    const result = await callAppsScript({ action: "settings" }, { timeoutMs: 1500, retries: 1 });
    if (result.ok) {
      const settings = normalizeSettings(result.settings);
      settingsCache = {
        settings,
        expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS
      };
      return settings;
    }
  } catch (error) {
    // Keep QR working even if settings cannot be read briefly.
  }

  return normalizeSettings({
    qrIntervalMinutes: process.env.ATTENDANCE_QR_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES
  });
}

function normalizeSettings(settings = {}) {
  const refreshTimes = normalizeRefreshTimes(settings.qrRefreshTimes || process.env.ATTENDANCE_QR_REFRESH_TIMES);
  return {
    qrIntervalMinutes: normalizeInterval(settings.qrIntervalMinutes),
    qrRefreshTimes: refreshTimes,
    qrMode: refreshTimes.length ? "fixedTimes" : "interval"
  };
}

async function getRosterPayload() {
  const now = Date.now();
  if (rosterCache.students && now < rosterCache.expiresAt) {
    return { ok: true, students: rosterCache.students, cached: true };
  }

  try {
    const result = await callAppsScript({ action: "roster" }, { timeoutMs: getAppsScriptTimeoutMs(), retries: 2 });
    if (!result.ok) throw new Error(result.message || "명부를 불러오지 못했습니다.");

    const students = Array.isArray(result.students) ? result.students : [];
    rosterCache = {
      students,
      expiresAt: now + ROSTER_CACHE_TTL_MS,
      staleUntil: now + ROSTER_STALE_TTL_MS
    };

    return { ok: true, students, cached: false };
  } catch (error) {
    if (rosterCache.students && now < rosterCache.staleUntil) {
      return {
        ok: true,
        students: rosterCache.students,
        cached: true,
        stale: true,
        message: "명부 서버 연결이 지연되어 최근 명부를 사용합니다."
      };
    }
    throw new Error(`명부 연결이 불안정합니다. 잠시 후 다시 시도해 주세요. (${error.message})`);
  }
}

async function getSchedulePayload(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && scheduleCache.payload && now < scheduleCache.expiresAt) {
    return Object.assign({}, scheduleCache.payload, { cached: true });
  }

  const params = forceRefresh ? { action: "schedule", refresh: "1" } : { action: "schedule" };
  const result = await callAppsScript(params, { timeoutMs: getAppsScriptTimeoutMs(), retries: 1 });
  if (!result.ok) throw new Error(result.message || "시간표를 불러오지 못했습니다.");

  const payload = {
    ok: true,
    slots: Array.isArray(result.slots) ? result.slots : [],
    updatedAt: result.updatedAt || "",
    note: result.note || "구글시트 시간표와 연결되어 있습니다."
  };
  scheduleCache = {
    payload,
    expiresAt: now + SCHEDULE_CACHE_TTL_MS
  };
  return payload;
}

async function getRecentLogsPayload(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && recentLogsCache.payload && now < recentLogsCache.expiresAt) {
    return Object.assign({}, recentLogsCache.payload, { cached: true });
  }

  const params = forceRefresh ? { action: "recentLogs", refresh: "1" } : { action: "recentLogs" };
  const result = await callAppsScript(params, { timeoutMs: getAppsScriptTimeoutMs(), retries: 1 });
  if (!result.ok) throw new Error(result.message || "최근 출퇴근 기록을 불러오지 못했습니다.");

  const payload = {
    ok: true,
    entries: Array.isArray(result.entries) ? result.entries : [],
    updatedAt: result.updatedAt || ""
  };
  recentLogsCache = {
    payload,
    expiresAt: now + RECENT_LOGS_CACHE_TTL_MS
  };
  return payload;
}

function normalizeInterval(value) {
  const interval = Number(value || DEFAULT_INTERVAL_MINUTES);
  if (ALLOWED_INTERVALS.includes(interval)) return interval;
  return DEFAULT_INTERVAL_MINUTES;
}

function isForceRefresh(value) {
  const text = String(value || "").trim().toUpperCase();
  return text === "1" || text === "Y" || text === "YES" || text === "TRUE";
}

function normalizeRefreshTimes(value) {
  const times = Array.isArray(value) ? value : String(value || "").split(",");
  return times
    .map((time) => String(time || "").trim())
    .filter((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    .sort((left, right) => timeToMinutes(left) - timeToMinutes(right));
}

function timeToMinutes(time) {
  const [hour, minute] = String(time || "00:00").split(":").map(Number);
  return hour * 60 + minute;
}

function getQrPayload(event, settings) {
  requireEnv("ATTENDANCE_QR_SECRET");

  const slot = getCurrentSlot(settings);
  const token = createToken(slot.dateKey, slot.slotIndex, slot.tokenScope);
  const appUrl = getSiteUrl(event);
  const scanUrl = `${appUrl}/?token=${encodeURIComponent(token)}&v=${encodeURIComponent(getPageVersion(slot))}`;

  return {
    ok: true,
    token,
    scanUrl,
    slotLabel: slot.slotLabel,
    nextChangeAt: slot.nextChangeLabel,
    intervalMinutes: settings.qrIntervalMinutes,
    refreshTimes: settings.qrRefreshTimes,
    serverTime: slot.serverTime
  };
}

function getPageVersion(slot) {
  return `${slot.dateKey}.${slot.slotIndex}`;
}

async function callAppsScript(params, options = {}) {
  const scriptUrl = requireEnv("GOOGLE_APPS_SCRIPT_URL");
  const proxySecret = requireEnv("ATTENDANCE_PROXY_SECRET");
  const url = new URL(scriptUrl);
  const timeoutMs = Number(options.timeoutMs || getAppsScriptTimeoutMs());
  const retries = Number(options.retries || 0);

  Object.entries(Object.assign({}, params, { secret: proxySecret })).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  });

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchAppsScriptJson(url, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!error.retryable || attempt >= retries) break;
      await wait(500 + attempt * 900);
    }
  }

  throw lastError;
}

async function fetchAppsScriptJson(url, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Apps Script 응답 시간이 초과되었습니다.");
      timeoutError.retryable = true;
      throw timeoutError;
    }
    error.retryable = true;
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const text = await response.text();

  if (!response.ok) {
    const responseError = new Error(`Apps Script 응답 오류: ${response.status}`);
    responseError.retryable = response.status === 429 || response.status >= 500;
    throw responseError;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("Apps Script 응답을 해석하지 못했습니다.");
  }
}

function getAppsScriptTimeoutMs() {
  const configured = Number(process.env.ATTENDANCE_APPS_SCRIPT_TIMEOUT_MS || DEFAULT_APPS_SCRIPT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 2000 ? configured : DEFAULT_APPS_SCRIPT_TIMEOUT_MS;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCurrentSlot(settings) {
  const timezone = process.env.ATTENDANCE_TIMEZONE || "Asia/Seoul";
  const now = new Date();
  const parts = getZonedParts(now, timezone);
  const dateKey = `${parts.year}${parts.month}${parts.day}`;
  const dateLabel = `${parts.year}-${parts.month}-${parts.day}`;
  const serverTime = `${dateLabel} ${parts.hour}:${parts.minute}:${parts.second}`;
  const minutesNow = Number(parts.hour) * 60 + Number(parts.minute);
  const refreshMinutes = (settings.qrRefreshTimes || []).map(timeToMinutes);

  if (refreshMinutes.length) {
    return getFixedTimeSlot(now, timezone, dateKey, dateLabel, serverTime, minutesNow, settings.qrRefreshTimes, refreshMinutes);
  }

  const intervalMinutes = settings.qrIntervalMinutes;
  const slotIndex = Math.floor(minutesNow / intervalMinutes);
  const nextMinutes = (slotIndex + 1) * intervalMinutes;
  const slotsPerDay = Math.ceil(1440 / intervalMinutes);
  const previousDayParts = getZonedParts(new Date(now.getTime() - 24 * 60 * 60 * 1000), timezone);
  const previousDayKey = `${previousDayParts.year}${previousDayParts.month}${previousDayParts.day}`;

  return {
    dateKey,
    dateLabel,
    slotIndex,
    minutesNow,
    changedAt: slotIndex * intervalMinutes,
    previousDateKey: slotIndex > 0 ? dateKey : previousDayKey,
    previousSlotIndex: slotIndex > 0 ? slotIndex - 1 : slotsPerDay - 1,
    tokenScope: String(intervalMinutes),
    slotLabel: `${dateLabel} / ${intervalMinutes}분 주기`,
    nextChangeLabel: formatMinutes(nextMinutes),
    serverTime
  };
}

function getFixedTimeSlot(now, timezone, dateKey, dateLabel, serverTime, minutesNow, refreshTimes, refreshMinutes) {
  const previousDayParts = getZonedParts(new Date(now.getTime() - 24 * 60 * 60 * 1000), timezone);
  const previousDayKey = `${previousDayParts.year}${previousDayParts.month}${previousDayParts.day}`;
  let slotIndex = -1;

  refreshMinutes.forEach((minutes, index) => {
    if (minutesNow >= minutes) slotIndex = index;
  });

  const tokenScope = refreshTimes.join(",");
  if (slotIndex === -1) {
    return {
      dateKey: previousDayKey,
      dateLabel,
      slotIndex: refreshMinutes.length - 1,
      minutesNow,
      changedAt: refreshMinutes[refreshMinutes.length - 1] - 1440,
      previousDateKey: previousDayKey,
      previousSlotIndex: Math.max(0, refreshMinutes.length - 2),
      tokenScope,
      slotLabel: `${dateLabel} / 지정 시각 교체`,
      nextChangeLabel: formatMinutes(refreshMinutes[0]),
      serverTime
    };
  }

  const nextIndex = slotIndex + 1;
  const nextMinutes = nextIndex < refreshMinutes.length ? refreshMinutes[nextIndex] : refreshMinutes[0] + 1440;
  return {
    dateKey,
    dateLabel,
    slotIndex,
    minutesNow,
    changedAt: refreshMinutes[slotIndex],
    previousDateKey: slotIndex > 0 ? dateKey : previousDayKey,
    previousSlotIndex: slotIndex > 0 ? slotIndex - 1 : refreshMinutes.length - 1,
    tokenScope,
    slotLabel: `${dateLabel} / 지정 시각 교체`,
    nextChangeLabel: formatMinutes(nextMinutes),
    serverTime
  };
}

function getZonedParts(date, timezone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const values = {};
  formatter.formatToParts(date).forEach((part) => {
    if (part.type !== "literal") values[part.type] = part.value;
  });
  if (values.hour === "24") values.hour = "00";
  return values;
}

function isTokenValid(token, settings) {
  const slot = getCurrentSlot(settings);
  if (token === createToken(slot.dateKey, slot.slotIndex, slot.tokenScope)) return true;

  const graceMinutes = Number(process.env.ATTENDANCE_QR_GRACE_MINUTES || "3");
  const inGrace = slot.minutesNow - slot.changedAt < graceMinutes;
  return inGrace && token === createToken(slot.previousDateKey, slot.previousSlotIndex, slot.tokenScope);
}

function createToken(dateKey, slotIndex, tokenScope) {
  const body = `${dateKey}.${slotIndex}.${tokenScope}`;
  const signature = crypto
    .createHmac("sha256", requireEnv("ATTENDANCE_QR_SECRET"))
    .update(body)
    .digest("base64url")
    .slice(0, 18);
  return `${body}.${signature}`;
}

function formatMinutes(totalMinutes) {
  if (totalMinutes >= 1440) {
    return `내일 ${formatMinutes(totalMinutes - 1440)}`;
  }
  const hour = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minute = String(totalMinutes % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

function getAdminPin() {
  return process.env.ATTENDANCE_ADMIN_PIN || process.env.ATTENDANCE_DISPLAY_PIN || "";
}

function requireAdmin(pin) {
  const expected = getAdminPin();
  if (!expected) throw httpError("ATTENDANCE_ADMIN_PIN 환경변수가 설정되지 않았습니다.", 500);
  if (String(pin || "") !== expected) throw httpError("관리자 PIN이 올바르지 않습니다.", 401);
}

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getSiteUrl(event) {
  if (process.env.ATTENDANCE_SITE_URL) {
    return process.env.ATTENDANCE_SITE_URL.replace(/\/$/, "");
  }

  const host = event.headers.host || event.headers.Host;
  const proto = event.headers["x-forwarded-proto"] || "https";
  if (!host) throw new Error("사이트 주소를 확인하지 못했습니다.");
  return `${proto}://${host}`.replace(/\/$/, "");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 설정되지 않았습니다.`);
  return value;
}

function json(payload, statusCode = 200) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify(payload)
  };
}
