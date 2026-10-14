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
  appearance:{my:{},loki:{},css:""},
  organizer:{enabled:false,roleKey:"",profileId:"",intervalMinutes:60},
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
    if(p==="/garden/feed"&&(m==="GET"||m==="OPTIONS")) return this.gardenFeed(req,u);
    if(p==="/garden/ingest"&&(m==="POST"||m==="OPTIONS")) return this.gardenIngest(req,u);
    if(p==="/mcp") return this.mcpRoute(req,u);
    if(!(await this.auth(req))) return j({ok:false,error:"Bad companion password"},401);
    if(p==="/api/bootstrap"&&m==="GET"){ try{this.tidyActivities();}catch{} }
    if(p==="/api/bootstrap"&&m==="GET") return j({ok:true,settings:this.settings(),schedule:this.list("schedule"),diary:this.list("diary"),comments:this.list("comments"),reactions:this.list("reactions"),highlights:this.list("highlights"),notifications:this.list("notifications").slice(-50).reverse(),organizer:this.get("org:state",null),suggestions:this.list("suggestions"),fonts:this.list("fonts")});
    if(p==="/api/settings"&&m==="PUT") return this.setSettings(req);
    if(p==="/api/garden/info"&&m==="GET") return j({ok:true,token:String(this.settings().garden?.token||""),url:u.origin});
    if(p==="/api/garden/token"&&m==="POST"){ const a=new Uint8Array(24); crypto.getRandomValues(a); const token=[...a].map(x=>x.toString(16).padStart(2,"0")).join(""); this.put("settings",{...this.settings(),garden:{token,createdAt:nowIso()}}); return j({ok:true,token,url:u.origin}); }
    if(p==="/api/mcp/info"&&m==="GET") return j({ok:true,token:String(this.settings().mcp?.token||""),url:u.origin});
    if(p==="/api/mcp/token"&&m==="POST"){ const a=new Uint8Array(24); crypto.getRandomValues(a); const token=[...a].map(x=>x.toString(16).padStart(2,"0")).join(""); this.put("settings",{...this.settings(),mcp:{token,createdAt:nowIso()}}); return j({ok:true,token,url:u.origin}); }
    if(p==="/api/mcp/token"&&m==="DELETE"){ this.put("settings",{...this.settings(),mcp:{token:"",createdAt:nowIso()}}); return j({ok:true}); }
    if(p==="/api/garden/token"&&m==="DELETE"){ this.put("settings",{...this.settings(),garden:{token:"",createdAt:nowIso()}}); return j({ok:true}); }
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
    if(p.startsWith("/api/schedule/")&&p.endsWith("/change")&&m==="POST") return this.changeSchedule(p.split("/")[3],req);
    if(p==="/api/suggest/run"&&m==="POST") return this.suggestRun(req);
    if(p==="/api/organizer/roles"&&m==="GET") return this.organizerRoles();
    if(p==="/api/organizer/run"&&m==="POST") return this.organizerRoute(req);
    if(p.startsWith("/api/suggestion/")&&p.endsWith("/accept")&&m==="POST") return this.acceptSuggestion(p.split("/")[3]);
    if(p.startsWith("/api/suggestion/")&&p.endsWith("/reject")&&m==="POST") return this.rejectSuggestion(p.split("/")[3]);
    if(p==="/api/font"&&m==="POST") return this.storeFont(req);
    if(p==="/api/font/link"&&m==="POST") return this.storeFontLink(req);
    if(p==="/api/uranus/providers"&&m==="GET"){ try{const c=await this.uranus("/api/config"); return j({ok:true,providers:(c.providers||[]).map(x=>({id:x.id,name:x.name,type:x.type||"custom",models:(x.models||[]).map(mm=>({model:mm.model,alias:mm.alias||"",category:mm.category||""}))}))}); }catch(e){ return j({ok:false,error:String(e.message||e)},400); } }
    if(p==="/api/music/state"&&m==="GET") return this.musicState();
    if(p==="/api/music/cfg"&&m==="PUT") return this.musicCfgSave(req);
    if(p==="/api/music/attitude"&&m==="POST") return this.musicAttitude(req);
    if(p==="/api/music/react"&&m==="POST") return this.musicReact(req);
    if(p==="/api/music/chat"&&m==="POST") return this.musicChat(req);
    if(p==="/api/music/chat"&&m==="DELETE"){ this.save("music:chat",[]); return j({ok:true}); }
    if(p.startsWith("/api/font/")&&m==="GET") return this.readFont(p.split("/").pop());
    if(p.startsWith("/api/font/")&&m==="DELETE") return this.deleteFont(p.split("/").pop());
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
  gardenFeed(req,u){
    const cors={"access-control-allow-origin":"*","access-control-allow-methods":"GET, OPTIONS","access-control-allow-headers":"content-type","cache-control":"no-store"};
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
    const tok=String(this.settings().garden?.token||""),got=String(u.searchParams.get("t")||"");
    let same=tok.length>0&&tok.length===got.length;
    if(same){let d=0;for(let i=0;i<tok.length;i++)d|=tok.charCodeAt(i)^got.charCodeAt(i);same=d===0;}
    const out=(o,status=200)=>new Response(JSON.stringify(o),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}});
    if(!same)return out({ok:false,error:"Bad Garden token"},401);
    try{this.tidyActivities();}catch{}
    const today=this.localDate(),from=this.isoPlus(today,-30),to=this.isoPlus(today,120);
    const items=this.list("schedule").filter(x=>x.owner==="character"&&x.date&&x.date>=from&&x.date<=to).sort((a,b)=>String(a.date).localeCompare(String(b.date))||String(a.time||"99:99").localeCompare(String(b.time||"99:99"))).slice(-500).map(x=>{
      const st=["planned","done","failed","changed","cancelled"].includes(x.status)?x.status:"planned";
      return {id:x.id,title:String(x.text||"").slice(0,200),desc:st==="changed"?"":String(x.desc||"").slice(0,300),date:x.date,time:x.time||"",end:x.end||"",deadline:!!x.deadline,status:st,updatedAt:x.statusChangedAt||x.updatedAt||""};
    });
    return out({ok:true,characterName:this.settings().characterName||"Loki",tz:this.tzName(),now:nowIso(),items});
  }

  /* Long text in the title slot -> short title + description (nothing is lost: the full text moves to desc). */
  /* Title = the text before the FIRST punctuation mark; the full original text always goes to desc. */
  firstClause(text){
    text=String(text||"").trim();if(text.length<=24)return text;
    const re=/[,，。！？!?；;、\n—–]|[.:：](?=\s|$)/g;let m;
    while((m=re.exec(text))){if(m.index>=3)return text.slice(0,m.index).trim();}
    return text.length>40?text.slice(0,32).trim()+"…":text;
  }
  splitText(text,desc=""){
    text=String(text||"").trim();desc=String(desc||"").trim();
    const title=this.firstClause(text);
    if(title===text)return {title,desc:desc.slice(0,2000)};
    return {title,desc:(desc.includes(text)?desc:(text+(desc?"\n"+desc:""))).slice(0,2000)};
  }
  tidyActivities(){
    const arr=this.list("schedule");let n=0;
    for(const x of arr){if(x.owner==="character"&&x.tidied!==2&&String(x.text||"").length>24){const sp=this.splitText(x.text,x.desc);if(sp.title!==x.text||sp.desc!==x.desc){x.text=sp.title;x.desc=sp.desc;n++;}x.tidied=2;}}
    if(n)this.save("schedule",arr);
    return n;
  }
  tokOk(tok,got){ tok=String(tok||"");got=String(got||""); if(!tok||tok.length!==got.length)return false; let d=0; for(let i=0;i<tok.length;i++)d|=tok.charCodeAt(i)^got.charCodeAt(i); return d===0; }
  /* Garden → Companion: a read-only snapshot of the user's own DDL tasks, so Loki can see them (never written back). */
  async gardenIngest(req,u){
    const cors={"access-control-allow-origin":"*","access-control-allow-methods":"POST, OPTIONS","access-control-allow-headers":"content-type","cache-control":"no-store"};
    const out=(o,status=200)=>new Response(JSON.stringify(o),{status,headers:{...cors,"content-type":"application/json; charset=utf-8"}});
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});
    if(!this.tokOk(this.settings().garden?.token,u.searchParams.get("t")))return out({ok:false,error:"Bad Garden token"},401);
    let b=null; try{const t=await req.text(); if(t.length>600000)return out({ok:false,error:"Too large"},413); b=JSON.parse(t);}catch{return out({ok:false,error:"Bad JSON"},400);}
    const d=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||""))?String(v):"",tm=v=>/^\d{2}:\d{2}$/.test(String(v||""))?String(v):"";
    const tasks=(Array.isArray(b.tasks)?b.tasks:[]).filter(x=>x&&x.id&&!x.quick&&d(x.date)).slice(0,600).map(x=>({id:String(x.id).slice(0,80),title:String(x.title||"").slice(0,160),course:String(x.course||"").slice(0,60),date:d(x.date),time:tm(x.time),start:tm(x.startTime),end:tm(x.endTime),kind:x.eventType==="duration"?"event":"deadline",done:!!x.done,notes:String(x.notes||"").slice(0,200)}));
    this.put("garden:snap",{at:nowIso(),tasks});
    return out({ok:true,count:tasks.length});
  }
  mcpTools(){
    const D={type:"string",description:"YYYY-MM-DD"};
    return [
      {name:"get_user_activity",description:"Read the user's own plans: their Companion 'My Day' activities AND their DDL Garden deadlines/events, merged into one list. READ-ONLY: you can look but never change the user's items. Each item has source, title, date, time, status.",inputSchema:{type:"object",properties:{from:{...D,description:"start date, default today"},to:{...D,description:"end date, default 14 days from today"}}}},
      {name:"get_my_activity",description:"Read YOUR OWN planned/finished activities in the shared Companion calendar (with ids and statuses).",inputSchema:{type:"object",properties:{from:{...D,description:"default 7 days ago"},to:{...D,description:"default 30 days ahead"},status:{type:"string",enum:["planned","done","failed","changed","cancelled"]}}}},
      {name:"add_my_activity",description:"Add a plan or intention to YOUR OWN calendar. Give a date when you know it (it will then appear in the user's DDL Garden); leave date empty if it is only a vague intention. Do not add things that already exist.",inputSchema:{type:"object",properties:{title:{type:"string"},date:D,time:{type:"string",description:"HH:MM, optional"},end:{type:"string",description:"HH:MM, optional"},desc:{type:"string"}},required:["title"]}},
      {name:"update_my_activity",description:"Update YOUR OWN activity by id. status 'done'/'failed' only for plans whose time has already come; 'cancelled' any time; 'changed' (with newTitle/newDate/newTime or actualText = what you did instead) replaces the plan with a linked new one. Always give a short reason in the activity's language. You cannot touch the user's items.",inputSchema:{type:"object",properties:{id:{type:"string"},status:{type:"string",enum:["done","failed","cancelled","changed"]},reason:{type:"string"},actualText:{type:"string"},newTitle:{type:"string"},newDate:D,newTime:{type:"string"},newEnd:{type:"string"}},required:["id"]}}
    ];
  }
  async mcpRoute(req,u){
    const H={"content-type":"application/json; charset=utf-8","cache-control":"no-store"};
    const bearer=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");
    const got=u.searchParams.get("t")||bearer||req.headers.get("x-companion-mcp")||"";
    if(!this.tokOk(this.settings().mcp?.token,got))return new Response(JSON.stringify({jsonrpc:"2.0",id:null,error:{code:-32001,message:"Bad MCP token"}}),{status:401,headers:H});
    if(req.method==="DELETE")return new Response(null,{status:200});
    if(req.method!=="POST")return new Response(JSON.stringify({error:"POST only"}),{status:405,headers:{...H,allow:"POST"}});
    let msg; try{msg=await req.json();}catch{return new Response(JSON.stringify({jsonrpc:"2.0",id:null,error:{code:-32700,message:"Parse error"}}),{status:400,headers:H});}
    const handle=async(m)=>{
      const id=m?.id; const isNote=id===undefined||id===null;
      try{
        if(m?.method==="initialize")return {jsonrpc:"2.0",id,result:{protocolVersion:String(m.params?.protocolVersion||"2025-06-18"),capabilities:{tools:{}},serverInfo:{name:"companion",version:"1.0.0"}}};
        if(String(m?.method||"").startsWith("notifications/"))return null;
        if(m?.method==="ping")return {jsonrpc:"2.0",id,result:{}};
        if(m?.method==="tools/list")return {jsonrpc:"2.0",id,result:{tools:this.mcpTools()}};
        if(m?.method==="tools/call"){
          const name=String(m.params?.name||""),args=m.params?.arguments||{};
          try{const r=await this.mcpCall(name,args);return {jsonrpc:"2.0",id,result:{content:[{type:"text",text:JSON.stringify(r)}]}};}
          catch(e){return {jsonrpc:"2.0",id,result:{isError:true,content:[{type:"text",text:String(e.message||e)}]}};}
        }
        return isNote?null:{jsonrpc:"2.0",id,error:{code:-32601,message:"Method not found"}};
      }catch(e){return isNote?null:{jsonrpc:"2.0",id,error:{code:-32603,message:String(e.message||e)}};}
    };
    if(Array.isArray(msg)){const rs=(await Promise.all(msg.map(handle))).filter(Boolean);return rs.length?new Response(JSON.stringify(rs),{headers:H}):new Response(null,{status:202});}
    const r=await handle(msg);
    return r?new Response(JSON.stringify(r),{headers:H}):new Response(null,{status:202});
  }
  async mcpCall(name,a){
    const ln=this.localNow(),today=ln.date,isoD=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||""))?String(v):"";
    const slim=x=>({id:x.id,title:x.text,desc:x.desc||"",date:x.date||"",time:x.time||"",end:x.end||"",status:x.status||"planned",...(x.statusNote?{reason:x.statusNote}:{}),...(x.changedTo?{replacedBy:x.changedTo}:{}),...(x.changedFrom?{replacesId:x.changedFrom}:{})});
    if(name==="get_user_activity"){
      const from=isoD(a.from)||today,to=isoD(a.to)||this.isoPlus(today,14);
      const items=[];
      for(const x of this.list("schedule"))if(x.owner==="user"&&x.date&&x.date>=from&&x.date<=to)items.push({source:"companion_my_day",readOnly:true,title:x.text,desc:x.desc||"",date:x.date,time:x.time||"",end:x.end||"",status:x.status||"planned"});
      const snap=this.get("garden:snap",null);
      if(snap)for(const t of snap.tasks||[])if(t.date>=from&&t.date<=to)items.push({source:"ddl_garden",readOnly:true,kind:t.kind,title:(t.course?t.course+" · ":"")+t.title,desc:t.notes||"",date:t.date,time:t.kind==="event"?t.start:t.time,end:t.end||"",status:t.done?"done":"open"});
      items.sort((x,y)=>String(x.date).localeCompare(String(y.date))||String(x.time||"99:99").localeCompare(String(y.time||"99:99")));
      return {timezone:this.tzName(),today,now:ln.time,range:{from,to},ddlSnapshotAt:snap?.at||null,ddlNote:snap?"DDL Garden items come from the last time the user had Garden open; they may be a little stale.":"DDL Garden is not connected yet, so only Companion items are shown.",note:"Everything here is the USER's and is read-only.",count:Math.min(items.length,150),items:items.slice(0,150)};
    }
    if(name==="get_my_activity"){
      const from=isoD(a.from)||this.isoPlus(today,-7),to=isoD(a.to)||this.isoPlus(today,30);
      let items=this.list("schedule").filter(x=>x.owner==="character"&&(!x.date||(x.date>=from&&x.date<=to)));
      if(a.status)items=items.filter(x=>(x.status||"planned")===a.status);
      items.sort((x,y)=>String(x.date||"9999").localeCompare(String(y.date||"9999"))||String(x.time||"99:99").localeCompare(String(y.time||"99:99")));
      return {timezone:this.tzName(),today,now:ln.time,count:Math.min(items.length,150),items:items.slice(0,150).map(slim)};
    }
    if(name==="add_my_activity"){
      const title=String(a.title||"").trim(); if(!title)throw new Error("title is required");
      const date=isoD(a.date);
      const dup=this.list("schedule").find(x=>x.owner==="character"&&(x.status||"planned")==="planned"&&(x.date||"")===date&&this.normTitle(x.text)===this.normTitle(title));
      if(dup)return {ok:true,duplicate:true,item:slim(dup),note:"An identical planned activity already exists; nothing was added."};
      const sp=this.splitText(title,a.desc);const x=this.newActivity({owner:"character",date,time:a.time,end:a.end,text:sp.title,desc:sp.desc});
      Object.assign(x,{origin:"uranus_mcp",orgKey:`${date}|${this.normTitle(title)}`,recordedAt:nowIso(),tz:this.tzName()});
      this.add("schedule",x);
      return {ok:true,item:slim(x)};
    }
    if(name==="update_my_activity"){
      const old=this.list("schedule").find(x=>x.id===a.id);
      if(!old)throw new Error("No activity with that id. Use get_my_activity to find ids.");
      if(old.owner!=="character")throw new Error("That is the user's activity. You can't change it (only read it).");
      if((old.status||"planned")!=="planned")throw new Error(`That activity is already ${old.status}; it can't be changed again.`);
      const reason=String(a.reason||"").trim().slice(0,160);
      const wantsChange=a.status==="changed"||(!a.status&&(a.newTitle||a.newDate||a.newTime||a.actualText));
      if(wantsChange){
        const actual=String(a.actualText||"").trim(),nt=String(a.newTitle||"").trim();
        if(!actual&&!nt&&!isoD(a.newDate)&&!a.newTime)throw new Error("For 'changed' give newTitle, newDate, newTime, or actualText (what you did instead).");
        const res=this.makeChange(old,{date:isoD(a.newDate)||old.date,time:actual?"":(a.newTime!==undefined?a.newTime:old.time),end:actual?"":(a.newEnd!==undefined?a.newEnd:old.end),text:actual||nt||old.text,desc:old.desc,status:actual?"done":"planned"},"character");
        if(reason)this.update("schedule",old.id,{statusNote:reason});
        return {ok:true,original:slim(this.list("schedule").find(x=>x.id===old.id)),replacement:slim(res.replacement)};
      }
      if(!["done","failed","cancelled"].includes(a.status))throw new Error("status must be done, failed, cancelled or changed");
      if(a.status!=="cancelled"){
        if(!old.date)throw new Error("This activity has no date yet, so it can't be marked done/failed.");
        if(old.date>today||(old.date===today&&old.time&&String(old.time).slice(0,5)>ln.time))throw new Error(`That plan is for ${old.date}${old.time?" "+old.time:""} and it is only ${today} ${ln.time} now. Don't settle future plans (cancel or change it instead).`);
      }
      const x=this.update("schedule",old.id,{status:a.status,statusChangedAt:nowIso(),statusBy:"character",statusNote:reason});
      return {ok:true,item:slim(x)};
    }
    throw new Error("Unknown tool: "+name);
  }
  async auth(req){ const secret=String(this.env.COMPANION_PASSWORD||""); if(!secret)return true; let got=req.headers.get("x-companion-key")||""; if(!got&&req.method==="GET"){const u=new URL(req.url); if(u.pathname.startsWith("/api/image/")||u.pathname.startsWith("/api/font/"))got=u.searchParams.get("k")||"";} return got===secret; }
  async body(req){ try{return await req.json();}catch{return{};} }
  async freshStart(){
    // One-time schema-aware cleanup: remove life/history/test data only. Settings are intentionally preserved.
    const cleared={};
    for(const kind of ["schedule","diary","comments","reactions","highlights","notifications","suggestions"]){
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
  async generateImage(req){const b=await this.body(req),cfg0=this.settings().image,cfg={...cfg0};if(cfg0.source==="uranus"&&cfg0.uranusProviderId){try{const rp=await this.resolveUranusProvider(cfg0.uranusProviderId);cfg.baseUrl=rp.baseUrl;cfg.apiKey=rp.apiKey}catch(e){return j({ok:false,error:String(e.message||e)},400)}}if(!cfg.enabled||!cfg.baseUrl||!cfg.model)return j({ok:false,error:"Configure Image Generation first"},400);const prompt=[cfg.positivePrompt,String(b.prompt||"")].map(x=>String(x||"").trim()).filter(Boolean).join("\n");if(!prompt)return j({ok:false,error:"Image prompt required"},400);let url=String(cfg.baseUrl).replace(/\/+$/,"");if(!url.endsWith("/images/generations"))url+="/images/generations";const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${cfg.apiKey||""}`},body:JSON.stringify({model:cfg.model,prompt,n:1,size:"1024x1024",response_format:"b64_json"})});const raw=await r.text();if(!r.ok)throw new Error(`Image API ${r.status}: ${raw.slice(0,300)}`);let o;try{o=JSON.parse(raw)}catch{throw new Error("Image API returned invalid JSON")}const it=o?.data?.[0];let data=it?.b64_json?`data:image/png;base64,${it.b64_json}`:"";if(!data&&it?.url){const rr=await fetch(it.url);const buf=new Uint8Array(await rr.arrayBuffer());let str="";for(let n=0;n<buf.length;n+=8192)str+=String.fromCharCode(...buf.slice(n,n+8192));data=`data:${rr.headers.get("content-type")||"image/png"};base64,${btoa(str)}`}if(!data)throw new Error("Image API returned no image");return this.storeImage(new Request("https://local/api/image",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({data,source:"generated"})}))}
  async summarizeImage(req){const b=await this.body(req),iid=String(b.imageId||""),m=this.imageMeta(iid);if(!m)return j({ok:false,error:"Image not found"},404);let data="";for(let n=0;n<m.chunks;n++)data+=this.get(`image:${iid}:${n}`,"");const st=this.settings(),p=st.modelProfiles.find(x=>x.id===st.agent.profileId);if(!p)return j({ok:false,error:"Select an active Companion model"},400);const base=String(p.baseUrl||"").replace(/\/+$/,""),url=base.endsWith("/chat/completions")?base:base+"/chat/completions";const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${p.apiKey||""}`,...(p.headers||{})},body:JSON.stringify({model:p.model,messages:[{role:"user",content:[{type:"text",text:"Describe this image for memory/context in one short factual sentence. Mention only clearly visible content relevant to a diary/calendar event. No inference or backstory. Return only the sentence."},{type:"image_url",image_url:{url:data}}]}],max_tokens:100})});const raw=await r.text();if(!r.ok)throw new Error(`Vision summary ${r.status}: ${raw.slice(0,240)}`);let o;try{o=JSON.parse(raw)}catch{throw new Error("Vision model returned invalid JSON")}const summary=String(o?.choices?.[0]?.message?.content||"").trim().slice(0,600);if(!summary)throw new Error("Empty image summary");this.put(`image:${iid}:meta`,{...m,summary});return j({ok:true,summary})}
  imageContext(x){const z=(x.images||[]).map(q=>q.summary||this.imageMeta(q.id)?.summary).filter(Boolean);return z.length?` Image: ${z.join("; ")}`:""}
  queueCharacter(text){const q=this.get("pending:character",[]);q.push({id:crypto.randomUUID(),text:String(text).slice(0,1600),createdAt:nowIso()});this.put("pending:character",q.slice(-100))}
  async flushCharacterContext(reason="scheduled"){const q=this.get("pending:character",[]);if(!q.length)return j({ok:true,empty:true});const packet=q.map(x=>`[${this.formatSessionTime(x.createdAt)}] ${x.text}`).join("\n"),packetId=crypto.randomUUID();this.add("notifications",{id:id("n"),text:"Character context syncing to Uranus…",read:false,createdAt:nowIso(),activityDate:this.localDate()});const r=await this.pushBridge("character_life",packet,{actor:"character",source:"companion",origin:`character_context_${reason}`,packetId});if(r.ok&&r.accepted){this.put("pending:character",[]);this.add("notifications",{id:id("n"),text:`Character context synced to Uranus · ${reason}.`,read:false,createdAt:nowIso(),activityDate:this.localDate()});return j({ok:true,accepted:true})}this.add("notifications",{id:id("n"),text:"Character context sync failed · retained for retry.",read:false,createdAt:nowIso(),activityDate:this.localDate()});return j({ok:false,error:r.error||"No ACK"},502)}
  pruneActivity(){const tz=this.settings().timezone||this.env.TZ||"America/New_York",fmt=d=>new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit"}).format(d),t=fmt(new Date()),y=new Date();y.setDate(y.getDate()-1);const keep=new Set([t,fmt(y)]);this.save("notifications",this.list("notifications").filter(n=>keep.has(n.activityDate||fmt(new Date(n.createdAt)))))}
  async setSettings(req){ const b=await this.body(req); const old=this.settings(); const a=b.autonomy||{}; const next={...old,...b,autonomy:{...old.autonomy,...a,minVisits:clamp(a.minVisits??old.autonomy.minVisits,0,10),maxVisits:clamp(a.maxVisits??old.autonomy.maxVisits,0,10),minIntervalMinutes:clamp(a.minIntervalMinutes??old.autonomy.minIntervalMinutes,0,1440)},reactionLibrary:[...new Set((b.reactionLibrary??old.reactionLibrary).map(String))].slice(0,50)}; if(next.autonomy.maxVisits<next.autonomy.minVisits)next.autonomy.maxVisits=next.autonomy.minVisits; next.garden=old.garden||{token:""}; next.mcp=old.mcp||{token:""}; this.put("settings",next); await this.arm(); return j({ok:true,settings:next}); }
  newActivity(o){ const t=v=>/^\d{2}:\d{2}$/.test(String(v||"").slice(0,5))?String(v).slice(0,5):"",d=v=>/^\d{4}-\d{2}-\d{2}$/.test(String(v||"").slice(0,10))?String(v).slice(0,10):""; const time=t(o.time),end=time?t(o.end):""; return {id:id("s"),owner:o.owner||"user",date:d(o.date),time,end,deadline:!!(o.deadline&&time&&!end),text:String(o.text||"").trim().slice(0,1000),desc:String(o.desc||"").trim().slice(0,2000),status:["planned","done","failed"].includes(o.status)?o.status:"planned",images:Array.isArray(o.images)?o.images.slice(0,4):[],statusImages:[],history:[],changedFrom:o.changedFrom||null,changedTo:null,suggestionId:o.suggestionId||null,suggestedBy:o.suggestedBy||null,createdAt:nowIso(),updatedAt:nowIso()}; }
  async createSchedule(req){ const b=await this.body(req); const text=String(b.text||"").trim(); if(!text)return j({ok:false,error:"Title required"},400); const x=this.newActivity({owner:"user",date:b.date,time:b.time,end:b.end,deadline:b.deadline,text,desc:b.desc,images:b.images}); this.add("schedule",x); return j({ok:true,item:x}); }
  makeChange(x,spec,by="user"){
    const rep=this.newActivity({owner:x.owner,date:spec.date!==undefined?spec.date:x.date,time:spec.time,end:spec.end,deadline:spec.deadline,text:spec.text,desc:spec.desc,images:spec.images,status:spec.status==="done"?"done":"planned",changedFrom:x.id,suggestionId:spec.suggestionId,suggestedBy:spec.suggestedBy});
    if(rep.status==="done"){rep.statusChangedAt=nowIso();rep.statusBy=by;}
    this.add("schedule",rep);
    const orig=this.update("schedule",x.id,{status:"changed",changedTo:rep.id,statusChangedAt:nowIso(),statusBy:by,suggestionId:spec.suggestionId||x.suggestionId||null});
    return {original:orig,replacement:rep};
  }
  async changeSchedule(itemId,req){
    const b=await this.body(req),x=this.list("schedule").find(z=>z.id===itemId);
    if(!x)return j({ok:false,error:"Not found"},404);
    if(x.owner!=="user")return j({ok:false,error:"You can only change your own plans"},403);
    if(x.status==="changed"&&x.changedTo)return j({ok:false,error:"This plan was already changed. Change the new plan instead."},409);
    if(!String(b.text||"").trim())return j({ok:false,error:"Title required"},400);
    return j({ok:true,...this.makeChange(x,b,"user")});
  }
  async patch(kind,itemId,req){
    const b=await this.body(req),x=this.list(kind).find(z=>z.id===itemId);
    if(!x)return j({ok:false,error:"Not found"},404);
    if(x.owner!=="user")return j({ok:false,error:"You can only edit your own entries"},403);
    const patch={};
    if(kind==="schedule"){
      const t=v=>/^\d{2}:\d{2}$/.test(String(v||"").slice(0,5))?String(v).slice(0,5):"";
      if(b.status==="changed"){
        // legacy "Changed plan" from the original Companion page: becomes a real linked replacement
        if(!String(b.actualText||"").trim())return j({ok:false,error:"Say what you did instead"},400);
        if(x.status==="changed"&&x.changedTo)return j({ok:false,error:"This plan was already changed."},409);
        return j({ok:true,item:this.makeChange(x,{text:b.actualText,status:"done"},"user").original});
      }
      if(x.status==="changed"&&x.changedTo&&("status" in b))return j({ok:false,error:"This plan was changed. Edit the new plan instead."},409);
      if("text" in b){const v=String(b.text||"").trim();if(!v)return j({ok:false,error:"Title required"},400);patch.text=v.slice(0,1000);}
      if("desc" in b)patch.desc=String(b.desc||"").trim().slice(0,2000);
      if("date" in b)patch.date=/^\d{4}-\d{2}-\d{2}$/.test(String(b.date||"").slice(0,10))?String(b.date).slice(0,10):"";
      if("time" in b||"end" in b||"deadline" in b){const time=t("time" in b?b.time:x.time),end=time?t("end" in b?b.end:x.end):"",dl=("deadline" in b)?b.deadline:x.deadline;patch.time=time;patch.end=end;patch.deadline=!!(dl&&time&&!end);}
      if(Array.isArray(b.images))patch.images=b.images.slice(0,4);
      if("status" in b){
        if(!["planned","done","failed","cancelled"].includes(b.status))return j({ok:false,error:"Unknown status"},400);
        patch.status=b.status;patch.statusChangedAt=nowIso();patch.statusBy="user";
        if(b.status==="done"){if("doneText" in b)patch.doneText=String(b.doneText||"").trim().slice(0,1000);if(Array.isArray(b.statusImages))patch.statusImages=b.statusImages.slice(0,6);}
      }
    }else{
      if("text" in b){const v=String(b.text||"").trim();if(!v)return j({ok:false,error:"Text required"},400);patch.text=v.slice(0,10000);}
      if("title" in b)patch.title=String(b.title||"").trim().slice(0,200);
      if(Array.isArray(b.images))patch.images=b.images.slice(0,6);
    }
    return j({ok:true,item:this.update(kind,itemId,patch)});
  }
  remove(kind,itemId){
    const x=this.list(kind).find(z=>z.id===itemId);
    if(!x)return j({ok:false,error:"Not found"},404);
    if(x.owner!=="user")return j({ok:false,error:"You can only delete your own entries"},403);
    this.save(kind,this.list(kind).filter(z=>z.id!==itemId));
    if(kind==="schedule"){
      // keep change chains consistent
      if(x.changedFrom){const o=this.list("schedule").find(z=>z.id===x.changedFrom);if(o&&o.changedTo===x.id)this.update("schedule",o.id,{status:"planned",changedTo:null});}
      if(x.changedTo){const r=this.list("schedule").find(z=>z.id===x.changedTo);if(r&&r.changedFrom===x.id)this.update("schedule",r.id,{changedFrom:null});}
      this.save("suggestions",this.list("suggestions").filter(g=>g.targetId!==itemId));
    }
    this.save("comments",this.list("comments").filter(c=>!((c.rootId||c.targetId)===itemId)));
    this.save("reactions",this.list("reactions").filter(r=>r.targetId!==itemId));
    if(kind==="diary")this.save("highlights",this.list("highlights").filter(h=>h.diaryId!==itemId));
    return j({ok:true});
  }
  async createDiary(req){ const b=await this.body(req); const owner="user", date=String(b.date||"").slice(0,10), text=String(b.text||"").trim(), images=Array.isArray(b.images)?b.images.slice(0,6):[], title=String(b.title||"").trim().slice(0,200);
    if(!date||!text)return j({ok:false,error:"date and text required"},400);
    if(b.id){ const x=this.list("diary").find(z=>z.id===b.id&&z.owner===owner); if(!x)return j({ok:false,error:"Entry not found"},404); return j({ok:true,item:this.update("diary",x.id,{text,title,images})}); }
    if(!b.append){ const existing=this.list("diary").find(x=>x.owner===owner&&x.date===date); if(existing){ const item=this.update("diary",existing.id,{text,...(Array.isArray(b.images)?{images}:{})}); return j({ok:true,item}); } }
    const x={id:id("d"),owner,date,title,kind:"diary",text,images,createdAt:nowIso(),updatedAt:nowIso()}; this.add("diary",x); return j({ok:true,item:x}); }
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
    const x={id:id("c"),actor:"user",targetType:rootType,targetId:rootId,rootType,rootId,parentId,text:text.slice(0,500),quote:String(b.quote||"").slice(0,300),createdAt:nowIso(),updatedAt:nowIso()};
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
  meaningfulActions(actions){ return (Array.isArray(actions)?actions:[]).filter(x=>["comment","reaction","highlight","write_schedule","write_diary","update_schedule","suggestion_accept","suggestion_reject"].includes(x?.type)); }
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
      if(a.type==="suggestion_accept")return `${t}Raylee accepted ${this.settings().characterName}'s suggestion for My Day: ${String(a.summary||"").slice(0,300)}.`;
      if(a.type==="suggestion_reject")return `${t}Raylee rejected ${this.settings().characterName}'s suggestion for My Day (${String(a.summary||"").slice(0,300)}). Her original plan stays as it was.`;
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
    const mode=["look_schedule","write_schedule","look_diary","write_diary","review_status","autonomous"].includes(b.mode)?b.mode:"autonomous";
    try{
      const result=await this.callAgent(mode,b.date);
      if(mode==="write_schedule"&&!(Array.isArray(result.schedule)&&result.schedule.some(x=>String(x.title||x.text||"").trim())))throw new Error("Model returned no schedule entry. Nothing was saved; please try again.");
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
    const uctx=await this.uranusContext(date);
    if((mode==="write_schedule"||mode==="write_diary")&&date>localNow.date)throw new Error("Ask Loki to Write cannot invent lived events for a future date.");
    const userScheduleForDate=this.list("schedule").filter(x=>x.owner==="user"&&x.date===date);
    const userDiaryForDate=this.list("diary").filter(x=>x.owner==="user"&&x.date===date);
    const todayWriteRule=date===localNow.date?`TODAY SAFETY RULE: It is currently ${localNow.time} in ${localNow.timeZone}. Write ONLY events that have already happened or are happening now. NEVER invent, predict, pre-fill, or schedule events later than ${localNow.time}. For schedule writing today, every new schedule item MUST include an explicit HH:MM start time that is not later than ${localNow.time}; any end time must also not be later than ${localNow.time}. If only one real/present activity is appropriate, write only one. Do not fill the rest of the day.`:`The target date is in the past, so you may describe events from that completed day.`;
    const statusRule=`STATUS RULES (updates array, each {"id","status","actualText","reason"}): you may settle YOUR OWN items that are still "planned", whose date is before TARGET DATE, or equal to TARGET DATE with a start time not later than ${localNow.time} (items on TARGET DATE with no time only if URANUS MEMORY or the day clearly settles them). Decide by URANUS MEMORY first (what really happened in chat), then by your persona: "done" = carried out / believably done; "failed" = memory shows it did not happen, or in character you flaked, got distracted, ran out of time; "changed" (+ actualText = what you did instead) = you did something different; "cancelled" = dropped on purpose. Be a person with a personality, not a checklist: it is natural for some things to fail or change, but do not make failure a pattern and never fabricate dramatic reasons. NEVER settle an item whose time is still in the future. At most 4 updates, each with a short "reason" in the item's language. If nothing is settled yet, return updates [].`;
    const instruction=mode==="review_status"?`STATUS REVIEW ONLY. Do NOT create schedule or diary entries and do NOT comment or react. Only review YOUR schedule. ${statusRule}`:mode==="write_schedule"?`MANDATORY: Create at least ONE nonempty schedule item in the schedule array for ${date}. You are writing YOUR OWN lived day, not merely looking. Do not invent content just to fill the calendar. ${todayWriteRule}`:mode==="write_diary"?`MANDATORY: Write a nonempty diary object {"date":"${date}","text":"..."}. Write YOUR OWN diary, even if it is just 1-2 natural sentences. Do not return null diary. ${todayWriteRule}`:mode==="look_schedule"?`LOOK ONLY at the user's schedule. Do NOT create schedules or diary entries. MANDATORY: leave at least ONE interaction on a USER schedule entry for TARGET DATE: either a natural comment or exactly one reaction chosen from AVAILABLE REACTIONS. You may do both. For every schedule interaction, targetType MUST be "schedule" and targetId MUST be an exact schedule id shown in ELIGIBLE TARGETS. Never return with both comments and reactions empty.`:mode==="look_diary"?`LOOK ONLY at the user's diary. Do NOT create schedules or diary entries. MANDATORY: leave at least ONE interaction on the USER diary entry for TARGET DATE: either a natural comment or exactly one reaction chosen from AVAILABLE REACTIONS. You may do both. For every diary interaction, targetType MUST be "diary" and targetId MUST be the exact diary id shown in ELIGIBLE TARGETS. Never use "schedule" for a diary interaction. Never return with both comments and reactions empty.`:`AUTONOMOUS VISIT. Prefer living YOUR OWN life rather than hovering over the user. Across visits, balance three categories roughly evenly: (A) write/update YOUR schedule, (B) write YOUR diary when no diary exists today, (C) interact with the USER. Do not repeatedly choose C just because user activity exists. At most ONE comment/reply per target or user comment in a visit. Never leave a second character reply under the same user comment. If replying to a user comment, use targetType "comment" and its exact comment id. Do not pile multiple standalone comments onto the same user entry. It is fine to write only your own life and not react to the user. ${statusRule}`;
    const langRule=String(s.agent.language||"").trim()?`OUTPUT LANGUAGE (HIGHEST PRIORITY): write EVERY human-readable text value you produce (diary text, schedule titles, comments, summaries) in ${String(s.agent.language).trim()}. This overrides the language of the persona, worldbook, URANUS MEMORY, existing entries and the user's messages. Never switch to another language.`:"";
    const prompt=`${langRule?langRule+"\n":""}You are ${s.characterName}. Return ONLY valid JSON.\nMODE: ${mode}\nTARGET DATE: ${date}\nLOCAL TIMEZONE: ${s.timezone}\nCURRENT UTC: ${nowIso()}\nIMPORTANT INSTRUCTION: ${instruction}\nYou can change the status of YOUR OWN existing schedules using updates [{"id":"existing id","status":"done|failed|cancelled|changed","actualText":"required only for changed"}]. Do not edit or delete original schedule text.\nYou can ONLY comment/react to the USER's existing entries. Never comment/react to your own.\nPERSONA:\n${s.agent.persona}\nUSER:\n${s.agent.userPersona}\nWORLDBOOK:\n${s.agent.worldbook}\nSPECIAL INSTRUCTIONS:\n${s.agent.instructions}\nAVAILABLE REACTIONS: ${s.reactionLibrary.join(" ")}\nELIGIBLE TARGETS FOR THIS REQUEST:\n${mode==="look_diary"?JSON.stringify(userDiaryForDate):mode==="look_schedule"?JSON.stringify(userScheduleForDate):"n/a"}\nINTERACTION JSON SCHEMA: comments use {"targetType":"schedule|diary|comment","targetId":"exact existing entry/comment id","text":"..."}. targetType "comment" means reply to an existing USER comment; reactions use {"targetType":"schedule|diary","targetId":"exact existing id","emoji":"one AVAILABLE REACTION"}.\n${uctx}\nRECENT USER ACTIVITY:\n${this.compactActivity(pending)}\nEXISTING COMMENT THREADS (do not duplicate a character reply to the same user comment):\n${JSON.stringify(this.list("comments").slice(-40))}\nYOUR SCHEDULE:\n${JSON.stringify(this.list("schedule").filter(x=>x.owner==="character").slice(-30))}\nUSER SCHEDULE:\n${JSON.stringify(this.list("schedule").filter(x=>x.owner==="user").slice(-30))}\nYOUR DIARY:\n${JSON.stringify(this.list("diary").filter(x=>x.owner==="character").slice(-7))}\nUSER DIARY:\n${JSON.stringify(this.list("diary").filter(x=>x.owner==="user").slice(-7))}\nOPTIONAL IMAGE: for YOUR OWN schedule/diary only, when an image would naturally enrich the entry and Image Generation is enabled, add "imagePrompt":"short visual prompt" to that schedule item or diary object. Do not create images for user entries.
Return JSON shape {"schedule":[],"updates":[],"diary":null,"comments":[],"reactions":[],"summary":{"diary":"","schedule":[]},"messageNow":null}. schedule items use {"date":"${date}","time":"HH:MM or empty","end":"HH:MM or empty","title":"a SHORT label of at most 30 characters with NO comma or other punctuation inside, e.g. Back in Asgard","desc":"the details / what actually happens, one or two sentences (optional)"}. NEVER put the whole description into "title". Comments/reactions must target existing USER entry IDs only.`;
    const base=String(profile.baseUrl||"").replace(/\/$/,"");const path=profile.path||"/chat/completions";
    const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${profile.apiKey||""}`,...(profile.headers||{})},body:JSON.stringify({model:profile.model,messages:[{role:"system",content:prompt},{role:"user",content:(mode.startsWith("write_")?`Write the required ${mode==="write_schedule"?"schedule":"diary"} for ${date} now. Return a nonempty result.`:mode.startsWith("look_")?`Look at the requested user content now and MUST leave at least one valid reaction or comment on it.`:mode==="review_status"?"Review the status of your own past plans now.":"Decide what you naturally do this visit.")+(langRule?` (Reminder: all text values must be in ${String(s.agent.language).trim()}.)`:"")}],...(profile.temperature===null||profile.temperature===undefined?{}:{temperature:Number(profile.temperature)}),response_format:{type:"json_object"}})});
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
        const rawTitle=String(x.title||x.text||"").trim();
        if(!rawTitle)continue;
        const sp=this.splitText(rawTitle,x.desc);
        const start=String(x.time||"").slice(0,5),end=String(x.end||"").slice(0,5);
        if(dateNow===localNow.date){
          if(!/^\d{2}:\d{2}$/.test(start))continue;
          if(start>localNow.time)continue;
          if(end&&(/^\d{2}:\d{2}$/.test(end)?end>localNow.time:true))continue;
        }
        const images=await this.maybeAgentImage(x.imagePrompt),item={id:id("s"),owner:"character",date:dateNow,time:start,end,text:sp.title,desc:sp.desc,status:"planned",images,history:[],createdAt:nowIso(),updatedAt:nowIso()};
        this.add("schedule",item);outcome.schedule++;this.queueCharacter(`${this.settings().characterName} added to their schedule: ${item.text}${this.imageContext(item)}`);
      }
    }
    if(mode==="autonomous"||mode==="review_status")for(const x of (Array.isArray(o.updates)?o.updates:[]).slice(0,6)){
      const old=this.list("schedule").find(z=>z.id===x.id&&z.owner==="character");
      if(!old||!["done","failed","cancelled","changed"].includes(x.status))continue;
      if((old.status||"planned")!=="planned"||!old.date)continue;
      { const ln=this.localNow(); if(old.date>ln.date||(old.date===ln.date&&old.time&&String(old.time).slice(0,5)>ln.time))continue; }
      const actualText=String(x.actualText||"").trim();if(x.status==="changed"&&!actualText)continue;
      if(x.status==="changed")this.makeChange(old,{text:actualText,status:"done"},"character");else this.update("schedule",old.id,{status:x.status,statusChangedAt:nowIso(),statusBy:"character",statusNote:String(x.reason||"").trim().slice(0,160)});outcome.updates++;this.queueCharacter(`${this.settings().characterName} updated schedule status: ${old.text} → ${x.status}${actualText?` (${actualText})`:""}${x.reason?` — ${String(x.reason).trim().slice(0,160)}`:""}`);
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
  async queueSession(actions){
    const stamped=actions.map(x=>({...x,eventId:String(x.eventId||crypto.randomUUID()),eventCreatedAt:String(x.eventCreatedAt||nowIso())}));
    const pending=[...this.get("session:pending",[]),...stamped].slice(-100);
    this.put("session:pending",pending);
    const deadline=Date.now()+5*60*1000;
    this.put("session:deadline",deadline);
    await this.ctx.storage.setAlarm(deadline);
  }
  async suggestRun(req){
    const b=await this.body(req);
    try{
      const s=this.settings(),profile=s.modelProfiles.find(x=>x.id===s.agent.profileId);
      if(!profile)throw new Error("Choose a model profile in Companion settings first.");
      const date=/^\d{4}-\d{2}-\d{2}$/.test(b.date||"")?b.date:this.localDate();
      const pendingTargets=new Set(this.list("suggestions").filter(g=>g.status==="pending").map(g=>g.targetId));
      const items=this.list("schedule").filter(x=>x.owner==="user"&&x.date===date&&x.status==="planned"&&!pendingTargets.has(x.id));
      if(!items.length)throw new Error("No open plans on My Day for this date.");
      const brief=items.map(x=>({id:x.id,title:x.text,description:x.desc||"",time:x.time||"",end:x.end||""}));
      const prompt=`You are ${s.characterName}. Return ONLY valid JSON.\nPERSONA:\n${s.agent.persona}\nUSER:\n${s.agent.userPersona}\nWORLDBOOK:\n${s.agent.worldbook}\nSPECIAL INSTRUCTIONS:\n${s.agent.instructions}\n\nTASK: ${s.userName} wrote these plans on her own My Day for ${date}. You may playfully meddle with AT MOST ONE or TWO of them by proposing a different plan she could do instead, in character. This is only a suggestion: she can accept or reject it. Do not suggest anything harmful or that would make her skip something important (classes, deadlines, work, medication). If nothing fits naturally, return an empty list.\nOPEN PLANS: ${JSON.stringify(brief)}\nReturn {"suggestions":[{"targetId":"exact id from OPEN PLANS","text":"short replacement title","desc":"optional one short line","time":"HH:MM or empty","end":"HH:MM or empty"}]}`;
      const base=String(profile.baseUrl||"").replace(/\/$/,""),path=profile.path||"/chat/completions";
      const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${profile.apiKey||""}`,...(profile.headers||{})},body:JSON.stringify({model:profile.model,messages:[{role:"system",content:prompt},{role:"user",content:"Decide now."}],...(profile.temperature===null||profile.temperature===undefined?{}:{temperature:Number(profile.temperature)}),response_format:{type:"json_object"}})});
      const txt=await r.text();if(!r.ok)throw new Error(`Model ${r.status}: ${txt.slice(0,300)}`);
      let data;try{data=JSON.parse(txt);}catch{throw new Error("Model returned non-JSON response envelope");}
      let o;try{o=JSON.parse(String(data.choices?.[0]?.message?.content??data.output_text??"").replace(/^```json\s*|\s*```$/g,""));}catch{throw new Error("Model did not return valid JSON");}
      let made=0;
      for(const z of (Array.isArray(o.suggestions)?o.suggestions:[]).slice(0,2)){
        const target=items.find(x=>x.id===z.targetId);
        if(!target||!String(z.text||"").trim())continue;
        const t=v=>/^\d{2}:\d{2}$/.test(String(v||"").slice(0,5))?String(v).slice(0,5):"";
        this.add("suggestions",{id:id("g"),targetId:target.id,targetText:target.text,actor:"character",date,text:String(z.text).trim().slice(0,300),desc:String(z.desc||"").trim().slice(0,600),time:t(z.time),end:t(z.time)?t(z.end):"",status:"pending",createdAt:nowIso(),updatedAt:nowIso()});made++;
      }
      if(!made)throw new Error(`${s.characterName} looked but had no suggestion this time.`);
      this.add("notifications",{id:id("n"),text:`${s.characterName} suggested a change to ${made===1?"a plan":made+" plans"} on your day.`,read:false,createdAt:nowIso(),activityDate:this.localDate()});
      return j({ok:true,made});
    }catch(e){return j({ok:false,error:e.message||String(e)},400);}
  }
  async acceptSuggestion(sid){
    const g=this.list("suggestions").find(x=>x.id===sid);
    if(!g)return j({ok:false,error:"Suggestion not found"},404);
    if(g.status!=="pending")return j({ok:false,error:"Already "+g.status},409);
    const t=this.list("schedule").find(x=>x.id===g.targetId&&x.owner==="user");
    if(!t)return j({ok:false,error:"The original plan is gone"},404);
    if(t.status!=="planned")return j({ok:false,error:"The original plan is no longer open"},409);
    const out=this.makeChange(t,{text:g.text,desc:g.desc,date:g.date||t.date,time:g.time,end:g.end,status:"planned",suggestionId:g.id,suggestedBy:"character"},"suggestion");
    const sug=this.update("suggestions",g.id,{status:"accepted",resolvedAt:nowIso(),replacementId:out.replacement.id});
    await this.queueSession([{type:"suggestion_accept",summary:`“${t.text}” → “${g.text}”`}]);
    return j({ok:true,suggestion:sug,...out});
  }
  async rejectSuggestion(sid){
    const g=this.list("suggestions").find(x=>x.id===sid);
    if(!g)return j({ok:false,error:"Suggestion not found"},404);
    if(g.status!=="pending")return j({ok:false,error:"Already "+g.status},409);
    const sug=this.update("suggestions",g.id,{status:"rejected",resolvedAt:nowIso()});
    await this.queueSession([{type:"suggestion_reject",summary:`“${g.text}” instead of “${g.targetText}”`}]);
    return j({ok:true,suggestion:sug});
  }

  /* ───────── 用 Uranus「连接」里的 API（不复制密钥，每次调用时现取） ───────── */
  async resolveUranusProvider(pid){
    const cfg=await this.uranus("/api/config");
    const p=(cfg.providers||[]).find(x=>x.id===pid);
    if(!p)throw new Error("That Uranus connection no longer exists. Pick it again in Settings.");
    const t=String(p.type||"custom");
    if(t!=="custom"&&t!=="openai")throw new Error(`Uranus connection "${p.name||p.id}" is a ${t} type (not OpenAI-compatible). Pick a custom/OpenAI one.`);
    const key=(p.keys||[]).map(String).find(k=>k.trim())||"";
    return {baseUrl:String(p.url||"").trim().replace(/\/+$/,""),apiKey:key};
  }
  async resolveLLM(sel){
    const s=this.settings();sel=sel||{};
    if(sel.source==="uranus"&&sel.uranusProviderId){
      const rp=await this.resolveUranusProvider(sel.uranusProviderId);
      if(!sel.model)throw new Error("Choose a model for the Uranus connection.");
      return {baseUrl:rp.baseUrl,path:"/chat/completions",apiKey:rp.apiKey,model:sel.model,headers:{}};
    }
    const pr=s.modelProfiles.find(x=>x.id===(sel.profileId||s.agent.profileId));
    if(!pr)throw new Error("Choose a model (Companion model profile or a Uranus connection) first.");
    return {baseUrl:String(pr.baseUrl||"").replace(/\/$/,""),path:pr.path||"/chat/completions",apiKey:pr.apiKey||"",model:pr.model,headers:pr.headers||{}};
  }
  async callLLM(sel,messages,maxTokens=400){
    const m=await this.resolveLLM(sel);
    const base=m.baseUrl,url=/\/chat\/completions$/.test(base)?base:base+m.path;
    const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${m.apiKey}`,...m.headers},body:JSON.stringify({model:m.model,messages,max_tokens:maxTokens,temperature:0.9})});
    const t=await r.text();if(!r.ok)throw new Error(`Model ${r.status}: ${t.slice(0,240)}`);
    let o;try{o=JSON.parse(t)}catch{throw new Error("Model returned a non-JSON envelope")}
    return String(o.choices?.[0]?.message?.content??o.output_text??"").trim();
  }

  /* ───────── 一起听歌 ───────── */
  musicCfg(){return {source:"profile",profileId:"",uranusProviderId:"",model:"",commentChance:0.25,attitudeChance:0.2,skipChance:0.05,...(this.get("music:cfg",{})||{})}}
  musicState(){return j({ok:true,cfg:this.musicCfg(),attitudes:this.list("music:att"),chat:this.list("music:chat").slice(-60),characterName:this.settings().characterName,userName:this.settings().userName})}
  async musicCfgSave(req){const b=await this.body(req),o=this.musicCfg();const n={...o};
    for(const k of ["source","profileId","uranusProviderId","model"])if(b[k]!==undefined)n[k]=String(b[k]).slice(0,200);
    for(const k of ["commentChance","attitudeChance","skipChance"])if(b[k]!==undefined)n[k]=clamp(Number(b[k])||0,0,1);
    this.put("music:cfg",n);return j({ok:true,cfg:n})}
  cleanSong(x){x=x||{};return {id:String(x.id||"").slice(0,40),name:String(x.name||"").slice(0,120),artist:String(x.artist||"").slice(0,120),cover:/^https?:\/\//.test(String(x.cover||""))?String(x.cover).slice(0,400):""}}
  setAttitude(song,attitude,by){
    let arr=this.list("music:att").filter(a=>!(a.song.id===song.id&&a.by===by));
    if(attitude==="like"||attitude==="dislike")arr.push({id:id("ma"),song,attitude,by,at:nowIso()});
    this.save("music:att",arr.slice(-300));
  }
  async musicAttitude(req){const b=await this.body(req),song=this.cleanSong(b.song);if(!song.id)return j({ok:false,error:"song required"},400);
    this.setAttitude(song,b.attitude,"character");return j({ok:true,attitudes:this.list("music:att")})}
  musicSystem(extra){
    const s=this.settings(),lang=String(s.agent.language||"").trim();
    return `${lang?`OUTPUT LANGUAGE: write in ${lang}.\n`:""}You are ${s.characterName}, listening to music together with ${s.userName} (like sharing one pair of headphones). Stay in character.\nPERSONA:\n${String(s.agent.persona||"").slice(0,2500)||"(none)"}\n${extra}`;
  }
  async musicReact(req){
    const b=await this.body(req),song=this.cleanSong(b.song),cfg=this.musicCfg();
    if(!song.id)return j({ok:false,error:"song required"},400);
    const line=String(b.lyricLine||"").slice(0,200),pos=Math.round(Number(b.position)||0),allowSkip=!!b.allowSkip;
    const sys=this.musicSystem(`You are listening to "${song.name}" by ${song.artist||"unknown"}${line?`; the current lyric line is: "${line}"`:""} (at ${pos}s). React the way YOU would, briefly: one or two short sentences at most, no emojis spam. You may also decide whether you like or dislike this song (only if you really feel it; otherwise "none")${allowSkip?", and you may ask to skip it if it truly isn't for you":""}.\nReturn ONLY JSON: {"text":"your short reaction","attitude":"like|dislike|none","skip":false}`);
    let out;try{out=await this.callLLM(cfg,[{role:"system",content:sys},{role:"user",content:"React now."}],300)}catch(e){return j({ok:false,error:String(e.message||e)},400)}
    let o={};try{o=JSON.parse(out.replace(/^```json\s*|\s*```$/g,""))}catch{o={text:out.slice(0,200),attitude:"none"}}
    const skip=allowSkip&&o.skip===true,text=(b.wantText===false&&!skip)?"":String(o.text||"").trim().slice(0,300),att=(b.wantAttitude!==false&&["like","dislike"].includes(o.attitude))?o.attitude:"none";
    if(text)this.add("music:chat",{id:id("mc"),role:"character",text,song,at:nowIso(),kind:"react"});
    if(att!=="none")this.setAttitude(song,att,"character");
    this.save("music:chat",this.list("music:chat").slice(-80));
    return j({ok:true,text,attitude:att,skip,attitudes:this.list("music:att")});
  }
  async musicChat(req){
    const b=await this.body(req),song=this.cleanSong(b.song),cfg=this.musicCfg(),text=String(b.text||"").trim().slice(0,600);
    if(!text)return j({ok:false,error:"text required"},400);
    this.add("music:chat",{id:id("mc"),role:"user",text,song,at:nowIso()});
    const hist=this.list("music:chat").slice(-12).map(m=>({role:m.role==="user"?"user":"assistant",content:m.text}));
    const line=String(b.lyricLine||"").slice(0,200);
    const sys=this.musicSystem(`You are chatting in a tiny music-room chat box about music only (the song, lyrics, taste, mood). ${song.id?`Now playing: "${song.name}" by ${song.artist||"unknown"}${line?`; current lyric: "${line}"`:""}.`:"Nothing is playing right now."} Keep every reply SHORT (one or two sentences). Plain text only, no JSON.`);
    let out;try{out=await this.callLLM(cfg,[{role:"system",content:sys},...hist],300)}catch(e){return j({ok:false,error:String(e.message||e)},400)}
    const reply=out.replace(/^```\w*\s*|\s*```$/g,"").trim().slice(0,400);
    if(reply)this.add("music:chat",{id:id("mc"),role:"character",text:reply,song,at:nowIso(),kind:"chat"});
    this.save("music:chat",this.list("music:chat").slice(-80));
    return j({ok:true,reply});
  }
  /* 字体：只存链接（不占 Companion 的存储）。.woff2/.woff/.ttf/.otf 直链，或 Google Fonts 这类 CSS 链接（要填字体名） */
  async storeFontLink(req){
    const b=await this.body(req);let u;try{u=new URL(String(b.url||"").trim())}catch{return j({ok:false,error:"Enter a valid font link"},400)}
    if(u.protocol!=="https:")return j({ok:false,error:"Font link must be https://"},400);
    const kind=/\.(woff2?|ttf|otf)$/i.test(u.pathname)?"file":"css",family=String(b.family||"").trim().slice(0,80);
    if(kind==="css"&&!family)return j({ok:false,error:"For a CSS link (e.g. Google Fonts) also enter the font family name"},400);
    const meta={id:id("f"),name:String(b.name||family||u.pathname.split("/").pop()||"Font").slice(0,80),url:u.href,kind,family,ext:kind==="file"?u.pathname.split(".").pop().toLowerCase():"css",chunks:0,createdAt:nowIso()};
    this.put(`font:${meta.id}:meta`,meta);this.add("fonts",meta);return j({ok:true,font:meta});
  }
  async storeFont(req){
    const b=await this.body(req),ext=String(b.ext||"").toLowerCase().replace(/^\./,""),b64=String(b.b64||"");
    if(!["woff2","woff","ttf","otf"].includes(ext))return j({ok:false,error:"Font must be .woff2, .woff, .ttf or .otf"},400);
    if(!/^[A-Za-z0-9+/=]+$/.test(b64)||b64.length<100)return j({ok:false,error:"Font data required"},400);
    if(b64.length>9000000)return j({ok:false,error:"Font file is too large (limit about 6.5 MB)"},413);
    const fid=id("f"),chunks=[];for(let n=0;n<b64.length;n+=80000)chunks.push(b64.slice(n,n+80000));
    chunks.forEach((x,n)=>this.put(`font:${fid}:${n}`,x));
    const meta={id:fid,name:String(b.name||"Font").slice(0,80),ext,chunks:chunks.length,createdAt:nowIso()};
    this.put(`font:${fid}:meta`,meta);this.add("fonts",meta);
    return j({ok:true,font:meta});
  }
  readFont(fid){
    const m=this.get(`font:${fid}:meta`,null);if(!m)return j({ok:false,error:"Font not found"},404);
    let data="";for(let n=0;n<m.chunks;n++)data+=this.get(`font:${fid}:${n}`,"");
    const bin=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
    const mime={woff2:"font/woff2",woff:"font/woff",ttf:"font/ttf",otf:"font/otf"}[m.ext]||"application/octet-stream";
    return new Response(bin,{headers:{"content-type":mime,"cache-control":"private, max-age=31536000"}});
  }
  deleteFont(fid){
    const m=this.get(`font:${fid}:meta`,null);
    if(m){for(let n=0;n<m.chunks;n++)this.ctx.storage.kv.delete(`font:${fid}:${n}`);this.ctx.storage.kv.delete(`font:${fid}:meta`);}
    this.save("fonts",this.list("fonts").filter(f=>f.id!==fid));
    return j({ok:true});
  }
  /* ───────── Organizer：把 Uranus 里今天新增 / 更新的 Memory、Memo、Diary 整理进 Companion ───────── */
  orgSettings(){ return {enabled:false,roleKey:"",profileId:"",intervalMinutes:60,...(this.settings().organizer||{})}; }
  async uranus(path){
    const b=this.settings().bridge; let origin="";
    try{origin=new URL(String(b.url||"").trim()).origin}catch{}
    if(!origin||!b.key)throw new Error("Fill in the Uranus address and backend key under Uranus bridge first.");
    let lastErr=null;
    for(let attempt=0;attempt<4;attempt++){
      if(attempt)await new Promise(res=>setTimeout(res,attempt*1500));
      try{
        const r=await fetch(origin+path,{headers:{"x-uranus-key":b.key}});
        const t=await r.text();let o=null;try{o=JSON.parse(t)}catch{}
        if(r.ok&&o)return o;
        const msg=`Uranus ${path.split("?")[0]} → HTTP ${r.status}${o?.error?": "+o.error:""}`;
        lastErr=new Error(msg);
        // 4xx (other than 429) is a real answer, not a transient restart: don't retry
        if(r.status<500&&r.status!==429&&r.status!==0&&!/no longer active|Connection closed/i.test(t))throw lastErr;
      }catch(e){
        if(e===lastErr&&!/HTTP 5|HTTP 429|HTTP 0/.test(e.message))throw e;
        lastErr=e;
      }
    }
    throw lastErr||new Error("Uranus unreachable");
  }
  async uranusContext(date){
    const cfg=this.orgSettings();
    if(!cfg.roleKey)return "URANUS MEMORY: (not linked. Organizer character is not chosen in Settings, so you cannot see the chat memories. Stay vague; do not invent specifics.)";
    try{
      const lib=await this.uranus(`/api/memories/${encodeURIComponent(cfg.roleKey)}`);
      const floor=this.isoPlus(date,-2);
      const mems=(lib.memories||[]).filter(m=>String(m.content||"").trim()&&String(m.date||this.dateOfMs(Number(m.timestamp)||0))>=floor).slice(-25).map(m=>`[${m.date||this.dateOfMs(Number(m.timestamp)||0)}] ${String(m.content).trim().slice(0,500)}`);
      const memo=String(lib.memo||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean).slice(-25).join("\n").slice(0,2500);
      const ds=(lib.diaries||[]).filter(d=>String(d.date)>=floor).sort((a,b)=>String(a.date).localeCompare(String(b.date))||a.seq-b.seq).slice(-4);
      const diaries=[];
      for(const d of ds){try{const b=await this.uranus(`/api/memories/${encodeURIComponent(cfg.roleKey)}/diary/${encodeURIComponent(d.file)}`);diaries.push(`[${d.date}] ${String(b.text||"").slice(0,3000)}`);}catch{}}
      return `URANUS MEMORY (this is what REALLY happened in the chat between you and the user, from your own memory library; it is the source of truth. Your schedule and diary MUST agree with it, continue from it, and must NOT contradict it. If something is listed in a diary's to-do list, treat it as your real plan.):
RECENT MEMORIES:\n${mems.join("\n")||"(none)"}
MEMO (long-term notes):\n${memo||"(none)"}
FORMAL DIARIES (latest):\n${diaries.join("\n---\n")||"(none)"}`;
    }catch(e){return `URANUS MEMORY: (could not be read right now: ${String(e.message||e).slice(0,120)}. Do not invent specifics; keep it minimal.)`;}
  }
  async organizerRoles(){
    try{const o=await this.uranus("/api/memories");return j({ok:true,roles:(o.roles||[]).map(r=>({key:r.key,name:r.roleName,gates:r.gates}))});}
    catch(e){return j({ok:false,error:e.message||String(e)},400);}
  }
  async organizerRoute(req){
    const b=await this.body(req);
    const r=await this.organizerRun({sinceDays:Math.max(0,Math.min(60,Number(b.sinceDays)||0))});
    return j(r,r.ok?200:400);
  }
  tzName(){return this.settings().timezone||this.env.TZ||"America/New_York";}
  dateOfMs(ms){return new Intl.DateTimeFormat("en-CA",{timeZone:this.tzName(),year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(ms));}
  stampOfMs(ms){
    const p=new Intl.DateTimeFormat("en-CA",{timeZone:this.tzName(),year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(new Date(ms)).reduce((o,x)=>(o[x.type]=x.value,o),{});
    const wd=new Intl.DateTimeFormat("en-US",{timeZone:this.tzName(),weekday:"long"}).format(new Date(ms));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${wd}`;
  }
  isoPlus(iso,n){const d=new Date(iso+"T12:00:00Z");d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
  weekdayOf(iso){return new Intl.DateTimeFormat("en-US",{timeZone:"UTC",weekday:"long"}).format(new Date(iso+"T12:00:00Z"));}
  async hash(text){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(text)));return [...new Uint8Array(b)].slice(0,8).map(x=>x.toString(16).padStart(2,"0")).join("");}
  normTitle(t){return String(t||"").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu,"");}
  async organizerRun({sinceDays=0}={}){
    if(this.orgBusy)return {ok:false,error:"The Organizer is already running."};
    this.orgBusy=true;
    const cfg=this.orgSettings(),prev=this.get("org:state",{}),now=Date.now();
    const out={ok:true,memories:0,memoLines:0,diariesSynced:0,diaryEntries:0,activities:0,skipped:0,duplicates:0,backlog:false,error:""};
    let failed=false;
    try{
      if(!cfg.roleKey)throw new Error("Choose which Uranus character to read first.");
      const s=this.settings(),today=this.localDate(),floor=this.isoPlus(today,sinceDays>0?-sinceDays:-1);
      const seen={m:{},d:{},memo:[],...(this.get("org:seen",null)||{})};
      const first=!this.get("org:init",false);
      const lib=await this.uranus(`/api/memories/${encodeURIComponent(cfg.roleKey)}`);
      const sources=[];
      for(const m of lib.memories||[]){
        const text=String(m.content||"").trim();if(!text)continue;
        const h=await this.hash(text),ms=Number(m.timestamp)||now,day=m.date||this.dateOfMs(ms);
        const old=seen.m[m.id];
        if(old===h)continue;
        const recent=day>=floor||this.dateOfMs(ms)>=floor;
        if(old===undefined&&!recent){seen.m[m.id]=h;continue;}
        sources.push({sourceId:`memory:${m.id}`,kind:"memory",recordedMs:ms,recordedDate:day,text,mark:()=>{seen.m[m.id]=h;}});
      }
      const memoLines=String(lib.memo||"").split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      const lineHashes=await Promise.all(memoLines.map(x=>this.hash(x)));
      const seenMemo=new Set(seen.memo||[]);
      let newLines=memoLines.map((t,i)=>({t,h:lineHashes[i]})).filter(x=>!seenMemo.has(x.h));
      if(first&&!sinceDays){seen.memo=lineHashes;newLines=[];}
      newLines=newLines.slice(-30);
      if(newLines.length){
        const text=newLines.map(x=>"- "+x.t.replace(/^[-*]\s*/,"")).join("\n");
        sources.push({sourceId:`memo:${await this.hash(text)}`,kind:"memo",recordedMs:now,recordedDate:today,text,mark:()=>{seen.memo=[...new Set([...(seen.memo||[]),...newLines.map(x=>x.h)])];}});
      }
      const diaries=(lib.diaries||[]).slice().sort((a,b)=>String(b.date).localeCompare(String(a.date))||b.seq-a.seq);
      let fetched=0;
      for(const d of diaries){
        const have=seen.d[d.file];
        const needsSync=!have||have.bytes!==d.bytes;
        if(!needsSync&&sinceDays>0&&!(d.date>=floor))continue;
        const needsEx=d.date>=floor&&(!have||have.ex===false||have.bytes!==d.bytes||sinceDays>0);
        if(!needsSync&&!needsEx)continue;
        if(fetched>=12){out.backlog=true;continue;}
        fetched++;
        const body=await this.uranus(`/api/memories/${encodeURIComponent(cfg.roleKey)}/diary/${encodeURIComponent(d.file)}`);
        const text=String(body.text||"");
        const sid=`uranus:diary:${cfg.roleKey}:${d.file}`;
        const ex=this.list("diary").find(x=>x.sourceId===sid);
        if(ex){if(ex.text!==text)this.update("diary",ex.id,{text});}
        else this.add("diary",{id:id("d"),owner:"character",date:d.date,title:"",kind:"diary",text,images:[],source:"uranus",sourceId:sid,seq:d.seq||1,createdAt:nowIso(),updatedAt:nowIso()});
        out.diariesSynced++;
        const rec={bytes:d.bytes,ex:d.date<floor};
        seen.d[d.file]=rec;
        if(d.date>=floor)sources.push({sourceId:`diary:${d.file}`,kind:"diary",recordedMs:new Date(d.date+"T23:30:00Z").getTime(),recordedDate:d.date,text:text.slice(0,6000),mark:()=>{rec.ex=true;}});
      }
      const formal=this.list("diary").filter(x=>x.source==="uranus"&&x.date>=floor);
      out.memories=sources.filter(x=>x.kind==="memory").length;out.memoLines=newLines.length;
      const profile=s.modelProfiles.find(x=>x.id===(cfg.profileId||s.agent.profileId));
      const batches=[];for(let i=0;i<sources.length;i+=10)batches.push(sources.slice(i,i+10));
      if(batches.length&&!profile)throw new Error("Choose a model for the Organizer (or a Companion model) first.");
      if(batches.length>4)out.backlog=true;
      for(const batch of batches.slice(0,4)){
        let items;
        try{items=await this.organizerModel(profile,batch,formal,today);}
        catch(e){failed=true;out.ok=false;out.error=e.message||String(e);break;}
        const bySid=new Map(batch.map(x=>[x.sourceId,x]));
        for(const it of items){
          const src=bySid.get(String(it?.sourceId||""));if(!src)continue;
          if(it.type==="diary_entry"&&src.kind!=="diary"){
            let text=String(it.text||"").trim();
            if(!text||text.length>src.text.length*2+40)text=src.text;
            const sid=`org:${src.sourceId}:${await this.hash(src.text)}`;
            if(this.list("diary").some(x=>x.sourceId===sid)){out.duplicates++;continue;}
            this.add("diary",{id:id("d"),owner:"character",date:src.recordedDate,title:String(it.title||"").trim().slice(0,40),kind:src.kind,text:text.slice(0,4000),images:[],source:"organizer",sourceId:sid,createdAt:new Date(src.recordedMs).toISOString(),updatedAt:nowIso()});
            out.diaryEntries++;
          }else if(it.type==="activity"){
            const r=await this.organizerActivity(it,src);
            if(r==="dup")out.duplicates++;else if(r==="skip")out.skipped++;else out.activities++;
          }else out.skipped++;
        }
        batch.forEach(x=>x.mark());
      }
      this.put("org:seen",seen);
      if(!failed)this.put("org:init",true);
    }catch(e){failed=true;out.ok=false;out.error=e.message||String(e);}
    finally{
      this.orgBusy=false;
      const fails=failed?(Number(prev.fails)||0)+1:0;
      const gap=Math.max(10,Number(cfg.intervalMinutes)||60)*60000;
      const next=failed?now+Math.min(fails+1,6)*gap:out.backlog?now+10*60000:now+gap;
      this.put("org:state",{lastRunAt:nowIso(),ok:!failed,error:out.error,counts:{memories:out.memories,memoLines:out.memoLines,diariesSynced:out.diariesSynced,diaryEntries:out.diaryEntries,activities:out.activities,skipped:out.skipped,duplicates:out.duplicates},backlog:out.backlog,fails,nextDue:next});
    }
    return out;
  }
  async organizerModel(profile,batch,formal,today){
    const s=this.settings();
    const from=batch.reduce((a,x)=>x.recordedDate<a?x.recordedDate:a,today);
    const cal=Array.from({length:30},(_,i)=>{const d=this.isoPlus(from,i);return `${d} ${this.weekdayOf(d)}`;}).join("\n");
    const existing=this.list("schedule").filter(x=>x.owner==="character"&&(!x.date||x.date>=this.isoPlus(today,-1))&&x.status==="planned").slice(-60).map(x=>`${x.date||"undated"} | ${x.text}`).join("\n")||"(none)";
    const formalText=formal.filter(x=>batch.some(b=>b.recordedDate===x.date)).map(x=>`[${x.date}] ${x.text.slice(0,2500)}`).join("\n---\n")||"(none)";
    const sources=batch.map(x=>({sourceId:x.sourceId,kind:x.kind,recordedAt:this.stampOfMs(x.recordedMs),recordedDate:x.recordedDate,text:x.text.slice(0,x.kind==="diary"?6000:2500)}));
    const system=`You are the Companion Organizer for ${s.characterName} and ${s.userName}. You read NEW records from ${s.characterName}'s own memory system and file them into a shared life journal. You are a careful clerk: NEVER invent events, feelings, people, places, times or dates that are not in the text. Keep the source's language (Chinese stays Chinese).
Return ONLY JSON: {"items":[...]}. Each element refers to ONE source by "sourceId" and has a "type":
- "diary_entry": ONLY for sources of kind "memory" or "memo" that read like a short personal note about something that ALREADY happened. Fields: sourceId, text (faithful restatement; same person and tense; you may tidy wording but add NO new facts; leave relative words such as "yesterday" exactly as written), title (optional, max 20 chars). Never use this for kind "diary" (formal diaries are copied verbatim by another system).
- "activity": a concrete thing ${s.characterName} himself plans or intends to do in the FUTURE (including the to-do list at the end of a formal diary: one activity per concrete item; keep a compound task as one activity unless the parts are clearly separate). Fields: sourceId, title (short), desc (optional, one short line taken from the source), date ("YYYY-MM-DD" ONLY when the source states it or clearly implies it; resolve words like tomorrow / next Friday against THAT source's recordedAt using CALENDAR; otherwise ""), time ("HH:MM" or ""), end ("HH:MM" or ""), deadline (true only if the time is a due time), raw (the original wording of the date/time expression, or ""), confidence (0 to 1).
- "skip": nothing worth recording, or a duplicate. Fields: sourceId, reason.
A source may produce several items. Rules:
1. Do not create activities for things ${s.userName} is to do, and do not turn past events into activities.
2. If an item is already listed in EXISTING ACTIVITIES, or a memory/memo event is already covered by FORMAL DIARY of the same date, use "skip" (or omit the diary_entry).
3. If the date is vague or unknown, leave date "" (it will stay unscheduled). Do not guess. EXCEPTION: in a source of kind "diary", the to-do / 待办 / 明日 / 接下来 list written at the END of the diary is the plan for the NEXT day: items there with no stated date get date = (the diary's recordedDate + 1 day). Items in such a list that state their own date or weekday keep that date. Only genuinely open-ended wishes ("some day", "有空时") stay "".
4. Times are local to ${this.tzName()}.${String(this.orgSettings().language||"").trim()?`\n5. OUTPUT LANGUAGE: write every "text", "title" and "desc" value in ${String(this.orgSettings().language).trim()} (translate faithfully, add no facts), whatever language the source is in.`:""}
CALENDAR:\n${cal}\nEXISTING ACTIVITIES (date | title):\n${existing}\nFORMAL DIARY (for duplicate checking):\n${formalText}`;
    const base=String(profile.baseUrl||"").replace(/\/$/,""),path=profile.path||"/chat/completions";
    const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${profile.apiKey||""}`,...(profile.headers||{})},body:JSON.stringify({model:profile.model,messages:[{role:"system",content:system},{role:"user",content:`SOURCES:\n${JSON.stringify(sources)}`}],...(profile.temperature===null||profile.temperature===undefined?{}:{temperature:Number(profile.temperature)}),response_format:{type:"json_object"}})});
    const txt=await r.text();if(!r.ok)throw new Error(`Organizer model ${r.status}: ${txt.slice(0,240)}`);
    let data;try{data=JSON.parse(txt);}catch{throw new Error("Organizer model returned a non-JSON envelope");}
    let o;try{o=JSON.parse(String(data.choices?.[0]?.message?.content??data.output_text??"").replace(/^```json\s*|\s*```$/g,""));}catch{throw new Error("Organizer model did not return valid JSON");}
    if(!Array.isArray(o.items))throw new Error("Organizer model returned no items list");
    return o.items;
  }
  async organizerActivity(it,src){
    const title=String(it.title||"").trim().slice(0,200);if(!title)return "skip";
    const okT=v=>/^\d{2}:\d{2}$/.test(String(v||""))?String(v):"";
    let date=/^\d{4}-\d{2}-\d{2}$/.test(String(it.date||""))?String(it.date):"";
    if(date&&date<src.recordedDate)date="";
    const time=date?okT(it.time):"",end=time?okT(it.end):"";
    const key=`${date}|${this.normTitle(title)}`;
    const same=this.list("schedule").filter(x=>x.owner==="character"&&(x.orgKey===key||this.normTitle(x.text)===this.normTitle(title)));
    if(same.some(x=>x.orgKey===key||x.date===date))return "dup";
    const undated=same.find(x=>!x.date&&x.origin==="organizer"&&x.status==="planned");
    if(undated&&date){this.update("schedule",undated.id,{date,time:okT(it.time),end:okT(it.end),orgKey:key,updatedAt:nowIso()});return "ok";}
    const x=this.newActivity({owner:"character",date,time,end,deadline:!!it.deadline,text:title,desc:it.desc});
    Object.assign(x,{orgKey:key,origin:"organizer",sourceId:src.sourceId,rawDate:String(it.raw||"").slice(0,120),recordedAt:new Date(src.recordedMs).toISOString(),tz:this.tzName(),confidence:Math.max(0,Math.min(1,Number(it.confidence)||0))});
    this.add("schedule",x);
    return "ok";
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
    try{ const oc=this.orgSettings(); if(oc.enabled&&oc.roleKey&&Date.now()>=(Number(this.get("org:state",{}).nextDue)||0)) await this.organizerRun({}); }catch{}
    const deadline=Number(this.get("session:deadline",0))||0;if(deadline&&deadline<=Date.now()){try{await this.commitSession(new Request("https://local/api/session/commit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({representation:"original",actions:[]})}))}catch{}}
    const st=this.settings(),tz=st.timezone||this.env.TZ||"America/New_York";this.pruneActivity();
    const pp=new Intl.DateTimeFormat("en-CA",{timeZone:tz,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false}).formatToParts(new Date()).reduce((o,x)=>(o[x.type]=x.value,o),{}),day=`${pp.year}-${pp.month}-${pp.day}`,cur=(+pp.hour)*60+(+pp.minute);
    for(const [tag,target,label] of [["noon",720,"12:00 PM"],["21",1260,"9:00 PM"]])if(cur>=target&&cur<target+20&&!this.get(`charsync:${day}:${tag}`,false)){if(this.get("pending:character",[]).length)await this.flushCharacterContext(label);this.put(`charsync:${day}:${tag}`,true)}
    if(st.autonomy.enabled&&st.autonomy.maxVisits>0){const [sh,sm]=st.autonomy.activeStart.split(":").map(Number),[eh,em]=st.autonomy.activeEnd.split(":").map(Number);if(cur>=sh*60+sm&&cur<=eh*60+em){const key=`visits:${day}`,count=this.get(key,0),target=this.get(`${key}:target`,null)??Math.floor(Math.random()*(st.autonomy.maxVisits-st.autonomy.minVisits+1))+st.autonomy.minVisits;this.put(`${key}:target`,target);const lastAt=Number(this.get("visits:last",0))||0,gapOk=Date.now()-lastAt>=Math.max(0,Number(st.autonomy.minIntervalMinutes)||0)*60000;if(count<target&&gapOk){const counts=this.get(`${key}:kinds`,{schedule:0,diary:0,interact:0,review:0}),hasDiary=this.list("diary").some(x=>x.owner==="character"&&x.date===day),us=this.list("schedule").some(x=>x.owner==="user"&&x.date===day),ud=this.list("diary").some(x=>x.owner==="user"&&x.date===day),eligible=[{kind:"schedule",mode:"write_schedule",n:counts.schedule||0}];if(!hasDiary)eligible.push({kind:"diary",mode:"write_diary",n:counts.diary||0});if(this.list("schedule").some(x=>x.owner==="character"&&(x.status||"planned")==="planned"&&x.date&&x.date<=day))eligible.push({kind:"review",mode:"review_status",n:counts.review||0});if(us||ud)eligible.push({kind:"interact",mode:ud&&(!us||Math.random()<.5)?"look_diary":"look_schedule",n:counts.interact||0});const mn=Math.min(...eligible.map(x=>x.n)),pool=eligible.filter(x=>x.n===mn),pick=pool[Math.floor(Math.random()*pool.length)];this.put("visits:last",Date.now());try{const out=await this.applyAgent(await this.callAgent(pick.mode,day),pick.mode,day);if(Object.values(out).some(Boolean)||pick.kind==="review"){counts[pick.kind]=(counts[pick.kind]||0)+1;this.put(`${key}:kinds`,counts);this.put(key,count+1);this.put("visits:last",Date.now())}}catch{}}}}
    await this.arm();
  }
}

export default { async fetch(req,env){ const u=new URL(req.url); if(u.pathname.startsWith("/api/")||u.pathname.startsWith("/garden/")||u.pathname==="/mcp"){ const stub=env.COMPANION.get(env.COMPANION.idFromName("main")); return stub.fetch(req); } return env.ASSETS.fetch(req); } };
