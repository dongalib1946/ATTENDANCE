const CONFIG = {
  SPREADSHEET_ID: "1u_1BWwQ_RHhlhDR4osz376vcZQSbl_7tOfMzOFoi6V4",
  ATTENDANCE_SHEET_NAME: "출퇴근기록",
  STUDENT_SHEET_NAME: "학생명부",
  SCHEDULE_SHEET_NAME: "시간표",
  TIMEZONE: "Asia/Seoul",
  TIMEZONE_PROPERTY: "ATTENDANCE_TIMEZONE",
  PROXY_SECRET_PROPERTY: "ATTENDANCE_PROXY_SECRET",
  QR_SECRET_PROPERTY: "ATTENDANCE_QR_SECRET",
  ADMIN_PIN_PROPERTY: "ATTENDANCE_ADMIN_PIN",
  DISPLAY_PIN_PROPERTY: "ATTENDANCE_DISPLAY_PIN",
  SITE_URL_PROPERTY: "ATTENDANCE_SITE_URL",
  QR_GRACE_MINUTES_PROPERTY: "ATTENDANCE_QR_GRACE_MINUTES",
  QR_INTERVAL_PROPERTY: "QR_INTERVAL_MINUTES",
  QR_REFRESH_TIMES_PROPERTY: "ATTENDANCE_QR_REFRESH_TIMES",
  DEFAULT_QR_INTERVAL_MINUTES: 60,
  ALLOWED_QR_INTERVAL_MINUTES: [30, 60, 180, 360],
  ROSTER_CACHE_KEY: "studentRoster:v1",
  ROSTER_CACHE_SECONDS: 300,
  SCHEDULE_CACHE_KEY: "interloanSchedule:v1",
  SCHEDULE_CACHE_SECONDS: 30,
  SCHEDULE_WEEKDAYS: ["월", "화", "수", "목", "금"],
  SCHEDULE_TIME_LABELS: ["1타임", "2타임", "3타임"]
};

function doGet(e) {
  const params = e.parameter || {};
  const action = params.action || "";
  let callback = "";

  try {
    callback = sanitizeCallback_(params.callback);
    const hasProxyAccess = isProxyAuthorized_(params.secret);

    let payload;
    if (action === "qr") {
      payload = getQrPayload_(params);
    } else if (action === "schedule") {
      const schedule = getSchedule_(isForceRefresh_(params.refresh));
      payload = {
        ok: true,
        dayLabel: schedule.dayLabel,
        slots: schedule.slots,
        updatedAt: getNowLabel_(),
        note: schedule.note
      };
    } else if (action === "roster") {
      if (!hasProxyAccess) requireValidToken_(params.token);
      payload = { ok: true, students: getRoster_() };
    } else if (action === "log") {
      if (!hasProxyAccess) requireValidToken_(params.token);
      payload = logAttendance_(params);
    } else if (action === "settings") {
      payload = { ok: true, settings: getSettings_() };
    } else if (action === "adminStatus") {
      requireAdmin_(params.adminPin);
      payload = getAdminStatus_();
    } else if (action === "updateSettings") {
      if (!hasProxyAccess) requireAdmin_(params.adminPin);
      payload = updateSettings_(params);
    } else {
      payload = { ok: false, message: "알 수 없는 요청입니다." };
    }

    return json_(payload, callback);
  } catch (error) {
    return json_({ ok: false, message: error.message }, callback);
  }
}

