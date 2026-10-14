import { DurableObject } from "cloudflare:workers";

const j = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{"content-type":"application/json; charset=utf-8"}});
const nowIso = () => new Date().toISOString();
const clamp = (n,a,b) => Math.max(a,Math.min(b,Number(n)||0));
const id = (p) => `${p}_${crypto.randomUUID()}`;
const DEFAULTS = {
  characterName:"Loki", userName:"Raylee", timezone:"America/New_York",
  autonomy:{enabled:false,minVisits:2,maxVisits:4,minIntervalMinutes:30,activeStart:"08:00",activeEnd:"23:30"},
  reactionLibrary:["❤️","🙄","😂","😭","😒","🤨","😌","💀","👀"],
  agent:{profileId:"",persona:"",userPersona:"",worldbook:"",instructions:"Write briefly and naturally. Do not invent shared experiences. Do not react to everything."},
  modelProfiles:[],
  bridge:{enabled:false,url:"",key:"",immediateReaction:"decide",maxContextChars:2800},
  image:{enabled:false,baseUrl:"",apiKey:"",model:"",positivePrompt:""},
  simplifyPrompt:"You compress a Companion activity session for another AI that already knows the user and character. Minimize tokens aggressively WITHOUT losing meaningful information or temporal context.\n\nRULES:\n1. Preserve ALL meaningful facts, outcomes, status changes, emotions, relationship cues, jokes, requests, promises, concerns, and user intent. Compression must not make meaningful information disappear merely because it seems casual.\n2. Preserve TIME CONTEXT. Each source event includes its local date/time. Keep exact or concise time references whenever timing affects meaning, chronology, behavior, or how the receiving character may respond (for example: staying up late, waking early, deadlines, meals, appointments, travel, or something happening unusually late/early). For multiple events close together, you may state one shared time/range instead of repeating timestamps. Do not drop a time merely to save tokens when it changes the meaning.\n3. Merge duplicate lifecycle events about the same item (created/planned/updated/done/etc.) into one concise statement reflecting the final state while retaining meaningful changes.\n4. Merge reactions and comments aimed at the same character entry when natural.\n5. Short source wording that is already efficient may be kept verbatim, especially distinctive emotional/relationship language. Long wording may be paraphrased, but ALL meaningful semantic content must still be conveyed.\n6. Preserve short direct quotes when exact wording, humor, affection, teasing, or tone matters. Do not preserve long wording merely for style.\n7. Never invent, infer, embellish, correct, moralize, or add facts. Do not change actor, target, chronology, time, completion status, or intent.\n8. Do not summarize away details that could change how the receiving character understands or responds.\n9. Remove mechanical repetition, UI wording, redundant target text, and duplicated descriptions.\n10. Use compact plain text, usually one line per distinct semantic event. No headings, analysis, JSON, or explanatory preamble.\n11. Aim for the fewest tokens possible AFTER satisfying all preservation rules. Accuracy, semantic completeness, and relevant temporal context outrank brevity.\n\nReturn ONLY the compressed session text."
};

