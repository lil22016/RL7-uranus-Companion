/*
 * 生活小 App 的后端：经期记录、专注陪伴（番茄钟）、他的位置（地图）。
 *
 * 以 mixin 的方式挂到 Companion 这个 Durable Object 上（index.js 里 Object.assign），
 * 所以这里的 this 就是那个 DO：get / put / list / save / settings / localNow / callLLM / pushBridge 都能直接用。
 *
 * 存储键：
 *   period:data   { records:[{id,startDate,endDate,flow,pain,symptoms,daily:{date:{flow,pain,symptoms,note}}}], settings:{cycleLength,periodLength,tellCharacter} }
 *   focus:cfg     计时长度、台词、立绘
 *   list:focus    完成的专注记录
 *   map:places    地点表
 *   map:state     他现在在哪 + 下次检查时间
 *   list:mapVisits 到过哪里（Session）
 *   map:meta      地图外观（种子、头像）、我的位置
 *   设置里的 settings.map：开关、模型、频率、静默时间
 */

const j = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID().slice(0, 13)}`;
const str = (v, n = 200) => String(v ?? "").trim().slice(0, n);
const isoD = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : "");
const hhmm = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || "")) ? String(v) : "");
const num = (v, a, b, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(a, Math.min(b, n)) : d;
};
const dayDiff = (a, b) => Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86400000);
const plusDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const toMin = (t) => {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
};

export const MAP_DEFAULTS = {
  enabled: false,
  source: "profile",
  profileId: "",
  uranusProviderId: "",
  model: "",
  minHours: 2,
  maxHours: 3,
  quiet: [{ start: "23:30", end: "08:00" }],
  syncToUranus: true,
  allowNewPlaces: true,
  usePersona: true,
  language: "",
  spontaneity: "normal", // low | normal | high：日程之外他有多「随性」
  reactToUser: true, // 你在地图上换了位置 → 过一会儿让他「看到」，自己决定要不要过来
};

export const PLACE_KINDS = ["home", "work", "study", "cafe", "food", "shop", "park", "gym", "bar", "friend", "transit", "culture", "other"];

/* ───────────── 经期：预测（前端有一份同样的算法，保持一致） ───────────── */

export function cycleSummary(records, settings, today) {
  const rs = [...(records || [])].filter((r) => isoD(r.startDate)).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const defC = num(settings?.cycleLength, 18, 60, 28);
  const defL = num(settings?.periodLength, 1, 15, 6);
  const cycles = [];
  for (let i = 1; i < rs.length; i++) {
    const d = dayDiff(rs[i - 1].startDate, rs[i].startDate);
    if (d >= 15 && d <= 60) cycles.push(d); // 太短 = 记错，太长 = 中间漏记，都不算
  }
  const lens = rs.map((r) => dayDiff(r.startDate, isoD(r.endDate) || r.startDate) + 1).filter((n) => n >= 1 && n <= 15);
  const avg = (a) => (a.length ? Math.round(a.slice(-6).reduce((x, y) => x + y, 0) / Math.min(a.length, 6)) : null);
  const avgCycle = avg(cycles) || defC;
  const avgLen = avg(lens) || defL;
  const last = rs[rs.length - 1] || null;
  const out = { avgCycle, avgLen, cyclesMeasured: cycles.length, last: last ? { startDate: last.startDate, endDate: last.endDate } : null };
  if (!last || !today) return out;
  if (today >= last.startDate && today <= (last.endDate || last.startDate)) out.inPeriod = { day: dayDiff(last.startDate, today) + 1, of: dayDiff(last.startDate, last.endDate) + 1 };
  out.cycleDay = dayDiff(last.startDate, today) + 1;
  const next = plusDays(last.startDate, avgCycle);
  out.nextStart = next;
  out.daysUntilNext = dayDiff(today, next);
  if (out.daysUntilNext < 0 && !out.inPeriod) out.lateBy = -out.daysUntilNext;
  const ov = plusDays(next, -14);
  out.ovulation = ov;
  out.fertile = { start: plusDays(ov, -5), end: plusDays(ov, 1) };
  return out;
}

function cleanRecord(r) {
  const startDate = isoD(r?.startDate);
  if (!startDate) return null;
  let endDate = isoD(r?.endDate) || startDate;
  if (endDate < startDate) endDate = startDate;
  if (dayDiff(startDate, endDate) > 20) endDate = plusDays(startDate, 20);
  const daily = {};
  for (const [k, v] of Object.entries(r?.daily || {})) {
    if (!isoD(k) || !v || typeof v !== "object") continue;
    daily[k] = { flow: num(v.flow, 0, 4, 0), pain: num(v.pain, 0, 3, 0), symptoms: str(v.symptoms === "无" ? "" : v.symptoms, 120), note: str(v.note, 300) };
  }
  return {
    id: str(r?.id || uid("pr"), 60),
    startDate,
    endDate,
    flow: num(r?.flow, 0, 4, 1),
    pain: num(r?.pain, 0, 3, 0),
    symptoms: str(r?.symptoms === "无" ? "" : r?.symptoms, 120),
    daily,
  };
}

/* ───────────── 地图：静默时间 ───────────── */

export function inQuiet(quiet, time) {
  const cur = toMin(time);
  for (const q of quiet || []) {
    if (!hhmm(q?.start) || !hhmm(q?.end)) continue;
    const a = toMin(q.start), b = toMin(q.end);
    if (a === b) continue;
    if (a < b ? cur >= a && cur < b : cur >= a || cur < b) return true;
  }
  return false;
}

function parseJsonLoose(t) {
  t = String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/```(?:json)?/gi, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("模型没有返回 JSON：" + t.slice(0, 160));
  return JSON.parse(t.slice(a, b + 1));
}