function setupSpreadsheet() {
  const ss = getSpreadsheet_();
  const attendance = getOrCreateSheet_(ss, CONFIG.ATTENDANCE_SHEET_NAME);
  const students = getOrCreateSheet_(ss, CONFIG.STUDENT_SHEET_NAME);
  const schedule = getOrCreateSheet_(ss, CONFIG.SCHEDULE_SHEET_NAME);

  if (attendance.getLastRow() === 0) {
    attendance.appendRow(["이름", "시간", "구분", "층"]);
  }

  if (students.getLastRow() === 0) {
    students.appendRow(["층", "이름", "사용여부", "비고"]);
    students.appendRow(["4층", "홍길동", "Y", ""]);
    students.appendRow(["5층", "김학생", "Y", ""]);
  }

  if (schedule.getLastRow() === 0) {
    schedule.appendRow(["요일", "1타임", "2타임", "3타임", "비고", "사용여부"]);
    CONFIG.SCHEDULE_WEEKDAYS.forEach(function (weekday) {
      schedule.appendRow([weekday, "", "", "", "", "Y"]);
    });
  }

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(CONFIG.QR_INTERVAL_PROPERTY)) {
    props.setProperty(CONFIG.QR_INTERVAL_PROPERTY, String(CONFIG.DEFAULT_QR_INTERVAL_MINUTES));
  }
}

function getSettings_() {
  const props = PropertiesService.getScriptProperties();
  const refreshTimes = normalizeRefreshTimes_(props.getProperty(CONFIG.QR_REFRESH_TIMES_PROPERTY));
  const interval = normalizeInterval_(props.getProperty(CONFIG.QR_INTERVAL_PROPERTY));
  return {
    qrIntervalMinutes: interval,
    qrRefreshTimes: refreshTimes,
    qrMode: refreshTimes.length ? "fixedTimes" : "interval"
  };
}

function updateSettings_(params) {
  const interval = normalizeInterval_(params.qrIntervalMinutes);
  PropertiesService
    .getScriptProperties()
    .setProperty(CONFIG.QR_INTERVAL_PROPERTY, String(interval));
  return { ok: true, settings: { qrIntervalMinutes: interval } };
}

function getAdminStatus_() {
  const props = PropertiesService.getScriptProperties();
  return {
    ok: true,
    configured: {
      googleAppsScriptUrl: true,
      proxySecret: Boolean(props.getProperty(CONFIG.PROXY_SECRET_PROPERTY)),
      qrSecret: Boolean(props.getProperty(CONFIG.QR_SECRET_PROPERTY)),
      adminPin: Boolean(getAdminPin_()),
      siteUrl: Boolean(props.getProperty(CONFIG.SITE_URL_PROPERTY)),
      timezone: Boolean(props.getProperty(CONFIG.TIMEZONE_PROPERTY)),
      refreshTimes: Boolean(props.getProperty(CONFIG.QR_REFRESH_TIMES_PROPERTY))
    },
    settings: getSettings_()
  };
}

function getQrPayload_(params) {
  requireScriptProperty_(CONFIG.QR_SECRET_PROPERTY);

  const settings = getSettings_();
  const slot = getCurrentSlot_(settings);
  const token = createToken_(slot.dateKey, slot.slotIndex, slot.tokenScope);
  const siteUrl = getSiteUrl_(params);

  return {
    ok: true,
    token: token,
    scanUrl: siteUrl + "/?token=" + encodeURIComponent(token) + "&v=" + encodeURIComponent(getPageVersion_(slot)),
    slotLabel: slot.slotLabel,
    nextChangeAt: slot.nextChangeLabel,
    intervalMinutes: settings.qrIntervalMinutes,
    refreshTimes: settings.qrRefreshTimes,
    serverTime: slot.serverTime
  };
}

function requireValidToken_(token) {
  if (!isTokenValid_(String(token || "").trim())) {
    throw new Error("QR 코드가 만료되었습니다. 모니터의 최신 QR을 다시 스캔해 주세요.");
  }
}

function isTokenValid_(token) {
  const settings = getSettings_();
  const slot = getCurrentSlot_(settings);
  if (token === createToken_(slot.dateKey, slot.slotIndex, slot.tokenScope)) return true;

  const graceMinutes = Number(
    PropertiesService
      .getScriptProperties()
      .getProperty(CONFIG.QR_GRACE_MINUTES_PROPERTY) || "3"
  );
  const inGrace = slot.minutesNow - slot.changedAt < graceMinutes;
  return inGrace && token === createToken_(slot.previousDateKey, slot.previousSlotIndex, slot.tokenScope);
}