export class Companion extends DurableObject {
  constructor(ctx, env){ super(ctx,env); this.ctx=ctx; this.env=env; }
  get(k,d=null){ const v=this.ctx.storage.kv.get(k); return v===undefined?d:v; }
  put(k,v){ this.ctx.storage.kv.put(k,v); }
  settings(){ return {...DEFAULTS,...this.get("settings",{}), autonomy:{...DEFAULTS.autonomy,...(this.get("settings",{}).autonomy||{})}, agent:{...DEFAULTS.agent,...(this.get("settings",{}).agent||{})}, bridge:{...DEFAULTS.bridge,...(this.get("settings",{}).bridge||{})},image:{...DEFAULTS.image,...(this.get("settings",{}).image||{})}}; }
  list(kind){ return this.get(`list:${kind}`,[]); }
  save(kind, arr){ this.put(`list:${kind}`,arr); }
  add(kind, item){ const arr=this.list(kind); arr.push(item); this.save(kind,arr); return item; }
  update(kind, itemId, patch){ const arr=this.list(kind); const i=arr.findIndex(x=>x.id===itemId); if(i<0)return null; arr[i]={...arr[i],...patch,updatedAt:nowIso()}; this.save(kind,arr); return arr[i]; }
  async fetch(req){
    const u=new URL(req.url), p=u.pathname, m=req.method;
    if(p==="/api/health") return j({ok:true});
    if(!(await this.auth(req))) return j({ok:false,error:"Bad companion password"},401);
    if(p==="/api/bootstrap"&&m==="GET") return j({ok:true,settings:this.settings(),schedule:this.list("schedule"),diary:this.list("diary"),comments:this.list("comments"),reactions:this.list("reactions"),highlights:this.list("highlights"),notifications:this.list("notifications").slice(-50).reverse()});
    if(p==="/api/settings"&&m==="PUT") return this.setSettings(req);
    if(p==="/api/image"&&m==="POST") return this.storeImage(req);
    if(p.startsWith("/api/image/")&&m==="GET") return this.readImage(p.split("/").pop());
    if(p.startsWith("/api/image/")&&m==="DELETE") return this.deleteImage(p.split("/").pop());
    if(p==="/api/image/generate"&&m==="POST") return this.generateImage(req);
    if(p==="/api/image/summarize"&&m==="POST") return this.summarizeImage(req);
    if(p==="/api/character/sync"&&m==="POST") return this.flushCharacterContext("manual");
    if(p==="/api/admin/fresh-start"&&m==="POST") return this.freshStart();
    if(p==="/api/schedule"&&m==="POST") return this.createSchedule(req);
    if(p.startsWith("/api/schedule/")&&m==="PATCH") return this.patch("schedule",p.split("/").pop(),req);
    if(p.startsWith("/api/schedule/")&&m==="DELETE") return this.remove("schedule",p.split("/").pop());
    if(p==="/api/diary"&&m==="POST") return this.createDiary(req);
    if(p.startsWith("/api/diary/")&&m==="PATCH") return this.patch("diary",p.split("/").pop(),req);
    if(p.startsWith("/api/diary/")&&m==="DELETE") return this.remove("diary",p.split("/").pop());
    if(p==="/api/comment"&&m==="POST") return this.createComment(req);
    if(p.startsWith("/api/comment/")&&m==="PATCH") return this.patchComment(p.split("/").pop(),req);
    if(p.startsWith("/api/comment/")&&m==="DELETE") return this.removeComment(p.split("/").pop());
    if(p==="/api/reaction"&&m==="POST") return this.createReaction(req);
    if(p==="/api/highlight"&&m==="POST") return this.createHighlight(req);
    if(p==="/api/agent/run"&&m==="POST") return this.agentRun(req);
    if(p==="/api/session/touch"&&m==="POST") return this.touchSession(req);
    if(p==="/api/session/preview"&&m==="GET") return this.previewSession();
    if(p==="/api/session/simplify"&&m==="POST") return this.simplifySession();
    if(p==="/api/session/simplified"&&m==="PUT") return this.saveSimplifiedSession(req);
    if(p==="/api/session/commit"&&m==="POST") return this.commitSession(req);
    if(p==="/api/notifications/read"&&m==="POST"){ this.save("notifications",this.list("notifications").map(x=>({...x,read:true}))); return j({ok:true}); }
    return j({ok:false,error:"Not found"},404);
  }
  async auth(req){ const secret=String(this.env.COMPANION_PASSWORD||""); if(!secret)return true; const got=req.headers.get("x-companion-key")||""; return got===secret; }
  async body(req){ try{return await req.json();}catch{return{};} }
  async freshStart(){
    // One-time schema-aware cleanup: remove life/history/test data only. Settings are intentionally preserved.
    const cleared={};
    for(const kind of ["schedule","diary","comments","reactions","highlights","notifications"]){
      cleared[kind]=this.list(kind).length;
      this.save(kind,[]);
    }
    const pending=this.get("pending:user",[]);
    cleared.pendingUser=Array.isArray(pending)?pending.length:0;
    this.put("pending:user",[]); this.put("pending:character",[]);
    const sessionPending=this.get("session:pending",[]); cleared.sessionPending=Array.isArray(sessionPending)?sessionPending.length:0;
    this.put("session:pending",[]); this.put("session:delivery",null); this.put("session:deadline",null); this.put("session:simplified",null);
    await this.arm();
    return j({ok:true,cleared,settingsPreserved:true,bridgeSettingsPreserved:true});
  }
  imageMeta(i){return this.get(`image:${i}:meta`,null)}
  async storeImage(req){const b=await this.body(req),data=String(b.data||"");if(!/^data:image\/(jpeg|png|webp);base64,/i.test(data))return j({ok:false,error:"Image data required"},400);if(data.length>900000)return j({ok:false,error:"Image too large after compression"},413);const iid=id("img"),chunks=[];for(let n=0;n<data.length;n+=80000)chunks.push(data.slice(n,n+80000));chunks.forEach((x,n)=>this.put(`image:${iid}:${n}`,x));const meta={id:iid,chunks:chunks.length,summary:String(b.summary||"").slice(0,600),source:b.source==="generated"?"generated":"upload",createdAt:nowIso()};this.put(`image:${iid}:meta`,meta);return j({ok:true,image:{...meta,url:`/api/image/${iid}`}})}
  readImage(i){const m=this.imageMeta(i);if(!m)return j({ok:false,error:"Image not found"},404);let data="";for(let n=0;n<m.chunks;n++)data+=this.get(`image:${i}:${n}`,"");const mm=data.match(/^data:(image\/[^;]+);base64,(.*)$/s);if(!mm)return j({ok:false,error:"Invalid stored image"},500);const bin=Uint8Array.from(atob(mm[2]),c=>c.charCodeAt(0));return new Response(bin,{headers:{"content-type":mm[1],"cache-control":"private, max-age=31536000"}})}
  deleteImage(i){const m=this.imageMeta(i);if(m){for(let n=0;n<m.chunks;n++)this.ctx.storage.kv.delete(`image:${i}:${n}`);this.ctx.storage.kv.delete(`image:${i}:meta`)}for(const k of ["schedule","diary"])this.save(k,this.list(k).map(x=>({...x,images:(x.images||[]).filter(q=>q.id!==i),statusImages:(x.statusImages||[]).filter(q=>q.id!==i)})));return j({ok:true})}
  async generateImage(req){const b=await this.body(req),cfg=this.settings().image;if(!cfg.enabled||!cfg.baseUrl||!cfg.model)return j({ok:false,error:"Configure Image Generation first"},400);const prompt=[cfg.positivePrompt,String(b.prompt||"")].map(x=>String(x||"").trim()).filter(Boolean).join("\n");if(!prompt)return j({ok:false,error:"Image prompt required"},400);let url=String(cfg.baseUrl).replace(/\/+$/,"");if(!url.endsWith("/images/generations"))url+="/images/generations";const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${cfg.apiKey||""}`},body:JSON.stringify({model:cfg.model,prompt,n:1,size:"1024x1024",response_format:"b64_json"})});const raw=await r.text();if(!r.ok)throw new Error(`Image API ${r.status}: ${raw.slice(0,300)}`);let o;try{o=JSON.parse(raw)}catch{throw new Error("Image API returned invalid JSON")}const it=o?.data?.[0];let data=it?.b64_json?`data:image/png;base64,${it.b64_json}`:"";if(!data&&it?.url){const rr=await fetch(it.url);const buf=new Uint8Array(await rr.arrayBuffer());let str="";for(let n=0;n<buf.length;n+=8192)str+=String.fromCharCode(...buf.slice(n,n+8192));data=`data:${rr.headers.get("content-type")||"image/png"};base64,${btoa(str)}`}if(!data)throw new Error("Image API returned no image");return this.storeImage(new Request("https://local/api/image",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({data,source:"generated"})}))}
  async summarizeImage(req){const b=await this.body(req),iid=String(b.imageId||""),m=this.imageMeta(iid);if(!m)return j({ok:false,error:"Image not found"},404);let data="";for(let n=0;n<m.chunks;n++)data+=this.get(`image:${iid}:${n}`,"");const st=this.settings(),p=st.modelProfiles.find(x=>x.id===st.agent.profileId);if(!p)return j({ok:false,error:"Select an active Companion model"},400);const base=String(p.baseUrl||"").replace(/\/+$/,""),url=base.endsWith("/chat/completions")?base:base+"/chat/completions";const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${p.apiKey||""}`,...(p.headers||{})},body:JSON.stringify({model:p.model,messages:[{role:"user",content:[{type:"text",text:"Describe this image for memory/context in one short factual sentence. Mention only clearly visible content relevant to a diary/calendar event. No inference or backstory. Return only the sentence."},{type:"image_url",image_url:{url:data}}]}],max_tokens:100})});const raw=await r.text();if(!r.ok)throw new Error(`Vision summary ${r.status}: ${raw.slice(0,240)}`);let o;try{o=JSON.parse(raw)}catch{throw new Error("Vision model returned invalid JSON")}const summary=String(o?.choices?.[0]?.message?.content||"").trim().slice(0,600);if(!summary)throw new Error("Empty image summary");this.put(`image:${iid}:meta`,{...m,summary});return j({ok:true,summary})}
  imageContext(x){const z=(x.images||[]).map(q=>q.summary||this.imageMeta(q.id)?.summary).filter(Boolean);return z.length?` Image: ${z.join("; ")}`:""}
  queueCharacter(text){const q=this.get("pending:character",[]);q.push({id:crypto.randomUUID(),text:String(text).slice(0,1600),createdAt:nowIso()});this.put("pending:character",q.slice(-100))}
  async flushCharacterContext(reason="scheduled"){const q=this.get("pending:character",[]);if(!q.length)return j({ok:true,empty:true});const packet=q.map(x=>`[${this.formatSessionTime(x.createdAt)}] ${x.text}`).join("\n"),packetId=crypto.randomUUID();this.add("notifications",{id:id("n"),text:"Character context syncing to Uranus…",read:false,createdAt:nowIso(),activityDate:this.localDate()});const r=await this.pushBridge("character_life",packet,{actor:"character",source:"companion",origin:`character_context_${reason}`,packetId});if(r.ok&&r.accepted){this.put("pending:character",[]);this.add("notifications",{id:id("n"),text:`Character context synced to Uranus · ${reason}.`,read:false,createdAt:nowIso(),activityDate:this.localDate()});return j({ok:true,accepted:true})}this.add("notifications",{id:id("n"),text:"Character context sync failed · retained for retry.",read:false,createdAt:nowIso(),activityDate:this.localDate()});return j({ok:false,error:r.error||"No ACK"},502)}
  pruneActivity(){const tz=this.settings().timezone||this.env.TZ||"America/New_York",fmt=d=>new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(d),t=fmt(new Date()),y=new Date();y.setDate(y.getDate()-1);const keep=new Set([t,fmt(y)]);this.save("notifications",this.list("notifications").filter(n=>keep.has(n.activityDate||fmt(new Date(n.createdAt)))))}
  async setSettings(req){ const b=await this.body(req); const old=this.settings(); const a=b.autonomy||{}; const next={...old,...b,autonomy:{...old.autonomy,...a,minVisits:clamp(a.minVisits??old.autonomy.minVisits,0,10),maxVisits:clamp(a.maxVisits??old.autonomy.maxVisits,0,10),minIntervalMinutes:clamp(a.minIntervalMinutes??old.autonomy.minIntervalMinutes,0,1440)},reactionLibrary:[...new Set((b.reactionLibrary??old.reactionLibrary).map(String))].slice(0,50)}; if(next.autonomy.maxVisits<next.autonomy.minVisits)next.autonomy.maxVisits=next.autonomy.minVisits; this.put("settings",next); await this.arm(); return j({ok:true,settings:next}); }
  async patch(kind,itemId,req){
    if(!["schedule","diary"].includes(kind))return j({ok:false,error:"Invalid kind"},400);
    const old=this.list(kind).find(x=>x.id===itemId);
    if(!old)return j({ok:false,error:"Entry not found"},404);
    if(old.owner!=="user")return j({ok:false,error:"Only your own entries can be edited here"},403);
    const b=await this.body(req),out={};
    const allowed=kind==="schedule"?["date","time","end","text","title","description","status","actualText","doneText","images","statusImages"]:["text","images"];
    for(const k of allowed)if(Object.prototype.hasOwnProperty.call(b,k)&&b[k]!==undefined){
      if(["images","statusImages"].includes(k)){if(Array.isArray(b[k]))out[k]=b[k].slice(0,6)}
      else out[k]=String(b[k]??"").slice(0,k==="description"?1500:10000);
    }
    if(kind==="schedule"){
      if(out.status&&! ["planned","done","failed","changed","cancelled"].includes(out.status))return j({ok:false,error:"Invalid status"},400);
      if(out.title!==undefined)out.text=out.title;
      if(out.text!==undefined&&!out.text.trim())return j({ok:false,error:"Title required"},400);
      if(out.status&&out.status!==old.status){out.statusChangedAt=nowIso();out.history=[...(old.history||[]),{status:old.status,at:nowIso()}].slice(-50)}
    }
    return j({ok:true,item:this.update(kind,itemId,out)});
  }
  remove(kind,itemId){
    if(!["schedule","diary"].includes(kind))return j({ok:false,error:"Invalid kind"},400);
    const item=this.list(kind).find(x=>x.id===itemId);
    if(!item)return j({ok:false,error:"Not found"},404);
    if(item.owner!=="user")return j({ok:false,error:"Cannot delete character entries"},403);
    this.save(kind,this.list(kind).filter(x=>x.id!==itemId));
    return j({ok:true});
  }
  async createSchedule(req){ const b=await this.body(req); const x={id:id("s"),owner:"user",date:String(b.date||"").slice(0,10),time:String(b.time||"").slice(0,5),end:String(b.end||"").slice(0,5),text:String(b.title||b.text||"").trim(),title:String(b.title||b.text||"").trim(),description:String(b.description||"").slice(0,1500),status:"planned",images:Array.isArray(b.images)?b.images.slice(0,4):[],history:[],createdAt:nowIso(),updatedAt:nowIso()}; if(!x.date||!x.text)return j({ok:false,error:"date and text required"},400); this.add("schedule",x); return j({ok:true,item:x}); }
  async createDiary(req){ const b=await this.body(req); const owner="user", date=String(b.date||"").slice(0,10); let arr=this.list("diary"); const existing=arr.find(x=>x.owner===owner&&x.date===date); if(existing){ const item=this.update("diary",existing.id,{text:String(b.text||"").trim(),...(Array.isArray(b.images)?{images:b.images.slice(0,6)}:{})}); return j({ok:true,item}); } const x={id:id("d"),owner,date,text:String(b.text||"").trim(),images:Array.isArray(b.images)?b.images.slice(0,6):[],createdAt:nowIso(),updatedAt:nowIso()}; if(!date||!x.text)return j({ok:false,error:"date and text required"},400); this.add("diary",x); return j({ok:true,item:x}); }
  target(type,targetId){
    if(type==="comment")return this.list("comments").find(x=>x.id===targetId)||null;
    if(!["schedule","diary"].includes(type))return null;
    return this.list(type).find(x=>x.id===targetId)||null;
  }
  commentRoot(comment){
    if(!comment)return null;
    if(comment.rootType&&comment.rootId)return {type:comment.rootType,id:comment.rootId};
    if(comment.targetType==="schedule"||comment.targetType==="diary")return {type:comment.targetType,id:comment.targetId};
    const parent=this.target("comment",comment.targetId);
    return this.commentRoot(parent);
  }
  async createComment(req){
    const b=await this.body(req);
    let rootType=b.targetType,rootId=b.targetId,parentId=null,target=this.target(rootType,rootId);
    if(b.targetType==="comment"){
      const parent=this.target("comment",b.targetId);
      if(!parent)return j({ok:false,error:"Comment not found"},404);
      if(parent.actor!=="character")return j({ok:false,error:"You can reply to Loki's comments here"},403);
      const root=this.commentRoot(parent); if(!root)return j({ok:false,error:"Comment thread is missing its source entry"},400);
      rootType=root.type;rootId=root.id;parentId=parent.id;target=this.target(rootType,rootId);
    }else if(!target||target.owner!=="character"){
      return j({ok:false,error:"You can only comment on Loki's entries or reply to Loki's comments"},403);
    }
    const text=String(b.text||"").trim(); if(!text)return j({ok:false,error:"Comment required"},400);
    const x={id:id("c"),actor:"user",targetType:rootType,targetId:rootId,rootType,rootId,parentId,text:text.slice(0,500),createdAt:nowIso(),updatedAt:nowIso()};
    this.add("comments",x);return j({ok:true,item:x});
  }
  async patchComment(commentId,req){
    const x=this.list("comments").find(c=>c.id===commentId);
    if(!x)return j({ok:false,error:"Comment not found"},404);
    if(x.actor!=="user")return j({ok:false,error:"You can only edit your own comments"},403);
    const b=await this.body(req),text=String(b.text||"").trim();
    if(!text)return j({ok:false,error:"Comment required"},400);
    return j({ok:true,item:this.update("comments",commentId,{text:text.slice(0,500)})});
  }
  removeComment(commentId){
    const x=this.list("comments").find(c=>c.id===commentId);
    if(!x)return j({ok:false,error:"Comment not found"},404);
    if(x.actor!=="user")return j({ok:false,error:"You can only delete your own comments"},403);
    const ids=new Set([commentId]); let changed=true;
    while(changed){changed=false;for(const c of this.list("comments"))if(c.parentId&&ids.has(c.parentId)&&!ids.has(c.id)){ids.add(c.id);changed=true;}}
    this.save("comments",this.list("comments").filter(c=>!ids.has(c.id)));
    return j({ok:true});
  }
  async createReaction(req){ const b=await this.body(req),lib=this.settings().reactionLibrary,target=this.target(b.targetType,b.targetId);
    if(!target||target.owner!=="character")return j({ok:false,error:"You can only react to the character's entries"},403);
    if(!String(b.emoji||"").trim()||String(b.emoji).length>80)return j({ok:false,error:"Enter a reaction (up to 80 characters)"},400);
    let arr=this.list("reactions").filter(x=>!(x.actor==="user"&&x.targetType===b.targetType&&x.targetId===b.targetId));
    const x={id:id("r"),actor:"user",targetType:b.targetType,targetId:b.targetId,emoji:b.emoji,createdAt:nowIso()};
    arr.push(x);this.save("reactions",arr);return j({ok:true,item:x}); }
  async createHighlight(req){const b=await this.body(req),diary=this.target("diary",b.diaryId);
    if(!diary||diary.owner!=="character")return j({ok:false,error:"Only the character's diary can be highlighted"},403);
    const x={id:id("h"),actor:"user",diaryId:diary.id,text:String(b.text||""),start:Number(b.start)||0,end:Number(b.end)||0,createdAt:nowIso()};
    if(!x.text)return j({ok:false,error:"Text required"},400);this.add("highlights",x);return j({ok:true,item:x}); }
  meaningfulActions(actions){ return (Array.isArray(actions)?actions:[]).filter(x=>["comment","reaction","highlight","write_schedule","write_diary","update_schedule"].includes(x?.type)); }
  async touchSession(req){
    const b=await this.body(req), meaningful=this.meaningfulActions(b.actions);
    if(!meaningful.length)return j({ok:true,empty:true,pending:this.get("session:pending",[]).length});
    const stamped=meaningful.map(x=>({...x,eventId:String(x.eventId||crypto.randomUUID()),eventCreatedAt:String(x.eventCreatedAt||nowIso())}));
    const pending=[...this.get("session:pending",[]),...stamped].slice(-100);
    this.put("session:pending",pending);
    const deadline=Date.now()+5*60*1000;
    this.put("session:deadline",deadline);
    await this.ctx.storage.setAlarm(deadline);
    return j({ok:true,queued:stamped.length,pending:pending.length,deadline:new Date(deadline).toISOString()});
  }
  previewSession(){
    const pending=this.get("session:pending",[]);
    const delivery=this.get("session:delivery",null);
    const deadline=Number(this.get("session:deadline",0))||0;
    const summary=pending.length?this.compactActivity(pending):"";
    const simplified=this.get("session:simplified",null);
    const fingerprint=this.sessionFingerprint(pending);
    return j({
      ok:true, pending:pending.length, summary,
      simplified:simplified?.text||"", simplifiedCurrent:Boolean(simplified&&simplified.fingerprint===fingerprint),
      simplifiedAt:simplified?.createdAt||null,
      retrying:Boolean(delivery), packetId:delivery?.packetId||null,
      retryActions:Array.isArray(delivery?.actions)?delivery.actions.length:0,
      deadline:deadline?new Date(deadline).toISOString():null
    });
  }
  sessionFingerprint(actions){ return (actions||[]).map(x=>x.eventId||"").join("|"); }
  async simplifySession(){
    const pending=this.get("session:pending",[]);
    if(!pending.length)return j({ok:false,error:"Nothing pending to simplify."},400);
    const s=this.settings(),profile=s.modelProfiles.find(x=>x.id===s.agent.profileId);
    if(!profile)return j({ok:false,error:"Choose an active Companion model profile first."},400);
    const original=this.compactActivity(pending);
    const prompt=String(this.settings().simplifyPrompt||DEFAULTS.simplifyPrompt).trim()||DEFAULTS.simplifyPrompt;
    const local=this.localNow();
    try{
      const base=String(profile.baseUrl||"").replace(/\/$/,""),path=String(profile.path||"/chat/completions");
      const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${profile.apiKey||""}`,...(profile.headers||{})},body:JSON.stringify({model:profile.model,messages:[{role:"system",content:prompt},{role:"user",content:`SESSION LOCAL TIMEZONE: ${local.timeZone}\nSIMPLIFICATION RUN LOCAL TIME: ${local.date} ${local.time}\nSOURCE SESSION (timestamps are local):\n${original}`}],...(profile.temperature===null||profile.temperature===undefined?{}:{temperature:Number(profile.temperature)})})});
      if(!r.ok)throw new Error(`Companion model returned HTTP ${r.status}`);
      const raw=await r.json();
      const text=String(raw?.choices?.[0]?.message?.content||raw?.output_text||"").trim();
      if(!text)throw new Error("Companion model returned an empty simplification.");
      const item={text,fingerprint:this.sessionFingerprint(pending),createdAt:nowIso()}; this.put("session:simplified",item);
      return j({ok:true,...item,original});
    }catch(e){return j({ok:false,error:e.message||String(e)},400)}
  }
  async saveSimplifiedSession(req){
    const b=await this.body(req),pending=this.get("session:pending",[]),text=String(b.text||"").trim();
    if(!text)return j({ok:false,error:"Simplified session cannot be empty."},400);
    // Keep this editor usable even when there is no pending activity. That makes it a
    // convenient manual test packet and avoids forcing the user to manufacture UI actions.
    const item={text,fingerprint:this.sessionFingerprint(pending),createdAt:nowIso(),edited:true,manual:!pending.length}; this.put("session:simplified",item); return j({ok:true,...item});
  }
  async commitSession(req){
    const b=await this.body(req), representation=b.representation==="simplified"?"simplified":"original", incoming=this.meaningfulActions(b.actions).map(x=>({...x,eventId:String(x.eventId||crypto.randomUUID()),eventCreatedAt:String(x.eventCreatedAt||nowIso())}));
    let pending=[...this.get("session:pending",[]),...incoming].slice(-100);
    if(!pending.length){
      // Manual Simplified Session test: it is intentionally allowed without pending UI
      // actions. It goes through the exact same Uranus Bridge + ACK path, but consumes no
      // pending events because there are none. Keep the editable text after success.
      if(representation!=="simplified")return j({ok:true,empty:true,pending:0});
      const simp=this.get("session:simplified",null), packet=String(simp?.text||"").trim();
      if(!packet)return j({ok:false,error:"Simplified session is empty."},400);
      const packetId=crypto.randomUUID();
      const bridge=await this.pushBridge("session_activity",packet,{actor:"user",source:"companion",origin:"manual_simplified_test",packetId,eventIds:[]});
      if(!bridge.ok)return j({ok:false,error:bridge.error||"Uranus Bridge push failed",bridge,pending:0,packetId},502);
      if(!bridge.accepted||bridge.packetId!==packetId)return j({ok:false,error:"Uranus did not return a matching delivery ACK.",bridge,pending:0,packetId},502);
      // ACK confirmed: consume the manual simplified text as well. A successful Push
      // must visibly empty the editor so it cannot be mistaken for an unsent packet.
      this.put("session:simplified",null);
      return j({ok:true,actions:0,manual:true,bridge,accepted:true,packetId,pending:0});
    }

    // Freeze a delivery snapshot. If transport/ACK is uncertain, retry this exact packet ID
    // before sending newer actions. This gives at-least-once delivery without losing data.
    let delivery=this.get("session:delivery",null);
    if(!delivery){
      const snapshot=pending.slice();
      let packet=this.compactActivity(snapshot);
      if(representation==="simplified"){ const simp=this.get("session:simplified",null); const fp=this.sessionFingerprint(snapshot); if(!simp||simp.fingerprint!==fp)return j({ok:false,error:"Simplified version is missing or outdated. Simplify again, or Push Original."},409); packet=simp.text; }
      delivery={packetId:crypto.randomUUID(),eventIds:snapshot.map(x=>x.eventId),actions:snapshot,representation,packet,createdAt:nowIso()};
      this.put("session:delivery",delivery);
    }
    const packet=delivery.packet||this.compactActivity(delivery.actions);
    const bridge=await this.pushBridge("session_activity",packet,{
      actor:"user",source:"companion",origin:"companion_ui",
      packetId:delivery.packetId,eventIds:delivery.eventIds
    });
    if(!bridge.ok){
      // Never consume pending data on failure. A later manual/automatic push retries it.
      return j({ok:false,error:bridge.error||"Uranus Bridge push failed",bridge,pending:pending.length,packetId:delivery.packetId},502);
    }
    if(!bridge.accepted || bridge.packetId!==delivery.packetId){
      return j({ok:false,error:"Uranus did not return a matching delivery ACK. Session kept pending.",bridge,pending:pending.length,packetId:delivery.packetId},502);
    }

    const accepted=new Set(delivery.eventIds);
    pending=this.get("session:pending",[]).filter(x=>!accepted.has(x.eventId));
    this.put("pending:user",[...this.get("pending:user",[]),...delivery.actions].slice(-60));
    this.put("session:pending",pending);
    this.put("session:delivery",null);
    this.put("session:simplified",null);

    // If actions arrived while an uncertain packet was being retried, send them now too.
    // One button press therefore drains the whole pending queue, while each packet remains idempotent.
    if(pending.length){
      const nextReq=new Request("https://companion.local/api/session/commit",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
      const next=await this.commitSession(nextReq);
      if(!next.ok)return next;
      const nextBody=await next.clone().json();
      return j({ok:true,actions:delivery.actions.length+(nextBody.actions||0),bridge:nextBody.bridge||bridge,accepted:true,drained:true,pending:nextBody.pending||0});
    }

    this.put("session:deadline",null);
    return j({ok:true,actions:delivery.actions.length,bridge,accepted:true,packetId:delivery.packetId,pending:0});
  }
  compactActivity(actions){
    const tz=this.settings().timezone||this.env.TZ||"America/New_York";
    const stamp=a=>{try{const d=new Date(a.eventCreatedAt||a.createdAt||Date.now());const parts=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(d);const g=t=>parts.find(x=>x.type===t)?.value||"";return `[${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}] `;}catch{return "";}};
    return actions.slice(-20).map(a=>{
      const t=stamp(a);
      if(a.type==="reaction")return `${t}Raylee reacted ${a.emoji||""} to Loki's entry “${String(a.targetText||"").slice(0,120)}”.`;
      if(a.type==="comment")return `${t}Raylee commented on Loki's entry “${String(a.targetText||"").slice(0,100)}”: “${String(a.text||"").slice(0,180)}”.`;
      if(a.type==="highlight")return `${t}Raylee highlighted “${String(a.text||"").slice(0,160)}”.`;
      if(a.type==="write_schedule")return `${t}Raylee added to My Day: ${String(a.summary||"").slice(0,220)}.`;
      if(a.type==="write_diary")return `${t}${String(a.summary||"").slice(0,700)}`;
      if(a.type==="update_schedule")return `${t}Raylee updated a plan: ${String(a.summary||"").slice(0,300)}.`;
      return `${t}${String(a.summary||a.type)}`;
    }).join("\n");
  }
  localNow(){
    const timeZone=this.settings().timezone||this.env.TZ||"America/New_York";
    const parts=new Intl.DateTimeFormat("en-US",{timeZone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
    const get=t=>parts.find(x=>x.type===t)?.value||"";
    return {date:`${get("year")}-${get("month")}-${get("day")}`,time:`${get("hour")}:${get("minute")}`,timeZone};
  }
  localDate(){return this.localNow().date;}
  async agentRun(req){
    const b=await this.body(req);
    const mode=["look_schedule","write_schedule","look_diary","write_diary","autonomous"].includes(b.mode)?b.mode:"autonomous";
    try{
      const result=await this.callAgent(mode,b.date);
      if(mode==="write_schedule"&&!(Array.isArray(result.schedule)&&result.schedule.some(x=>String(x.text||"").trim())))throw new Error("Model returned no schedule entry. Nothing was saved; please try again.");
      if(mode==="write_diary"&&!String(result.diary?.text||"").trim())throw new Error("Model returned no diary entry. Nothing was saved; please try again.");
      if((mode==="look_schedule"||mode==="look_diary")&&!(Array.isArray(result.comments)&&result.comments.length)&&!(Array.isArray(result.reactions)&&result.reactions.length))throw new Error("Loki looked, but returned no reaction or comment. Please try again.");
      const outcome=await this.applyAgent(result,mode,b.date);
      if(mode==="write_schedule"&&outcome.schedule===0)throw new Error("Model returned no schedule entry. Nothing was saved; please try again.");
      if(mode==="write_diary"&&outcome.diary===0)throw new Error("Model returned no diary entry. Nothing was saved; please try again.");
      if((mode==="look_schedule"||mode==="look_diary")&&outcome.comments+outcome.reactions===0)throw new Error("Loki did not leave a valid reaction or comment. Nothing was recorded; please try again.");
      if(mode==="look_schedule"||mode==="look_diary"){
        const subject=mode==="look_diary"?"diary":"schedule";
        const details=[];
        if(outcome.reactions)details.push(`reacted to ${outcome.reactions} ${outcome.reactions===1?"entry":"entries"}`);
        if(outcome.comments)details.push(`commented on ${outcome.comments} ${outcome.comments===1?"entry":"entries"}`);
        const receipt=`${this.settings().characterName} looked at your ${subject}. ${details.length?details.join(" and ")+".":"No reaction or comment."}`;
        this.add("notifications",{id:id("n"),text:receipt,read:false,createdAt:nowIso(),activityDate:this.localDate()});
      }
      return j({ok:true,result,applied:outcome});
    }catch(e){return j({ok:false,error:e.message||String(e)},400);}
  }
  async callAgent(mode,requestedDate){
    const s=this.settings(),profile=s.modelProfiles.find(x=>x.id===s.agent.profileId);
    if(!profile)throw new Error("Choose a model profile in Settings first.");
    const pending=this.get("pending:user",[]),date=/^\d{4}-\d{2}-\d{2}$/.test(requestedDate||"")?requestedDate:this.localDate();
    const localNow=this.localNow();
    if((mode==="write_schedule"||mode==="write_diary")&&date>localNow.date)throw new Error("Ask Loki to Write cannot invent lived events for a future date.");
    const userScheduleForDate=this.list("schedule").filter(x=>x.owner==="user"&&x.date===date);
    const userDiaryForDate=this.list("diary").filter(x=>x.owner==="user"&&x.date===date);
    const todayWriteRule=date===localNow.date?`TODAY SAFETY RULE: It is currently ${localNow.time} in ${localNow.timeZone}. Write ONLY events that have already happened or are happening now. NEVER invent, predict, pre-fill, or schedule events later than ${localNow.time}. For schedule writing today, every new schedule item MUST include an explicit HH:MM start time that is not later than ${localNow.time}; any end time must also not be later than ${localNow.time}. If only one real/present activity is appropriate, write only one. Do not fill the rest of the day.`:`The target date is in the past, so you may describe events from that completed day.`;
    const instruction=mode==="write_schedule"?`MANDATORY: Create at least ONE nonempty schedule item in the schedule array for ${date}. You are writing YOUR OWN lived day, not merely looking. Do not invent content just to fill the calendar. ${todayWriteRule}`:mode==="write_diary"?`MANDATORY: Write a nonempty diary object {"date":"${date}","text":"..."}. Write YOUR OWN diary, even if it is just 1-2 natural sentences. Do not return null diary. ${todayWriteRule}`:mode==="look_schedule"?`LOOK ONLY at the user's schedule. Do NOT create schedules or diary entries. MANDATORY: leave at least ONE interaction on a USER schedule entry for TARGET DATE: either a natural comment or exactly one reaction chosen from AVAILABLE REACTIONS. You may do both. For every schedule interaction, targetType MUST be "schedule" and targetId MUST be an exact schedule id shown in ELIGIBLE TARGETS. Never return with both comments and reactions empty.`:mode==="look_diary"?`LOOK ONLY at the user's diary. Do NOT create schedules or diary entries. MANDATORY: leave at least ONE interaction on the USER diary entry for TARGET DATE: either a natural comment or exactly one reaction chosen from AVAILABLE REACTIONS. You may do both. For every diary interaction, targetType MUST be "diary" and targetId MUST be the exact diary id shown in ELIGIBLE TARGETS. Never use "schedule" for a diary interaction. Never return with both comments and reactions empty.`:`AUTONOMOUS VISIT. Prefer living YOUR OWN life rather than hovering over the user. Across visits, balance three categories roughly evenly: (A) write/update YOUR schedule, (B) write YOUR diary when no diary exists today, (C) interact with the USER. Do not repeatedly choose C just because user activity exists. At most ONE comment/reply per target or user comment in a visit. Never leave a second character reply under the same user comment. If replying to a user comment, use targetType "comment" and its exact comment id. Do not pile multiple standalone comments onto the same user entry. It is fine to write only your own life and not react to the user.`;
    const prompt=`You are ${s.characterName}. Return ONLY valid JSON.\nMODE: ${mode}\nTARGET DATE: ${date}\nLOCAL TIMEZONE: ${s.timezone}\nCURRENT UTC: ${nowIso()}\nIMPORTANT INSTRUCTION: ${instruction}\nYou can change the status of YOUR OWN existing schedules using updates [{"id":"existing id","status":"done|failed|cancelled|changed","actualText":"required only for changed"}]. Do not edit or delete original schedule text.\nYou can ONLY comment/react to the USER's existing entries. Never comment/react to your own.\nPERSONA:\n${s.agent.persona}\nUSER:\n${s.agent.userPersona}\nWORLDBOOK:\n${s.agent.worldbook}\nSPECIAL INSTRUCTIONS:\n${s.agent.instructions}\nAVAILABLE REACTIONS: ${s.reactionLibrary.join(" ")}\nELIGIBLE TARGETS FOR THIS REQUEST:\n${mode==="look_diary"?JSON.stringify(userDiaryForDate):mode==="look_schedule"?JSON.stringify(userScheduleForDate):"n/a"}\nINTERACTION JSON SCHEMA: comments use {"targetType":"schedule|diary|comment","targetId":"exact existing entry/comment id","text":"..."}. targetType "comment" means reply to an existing USER comment; reactions use {"targetType":"schedule|diary","targetId":"exact existing id","emoji":"one AVAILABLE REACTION"}.\nRECENT USER ACTIVITY:\n${this.compactActivity(pending)}\nEXISTING COMMENT THREADS (do not duplicate a character reply to the same user comment):\n${JSON.stringify(this.list("comments").slice(-40))}\nYOUR SCHEDULE:\n${JSON.stringify(this.list("schedule").filter(x=>x.owner==="character").slice(-30))}\nUSER SCHEDULE:\n${JSON.stringify(this.list("schedule").filter(x=>x.owner==="user").slice(-30))}\nYOUR DIARY:\n${JSON.stringify(this.list("diary").filter(x=>x.owner==="character").slice(-7))}\nUSER DIARY:\n${JSON.stringify(this.list("diary").filter(x=>x.owner==="user").slice(-7))}\nOPTIONAL IMAGE: for YOUR OWN schedule/diary only, when an image would naturally enrich the entry and Image Generation is enabled, add "imagePrompt":"short visual prompt" to that schedule item or diary object. Do not create images for user entries.
Return JSON shape {"schedule":[],"updates":[],"diary":null,"comments":[],"reactions":[],"summary":{"diary":"","schedule":[]},"messageNow":null}. schedule items use {"date":"${date}","time":"HH:MM or empty","end":"HH:MM or empty","text":"..."}. Comments/reactions must target existing USER entry IDs only.`;
    const base=String(profile.baseUrl||"").replace(/\/$/,"");const path=profile.path||"/chat/completions";
    const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${profile.apiKey||""}`,...(profile.headers||{})},body:JSON.stringify({model:profile.model,messages:[{role:"system",content:prompt},{role:"user",content:mode.startsWith("write_")?`Write the required ${mode==="write_schedule"?"schedule":"diary"} for ${date} now. Return a nonempty result.`:mode.startsWith("look_")?`Look at the requested user content now and MUST leave at least one valid reaction or comment on it.`:"Decide what you naturally do this visit."}],...(profile.temperature===null||profile.temperature===undefined?{}:{temperature:Number(profile.temperature)}),response_format:{type:"json_object"}})});
    const txt=await r.text();if(!r.ok)throw new Error(`Model ${r.status}: ${txt.slice(0,300)}`);
    let data;try{data=JSON.parse(txt);}catch{throw new Error("Model returned non-JSON response envelope");}
    const content=data.choices?.[0]?.message?.content??data.output_text??"";
    try{return JSON.parse(content.replace(/^```json\s*|\s*```$/g,""));}catch{throw new Error("Model did not return valid action JSON");}
  }
  async maybeAgentImage(prompt){if(!String(prompt||"").trim()||!this.settings().image.enabled)return[];try{const rr=await this.generateImage(new Request("https://local/api/image/generate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:String(prompt).slice(0,700)})}));const o=await rr.json();if(!o.image)return[];try{const sr=await this.summarizeImage(new Request("https://local/api/image/summarize",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({imageId:o.image.id})}));const so=await sr.json();o.image.summary=so.summary||""}catch{}return[o.image]}catch{return[]}}
  async applyAgent(o,mode="autonomous",requestedDate){
    if(!o||typeof o!=="object")throw new Error("Model returned invalid action data");
    const dateNow=/^\d{4}-\d{2}-\d{2}$/.test(requestedDate||"")?requestedDate:this.localDate();
    const outcome={schedule:0,diary:0,updates:0,comments:0,reactions:0};
    const writeSchedule=mode==="write_schedule"||mode==="autonomous",writeDiary=mode==="write_diary"||mode==="autonomous";
    if(writeSchedule){
      const localNow=this.localNow();
      if(dateNow>localNow.date)throw new Error("Refusing to save invented future schedule entries.");
      for(const x of (Array.isArray(o.schedule)?o.schedule:[]).slice(0,10)){
        if(!String(x.text||"").trim())continue;
        const start=String(x.time||"").slice(0,5),end=String(x.end||"").slice(0,5);
        if(dateNow===localNow.date){
          if(!/^\d{2}:\d{2}$/.test(start))continue;
          if(start>localNow.time)continue;
          if(end&&(/^\d{2}:\d{2}$/.test(end)?end>localNow.time:true))continue;
        }
        const images=await this.maybeAgentImage(x.imagePrompt),item={id:id("s"),owner:"character",date:dateNow,time:start,end,text:String(x.text).trim().slice(0,1000),status:"planned",images,history:[],createdAt:nowIso(),updatedAt:nowIso()};
        this.add("schedule",item);outcome.schedule++;this.queueCharacter(`${this.settings().characterName} added to their schedule: ${item.text}${this.imageContext(item)}`);
      }
    }
    if(mode==="autonomous")for(const x of (Array.isArray(o.updates)?o.updates:[]).slice(0,12)){
      const old=this.list("schedule").find(z=>z.id===x.id&&z.owner==="character");
      if(!old||!["planned","done","failed","cancelled","changed"].includes(x.status))continue;
      const actualText=String(x.actualText||"").trim();if(x.status==="changed"&&!actualText)continue;
      this.update("schedule",old.id,{status:x.status,actualText:x.status==="changed"?actualText:"",statusChangedAt:nowIso()});outcome.updates++;this.queueCharacter(`${this.settings().characterName} updated schedule status: ${old.text} → ${x.status}${actualText?` (${actualText})`:""}`);
    }
    if(writeDiary&&o.diary&&String(o.diary.text||"").trim()){
      const text=String(o.diary.text).trim().slice(0,10000);
      const existing=this.list("diary").find(x=>x.owner==="character"&&x.date===dateNow);
      if(!existing){const images=await this.maybeAgentImage(o.diary.imagePrompt),item={id:id("d"),owner:"character",date:dateNow,text,images,createdAt:nowIso(),updatedAt:nowIso()};this.add("diary",item);outcome.diary++;this.queueCharacter(`${this.settings().characterName} wrote in their diary: ${text.slice(0,700)}${this.imageContext(item)}`);}
      else if(mode==="write_diary")throw new Error("A diary entry already exists for this day. No overwrite was made.");
    }
    const forcedType=mode==="look_diary"?"diary":mode==="look_schedule"?"schedule":null;
    const diaryTarget=mode==="look_diary"?this.list("diary").find(z=>z.owner==="user"&&z.date===dateNow):null;
    for(const x of (Array.isArray(o.comments)?o.comments:[]).slice(0,3)){
      let type=forcedType||x.targetType||"schedule",targetId=x.targetId,parentId=null,rootType=type,rootId=targetId;
      let target=this.target(type,targetId);
      if(mode==="look_diary"&&(!target||target.owner!=="user")) { target=diaryTarget; targetId=diaryTarget?.id; rootType="diary";rootId=targetId; }
      if(type==="comment"){
        const parent=this.target("comment",targetId);
        if(!parent||parent.actor!=="user")continue;
        if(this.list("comments").some(c=>c.actor==="character"&&c.parentId===parent.id))continue;
        const root=this.commentRoot(parent); if(!root)continue;
        parentId=parent.id;rootType=root.type;rootId=root.id;target=this.target(rootType,rootId);
      }else{
        if(!target||target.owner!=="user")continue;
        // One character standalone comment per source entry. Further conversation should happen as replies.
        if(this.list("comments").some(c=>c.actor==="character"&&!c.parentId&&c.rootType===rootType&&c.rootId===rootId))continue;
      }
      if(!target||!String(x.text||"").trim())continue;
      this.add("comments",{id:id("c"),actor:"character",targetType:rootType,targetId:rootId,rootType,rootId,parentId,text:String(x.text).slice(0,500),createdAt:nowIso(),updatedAt:nowIso()});outcome.comments++;
    }
    for(const x of (Array.isArray(o.reactions)?o.reactions:[]).slice(0,5)){
      const type=forcedType||x.targetType||"schedule";
      let targetId=x.targetId;
      let target=this.target(type,targetId);
      if(mode==="look_diary"&&(!target||target.owner!=="user")) { target=diaryTarget; targetId=diaryTarget?.id; }
      if(!target||target.owner!=="user"||!this.settings().reactionLibrary.includes(x.emoji))continue;
      const arr=this.list("reactions").filter(r=>!(r.actor==="character"&&r.targetType===type&&r.targetId===targetId));
      arr.push({id:id("r"),actor:"character",targetType:type,targetId,emoji:x.emoji,createdAt:nowIso()});this.save("reactions",arr);outcome.reactions++;
    }
    if(Object.values(outcome).some(Boolean)){
      this.put("pending:user",[]);
      const parts=[];if(outcome.schedule)parts.push(`wrote ${outcome.schedule} schedule ${outcome.schedule===1?"entry":"entries"}`);
      if(outcome.diary)parts.push("wrote a diary entry");if(outcome.updates)parts.push(`updated ${outcome.updates} schedule status(es)`);
      if(outcome.comments)parts.push(`left ${outcome.comments} comment(s)`);if(outcome.reactions)parts.push(`added ${outcome.reactions} reaction(s)`);
      this.add("notifications",{id:id("n"),text:`${this.settings().characterName} ${parts.join(", ")}.`,read:false,createdAt:nowIso(),activityDate:this.localDate()});
      const summary=[];if(o.summary?.diary)summary.push(`Diary\n${String(o.summary.diary).slice(0,280)}`);
      if(Array.isArray(o.summary?.schedule)&&o.summary.schedule.length)summary.push(`Schedule\n${o.summary.schedule.slice(0,8).map(x=>`- ${String(x).slice(0,120)}`).join("\n")}`);
      if(summary.length)this.queueCharacter(summary.join(" | "));
    }
    return outcome;
  }
  bridgeUrl(raw){ try{ const u=new URL(String(raw||"").trim()); if(!u.pathname||u.pathname==="/")u.pathname="/api/companion/bridge"; return u.toString(); }catch{return String(raw||"").trim();} }
  async pushBridge(type,text,meta={}){
    const s=this.settings(),b=s.bridge;
    if(!b.enabled)return {ok:false,error:"Uranus Bridge is disabled"};
    if(!b.url)return {ok:false,error:"Bridge URL is missing"};
    if(!text)return {ok:false,error:"Nothing to push"};
    const url=this.bridgeUrl(b.url);
    try{
      const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-uranus-key":b.key||""},body:JSON.stringify({id:meta.packetId||crypto.randomUUID(),packetId:meta.packetId||null,eventIds:Array.isArray(meta.eventIds)?meta.eventIds:[],type,text,characterName:s.characterName,userName:s.userName,maxContextChars:b.maxContextChars,actor:meta.actor||((type==="character_summary"||type==="character_life")?"character":"user"),source:meta.source||"companion",origin:meta.origin||((type==="character_summary")?"companion_agent":"companion_ui"),createdAt:nowIso()})});
      const responseText=(await r.text()).slice(0,2000); let response=null; try{response=JSON.parse(responseText)}catch{}
      if(!r.ok)return {ok:false,status:r.status,url,error:`Uranus returned HTTP ${r.status}${responseText?`: ${responseText.slice(0,500)}`:""}`};
      return {ok:true,status:r.status,url,response,accepted:response?.accepted===true,packetId:String(response?.packetId||"")};
    }catch(e){return {ok:false,url,error:`Failed to reach Uranus: ${e?.message||e}`};}
  }
  async arm(){const deadline=Number(this.get("session:deadline",0))||0,next=deadline>Date.now()?Math.min(deadline,Date.now()+10*60000):Date.now()+10*60000;await this.ctx.storage.setAlarm(next)}
  async alarm(){
    const deadline=Number(this.get("session:deadline",0))||0;if(deadline&&deadline<=Date.now()){try{await this.commitSession(new Request("https://local/api/session/commit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({representation:"original",actions:[]})}))}catch{}}
    const st=this.settings(),tz=st.timezone||this.env.TZ||"America/New_York";this.pruneActivity();
    const pp=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date()).reduce((o,x)=>(o[x.type]=x.value,o),{}),day=`${pp.year}-${pp.month}-${pp.day}`,cur=(+pp.hour)*60+(+pp.minute);
    for(const [tag,target,label] of [["noon",720,"12:00 PM"],["21",1260,"9:00 PM"]])if(cur>=target&&cur<target+20&&!this.get(`charsync:${day}:${tag}`,false)){if(this.get("pending:character",[]).length)await this.flushCharacterContext(label);this.put(`charsync:${day}:${tag}`,true)}
    if(st.autonomy.enabled&&st.autonomy.maxVisits>0){const [sh,sm]=st.autonomy.activeStart.split(":").map(Number),[eh,em]=st.autonomy.activeEnd.split(":").map(Number);if(cur>=sh*60+sm&&cur<=eh*60+em){const key=`visits:${day}`,count=this.get(key,0),target=this.get(`${key}:target`,null)??Math.floor(Math.random()*(st.autonomy.maxVisits-st.autonomy.minVisits+1))+st.autonomy.minVisits;this.put(`${key}:target`,target);if(count<target){const counts=this.get(`${key}:kinds`,{schedule:0,diary:0,interact:0}),hasDiary=this.list("diary").some(x=>x.owner==="character"&&x.date===day),us=this.list("schedule").some(x=>x.owner==="user"&&x.date===day),ud=this.list("diary").some(x=>x.owner==="user"&&x.date===day),eligible=[{kind:"schedule",mode:"write_schedule",n:counts.schedule||0}];if(!hasDiary)eligible.push({kind:"diary",mode:"write_diary",n:counts.diary||0});if(us||ud)eligible.push({kind:"interact",mode:ud&&(!us||Math.random()<.5)?"look_diary":"look_schedule",n:counts.interact||0});const mn=Math.min(...eligible.map(x=>x.n)),pool=eligible.filter(x=>x.n===mn),pick=pool[Math.floor(Math.random()*pool.length)];try{const out=await this.applyAgent(await this.callAgent(pick.mode,day),pick.mode,day);if(Object.values(out).some(Boolean)){counts[pick.kind]=(counts[pick.kind]||0)+1;this.put(`${key}:kinds`,counts);this.put(key,count+1)}}catch{}}}}
    await this.arm();
  }
}

export default { async fetch(req,env){ const u=new URL(req.url); if(u.pathname.startsWith("/api/")){ const stub=env.COMPANION.get(env.COMPANION.idFromName("main")); return stub.fetch(req); } return env.ASSETS.fetch(req); } };
