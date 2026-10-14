/*
 * Companion 设置页。
 *
 * 先移了最常用的：名字 / 时区 / 表情库、模型、Loki 自主、人设、Uranus 桥接、图片生成、外观。
 * 「手动推送 / 精简会话」「重置数据」这类很少用的工具还在原来的 Companion 页面里，之后再搬。
 */

import { useEffect, useState } from "react";
import { cx } from "./api.js";
import { Field } from "./editors.jsx";

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

function FontSelect({ value, onChange, fonts }) {
  const isCss = value?.startsWith("css:");
  return (
    <div className="gap" style={{ gap: 6 }}>
      <select value={isCss ? "css:" : value || ""} onChange={(e) => onChange(e.target.value === "css:" ? "css:" : e.target.value)}>
        <option value="">默认字体</option>
        {fonts.map((f) => (
          <option key={f.id} value={`font:${f.id}`}>
            {f.name}（已上传）
          </option>
        ))}
        <option value="css:">按字体名称…</option>
      </select>
      {isCss && <input placeholder="系统里已有的字体名，如 Georgia" value={value.slice(4)} onChange={(e) => onChange(`css:${e.target.value}`)} />}
    </div>
  );
}

function StyleBlock({ title, value = {}, onChange, fonts }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  return (
    <div className="profile">
      <b>{title}</b>
      <div className="two" style={{ marginTop: 8 }}>
        <Field label="标题字体">
          <FontSelect value={value.titleFont} onChange={(v) => set("titleFont", v)} fonts={fonts} />
        </Field>
        <Field label="描述字体">
          <FontSelect value={value.descFont} onChange={(v) => set("descFont", v)} fonts={fonts} />
        </Field>
        <Field label="标题颜色">
          <div className="row">
            <input type="color" value={value.titleColor || "#18181b"} onChange={(e) => set("titleColor", e.target.value)} style={{ width: 52, padding: 2 }} />
            <button type="button" className="link" onClick={() => set("titleColor", "")}>
              还原
            </button>
          </div>
        </Field>
        <Field label="描述颜色">
          <div className="row">
            <input type="color" value={value.descColor || "#787878"} onChange={(e) => set("descColor", e.target.value)} style={{ width: 52, padding: 2 }} />
            <button type="button" className="link" onClick={() => set("descColor", "")}>
              还原
            </button>
          </div>
        </Field>
        <Field label="标题字号（px）">
          <input type="number" min="12" max="32" value={value.titleSize || ""} placeholder="17" onChange={(e) => set("titleSize", e.target.value)} />
        </Field>
        <Field label="描述字号（px）">
          <input type="number" min="10" max="24" value={value.descSize || ""} placeholder="13" onChange={(e) => set("descSize", e.target.value)} />
        </Field>
      </div>
    </div>
  );
}


