/*
 * 拾心界 → Companion
 *
 * 拾心界（shixinjie-RL7）是一个纯前端的字卡聊天网站，数据都在手机浏览器里。
 * 它把每天发生的事（聊天、商城、行踪、番茄钟、戳一戳……）翻译成一句句人话，
 * 推到 /sxj/ingest。这里负责：
 *
 *   1. 收下来，按天存（sxj:day:YYYY-MM-DD），按事件 id 去重 —— 同一条补发多少次都只算一次
 *   2. 行踪 → 地图：报到的地点没有就新建，再把他挪过去（只认最近 6 小时内的，补发的旧行踪不挪）
 *   3. 「日记来源」选了拾心界时：每天到点调一次模型，写一篇短日记 + 明天的待办，
 *      日记进 Companion 的日记，待办进他的日程（DDL Garden 从日程读，所以 Garden 不用改）
 *
 * 日记来源选 Uranus 时，这里只收数据不写日记，原来的整理流程（orgTick）照旧。
 *
 * 以 mixin 方式挂到 Companion DO 上（同 life.js），this 就是那个 DO。
 *
 * 存储键：
 *   sxj:token          推送口令（不放 settings 里，免得设置页整份保存时被旧副本覆盖）
 *   sxj:day:<date>     [{id,t,who,kind,text,merge?}]  一天的事件
 *   sxj:days           有事件的日期列表（最近 60 天）
 *   sxj:done:<date>    {at, diaryId, todos} 这天的日记写好了
 *   sxj:fail:<date>    {at, count, error}   写失败，30 分钟后重试，最多 5 次
 *   sxj:state          {lastIngestAt, lastIngestCount, lastDiaryAt, lastError}
 *   settings.sxj       {writeAt, language, profileId, glossary, premise, extra, mapSync, minWords, maxWords}
 *   settings.diarySource  "uranus"（默认）| "shixinjie"
 */

const j = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const nowIso = () => new Date().toISOString();
const uid = (p) => `${p}_${crypto.randomUUID()}`;
const str = (v, n = 200) => String(v ?? "").trim().slice(0, n);

export const SXJ_PREMISE = `{{char}} talks to {{user}} through a broken channel called 拾心界 (Shixinjie). Every reply is really from him, but the "system" between them interferes: it picks his words at random from a fixed deck of word cards, splices extra fragments onto what he meant, or replaces his words entirely. A reply may be only partly his, or not his at all. When a message reads like nonsense or contradicts itself, that is the system's doing, not his true intent. Read each reply for what he was most likely trying to say, and never treat random fragments as real events, facts or promises. He knows this channel is frustrating, and sometimes says so himself.`;

export const SXJ_GLOSSARY = `HOW TO READ THE LOG (what each kind of line means in 拾心界):
- Chat lines ("{{user}}: …" / "{{char}}: …"): normal messages. {{char}}'s lines are word-card replies (see the premise above). A "(mood: …)" tag after his line is the mood he was in when it came through; take it as his feeling, but lightly, since the channel is random.
- "[sticker]", "[image]", "[voice message]", "[doodle]": he or she sent a sticker / picture / voice note / drawing. Only the kind is known, not the details.
- "[pat] A patted B": the playful "pat-pat" nudge, an affectionate little poke at each other in chat.
- "[red packet]": a small money gift in a red envelope, a playful gesture.
- "[gift]" / "[shop]": something bought in the 拾心 shop. "{{user}} bought X for {{char}}" means she gave it to him as a present; "{{char}} asked whether to buy X" / "{{user}} paid for X for him" etc. are as written.
- "[study with {{char}}]": {{user}} ran a Pomodoro focus timer with {{char}} keeping her company while she studied. The title (if any) is what she studied, the minutes are how long.
- "[stay with {{char}}]": {{user}} poked {{char}} for fun in the Stay with {{char}} screen, usually when she is bored or wants attention. The count says how many pokes.
- "[whereabouts]": {{char}} reported where he is and what he is doing. Treat this as where he really went today.
- "[private frequency invite]": {{char}} sent {{user}} a private-frequency invitation (a private, intimate activity just for the two of them). Whether she accepted is not recorded; judge only from what she said afterwards, and keep any mention brief and discreet.
- "[listen together]": they listened to a song together (like sharing one pair of headphones).
- "[shared an article]" / "[shared a recipe]": {{char}} sent her something to read or cook, with a short note.
- "[call]": a voice/video call attempt; "[game invite]": an invitation to play a mini game; "[decision]": they used the decision wheel; "[forward]": a message forwarded from another chat; "[tarot]" / "[镜界]": a tarot reading; "[period reminder]": {{char}} reminded her about her cycle; "[recall]": a message was taken back; "[punish]" / "[blacknotice]": playful system notices of the chat's punishment / "black room" games.
- Anything else in [brackets] is some other small feature; mention it only if it clearly mattered.`;