function createToken_(dateKey, slotIndex, intervalMinutes) {
  const body = dateKey + "." + slotIndex + "." + intervalMinutes;
  const secret = requireScriptProperty_(CONFIG.QR_SECRET_PROPERTY);
  const signatureBytes = Utilities.computeHmacSha256Signature(body, secret);
  const signature = Utilities
    .base64EncodeWebSafe(signatureBytes)
    .replace(/=+$/, "")
    .slice(0, 18);
  return body + "." + signature;
}

function getCurrentSlot_(settings) {
  const now = new Date();
  const timezone = getTimezone_();
  const dateKey = Utilities.formatDate(now, timezone, "yyyyMMdd");
  const dateLabel = Utilities.formatDate(now, timezone, "yyyy-MM-dd");
  const serverTime = Utilities.formatDate(now, timezone, "yyyy-MM-dd HH:mm:ss");
  const hour = Number(Utilities.formatDate(now, timezone, "HH"));
  const minute = Number(Utilities.formatDate(now, timezone, "mm"));
  const minutesNow = hour * 60 + minute;
  const refreshMinutes = (settings.qrRefreshTimes || []).map(timeToMinutes_);

  if (refreshMinutes.length) {
    return getFixedTimeSlot_(now, timezone, dateKey, dateLabel, serverTime, minutesNow, settings.qrRefreshTimes, refreshMinutes);
  }

  const intervalMinutes = settings.qrIntervalMinutes;
  const slotIndex = Math.floor(minutesNow / intervalMinutes);
  const nextMinutes = (slotIndex + 1) * intervalMinutes;
  const slotsPerDay = Math.ceil(1440 / intervalMinutes);
  const previousDayKey = Utilities.formatDate(new Date(now.getTime() - 24 * 60 * 60 * 1000), timezone, "yyyyMMdd");
  return {
    dateKey: dateKey,
    dateLabel: dateLabel,
    slotIndex: slotIndex,
    minutesNow: minutesNow,
    changedAt: slotIndex * intervalMinutes,
    previousDateKey: slotIndex > 0 ? dateKey : previousDayKey,
    previousSlotIndex: slotIndex > 0 ? slotIndex - 1 : slotsPerDay - 1,
    tokenScope: String(intervalMinutes),
    slotLabel: dateLabel + " / " + intervalMinutes + "분 주기",
    nextChangeLabel: formatMinutes_(nextMinutes),
    serverTime: serverTime
  };
}

function getFixedTimeSlot_(now, timezone, dateKey, dateLabel, serverTime, minutesNow, refreshTimes, refreshMinutes) {
  const previousDayKey = Utilities.formatDate(new Date(now.getTime() - 24 * 60 * 60 * 1000), timezone, "yyyyMMdd");
  let slotIndex = -1;
  for (let index = 0; index < refreshMinutes.length; index += 1) {
    if (minutesNow >= refreshMinutes[index]) slotIndex = index;
  }

  const tokenScope = refreshTimes.join(",");
  if (slotIndex === -1) {
    return {
      dateKey: previousDayKey,
      dateLabel: dateLabel,
      slotIndex: refreshMinutes.length - 1,
      minutesNow: minutesNow,
      changedAt: refreshMinutes[refreshMinutes.length - 1] - 1440,
      previousDateKey: previousDayKey,
      previousSlotIndex: Math.max(0, refreshMinutes.length - 2),
      tokenScope: tokenScope,
      slotLabel: dateLabel + " / 지정 시각 교체",
      nextChangeLabel: formatMinutes_(refreshMinutes[0]),
      serverTime: serverTime
    };
  }

  const nextIndex = slotIndex + 1;
  const nextMinutes = nextIndex < refreshMinutes.length ? refreshMinutes[nextIndex] : refreshMinutes[0] + 1440;
  return {
    dateKey: dateKey,
    dateLabel: dateLabel,
    slotIndex: slotIndex,
    minutesNow: minutesNow,
    changedAt: refreshMinutes[slotIndex],
    previousDateKey: slotIndex > 0 ? dateKey : previousDayKey,
    previousSlotIndex: slotIndex > 0 ? slotIndex - 1 : refreshMinutes.length - 1,
    tokenScope: tokenScope,
    slotLabel: dateLabel + " / 지정 시각 교체",
    nextChangeLabel: formatMinutes_(nextMinutes),
    serverTime: serverTime
  };
}