function OrganizerCard({ s, up, data, save, ctx }) {
  const { load, toast } = ctx;
  const org = s.organizer || {};
  const st = data.organizer;
  const [roles, setRoles] = useState(null);
  const [rolesErr, setRolesErr] = useState("");
  const [busy, setBusy] = useState("");
  const [days, setDays] = useState(7);

  async function fetchRoles() {
    setRolesErr("");
    try {
      setRoles((await cx("/organizer/roles")).roles);
    } catch (e) {
      setRolesErr(e.message);
    }
  }
  useEffect(() => {
    if (data.settings.bridge?.url && data.settings.bridge?.key) fetchRoles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(sinceDays) {
    setBusy(sinceDays ? "back" : "now");
    try {
      await save(true); // 先把当前设置存上，再整理
      const r = await cx("/organizer/run", { method: "POST", body: { sinceDays } });
      await load();
      toast(`整理完成：新日记 ${r.diaryEntries}，新活动 ${r.activities}，同步日记 ${r.diariesSynced}，重复跳过 ${r.duplicates}`);
    } catch (e) {
      await load();
      toast(e.message);
    } finally {
      setBusy("");
    }
  }

  const c = st?.counts;
  return (
    <div className="card">
      <h3>整理（从 Uranus 读记忆 / 备忘录 / 日记）</h3>
      <p className="faint" style={{ marginTop: 0 }}>
        只读取「今天新增或改过」的记忆和备忘录，以及最近的日记；Uranus 里的日记原文原样同步（评论不会丢）；
        明确的未来计划会被写成角色的活动，日期不明的留在「未排期」。整理用的是下面选的模型，和角色聊天用的模型无关。
      </p>
      <label className="check">
        <input type="checkbox" checked={!!org.enabled} onChange={(e) => up(["organizer", "enabled"], e.target.checked)} /> 自动整理（每隔一段时间一次）
      </label>
      <Field label="读取哪个 Uranus 角色">
        <select value={org.roleKey || ""} onChange={(e) => up(["organizer", "roleKey"], e.target.value)}>
          <option value="">未选择</option>
          {(roles || []).map((r) => (
            <option key={r.key} value={r.key}>
              {r.name || r.key}
            </option>
          ))}
          {org.roleKey && !(roles || []).some((r) => r.key === org.roleKey) && <option value={org.roleKey}>{org.roleKey}</option>}
        </select>
      </Field>
      {rolesErr && <p className="err meta">{rolesErr}</p>}
      <button type="button" className="link" onClick={fetchRoles}>
        重新读取角色列表
      </button>
      <Field label="整理用的模型（不选就用 Companion 的模型）">
        <select value={org.profileId || ""} onChange={(e) => up(["organizer", "profileId"], e.target.value)}>
          <option value="">跟随 Companion 的模型</option>
          {(s.modelProfiles || []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name || p.model || "未命名"}
            </option>
          ))}
        </select>
      </Field>
      <Field label="自动整理间隔（分钟，至少 10）">
        <input type="number" min="10" value={org.intervalMinutes ?? 60} onChange={(e) => up(["organizer", "intervalMinutes"], Number(e.target.value))} />
      </Field>
      <div className="row" style={{ flexWrap: "wrap", marginTop: 4 }}>
        <button type="button" className="pill solid" disabled={!!busy || !org.roleKey} onClick={() => run(0)}>
          {busy === "now" ? "整理中…" : "立即整理"}
        </button>
        <span className="meta">补最近</span>
        <input type="number" min="1" max="60" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ width: 70 }} />
        <span className="meta">天</span>
        <button type="button" className="pill" disabled={!!busy || !org.roleKey} onClick={() => run(Math.max(1, Math.min(60, days || 7)))}>
          {busy === "back" ? "补录中…" : "补录"}
        </button>
      </div>
      <p className="meta" style={{ marginBottom: 0 }}>
        第一次整理只会记下已有的备忘录，不会把整份旧清单当成新计划；想把旧内容也整理，用「补录」。
      </p>
      {st && (
        <div className="profile" style={{ marginTop: 10 }}>
          <div>
            上次：{new Date(st.lastRunAt).toLocaleString("zh-CN")} · {st.ok ? "成功" : <span className="err">失败</span>}
            {st.backlog ? " · 还有积压，10 分钟后继续" : ""}
          </div>
          {st.error && <div className="err meta">{st.error}</div>}
          {c && (
            <div className="meta">
              记忆 {c.memories} · 备忘录新增行 {c.memoLines} · 同步日记 {c.diariesSynced} · 新短日记 {c.diaryEntries} · 新活动 {c.activities} · 跳过 {c.skipped} · 重复 {c.duplicates}
            </div>
          )}
          {!st.ok && st.nextDue > Date.now() && <div className="meta">下次自动重试：{new Date(st.nextDue).toLocaleTimeString("zh-CN")}</div>}
        </div>
      )}
    </div>
  );
}