export const SXJ_DEFAULTS = {
  writeAt: "23:45", // 每天几点写日记（按 Companion 设置里的时区）
  language: "", // 日记语言；空 = 跟随「输出语言」，再空就跟聊天的语言走
  source: "profile", // 和其他功能一样：profile = Companion 模型档案；uranus = Uranus「连接」里的模型
  profileId: "",
  uranusProviderId: "",
  model: "",
  premise: SXJ_PREMISE,
  glossary: SXJ_GLOSSARY,
  extra: "",
  mapSync: true,
  minWords: 120,
  maxWords: 260,
};

const MAX_DAY_EVENTS = 4000;
const MAX_PROMPT_CHARS = 36000;

export const SxjMixin = {
  sxjSettings() {
    const s = this.settings();
    const o = { ...SXJ_DEFAULTS, ...(s.sxj || {}) };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(o.writeAt))) o.writeAt = SXJ_DEFAULTS.writeAt;
    if (!String(o.premise || "").trim()) o.premise = SXJ_PREMISE;
    if (!String(o.glossary || "").trim()) o.glossary = SXJ_GLOSSARY;
    o.minWords = Math.max(30, Math.min(2000, Number(o.minWords) || SXJ_DEFAULTS.minWords));
    o.maxWords = Math.max(o.minWords, Math.min(3000, Number(o.maxWords) || SXJ_DEFAULTS.maxWords));
    return o;
  },
  sxjMode() {
    return this.settings().diarySource === "shixinjie";
  },
  sxjVars(text) {
    const s = this.settings();
    return String(text || "").replaceAll("{{char}}", s.characterName || "Loki").replaceAll("{{user}}", s.userName || "Raylee");
  },

  /* ───────── 路由 ───────── */
  async sxjPublic(req, u) {
    const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "no-store" };
    const out = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json; charset=utf-8" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (!this.tokOk(this.get("sxj:token", ""), u.searchParams.get("t"))) return out({ ok: false, error: "Bad Shixinjie token" }, 401);
    if (req.method === "GET") return out({ ok: true, characterName: this.settings().characterName, mode: this.sxjMode() ? "shixinjie" : "uranus" });
    let b = null;
    try {
      const t = await req.text();
      if (t.length > 900000) return out({ ok: false, error: "Too large" }, 413);
      b = JSON.parse(t || "{}");
    } catch {
      return out({ ok: false, error: "Bad JSON" }, 400);
    }
    try {
      const r = await this.sxjIngest(Array.isArray(b.events) ? b.events : []);
      return out({ ok: true, ...r });
    } catch (e) {
      return out({ ok: false, error: String(e.message || e) }, 500);
    }
  },
  async sxjRoute(req, p, m) {
    if (p === "/api/sxj/info" && m === "GET") {
      const u = new URL(req.url);
      return j({ ok: true, token: String(this.get("sxj:token", "") || ""), url: u.origin, mode: this.sxjMode() ? "shixinjie" : "uranus", cfg: this.sxjSettings(), state: this.get("sxj:state", {}) || {}, days: this.sxjDaySummary(), defaults: { premise: SXJ_PREMISE, glossary: SXJ_GLOSSARY } });
    }
    if (p === "/api/sxj/token" && m === "POST") {
      const a = new Uint8Array(24);
      crypto.getRandomValues(a);
      const token = [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
      this.put("sxj:token", token);
      return j({ ok: true, token, url: new URL(req.url).origin });
    }
    if (p === "/api/sxj/token" && m === "DELETE") {
      this.put("sxj:token", "");
      return j({ ok: true });
    }
    if (p === "/api/sxj/run" && m === "POST") {
      const b = await this.body(req);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || "")) ? String(b.date) : this.localDate();
      const r = await this.sxjWriteDiary(date, { manual: true, force: !!b.force });
      return j(r, r.ok ? 200 : 400);
    }
    /* 从 Uranus 把角色人设复制过来（只在你点按钮时做一次，不会自动覆盖） */
    if (p === "/api/sxj/copy-persona" && m === "POST") {
      try {
        const c = await this.uranus("/api/config");
        const name = String(this.settings().characterName || "").toLowerCase();
        const roles = (c.roles || []).filter((r) => String(r.description || "").trim());
        const r = roles.find((x) => String(x.name || "").toLowerCase() === name) || roles[0];
        if (!r) return j({ ok: false, error: "Uranus 里没有写了人设的角色" }, 400);
        const s = this.settings();
        this.put("settings", { ...this.get("settings", {}), agent: { ...s.agent, persona: String(r.description).slice(0, 20000) } });
        return j({ ok: true, from: r.name || r.id, persona: String(r.description).slice(0, 20000) });
      } catch (e) {
        return j({ ok: false, error: String(e.message || e) }, 400);
      }
    }
    if (p === "/api/sxj/day" && m === "GET") {
      const u = new URL(req.url);
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(u.searchParams.get("date") || "")) ? u.searchParams.get("date") : this.localDate();
      return j({ ok: true, date, lines: this.sxjLines(date).split("\n").filter(Boolean) });
    }
    return null;
  },

  /* ───────── 收数据 ───────── */
  sxjDateOf(ms) {
    return this.dateOfMs(ms);
  },
  sxjDaySummary() {
    return (this.get("sxj:days", []) || []).slice(-14).reverse().map((d) => ({ date: d, events: (this.get(`sxj:day:${d}`, []) || []).length, done: !!this.get(`sxj:done:${d}`, null), fail: this.get(`sxj:fail:${d}`, null) }));
  },
  async sxjIngest(events) {
    const now = Date.now();
    const byDay = new Map();
    for (const e of events.slice(0, 2000)) {
      if (!e || !e.id) continue;
      const t = Number(e.t) || now;
      if (t > now + 10 * 60000 || t < now - 60 * 86400000) continue; // 时间离谱的不要
      const ev = {
        id: str(e.id, 120),
        t,
        who: ["user", "char", "sys"].includes(e.who) ? e.who : "sys",
        kind: str(e.kind, 40) || "msg",
        text: str(e.text, 800),
        merge: str(e.merge, 60),
        place: str(e.place, 60),
        activity: str(e.activity, 160),
      };
      if (!ev.text && ev.kind !== "whereabout") continue;
      const d = this.sxjDateOf(t);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d).push(ev);
    }
    let added = 0;
    const days = new Set(this.get("sxj:days", []) || []);
    const fresh = [];
    for (const [d, list] of byDay) {
      const arr = this.get(`sxj:day:${d}`, []) || [];
      const seen = new Set(arr.map((x) => x.id));
      for (const ev of list) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        arr.push(ev);
        fresh.push(ev);
        added++;
      }
      arr.sort((a, b) => a.t - b.t);
      this.put(`sxj:day:${d}`, arr.slice(-MAX_DAY_EVENTS));
      days.add(d);
    }
    const dayList = [...days].sort().slice(-60);
    // 60 天前的那几天直接清掉，免得越存越多
    for (const d of this.get("sxj:days", []) || []) if (!dayList.includes(d)) this.ctx.storage.kv.delete(`sxj:day:${d}`);
    this.put("sxj:days", dayList);
    let moved = "";
    try {
      moved = await this.sxjMap(fresh);
    } catch (e) {
      moved = "";
      this.sxjNote({ lastMapError: String(e.message || e).slice(0, 200) });
    }
    this.sxjNote({ lastIngestAt: nowIso(), lastIngestCount: added });
    return { added, moved };
  },
  sxjNote(patch) {
    this.put("sxj:state", { ...(this.get("sxj:state", {}) || {}), ...patch });
  },
  /* 行踪 → 地图：只认最近 6 小时内、最新的那一条 */
  async sxjMap(fresh) {
    if (!this.sxjSettings().mapSync) return "";
    const recent = fresh.filter((e) => e.kind === "whereabout" && e.place && e.t > Date.now() - 6 * 3600000).sort((a, b) => a.t - b.t);
    const last = recent.pop();
    if (!last) return "";
    const pl = this.mapAddPlace({ name: last.place, kind: "other", note: "From 拾心界 whereabouts" }, "character");
    await this.mapMoveTo(pl.id, last.activity || "", "mcp", "拾心界行踪");
    return pl.name;
  },

  /* ───────── 写日记 ───────── */
  /* 一天的事件 → 给模型看的流水。连续的同类小事（戳一戳、拍一拍）合成一行 */
  sxjLines(date) {
    const s = this.settings();
    const arr = this.get(`sxj:day:${date}`, []) || [];
    const hm = (t) => new Intl.DateTimeFormat("en-GB", { timeZone: this.tzName(), hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
    const who = { user: s.userName || "Raylee", char: s.characterName || "Loki" };
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const e = arr[i];
      if (e.merge) {
        let k = i;
        while (k + 1 < arr.length && arr[k + 1].merge === e.merge && arr[k + 1].t - arr[k].t < 30 * 60000) k++;
        const n = k - i + 1;
        const span = n > 1 && hm(arr[k].t) !== hm(e.t) ? `${hm(e.t)}–${hm(arr[k].t)}` : hm(e.t);
        // 客户端在可合并的那类事件里用 {n} 占位次数（如「戳了 {n} 下」）；没有占位就在末尾标 ×n
        out.push(`[${span}] ${/\{n\}/.test(e.text) ? e.text.replace(/\{n\}/g, String(n)) : e.text + (n > 1 ? ` (×${n})` : "")}`);
        i = k;
        continue;
      }
      if (e.kind === "whereabout" && !e.text) {
        out.push(`[${hm(e.t)}] [whereabouts] ${who.char} is at ${e.place}${e.activity ? `: ${e.activity}` : ""}`);
        continue;
      }
      const name = e.who === "user" ? `${who.user}: ` : e.who === "char" ? `${who.char}: ` : "";
      out.push(`[${hm(e.t)}] ${name}${e.text}`);
    }
    let text = this.sxjVars(out.join("\n"));
    if (text.length > MAX_PROMPT_CHARS) text = "(earlier part of the day omitted)\n" + text.slice(-MAX_PROMPT_CHARS);
    return text;
  },
  /* 闹钟每 10 分钟一跳。一次最多写一天 */
  async sxjTick() {
    if (!this.sxjMode() || this.sxjBusy) return;
    const cfg = this.sxjSettings();
    const ln = this.localNow();
    const today = ln.date;
    const days = (this.get("sxj:days", []) || []).filter((d) => d >= this.isoPlus(today, -3) && d <= today);
    for (const d of days) {
      if (this.get(`sxj:done:${d}`, null)) continue;
      if (d === today && ln.time < cfg.writeAt) continue;
      if (!(this.get(`sxj:day:${d}`, []) || []).length) continue;
      const f = this.get(`sxj:fail:${d}`, null);
      if (f && (f.count >= 5 || Date.now() - Date.parse(f.at) < 30 * 60000)) continue;
      await this.sxjWriteDiary(d, {});
      return;
    }
  },
  async sxjWriteDiary(date, { manual = false, force = false } = {}) {
    if (this.sxjBusy) return { ok: false, error: "正在写另一篇，稍等一下" };
    const done = this.get(`sxj:done:${date}`, null);
    if (done && !force) return { ok: false, error: "这天的日记已经写过了（要重写就勾选「重写」）" };
    const log = this.sxjLines(date);
    if (!log.trim()) return { ok: false, error: "这天拾心界还没有任何记录" };
    this.sxjBusy = true;
    const s = this.settings();
    const cfg = this.sxjSettings();
    try {
      const lang = String(cfg.language || s.agent.language || "").trim();
      const tomorrow = this.isoPlus(date, 1);
      const prevDone = this.list("diary").filter((x) => x.owner === "character" && x.date < date).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-1)[0];
      const plans = this.list("schedule").filter((x) => x.owner === "character" && x.date === date).map((x) => `- ${x.time ? x.time + " " : ""}${x.text}${x.status && x.status !== "planned" ? ` (${x.status})` : ""}`).join("\n");
      const tomorrowPlans = this.list("schedule").filter((x) => x.owner === "character" && x.date === tomorrow).map((x) => `- ${x.time ? x.time + " " : ""}${x.text}`).join("\n");
      const system = this.sxjVars(`${lang ? `OUTPUT LANGUAGE (HIGHEST PRIORITY): write the diary and every todo in ${lang}.\n` : ""}You are {{char}}. Tonight you write your private diary about today, ${date} (${this.weekdayOf(date)}), and jot down your plans for tomorrow, ${tomorrow} (${this.weekdayOf(tomorrow)}).

THE GREAT PREMISE (read this first, it overrides everything):
${cfg.premise}

${cfg.glossary}

PERSONA:
${String(s.agent.persona || "").slice(0, 6000) || "(none)"}
ABOUT {{user}}:
${String(s.agent.userPersona || "").slice(0, 3000) || "(none)"}
WORLDBOOK:
${String(s.agent.worldbook || "").slice(0, 4000) || "(none)"}
${cfg.extra ? `EXTRA INSTRUCTIONS:\n${cfg.extra}\n` : ""}
RULES:
1. Write in first person, as {{char}}, in his own voice. It is a diary, not a report: pick what mattered, skip the rest.
2. Base it ONLY on today's log below (plus your persona). Do not invent shared experiences, places or events that are not in the log. Your own whereabouts lines are real; you may describe them.
3. Interpret your own word-card replies through the premise: say what you meant, or grumble about the channel garbling you, but never treat random fragments as things that really happened.
4. Diary body: about ${cfg.minWords}-${cfg.maxWords} words.
5. "todos": 2-5 concrete, believable things you plan to do TOMORROW (your own life, or things that follow naturally from today). Not things {{user}} has to do. Each: {"title":"short","desc":"optional one short line","time":"HH:MM or empty","end":"HH:MM or empty","deadline":false}. Do not repeat anything already in TOMORROW'S EXISTING PLANS.
Return ONLY JSON: {"title":"optional, max 20 chars","diary":"...","todos":[...]}`);
      const user = this.sxjVars(`YESTERDAY'S DIARY (for continuity, do not repeat it):\n${prevDone ? String(prevDone.text || "").slice(0, 1500) : "(none)"}\n\nYOUR PLANS FOR TODAY (from your schedule):\n${plans || "(none)"}\n\nTOMORROW'S EXISTING PLANS:\n${tomorrowPlans || "(none)"}\n\nTODAY'S LOG FROM 拾心界 (${date}, times are local):\n${log}`);
      const sel = { source: cfg.source, profileId: cfg.profileId || this.settings().organizer?.profileId || "", uranusProviderId: cfg.uranusProviderId, model: cfg.model };
      let o = null, raw = "";
      for (let i = 0; i < 2 && !o; i++) {
        raw = await this.callLLM(sel, [{ role: "system", content: system }, { role: "user", content: user }], 3000);
        o = this.loose(raw);
        if (o && !String(o.diary || "").trim()) o = null;
      }
      if (!o) throw new Error("模型没有按要求返回日记（JSON 格式不对）");
      const text = String(o.diary).trim().slice(0, 8000);
      const title = str(o.title, 40);
      const sid = `sxj:diary:${date}`;
      const old = this.list("diary").find((x) => x.sourceId === sid);
      let diaryId;
      if (old) {
        this.update("diary", old.id, { text, title });
        diaryId = old.id;
      } else {
        diaryId = id("d");
        this.add("diary", { id: diaryId, owner: "character", date, title, kind: "diary", text, images: [], source: "shixinjie", sourceId: sid, createdAt: nowIso(), updatedAt: nowIso() });
      }
      let todos = 0;
      const src = { sourceId: sid, recordedDate: date, recordedMs: Date.now() };
      for (const t of Array.isArray(o.todos) ? o.todos.slice(0, 6) : []) {
        const r = await this.organizerActivity({ title: t?.title, desc: t?.desc, date: tomorrow, time: t?.time, end: t?.end, deadline: !!t?.deadline }, src);
        if (r === "ok") todos++;
      }
      this.put(`sxj:done:${date}`, { at: nowIso(), diaryId, todos });
      this.ctx.storage.kv.delete(`sxj:fail:${date}`);
      this.sxjNote({ lastDiaryAt: nowIso(), lastDiaryDate: date, lastError: "" });
      this.add("notifications", { id: id("n"), kind: "system", text: `✓ 拾心界日记写好了（${date}）· 明天的新活动 ${todos} 个`, read: false, createdAt: nowIso(), activityDate: this.localDate() });
      return { ok: true, date, diaryId, todos, title };
    } catch (e) {
      const err = String(e.message || e).slice(0, 300);
      const f = this.get(`sxj:fail:${date}`, null) || { count: 0 };
      if (!manual) this.put(`sxj:fail:${date}`, { at: nowIso(), count: (f.count || 0) + 1, error: err });
      this.sxjNote({ lastError: `${date}: ${err}` });
      this.add("notifications", { id: id("n"), kind: "system", text: `⚠️ 拾心界日记（${date}）没写成：${err}${manual ? "" : " · 30 分钟后自动重试"}`, read: false, createdAt: nowIso(), activityDate: this.localDate() });
      return { ok: false, error: err };
    } finally {
      this.sxjBusy = false;
    }
  },
};

function id(p) {
  return uid(p);
}