function formatMinutes_(totalMinutes) {
  if (totalMinutes >= 1440) {
    return "내일 " + formatMinutes_(totalMinutes - 1440);
  }
  const hour = String(Math.floor(totalMinutes / 60));
  const minute = String(totalMinutes % 60);
  return pad2_(hour) + ":" + pad2_(minute);
}

function pad2_(value) {
  return String(value).length === 1 ? "0" + value : String(value);
}

function getSiteUrl_(params) {
  const configured = PropertiesService
    .getScriptProperties()
    .getProperty(CONFIG.SITE_URL_PROPERTY);
  const siteUrl = String(params.siteUrl || configured || "").trim().replace(/\/$/, "");
  if (!siteUrl) {
    throw new Error("ATTENDANCE_SITE_URL 스크립트 속성 또는 siteUrl 요청 값이 필요합니다.");
  }
  return siteUrl;
}

function getPageVersion_(slot) {
  return slot.dateKey + "." + slot.slotIndex;
}

function logAttendance_(params) {
  const floor = normalizeFloor_(params.floor || "");
  const name = String(params.name || "").trim();
  const kind = String(params.kind || "").trim();

  if (!floor) throw new Error("근무 위치를 선택해 주세요.");
  if (!name) throw new Error("이름을 선택해 주세요.");
  if (kind !== "in" && kind !== "out") throw new Error("출근 또는 퇴근을 선택해 주세요.");

  const roster = getRoster_();
  const exists = roster.some(function (student) {
    return student.floor === floor && student.name === name;
  });
  if (!exists) {
    throw new Error("학생명부에 없는 이름 또는 근무 위치입니다.");
  }

  const ss = getSpreadsheet_();
  const sheet = getOrCreateSheet_(ss, CONFIG.ATTENDANCE_SHEET_NAME);
  if (sheet.getLastRow() === 0) sheet.appendRow(["이름", "시간", "구분", "층"]);

  const now = new Date();
  const recordedAt = Utilities.formatDate(now, getTimezone_(), "yyyy-MM-dd HH:mm:ss");
  const kindLabel = kind === "in" ? "출근" : "퇴근";
  sheet.appendRow([name, recordedAt, kindLabel, floor]);

  return { ok: true, floor, name, kindLabel, recordedAt };
}

function getRoster_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CONFIG.ROSTER_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (error) {
      cache.remove(CONFIG.ROSTER_CACHE_KEY);
    }
  }

  const roster = readRoster_();
  cache.put(CONFIG.ROSTER_CACHE_KEY, JSON.stringify(roster), CONFIG.ROSTER_CACHE_SECONDS);
  return roster;
}

function getSchedule_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  const cached = forceRefresh ? "" : cache.get(CONFIG.SCHEDULE_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (error) {
      cache.remove(CONFIG.SCHEDULE_CACHE_KEY);
    }
  }

  const schedule = readSchedule_();
  cache.put(CONFIG.SCHEDULE_CACHE_KEY, JSON.stringify(schedule), CONFIG.SCHEDULE_CACHE_SECONDS);
  return schedule;
}