export function SettingsPage({ ctx }) {
  const { data, load, toast } = ctx;
  const orig = data.settings;
  const [s, setS] = useState(() => JSON.parse(JSON.stringify(orig)));
  const [busy, setBusy] = useState(false);
  const up = (path, v) =>
    setS((cur) => {
      const n = JSON.parse(JSON.stringify(cur));
      let o = n;
      path.slice(0, -1).forEach((k) => (o = o[k] ??= {}));
      o[path[path.length - 1]] = v;
      return n;
    });

  async function save(quiet = false) {
    setBusy(true);
    try {
      const body = {
        ...s,
        reactionLibrary: String(Array.isArray(s.reactionLibrary) ? s.reactionLibrary.join(" ") : s.reactionLibrary).trim().split(/\s+/).filter(Boolean),
        modelProfiles: s.modelProfiles.map(({ _open, ...p }) => p),
      };
      await cx("/settings", { method: "PUT", body });
      await load();
      if (quiet !== true) toast("已保存");
    } catch (e) {
      toast(e.message);
      if (quiet === true) throw e;
    } finally {
      setBusy(false);
    }
  }

  async function uploadFont(file) {
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await cx("/font", { method: "POST", body: { name: file.name.replace(/\.[^.]+$/, ""), ext, b64: btoa(bin) } });
      await load();
      toast("字体已上传");
    } catch (e) {
      toast(e.message);
    }
  }
  async function removeFont(f) {
    if (!window.confirm(`删除字体「${f.name}」？用到它的地方会回到默认字体。`)) return;
    try {
      await cx(`/font/${f.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      toast(e.message);
    }
  }

  const profiles = s.modelProfiles || [];
  const setProfile = (i, k, v) => up(["modelProfiles"], profiles.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  const fonts = data.fonts || [];
  const ap = s.appearance || {};

  return (
    <>
      <div className="card">
        <h3>基本</h3>
        <div className="two">
          <Field label="角色名字">
            <input value={s.characterName || ""} onChange={(e) => up(["characterName"], e.target.value)} />
          </Field>
          <Field label="你的名字">
            <input value={s.userName || ""} onChange={(e) => up(["userName"], e.target.value)} />
          </Field>
        </div>
        <Field label="时区（如 America/New_York）">
          <input value={s.timezone || ""} onChange={(e) => up(["timezone"], e.target.value)} />
        </Field>
        <Field label="表情库（用空格隔开）">
          <input value={Array.isArray(s.reactionLibrary) ? s.reactionLibrary.join(" ") : s.reactionLibrary} onChange={(e) => up(["reactionLibrary"], e.target.value)} />
        </Field>
      </div>

      <div className="card">
        <h3>模型</h3>
        <Field label="Companion 用的模型">
          <select value={s.agent?.profileId || ""} onChange={(e) => up(["agent", "profileId"], e.target.value)}>
            <option value="">未选择</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.model || "未命名"}
              </option>
            ))}
          </select>
        </Field>
        {profiles.map((p, i) => (
          <details className="profile" key={p.id} open={p._open}>
            <summary>
              {p.name || p.model || "新模型"} <span className="meta">{p.model}</span>
            </summary>
            <div className="two" style={{ marginTop: 8 }}>
              <Field label="名称">
                <input value={p.name || ""} onChange={(e) => setProfile(i, "name", e.target.value)} />
              </Field>
              <Field label="模型">
                <input value={p.model || ""} onChange={(e) => setProfile(i, "model", e.target.value)} />
              </Field>
            </div>
            <Field label="Base URL">
              <input value={p.baseUrl || ""} onChange={(e) => setProfile(i, "baseUrl", e.target.value)} />
            </Field>
            <Field label="API Key">
              <input type="password" autoComplete="off" value={p.apiKey || ""} onChange={(e) => setProfile(i, "apiKey", e.target.value)} />
            </Field>
            <div className="two">
              <Field label="路径">
                <input value={p.path || "/chat/completions"} onChange={(e) => setProfile(i, "path", e.target.value)} />
              </Field>
              <Field label="Temperature">
                <input type="number" step=".1" value={p.temperature ?? ""} onChange={(e) => setProfile(i, "temperature", e.target.value === "" ? null : Number(e.target.value))} />
              </Field>
            </div>
            <button type="button" className="pill danger" onClick={() => up(["modelProfiles"], profiles.filter((_, j) => j !== i))}>
              移除
            </button>
          </details>
        ))}
        <button type="button" className="pill" onClick={() => up(["modelProfiles"], [...profiles, { id: newId(), name: "", model: "", baseUrl: "", apiKey: "", path: "/chat/completions", temperature: null, _open: true }])}>
          + 添加模型
        </button>
      </div>

      <div className="card">
        <h3>人设（给 Companion 里的角色用）</h3>
        <Field label="角色人设">
          <textarea value={s.agent?.persona || ""} onChange={(e) => up(["agent", "persona"], e.target.value)} />
        </Field>
        <Field label="你的人设">
          <textarea value={s.agent?.userPersona || ""} onChange={(e) => up(["agent", "userPersona"], e.target.value)} />
        </Field>
        <Field label="世界书">
          <textarea value={s.agent?.worldbook || ""} onChange={(e) => up(["agent", "worldbook"], e.target.value)} />
        </Field>
        <Field label="额外指令">
          <textarea value={s.agent?.instructions || ""} onChange={(e) => up(["agent", "instructions"], e.target.value)} />
        </Field>
      </div>

      <div className="card">
        <h3>角色自己来看看</h3>
        <label className="check">
          <input type="checkbox" checked={!!s.autonomy?.enabled} onChange={(e) => up(["autonomy", "enabled"], e.target.checked)} /> 允许角色自己来访
        </label>
        <div className="two" style={{ marginTop: 10 }}>
          <Field label="每天最少次数">
            <input type="number" value={s.autonomy?.minVisits ?? 0} onChange={(e) => up(["autonomy", "minVisits"], Number(e.target.value))} />
          </Field>
          <Field label="每天最多次数">
            <input type="number" value={s.autonomy?.maxVisits ?? 0} onChange={(e) => up(["autonomy", "maxVisits"], Number(e.target.value))} />
          </Field>
          <Field label="最短间隔（分钟）">
            <input type="number" value={s.autonomy?.minIntervalMinutes ?? 30} onChange={(e) => up(["autonomy", "minIntervalMinutes"], Number(e.target.value))} />
          </Field>
          <span />
          <Field label="活跃开始">
            <input type="time" value={s.autonomy?.activeStart || "08:00"} onChange={(e) => up(["autonomy", "activeStart"], e.target.value)} />
          </Field>
          <Field label="活跃结束">
            <input type="time" value={s.autonomy?.activeEnd || "23:30"} onChange={(e) => up(["autonomy", "activeEnd"], e.target.value)} />
          </Field>
        </div>
      </div>

      <div className="card">
        <h3>Uranus 桥接</h3>
        <label className="check">
          <input type="checkbox" checked={!!s.bridge?.enabled} onChange={(e) => up(["bridge", "enabled"], e.target.checked)} /> 把生活动态推给 Uranus
        </label>
        <Field label="Uranus 地址（你的 Uranus Worker 的 workers.dev 地址）">
          <input value={s.bridge?.url || ""} onChange={(e) => up(["bridge", "url"], e.target.value)} />
        </Field>
        <Field label="后端密钥">
          <input type="password" autoComplete="off" value={s.bridge?.key || ""} onChange={(e) => up(["bridge", "key"], e.target.value)} />
        </Field>
      </div>

      <OrganizerCard s={s} up={up} data={data} save={save} ctx={ctx} />

      <div className="card">
        <h3>图片生成（可选）</h3>
        <label className="check">
          <input type="checkbox" checked={!!s.image?.enabled} onChange={(e) => up(["image", "enabled"], e.target.checked)} /> 启用
        </label>
        <Field label="Base URL">
          <input value={s.image?.baseUrl || ""} onChange={(e) => up(["image", "baseUrl"], e.target.value)} />
        </Field>
        <div className="two">
          <Field label="API Key">
            <input type="password" autoComplete="off" value={s.image?.apiKey || ""} onChange={(e) => up(["image", "apiKey"], e.target.value)} />
          </Field>
          <Field label="模型">
            <input value={s.image?.model || ""} onChange={(e) => up(["image", "model"], e.target.value)} />
          </Field>
        </div>
        <Field label="固定提示词前缀">
          <textarea style={{ minHeight: 56 }} value={s.image?.positivePrompt || ""} onChange={(e) => up(["image", "positivePrompt"], e.target.value)} />
        </Field>
      </div>

      <div className="card">
        <h3>外观（只影响 Companion）</h3>
        <p className="faint" style={{ marginTop: 0 }}>
          “我的一天”和“{s.characterName || "Loki"} 的一天”可以各用各的字体和颜色，像两个人各自手写的日程。{s.characterName || "Loki"} 给你的建议用他自己的样式。
        </p>
        <StyleBlock title={`${s.userName || "我"} 的一天`} value={ap.my} onChange={(v) => up(["appearance", "my"], v)} fonts={fonts} />
        <StyleBlock title={`${s.characterName || "Loki"} 的一天 / 建议`} value={ap.loki} onChange={(v) => up(["appearance", "loki"], v)} fonts={fonts} />
        <Field label="上传字体（.woff2 / .woff / .ttf / .otf，6MB 以内，只存在你自己的 Companion 里）">
          <input
            type="file"
            accept=".woff2,.woff,.ttf,.otf"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) uploadFont(f);
            }}
          />
        </Field>
        {fonts.map((f) => (
          <div className="row" key={f.id} style={{ marginBottom: 6 }}>
            <span className="grow">{f.name}</span>
            <span className="meta">{f.ext}</span>
            <button type="button" className="link" onClick={() => removeFont(f)}>
              删除
            </button>
          </div>
        ))}
        <Field label="自定义 CSS（只在 Companion 里生效；会过滤 @import 和外部图片）">
          <textarea style={{ minHeight: 120, fontFamily: "ui-monospace,monospace", fontSize: 12 }} value={ap.css || ""} onChange={(e) => up(["appearance", "css"], e.target.value)} placeholder={".act .atitle { letter-spacing: .02em; }"} />
        </Field>
      </div>

      <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button type="button" className="pill solid" disabled={busy} onClick={() => save()}>
          {busy ? "保存中…" : "保存设置"}
        </button>
      </div>
    </>
  );
}