const normName = (s) => String(s || "").toLowerCase().replace(/[\s\-_·'’"“”.,，。!！?？()（）]/g, "");

/** 地点里的房间（子地图）：[{id,name,icon}]，按 id / 名字沿用旧 id，最多 12 个 */
function cleanRooms(arr, old = []) {
  const out = [], seen = new Set();
  for (const r of Array.isArray(arr) ? arr : []) {
    const name = str(r?.name, 30);
    if (!name || seen.has(normName(name))) continue;
    seen.add(normName(name));
    const prev = old.find((o) => (r.id && o.id === r.id) || normName(o.name) === normName(name));
    out.push({ id: prev?.id || str(r.id, 40) || uid("rm"), name, icon: str(r.icon, 8) || "" });
    if (out.length >= 12) break;
  }
  return out;
}
const findRoom = (pl, key) => (key ? (pl?.rooms || []).find((r) => r.id === key || normName(r.name) === normName(key)) : null);

export const LifeMixin = {
  /* ═════════════ 路由 ═════════════ */
  async lifeRoute(req, p, m) {
    if (p === "/api/period" && m === "GET") return this.periodGet();
    if (p === "/api/period" && m === "PUT") return this.periodPut(req);

    if (p === "/api/focus" && m === "GET") return this.focusGet();
    if (p === "/api/focus/cfg" && m === "PUT") return this.focusCfgPut(req);
    if (p === "/api/focus/log" && m === "POST") return this.focusLogAdd(req);
    if (p.startsWith("/api/focus/log/") && m === "DELETE") {
      const fid = p.split("/").pop();
      this.save("focus", this.list("focus").filter((x) => x.id !== fid));
      return j({ ok: true });
    }

    if (p === "/api/map" && m === "GET") return this.mapGet();
    if (p === "/api/map/settings" && m === "PUT") return this.mapSettingsPut(req);
    if (p === "/api/map/meta" && m === "PUT") return this.mapMetaPut(req);
    if (p === "/api/map/place" && m === "POST") {
      const b = await this.body(req);
      try {
        return j({ ok: true, place: this.mapAddPlace(b, "user") });
      } catch (e) {
        return j({ ok: false, error: e.message }, 400);
      }
    }
    if (p.startsWith("/api/map/place/") && m === "PATCH") {
      const b = await this.body(req);
      try {
        return j({ ok: true, place: this.mapUpdatePlace(p.split("/").pop(), b, "user") });
      } catch (e) {
        return j({ ok: false, error: e.message }, 400);
      }
    }
    if (p.startsWith("/api/map/place/") && m === "DELETE") return this.mapDeletePlace(p.split("/").pop());
    if (p === "/api/map/move" && m === "POST") {
      const b = await this.body(req);
      try {
        const r = await this.mapMoveTo(str(b.placeId, 80), str(b.activity, 160), "user", "", str(b.room, 40));
        return j({ ok: true, ...r });
      } catch (e) {
        return j({ ok: false, error: e.message }, 400);
      }
    }
    if (p === "/api/map/check" && m === "POST") {
      const r = await this.mapDecide("manual");
      return j(r, r.ok ? 200 : 502);
    }
    if (p.startsWith("/api/map/visit/") && m === "PATCH") {
      const b = await this.body(req), vid = p.split("/").pop();
      const arr = this.list("mapVisits"), v = arr.find((x) => x.id === vid);
      if (!v) return j({ ok: false, error: "找不到这条记录" }, 404);
      if (b.activity !== undefined) v.activity = str(b.activity, 160);
      if (b.note !== undefined) v.note = str(b.note, 400);
      this.save("mapVisits", arr);
      return j({ ok: true, visit: v });
    }
    if (p.startsWith("/api/map/visit/") && m === "DELETE") {
      const vid = p.split("/").pop();
      const st = this.mapState();
      if (st.visitId === vid) return j({ ok: false, error: "这是他现在所在的这一段，不能删。先让他换个地方。" }, 400);
      this.save("mapVisits", this.list("mapVisits").filter((x) => x.id !== vid));
      return j({ ok: true });
    }
    return null;
  },

  /* ═════════════ 经期 ═════════════ */
  periodData() {
    const d = this.get("period:data", null) || {};
    return {
      records: Array.isArray(d.records) ? d.records : [],
      settings: { cycleLength: 28, periodLength: 6, tellCharacter: true, ...(d.settings || {}) },
    };
  },
  periodGet() {
    const d = this.periodData(), today = this.localDate();
    return j({ ok: true, ...d, today, summary: cycleSummary(d.records, d.settings, today), characterName: this.settings().characterName, userName: this.settings().userName });
  },
  async periodPut(req) {
    const b = await this.body(req);
    const old = this.periodData();
    const records = (Array.isArray(b.records) ? b.records : old.records).map(cleanRecord).filter(Boolean);
    // 同一天开始的两条只留一条（导入时最容易撞上）
    const seen = new Set();
    const uniq = records.sort((a, b2) => a.startDate.localeCompare(b2.startDate)).filter((r) => (seen.has(r.startDate) ? false : seen.add(r.startDate)));
    const s = b.settings || {};
    const settings = {
      cycleLength: num(s.cycleLength ?? old.settings.cycleLength, 18, 60, 28),
      periodLength: num(s.periodLength ?? old.settings.periodLength, 1, 15, 6),
      tellCharacter: s.tellCharacter === undefined ? old.settings.tellCharacter !== false : !!s.tellCharacter,
    };
    this.put("period:data", { records: uniq.slice(-400), settings });
    // 新记了一次「今天 / 昨天开始」的经期 → 让他知道（只是背景，不会逼他回消息）
    const today = this.localDate();
    if (settings.tellCharacter) {
      const oldStarts = new Set(old.records.map((r) => r.startDate));
      const fresh = uniq.find((r) => !oldStarts.has(r.startDate) && dayDiff(r.startDate, today) >= 0 && dayDiff(r.startDate, today) <= 1);
      if (fresh) {
        const st = this.settings();
        this.pushBridge("user_life", `${st.userName || "The user"}'s period started ${fresh.startDate === today ? "today" : "yesterday"} (${fresh.startDate}).`, { origin: "period_tracker" }).catch(() => {});
      }
    }
    return this.periodGet();
  },

  /* ═════════════ 专注陪伴 ═════════════ */
  focusCfg() {
    const c = this.get("focus:cfg", null) || {};
    return {
      focusMinutes: 25,
      breakMinutes: 5,
      longBreakMinutes: 15,
      longEvery: 4,
      autoNext: false,
      keepAwake: false,
      tellCharacter: true,
      breathe: true,
      lines: {},
      ...c,
      art: this.focusArt(c.art),
    };
  },
  /** 立绘：Study 和 Stay 的布局不一样，大小 / 位置各存一份（旧数据只有一份 → 当作 Study 的） */
  focusArt(a) {
    a = a || {};
    const box = (o, d) => ({ scale: num(o?.scale, 40, 200, d.scale), x: num(o?.x, -220, 220, d.x), y: num(o?.y, -260, 260, d.y) });
    const legacy = { scale: a.scale ?? 100, x: a.x ?? 0, y: a.y ?? 0 };
    return {
      imageId: str(a.imageId, 80),
      flip: !!a.flip,
      study: box(a.study || legacy, { scale: 100, x: 0, y: 0 }),
      stay: box(a.stay, { scale: 82, x: 0, y: 0 }),
    };
  },
  focusGet() {
    const st = this.settings();
    const floor = plusDays(this.localDate(), -90);
    return j({ ok: true, cfg: this.focusCfg(), log: this.list("focus").filter((x) => (x.date || "") >= floor), today: this.localDate(), characterName: st.characterName, userName: st.userName });
  },
  async focusCfgPut(req) {
    const b = await this.body(req), o = this.focusCfg();
    const n = { ...o };
    for (const [k, a, z] of [["focusMinutes", 1, 180], ["breakMinutes", 1, 60], ["longBreakMinutes", 1, 90], ["longEvery", 0, 12]]) if (b[k] !== undefined) n[k] = num(b[k], a, z, o[k]);
    for (const k of ["autoNext", "keepAwake", "tellCharacter", "breathe"]) if (b[k] !== undefined) n[k] = !!b[k];
    if (b.lines && typeof b.lines === "object") {
      n.lines = {};
      for (const k of ["study", "soft", "tease", "stay", "done", "start"]) {
        if (Array.isArray(b.lines[k])) n.lines[k] = b.lines[k].map((x) => str(x, 200)).filter(Boolean).slice(0, 40);
      }
    }
    if (b.art && typeof b.art === "object") {
      const a = b.art;
      if (a.imageId !== undefined && a.imageId !== o.art.imageId && o.art.imageId) {
        // 换了图：旧图删掉，不然一直占着存储
        try {
          this.deleteImage(o.art.imageId);
        } catch {}
      }
      n.art = this.focusArt({
        imageId: a.imageId !== undefined ? a.imageId : o.art.imageId,
        flip: a.flip !== undefined ? a.flip : o.art.flip,
        study: a.study ? { ...o.art.study, ...a.study } : o.art.study,
        stay: a.stay ? { ...o.art.stay, ...a.stay } : o.art.stay,
      });
    }
    this.put("focus:cfg", n);
    return j({ ok: true, cfg: n });
  },
  async focusLogAdd(req) {
    const b = await this.body(req);
    const minutes = num(b.minutes, 1, 600, 0);
    if (!minutes) return j({ ok: false, error: "minutes required" }, 400);
    const ln = this.localNow();
    const item = { id: uid("fc"), date: isoD(b.date) || ln.date, end: hhmm(b.end) || ln.time, minutes, task: str(b.task, 120), createdAt: nowIso() };
    const arr = this.list("focus");
    arr.push(item);
    this.save("focus", arr.slice(-3000));
    const cfg = this.focusCfg();
    if (cfg.tellCharacter) {
      const todays = arr.filter((x) => x.date === item.date);
      const total = todays.reduce((s, x) => s + x.minutes, 0);
      const last = Number(this.get("focus:lastPush", 0)) || 0;
      // 连着几个番茄的时候不要每个都推，20 分钟内只推一次（下一次推的时候带着当天总数）
      if (Date.now() - last > 20 * 60000) {
        this.put("focus:lastPush", Date.now());
        const st = this.settings();
        this.pushBridge("user_life", `${st.userName || "The user"} finished a ${minutes}-min focus session at ${item.end}${item.task ? ` (${item.task})` : ""}. Today so far: ${todays.length} session${todays.length > 1 ? "s" : ""}, ${total} min.`, { origin: "focus_timer" }).catch(() => {});
      }
    }
    return j({ ok: true, item });
  },

  /* ═════════════ 地图 ═════════════ */
  mapSettings() {
    const m = { ...MAP_DEFAULTS, ...(this.settings().map || {}) };
    m.minHours = num(m.minHours, 0.5, 12, 2);
    m.maxHours = num(m.maxHours, m.minHours, 24, Math.max(3, m.minHours));
    m.quiet = (Array.isArray(m.quiet) ? m.quiet : []).filter((q) => hhmm(q?.start) && hhmm(q?.end)).slice(0, 4);
    return m;
  },
  mapState() {
    return { placeId: "", roomId: "", activity: "", since: "", visitId: "", reactAt: 0, reactPlace: "", by: "", nextCheckAt: 0, lastCheckAt: 0, lastError: "", lastReason: "", ...(this.get("map:state", null) || {}) };
  },
  mapMeta() {
    return { seed: 0, avatarRole: "", avatarUser: "", me: { placeId: "", x: null, y: null, visible: true, since: "" }, ...(this.get("map:meta", null) || {}) };
  },
  mapPlaces() {
    return this.get("map:places", []) || [];
  },
  mapGet() {
    const st = this.settings();
    const floor = plusDays(this.localDate(), -60);
    return j({
      ok: true,
      settings: this.mapSettings(),
      state: this.mapState(),
      meta: this.mapMeta(),
      places: this.mapPlaces(),
      visits: this.list("mapVisits").filter((v) => (v.date || "") >= floor),
      today: this.localDate(),
      now: this.localNow().time,
      tz: this.tzName(),
      quietNow: inQuiet(this.mapSettings().quiet, this.localNow().time),
      characterName: st.characterName,
      userName: st.userName,
      kinds: PLACE_KINDS,
      // 设置面板选模型用：只给名字，不给 key
      profiles: (st.modelProfiles || []).map((p) => ({ id: p.id, name: p.name || p.model || "未命名", model: p.model || "" })),
      mainProfileId: st.agent?.profileId || "",
    });
  },
  async mapSettingsPut(req) {
    const b = await this.body(req);
    const all = this.get("settings", {});
    const cur = { ...MAP_DEFAULTS, ...(all.map || {}) };
    const n = { ...cur };
    for (const k of ["enabled", "syncToUranus", "allowNewPlaces", "usePersona", "reactToUser"]) if (b[k] !== undefined) n[k] = !!b[k];
    if (["low", "normal", "high"].includes(b.spontaneity)) n.spontaneity = b.spontaneity;
    for (const k of ["source", "profileId", "uranusProviderId", "model", "language"]) if (b[k] !== undefined) n[k] = str(b[k], 200);
    if (b.minHours !== undefined) n.minHours = num(b.minHours, 0.5, 12, 2);
    if (b.maxHours !== undefined) n.maxHours = num(b.maxHours, 0.5, 24, 3);
    if (Array.isArray(b.quiet)) n.quiet = b.quiet.filter((q) => hhmm(q?.start) && hhmm(q?.end)).slice(0, 4).map((q) => ({ start: q.start, end: q.end }));
    this.put("settings", { ...all, map: n });
    // 刚打开：下一跳就检查，不用等
    if (n.enabled && !cur.enabled) this.put("map:state", { ...this.mapState(), nextCheckAt: 0 });
    return j({ ok: true, settings: this.mapSettings() });
  },
  async mapMetaPut(req) {
    const b = await this.body(req), o = this.mapMeta();
    const n = { ...o };
    if (b.seed !== undefined) n.seed = num(b.seed, 0, 2 ** 31, 0) | 0;
    for (const k of ["avatarRole", "avatarUser"]) {
      if (b[k] === undefined) continue;
      const v = str(b[k], 80);
      if (o[k] && o[k] !== v) {
        try {
          this.deleteImage(o[k]);
        } catch {}
      }
      n[k] = v;
    }
    if (b.me && typeof b.me === "object") {
      n.me = {
        placeId: b.me.placeId !== undefined ? str(b.me.placeId, 80) : o.me.placeId,
        x: b.me.x === null ? null : b.me.x !== undefined ? num(b.me.x, 0, 1000, 500) : o.me.x,
        y: b.me.y === null ? null : b.me.y !== undefined ? num(b.me.y, 0, 1000, 500) : o.me.y,
        visible: b.me.visible !== undefined ? !!b.me.visible : o.me.visible,
        since: o.me.since || "",
      };
      const changed = n.me.placeId !== o.me.placeId || n.me.x !== o.me.x || n.me.y !== o.me.y || (n.me.visible && !o.me.visible);
      if (changed) n.me.since = nowIso();
      // 你换了地方：过 5–25 分钟让他「看到」，自己决定要不要过来（不是每次都会来）
      const ms = this.mapSettings(), st = this.mapState();
      const pl = this.mapPlaces().find((x) => x.id === n.me.placeId);
      if (changed && ms.enabled && ms.reactToUser && n.me.visible && pl && pl.id !== st.placeId) {
        this.put("map:state", { ...st, reactAt: Date.now() + Math.round((5 + Math.random() * 20) * 60000), reactPlace: pl.id });
      } else if (!n.me.visible && st.reactAt) {
        this.put("map:state", { ...st, reactAt: 0, reactPlace: "" });
      }
    }
    this.put("map:meta", n);
    return j({ ok: true, meta: n });
  },
  mapAddPlace(b, by) {
    const name = str(b.name, 60);
    if (!name) throw new Error("地点名称不能为空");
    const places = this.mapPlaces();
    const dup = places.find((x) => normName(x.name) === normName(name));
    if (dup) return dup;
    if (places.length >= 120) throw new Error("地点太多了（最多 120 个），先删掉一些");
    const kind = PLACE_KINDS.includes(b.kind) ? b.kind : "other";
    const place = {
      id: uid("pl"),
      name,
      kind,
      note: str(b.note, 300),
      rooms: cleanRooms(b.rooms),
      x: b.x === undefined || b.x === null ? null : num(b.x, 0, 1000, 500),
      y: b.y === undefined || b.y === null ? null : num(b.y, 0, 1000, 500),
      by,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    places.push(place);
    this.put("map:places", places);
    return place;
  },
  mapUpdatePlace(pid, b, by) {
    const places = this.mapPlaces();
    const pl = places.find((x) => x.id === pid);
    if (!pl) throw new Error("找不到这个地点");
    if (b.name !== undefined) {
      const name = str(b.name, 60);
      if (!name) throw new Error("地点名称不能为空");
      if (places.some((x) => x.id !== pid && normName(x.name) === normName(name))) throw new Error("已经有同名的地点了");
      pl.name = name;
    }
    if (b.kind !== undefined && PLACE_KINDS.includes(b.kind)) pl.kind = b.kind;
    if (b.note !== undefined) pl.note = str(b.note, 300);
    if (Array.isArray(b.rooms)) pl.rooms = cleanRooms(b.rooms, pl.rooms || []);
    if (b.x !== undefined) pl.x = b.x === null ? null : num(b.x, 0, 1000, 500);
    if (b.y !== undefined) pl.y = b.y === null ? null : num(b.y, 0, 1000, 500);
    pl.updatedAt = nowIso();
    pl.editedBy = by;
    this.put("map:places", places);
    // Session 里存的是当时的名字快照，改名以后让「当前这一段」也跟上
    const st = this.mapState();
    if (st.placeId === pid && st.roomId && !findRoom(pl, st.roomId)) this.put("map:state", { ...st, roomId: "" });
    if (st.placeId === pid && st.visitId && b.name !== undefined) {
      const arr = this.list("mapVisits"), v = arr.find((x) => x.id === st.visitId);
      if (v) {
        v.placeName = pl.name;
        this.save("mapVisits", arr);
      }
    }
    return pl;
  },
  mapDeletePlace(pid) {
    const st = this.mapState();
    if (st.placeId === pid) return j({ ok: false, error: "他现在就在这里，不能删。先把他挪到别的地方。" }, 400);
    this.put("map:places", this.mapPlaces().filter((x) => x.id !== pid));
    const meta = this.mapMeta();
    if (meta.me?.placeId === pid) this.put("map:meta", { ...meta, me: { ...meta.me, placeId: "" } });
    return j({ ok: true });
  },

  /**
   * 把他挪到某个地点 / 某个房间（同一个地点里换房间、换在做的事，算同一段停留）。
   * by: model | mcp | user
   */
  async mapMoveTo(placeId, activity, by, reason = "", roomKey = "") {
    const places = this.mapPlaces();
    const pl = places.find((x) => x.id === placeId);
    if (!pl) throw new Error("找不到这个地点");
    const room = findRoom(pl, roomKey);
    const st = this.mapState();
    const ln = this.localNow();
    const visits = this.list("mapVisits");
    const at = nowIso();
    let moved = false, roomChanged = false;
    if (st.placeId === pl.id && st.visitId && visits.some((v) => v.id === st.visitId)) {
      const v = visits.find((x) => x.id === st.visitId);
      roomChanged = !!room && room.id !== st.roomId;
      if ((activity && activity !== v.activity) || roomChanged) {
        v.log = [...(v.log || []), { at, time: ln.time, activity: activity || v.activity, room: room?.name || "" }].slice(-16);
        if (activity) v.activity = activity;
      }
      if (room) Object.assign(v, { roomId: room.id, roomName: room.name });
      st.activity = activity || st.activity;
      if (room) st.roomId = room.id;
    } else {
      const cur = visits.find((x) => x.id === st.visitId);
      if (cur && !cur.end) {
        cur.end = at;
        cur.endTime = ln.time;
        cur.endDate = ln.date;
      }
      const v = { id: uid("vs"), placeId: pl.id, placeName: pl.name, kind: pl.kind, roomId: room?.id || "", roomName: room?.name || "", activity, start: at, date: ln.date, startTime: ln.time, end: "", by, log: activity || room ? [{ at, time: ln.time, activity, room: room?.name || "" }] : [] };
      visits.push(v);
      Object.assign(st, { placeId: pl.id, roomId: room?.id || "", activity, since: at, visitId: v.id });
      moved = true;
    }
    st.by = by;
    if (reason) st.lastReason = reason;
    this.save("mapVisits", visits.slice(-1500));
    this.put("map:state", st);
    // 让他在聊天里也知道自己在哪（他自己通过 MCP 挪的就不用再告诉他了）
    const ms = this.mapSettings();
    if (ms.syncToUranus && by !== "mcp" && (moved || roomChanged || activity)) {
      const name = this.settings().characterName || "The character";
      const where = `${pl.name}${room ? ` (${room.name})` : ""}`;
      this.pushBridge("character_life", `${ln.time} ${name} ${moved ? "is now at" : roomChanged ? "moved to" : "is still at"} ${where}${activity ? ` — ${activity}` : ""}.`, { origin: "map_location" }).catch(() => {});
    }
    return { moved, roomChanged, place: pl, room, state: st };
  },

  /** 定时器每一跳都调；没到点 / 静默时间 / 没开就什么也不做（不调模型、不花 token） */
  async mapTick() {
    const ms = this.mapSettings();
    if (!ms.enabled) return;
    const ln = this.localNow();
    if (inQuiet(ms.quiet, ln.time)) return;
    const st = this.mapState(), now = Date.now();
    // 你刚换了位置：到点就让他「看到」并决定（离上次判断太近就往后挪一点）
    if (st.reactAt && now >= st.reactAt) {
      if (st.lastCheckAt && now - st.lastCheckAt < 15 * 60000) {
        this.put("map:state", { ...st, reactAt: st.lastCheckAt + 15 * 60000 });
        return;
      }
      await this.mapDecide("user_moved");
      return;
    }
    if (st.nextCheckAt && now < st.nextCheckAt) return;
    if (st.lastCheckAt && now - st.lastCheckAt < 25 * 60000) return; // 保险：怎么都不会 25 分钟内连调两次
    await this.mapDecide("scheduled");
  },

  async mapDecide(reason) {
    const ms = this.mapSettings();
    const st = this.mapState();
    const now = Date.now();
    st.lastCheckAt = now;
    const plan = (hours) => now + Math.round(hours * 3600000);
    const randomNext = () => plan(ms.minHours + Math.random() * (ms.maxHours - ms.minHours));
    try {
      const places = this.mapPlaces();
      if (!places.length && !ms.allowNewPlaces) throw new Error("地点表是空的：先在地图的「地点」里加几个地方。");
      const s = this.settings();
      const ln = this.localNow();
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone: this.tzName(), weekday: "long" }).format(new Date());
      const name = s.characterName || "the character";
      const cur = places.find((x) => x.id === st.placeId);
      const visits = this.list("mapVisits");
      const recent = visits.slice(-8).map((v) => `${v.date} ${v.startTime}${v.end ? `–${v.endTime}` : "–now"} ${v.placeName}${v.activity ? ` (${v.activity})` : ""}`);
      const sched = this.list("schedule")
        .filter((x) => x.owner === "character" && x.date === ln.date)
        .sort((a, b) => String(a.time || "99").localeCompare(String(b.time || "99")))
        .slice(0, 15)
        .map((x) => `${x.time || "anytime"}${x.end ? `–${x.end}` : ""} ${x.text}${x.status && x.status !== "planned" ? ` [${x.status}]` : ""}`);
      const placeLines = places.slice(0, 60).map((p) => `${p.id} | ${p.name} | ${p.kind}${p.note ? ` | ${p.note.slice(0, 80)}` : ""}${p.rooms?.length ? ` | rooms: ${p.rooms.map((r) => r.name).join(", ")}` : ""}`);
      const curRoom = findRoom(cur, st.roomId);
      // 她在哪 + 她今天的安排（Companion 里她自己的待办 + DDL Garden）
      const userName = s.userName || "the user";
      const meta = this.mapMeta();
      const herPlace = meta.me?.visible !== false ? places.find((x) => x.id === meta.me?.placeId) : null;
      const fmtT = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { timeZone: this.tzName(), weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }) : "?");
      const herSched = this.list("schedule")
        .filter((x) => x.owner === "user" && x.date === ln.date)
        .map((x) => `${x.time || "anytime"}${x.end ? `–${x.end}` : ""} ${x.text}${x.status && x.status !== "planned" ? ` [${x.status}]` : ""}`);
      for (const t of this.get("garden:snap", null)?.tasks || []) if (t.date === ln.date) herSched.push(`${(t.kind === "event" ? t.start : t.time) || "anytime"}${t.end ? `–${t.end}` : ""} ${t.course ? t.course + " · " : ""}${t.title}${t.done ? " [done]" : ""}`);
      herSched.sort();
      const reactPlace = reason === "user_moved" ? places.find((x) => x.id === st.reactPlace) : null;
      const spont = {
        low: `Stick closely to ${name}'s schedule and usual routine; only move when the schedule or the time of day calls for it.`,
        normal: `The schedule is a guide, not a script. Between and around plans ${name} lives naturally: errands, a coffee, a walk, moving between rooms at home, sometimes dropping by to see ${userName} when it fits who he is and what he has going on.`,
        high: `${name} is spontaneous. Besides the schedule he takes detours, wanders, runs errands on a whim, and fairly often decides on impulse to go see ${userName} where she is (if it fits his plans and the time).`,
      }[ms.spontaneity] || "";
      const persona = ms.usePersona ? String(s.agent?.persona || "").trim().slice(0, 1200) : "";
      const quiet = ms.quiet.map((q) => `${q.start}–${q.end}`).join(", ");
      const sys = [
        `You track where ${name} physically is during the day, like a shared-location app. Decide where ${name} most plausibly is RIGHT NOW and what they are doing.`,
        `Be realistic and consistent: respect the time of day and weekday, don't teleport around for no reason (staying put is often right), and don't invent dramatic events. Fixed commitments in the schedule (meetings, classes, appointments) still happen.`,
        spont,
        `If the chosen place has rooms, pick the room he is in (people move between rooms at home: kitchen for food, bathroom in the morning, bedroom late at night, etc.).`,
        ms.allowNewPlaces ? `Prefer the known places. Only if none fits, you may create ONE new place (short name, a realistic everyday location).` : `You MUST choose one of the known places.`,
        `${ms.language ? `Write "activity" in ${ms.language}.` : `Write "activity" in the same language as the place names.`} "activity" is a short phrase (max 12 words), e.g. "working on the quarterly report".`,
        `Reply with ONLY a JSON object: {"placeId": "<id of a known place, or empty>", "newPlace": null | {"name": "...", "kind": "${PLACE_KINDS.join("|")}", "note": "..."}, "room": "<room name of that place, or empty>", "activity": "...", "visitingUser": true|false, "expectedStayMinutes": <number>, "reason": "<one short sentence>"}`,
      ].join("\n");
      const user = [
        persona ? `ABOUT ${name.toUpperCase()}:\n${persona}` : "",
        `NOW: ${weekday} ${ln.date} ${ln.time} (${this.tzName()})`,
        quiet ? `(Overnight quiet hours with no checks: ${quiet}. Whatever you pick may need to last until the next check.)` : "",
        `CURRENTLY: ${cur ? `${cur.name} (${cur.id})${curRoom ? `, in the ${curRoom.name}` : ""}, since ${fmtT(st.since)}${st.activity ? `, ${st.activity}` : ""}` : "unknown"}`,
        `${userName.toUpperCase()} RIGHT NOW: ${herPlace ? `at ${herPlace.name} (${herPlace.id}) since ${fmtT(meta.me.since)}` : "location not shared"}`,
        `${userName.toUpperCase()}'S PLANS TODAY:\n${herSched.slice(0, 12).join("\n") || "(nothing listed)"}`,
        reactPlace ? `TRIGGER: ${userName} just updated her location to ${reactPlace.name} a few minutes ago, and ${name} noticed. Decide whether he does anything about it — going to see her, meeting her nearby, or simply carrying on — whatever fits him, his plans and the time. He does not always come running.` : "",
        `KNOWN PLACES (id | name | kind | note):\n${placeLines.join("\n") || "(none yet)"}`,
        `${name.toUpperCase()}'S SCHEDULE TODAY:\n${sched.join("\n") || "(nothing scheduled)"}`,
        `RECENT MOVEMENTS:\n${recent.join("\n") || "(none)"}`,
      ]
        .filter(Boolean)
        .join("\n\n");
      const out = await this.callLLM({ source: ms.source, profileId: ms.profileId, uranusProviderId: ms.uranusProviderId, model: ms.model }, [{ role: "system", content: sys }, { role: "user", content: user }], 700);
      const d = parseJsonLoose(out);
      let pid = str(d.placeId, 80);
      if (!places.some((x) => x.id === pid)) {
        // 模型有时把名字当 id 写
        const byName = places.find((x) => normName(x.name) === normName(d.placeId) || (d.newPlace && normName(x.name) === normName(d.newPlace.name)));
        pid = byName?.id || "";
      }
      if (!pid && d.newPlace && ms.allowNewPlaces) pid = this.mapAddPlace({ name: d.newPlace.name, kind: d.newPlace.kind, note: d.newPlace.note }, "character").id;
      if (!pid) throw new Error("模型没选出有效的地点：" + out.slice(0, 160));
      const r = await this.mapMoveTo(pid, str(d.activity, 160), "model", str(d.reason, 300), str(d.room, 40));
      const stay = Number(d.expectedStayMinutes);
      const next = Number.isFinite(stay) && stay > 0 ? plan(Math.max(ms.minHours, Math.min(ms.maxHours, stay / 60))) : randomNext();
      const st2 = this.mapState();
      // 被你触发的那次不打乱原来的节奏：下次常规检查不早于原定时间
      const keep = reason === "user_moved" && st.nextCheckAt > now ? Math.max(st.nextCheckAt, next) : next;
      this.put("map:state", { ...st2, lastCheckAt: now, nextCheckAt: keep, lastError: "", reactAt: 0, reactPlace: "" });
      return { ok: true, ...r, reason: str(d.reason, 300), nextCheckAt: keep, visitingUser: !!d.visitingUser };
    } catch (e) {
      const st2 = this.mapState();
      // 出错 30 分钟后再试，不要每 10 分钟都去撞
      this.put("map:state", { ...st2, lastCheckAt: now, reactAt: 0, reactPlace: "", nextCheckAt: now + 30 * 60000, lastError: `${new Date().toISOString()} ${String(e.message || e).slice(0, 300)}` });
      try {
        this.add("notifications", { id: uid("n"), text: `地图位置更新失败（${reason}）：${String(e.message || e).slice(0, 200)}`, read: false, createdAt: nowIso(), activityDate: this.localDate() });
      } catch {}
      return { ok: false, error: String(e.message || e) };
    }
  },

  /* ═════════════ MCP ═════════════ */
  lifeMcpTools() {
    return [
      {
        name: "get_my_location",
        description: "Where YOU are right now on the shared location map (the user can see it like Find My), what you're doing there, today's trail of places, and the list of known places with ids.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "move_to",
        description: "Update YOUR location on the shared map when you actually go somewhere (or update what you're doing where you are). Use a known placeId, or give placeName; an unknown placeName creates a new place. Only call this when your location really changes in the story — don't move around just to show off.",
        inputSchema: { type: "object", properties: { placeId: { type: "string" }, placeName: { type: "string" }, kind: { type: "string", enum: PLACE_KINDS }, room: { type: "string", description: "optional: room inside that place (e.g. kitchen at home); unknown room names are added" }, activity: { type: "string", description: "short phrase: what you're doing there" } } },
      },
      {
        name: "add_place",
        description: "Add a place you go to (home, office, a café you like…) to the shared map without moving there.",
        inputSchema: { type: "object", properties: { name: { type: "string" }, kind: { type: "string", enum: PLACE_KINDS }, note: { type: "string" } }, required: ["name"] },
      },
      {
        name: "add_room",
        description: "Add a room / area inside a place (e.g. bedroom, kitchen, bathroom at home; meeting room at the office). Rooms show up on the place's floor plan.",
        inputSchema: { type: "object", properties: { placeId: { type: "string" }, placeName: { type: "string" }, name: { type: "string" }, icon: { type: "string", description: "one emoji, optional" } }, required: ["name"] },
      },
      {
        name: "update_place",
        description: "Rename a place, change its kind, or edit its note.",
        inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, kind: { type: "string", enum: PLACE_KINDS }, note: { type: "string" } }, required: ["id"] },
      },
      {
        name: "get_user_cycle",
        description: "READ-ONLY: the user's menstrual cycle from their period tracker — whether they're on their period now (and which day), predicted next period, average cycle length, and recent periods. Use it to be considerate; don't bring it up out of nowhere.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_user_focus",
        description: "READ-ONLY: the user's focus/study timer sessions (Study with you) for a day — how many sessions, minutes, and what they worked on.",
        inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD, default today" } } },
      },
    ];
  },
  async lifeMcpCall(name, a) {
    const ln = this.localNow();
    const placeOut = (p) => p && { id: p.id, name: p.name, kind: p.kind, note: p.note || "", addedBy: p.by, ...(p.rooms?.length ? { rooms: p.rooms.map((r) => r.name) } : {}) };
    if (name === "get_my_location") {
      const st = this.mapState(), places = this.mapPlaces();
      const cur = places.find((x) => x.id === st.placeId);
      return {
        now: `${ln.date} ${ln.time}`,
        timezone: this.tzName(),
        current: cur ? { place: placeOut(cur), room: findRoom(cur, st.roomId)?.name || "", activity: st.activity, since: st.since } : null,
        user: (() => {
          const m = this.mapMeta(), hp = m.me?.visible !== false ? places.find((x) => x.id === m.me?.placeId) : null;
          return hp ? { name: this.settings().userName, at: hp.name, since: m.me.since || "" } : { name: this.settings().userName, at: null, note: "She hasn't shared her location on the map." };
        })(),
        todayTrail: this.list("mapVisits").filter((v) => v.date === ln.date || (!v.end && v.id === st.visitId)).map((v) => ({ place: v.placeName, room: v.roomName || "", from: v.startTime, to: v.end ? v.endTime : "now", activity: v.activity })),
        places: places.map(placeOut),
      };
    }
    if (name === "move_to") {
      const places = this.mapPlaces();
      let pl = places.find((x) => x.id === str(a.placeId, 80)) || places.find((x) => normName(x.name) === normName(a.placeName));
      if (!pl) {
        if (!str(a.placeName)) throw new Error("Give a placeId from get_my_location, or a placeName.");
        if (!this.mapSettings().allowNewPlaces) throw new Error("New places are disabled; pick one of the known places (see get_my_location).");
        pl = this.mapAddPlace({ name: a.placeName, kind: a.kind }, "character");
      }
      let roomKey = str(a.room, 30);
      if (roomKey && !findRoom(pl, roomKey)) {
        this.mapUpdatePlace(pl.id, { rooms: [...(pl.rooms || []), { name: roomKey }] }, "character");
        pl = this.mapPlaces().find((x) => x.id === pl.id);
      }
      const r = await this.mapMoveTo(pl.id, str(a.activity, 160), "mcp", "", roomKey);
      // 自己挪了之后，定时检查往后推一推，别刚挪完就被模型又挪走
      const ms = this.mapSettings(), st = this.mapState();
      this.put("map:state", { ...st, nextCheckAt: Date.now() + Math.round(ms.minHours * 3600000) });
      return { ok: true, moved: r.moved, place: placeOut(pl), room: r.room?.name || "", activity: r.state.activity };
    }
    if (name === "add_room") {
      const places = this.mapPlaces();
      const pl = places.find((x) => x.id === str(a.placeId, 80)) || places.find((x) => normName(x.name) === normName(a.placeName));
      if (!pl) throw new Error("Unknown place; give placeId from get_my_location.");
      const upd = this.mapUpdatePlace(pl.id, { rooms: [...(pl.rooms || []), { name: a.name, icon: a.icon }] }, "character");
      return { ok: true, place: placeOut(upd) };
    }
    if (name === "add_place") return { ok: true, place: placeOut(this.mapAddPlace(a, "character")) };
    if (name === "update_place") return { ok: true, place: placeOut(this.mapUpdatePlace(str(a.id, 80), { name: a.name, kind: a.kind, note: a.note }, "character")) };
    if (name === "get_user_cycle") {
      const d = this.periodData();
      const sum = cycleSummary(d.records, d.settings, ln.date);
      return {
        today: ln.date,
        onPeriod: sum.inPeriod ? `day ${sum.inPeriod.day}` : false,
        predictedNextStart: sum.nextStart || null,
        daysUntilNext: sum.daysUntilNext ?? null,
        lateByDays: sum.lateBy || 0,
        avgCycleDays: sum.avgCycle,
        avgPeriodDays: sum.avgLen,
        recent: d.records.slice(-4).map((r) => ({ start: r.startDate, end: r.endDate, pain: r.pain, symptoms: r.symptoms || "" })),
        note: d.records.length ? "Predictions are estimates from the user's own records." : "The user hasn't recorded any periods yet.",
      };
    }
    if (name === "get_user_focus") {
      const date = isoD(a.date) || ln.date;
      const items = this.list("focus").filter((x) => x.date === date);
      return { date, sessions: items.length, minutes: items.reduce((s, x) => s + x.minutes, 0), items: items.map((x) => ({ endedAt: x.end, minutes: x.minutes, task: x.task })) };
    }
    return undefined;
  },
};