function readSchedule_() {
  const ss = getSpreadsheet_();
  const sheet = getOrCreateSheet_(ss, CONFIG.SCHEDULE_SHEET_NAME);
  ensureScheduleHeader_(sheet);

  const dayLabel = getTodayWeekday_();
  const schedule = createDefaultInterloanSchedule_(dayLabel);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || CONFIG.SCHEDULE_WEEKDAYS.indexOf(dayLabel) === -1) return schedule;

  const values = sheet.getRange(1, 1, lastRow, Math.max(6, sheet.getLastColumn())).getValues();
  const headers = values[0].map(function (header) {
    return normalizeHeader_(header);
  });
  const indexes = {
    weekday: findHeaderIndex_(headers, ["요일", "weekday", "day"]),
    first: findHeaderIndex_(headers, ["1타임", "1", "first", "time1"]),
    second: findHeaderIndex_(headers, ["2타임", "2", "second", "time2"]),
    third: findHeaderIndex_(headers, ["3타임", "3", "third", "time3"]),
    note: findHeaderIndex_(headers, ["비고", "메모", "note"]),
    active: findHeaderIndex_(headers, ["사용여부", "사용", "active"])
  };
  if (indexes.weekday === -1) return schedule;

  values.slice(1).forEach(function (row) {
    const rowDay = normalizeWeekday_(row[indexes.weekday]);
    if (rowDay !== dayLabel) return;

    const active = indexes.active === -1 ? "Y" : String(row[indexes.active] || "Y").trim().toUpperCase();
    if (!isActive_(active)) {
      schedule.note = dayLabel + "요일 상호대차 시간표가 비활성화되어 있습니다.";
      return;
    }

    schedule.slots[0].staff = normalizeScheduleText_(row[indexes.first]);
    schedule.slots[1].staff = normalizeScheduleText_(row[indexes.second]);
    schedule.slots[2].staff = normalizeScheduleText_(row[indexes.third]);
    schedule.note = indexes.note === -1 || !row[indexes.note]
      ? dayLabel + "요일 상호대차 담당자입니다."
      : normalizeScheduleText_(row[indexes.note]);
  });

  return schedule;
}

function ensureScheduleHeader_(sheet) {
  if (sheet.getLastRow() > 0) return;
  sheet.appendRow(["요일", "1타임", "2타임", "3타임", "비고", "사용여부"]);
}

function createDefaultInterloanSchedule_(dayLabel) {
  const isWeekday = CONFIG.SCHEDULE_WEEKDAYS.indexOf(dayLabel) !== -1;
  return {
    dayLabel: dayLabel,
    slots: CONFIG.SCHEDULE_TIME_LABELS.map(function (label) {
      return {
        label: label,
        staff: "",
        note: ""
      };
    }),
    note: isWeekday
      ? dayLabel + "요일 상호대차 담당자입니다."
      : "오늘은 상호대차 근무일이 아닙니다."
  };
}

function normalizeHeader_(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function findHeaderIndex_(headers, candidates) {
  for (let index = 0; index < candidates.length; index += 1) {
    const headerIndex = headers.indexOf(candidates[index]);
    if (headerIndex !== -1) return headerIndex;
  }
  return -1;
}

function normalizeWeekday_(value) {
  const text = String(value || "").trim().replace("요일", "");
  if (!text) return "";
  const englishWeekdays = {
    monday: "월",
    tuesday: "화",
    wednesday: "수",
    thursday: "목",
    friday: "금"
  };
  return englishWeekdays[text.toLowerCase()] || text;
}

function normalizeScheduleText_(value) {
  return String(value || "")
    .trim()
    .replace(/\s*,\s*/g, ", ")
    .replace(/\n{3,}/g, "\n\n");
}

function getNowLabel_() {
  return Utilities.formatDate(new Date(), getTimezone_(), "HH:mm");
}

function getTodayWeekday_() {
  const dateText = Utilities.formatDate(new Date(), getTimezone_(), "yyyy-MM-dd");
  const parts = dateText.split("-").map(function (part) {
    return Number(part);
  });
  const dayIndex = new Date(parts[0], parts[1] - 1, parts[2]).getDay();
  return ["일", "월", "화", "수", "목", "금", "토"][dayIndex];
}

function readRoster_() {
  const ss = getSpreadsheet_();
  const sheet = getOrCreateSheet_(ss, CONFIG.STUDENT_SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const values = sheet.getRange(2, 1, lastRow - 1, Math.max(4, sheet.getLastColumn())).getValues();
  return values
    .map(function (row) {
      return {
        floor: normalizeFloor_(row[0]),
        name: String(row[1] || "").trim(),
        active: String(row[2] || "Y").trim().toUpperCase()
      };
    })
    .filter(function (student) {
      return student.floor && student.name && isActive_(student.active);
    })
    .map(function (student) {
      return { floor: student.floor, name: student.name };
    });
}

function clearRosterCache() {
  CacheService.getScriptCache().remove(CONFIG.ROSTER_CACHE_KEY);
}

function clearScheduleCache() {
  CacheService.getScriptCache().remove(CONFIG.SCHEDULE_CACHE_KEY);
}

function isForceRefresh_(value) {
  const text = String(value || "").trim().toUpperCase();
  return text === "1" || text === "Y" || text === "YES" || text === "TRUE";
}

function normalizeInterval_(value) {
  const interval = Number(value || CONFIG.DEFAULT_QR_INTERVAL_MINUTES);
  if (CONFIG.ALLOWED_QR_INTERVAL_MINUTES.indexOf(interval) !== -1) return interval;
  return CONFIG.DEFAULT_QR_INTERVAL_MINUTES;
}

function normalizeRefreshTimes_(value) {
  return String(value || "")
    .split(",")
    .map(function (time) {
      return time.trim();
    })
    .filter(function (time) {
      return /^([01]\d|2[0-3]):[0-5]\d$/.test(time);
    })
    .sort(function (left, right) {
      return timeToMinutes_(left) - timeToMinutes_(right);
    });
}

function timeToMinutes_(time) {
  const parts = String(time || "00:00").split(":");
  return Number(parts[0]) * 60 + Number(parts[1]);
}

function getTimezone_() {
  return PropertiesService
    .getScriptProperties()
    .getProperty(CONFIG.TIMEZONE_PROPERTY) || CONFIG.TIMEZONE;
}

function isProxyAuthorized_(secret) {
  const expected = PropertiesService
    .getScriptProperties()
    .getProperty(CONFIG.PROXY_SECRET_PROPERTY);

  return Boolean(expected) && String(secret || "") === expected;
}

function requireAdmin_(pin) {
  const expected = getAdminPin_();
  if (!expected) {
    throw new Error("ATTENDANCE_ADMIN_PIN 또는 ATTENDANCE_DISPLAY_PIN 스크립트 속성이 설정되지 않았습니다.");
  }
  if (String(pin || "") !== expected) {
    throw new Error("관리자 PIN이 올바르지 않습니다.");
  }
}

function getAdminPin_() {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty(CONFIG.ADMIN_PIN_PROPERTY) || props.getProperty(CONFIG.DISPLAY_PIN_PROPERTY) || "";
}

function requireScriptProperty_(name) {
  const value = PropertiesService
    .getScriptProperties()
    .getProperty(name);

  if (!value) {
    throw new Error(name + " 스크립트 속성이 설정되지 않았습니다.");
  }
  return value;
}

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID && CONFIG.SPREADSHEET_ID !== "PASTE_YOUR_GOOGLE_SHEET_ID_HERE") {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error("활성 구글시트를 찾지 못했습니다. CONFIG.SPREADSHEET_ID를 입력해 주세요.");
  }
  return active;
}

function normalizeFloor_(value) {
  const text = String(value || "").trim();
  if (text === "4" || text === "4F" || text.toUpperCase() === "F4") return "4층";
  if (text === "5" || text === "5F" || text.toUpperCase() === "F5") return "5층";
  return text;
}

function isActive_(value) {
  return value !== "N" && value !== "NO" && value !== "FALSE" && value !== "비활성";
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function sanitizeCallback_(callback) {
  const text = String(callback || "").trim();
  if (!text) return "";
  if (/^[A-Za-z_$][0-9A-Za-z_$]*(\.[A-Za-z_$][0-9A-Za-z_$]*)*$/.test(text)) {
    return text;
  }
  throw new Error("callback 형식이 올바르지 않습니다.");
}

function json_(payload, callback) {
  const body = callback
    ? callback + "(" + JSON.stringify(payload) + ");"
    : JSON.stringify(payload);
  return ContentService
    .createTextOutput(body)
    .setMimeType(callback ? ContentService.MimeType.JAVASCRIPT : ContentService.MimeType.JSON);
}
