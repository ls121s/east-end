/* East End: a private house hunt on a phone.
   This file is the whole app. It reads one bundle (app.json) from a private GitHub repository, the "notebook",
   and writes the owner's stars, notes and settings back to it. It talks to GitHub and to nothing else. */
(function(){
"use strict";

var CFG = window.EE_CONFIG || {};
var API = String(CFG.api || "https://api.github.com").replace(/\/+$/,"");
var BRANCH = CFG.branch || "main";
var LIMIT = 15, MAXMIN = 35;      /* drive-time line and ruler length, in minutes. The notebook can change the line. */
var TZ;                            /* the scan's time zone. Comes from the notebook. Until then, the phone's own. */
var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sept","Oct","Nov","Dec"];
var DAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
var METERS = ["Land","Value","Location","Freedom"];
var KIND = {"new":"New","cut":"Price cut","back":"Back on market","pending":"Pending","gone":"Off market","sold":"Sold","note":"Your note","rank":"Ranking","skip":"Skipped","info":"Note"};
var KORDER = ["new","back","cut","pending","gone","sold","note","rank","skip","info"];
var RECENTK = {"new":1, "cut":1, "back":1, "pending":1, "gone":1, "sold":1};   /* report items that put a listing in Recent activity */
var TITLES = {today:"", map:"Map", board:"The board", starred:"My contenders", reports:"Daily reports", ask:"Ask Claude"};
var FILES = {stars:"me/stars.json", notes:"me/notes.json", push:"me/push.json", prefs:"me/prefs.json"};
var SHEETS = {listing:"sheet", settings:"settings", brief:"briefsheet"};
var IDRE = /^[A-Za-z0-9_-]{1,80}$/;
var PHRE = /^board\/photos\/[A-Za-z0-9_-]{1,80}(-s)?\.(jpg|png|webp)$/, SHARE = /^[0-9a-f]{40}$/, COLRE = /^#[0-9a-f]{6}$/i;
var MPRE = /^board\/map\/[A-Za-z0-9_\/-]{1,120}\.(png|jpg|jpeg)$/;
var PTYPES = {"image/jpeg":1, "image/png":1, "image/webp":1};
var ATTRIB = "Esri, HERE, Garmin, FAO, NOAA, USGS, © OpenStreetMap contributors";   /* the basemap's legal credit, used when the manifest has none */
var IMGCACHE = "ee-images-1";       /* photos and map images, in the phone's Cache storage, keyed by blob sha */
var INFLIGHT = 4;                   /* image fetches at once, per kind (photo, map) */
var RM = false;                    /* the phone asked for reduced motion */
var FOLDOK = !!(window.CSS && CSS.supports && CSS.supports("grid-template-rows", "0fr"));

var S = {
  token:null, owner:"",
  loaded:false, fromCache:false, lastSync:0, syncing:false, syncErr:null,
  home:null, L:{}, lanes:{}, reports:[], skipped:[], replies:{}, built:null,
  srv:{stars:{}, notes:[], prefs:{}},          /* what the notebook holds */
  stars:{}, notes:[], prefs:{},                /* that, plus changes still waiting to save */
  queue:[], flushing:false, saveErr:null, flushTimer:0,
  view:"today", rep:null, repPushed:false, repFrom:null, overlay:null, overlayPushed:false, overlayLeaving:false,
  f:{type:"All", area:"All", maxp:0, sort:"rank", near:false},
  mf:{top:false, starred:false},               /* map-only chips */
  map:null, mapSel:null, mapLevel:"area", img:{}, imgFail:{}, pinsPlayed:null,
  mapKey:null, mapCKey:null, mapMs:1, mapWant:null, mapPick:null, mapClusters:[], homeW:0,
  homeFold:"", readOpen:false, folds:{pending:false, gone:false, skip:false},
  homeRep:0,                                   /* the report the Home card shows: an index into reports, 0 is the newest. Memory only. */
  starPop:null, mediaText:null,
  seenReport:null, seenReplies:{}, confirm:null, pushState:"unknown"
};

/* ---------- small helpers ---------- */
function $(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];}); }
function usd(n){ return "$"+Math.round(Number(n)||0).toLocaleString("en-US"); }
function pad(n){ return (n<10?"0":"")+n; }
function okDate(d){ return typeof d==="string" && /^\d{4}-\d{2}-\d{2}$/.test(d); }
function dnum(d){ var p=d.split("-"); return Date.UTC(+p[0],+p[1]-1,+p[2])/864e5; }
function fmt(d){ if(!okDate(d)) return ""; var p=d.split("-"); return MONTHS[+p[1]-1]+" "+(+p[2])+", "+p[0]; }
function fmtShort(d){ if(!okDate(d)) return ""; var p=d.split("-"); return MONTHS[+p[1]-1]+" "+(+p[2]); }
function fmtDay(d){ if(!okDate(d)) return ""; var p=d.split("-"); var w=new Date(Date.UTC(+p[0],+p[1]-1,+p[2])).getUTCDay(); return DAYS[w]+", "+MONTHS[+p[1]-1]+" "+(+p[2]); }
function safeUrl(u){ return (typeof u==="string" && /^https:\/\//.test(u)) ? u : "#"; }
function arr(x){ return Array.isArray(x)?x:[]; }
function objs(x){ return arr(x).filter(function(v){ return v && typeof v==="object"; }); }
function hasOwn(o, k){ return Object.prototype.hasOwnProperty.call(o, k); }
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); return true; }catch(e){ return false; } }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
function lsJson(k,fallback){ try{ var v=JSON.parse(lsGet(k)); return v==null?fallback:v; }catch(e){ return fallback; } }
function ssGet(k){ try{ return sessionStorage.getItem(k); }catch(e){ return null; } }
function ssSet(k,v){ try{ sessionStorage.setItem(k,v); }catch(e){} }
function louNow(){
  try{
    var o={}, opt={year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hour12:false};
    if(TZ) opt.timeZone=TZ;
    new Intl.DateTimeFormat("en-CA",opt)
      .formatToParts(new Date()).forEach(function(p){ o[p.type]=p.value; });
    return {date:o.year+"-"+o.month+"-"+o.day, hour:Number(o.hour)%24};
  }catch(e){
    var d=new Date();
    return {date:d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate()), hour:d.getHours()};
  }
}
function clock(ts, zone){
  try{ return new Date(ts).toLocaleTimeString("en-US", zone?{timeZone:zone,hour:"numeric",minute:"2-digit"}:{hour:"numeric",minute:"2-digit"}); }
  catch(e){ return ""; }
}
function b64decode(b64){
  var bin=atob(String(b64||"").replace(/\s/g,"")), bytes=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}
function b64encode(str){
  var bytes=new TextEncoder().encode(str), bin="";
  for(var i=0;i<bytes.length;i+=0x8000) bin+=String.fromCharCode.apply(null, bytes.subarray(i,i+0x8000));
  return btoa(bin);
}
function b64urlBytes(s){
  s=String(s).replace(/-/g,"+").replace(/_/g,"/"); while(s.length%4) s+="=";
  var bin=atob(s), out=new Uint8Array(bin.length);
  for(var i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
function isIOS(){ return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1); }
function isStandalone(){
  try{ if(window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) return true; }catch(e){}
  return navigator.standalone===true;
}
function deviceLabel(){
  var ua=navigator.userAgent;
  if(/iPhone/.test(ua)) return "iPhone";
  if(/iPad/.test(ua) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1)) return "iPad";
  if(/Android/.test(ua)) return "Android";
  if(/Mac/.test(ua)) return "Mac";
  return "Browser";
}
var toastTimer=0, toastTimer2=0;
function toast(msg, ms){
  var t=$("toast"); clearTimeout(toastTimer); clearTimeout(toastTimer2);
  t.classList.remove("out"); t.textContent=msg; t.hidden=false;
  toastTimer=setTimeout(function(){
    t.classList.add("out");
    toastTimer2=setTimeout(function(){ t.hidden=true; t.classList.remove("out"); }, RM?1:170);
  }, ms||3200);
}
/* restart a short CSS animation on an element */
function replay(el, cls){ if(!el || RM) return; el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

/* inline icons. Stroke icons inherit their colour; nothing here is notebook data. */
var G = {
  house:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>',
  tree:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l5.5 7.5h-3l4.5 6.5H5l4.5-6.5h-3z"/><path d="M12 17v4"/></svg>',
  map:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4l6 2 6-2v14l-6 2-6-2-6 2V6z"/><path d="M9 4v14M15 6v14"/></svg>',
  car:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12l1.6-4.5h10.8L19 12"/><path d="M3.5 12h17v5h-17z"/><circle cx="7.5" cy="17" r="1.6"/><circle cx="16.5" cy="17" r="1.6"/></svg>',
  chev:'<svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
};
function glyph(name, cls){ return '<span class="glyph'+(cls?' '+cls:'')+'">'+G[name]+'</span>'; }
function starSvg(pop){ return '<svg'+(pop?' class="pop"':'')+' viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z"/></svg>'; }

/* ---------- GitHub: the only place this app sends anything ---------- */
function repoUrl(path){ return API+"/repos/"+encodeURIComponent(S.owner)+"/"+encodeURIComponent(CFG.notebook||"east-end-notebook")+(path||""); }
function contents(path){ return "/contents/"+path.split("/").map(encodeURIComponent).join("/"); }
function gh(method, path, opt){
  opt=opt||{};
  var headers={"Authorization":"Bearer "+(opt.token||S.token), "Accept":(opt.raw||opt.bytes)?"application/vnd.github.raw+json":"application/vnd.github+json"};
  if(opt.etag) headers["If-None-Match"]=opt.etag;   /* ask only whether the file changed: a 304 carries no body and costs no rate limit */
  var init={method:method, headers:headers, cache:"no-store"};
  if(opt.body){ headers["Content-Type"]="application/json"; init.body=JSON.stringify(opt.body); }
  var ctl=("AbortController" in window)?new AbortController():null, timer=0;
  if(ctl){ init.signal=ctl.signal; timer=setTimeout(function(){ ctl.abort(); }, 20000); }
  return fetch(repoUrl(path), init).then(function(res){
    clearTimeout(timer);
    if(opt.etag && res.status===304) return {notModified:true, etag:opt.etag};
    if(res.ok){
      var body=opt.bytes ? res.arrayBuffer() : (opt.raw ? res.text() : res.json());
      if(!opt.meta) return body;
      var tag=res.headers.get("ETag")||"";
      return Promise.resolve(body).then(function(b){ return {body:b, etag:tag}; });
    }
    return res.json().catch(function(){ return {}; }).then(function(j){
      var e=new Error("GitHub answered "+res.status); e.status=res.status; e.detail=j && j.message; throw e;
    });
  }, function(){
    clearTimeout(timer);
    var e=new Error("No connection"); e.offline=true; throw e;
  });
}
function readFile(path){
  return gh("GET", contents(path)+"?ref="+encodeURIComponent(BRANCH)).then(function(r){
    return {data:JSON.parse(b64decode(r.content)), sha:r.sha};
  }).catch(function(e){ if(e.status===404) return {data:null, sha:null}; throw e; });
}
/* Commits are signed with GitHub's no-reply address for the owner, so the account's real email never lands in the notebook. */
function noReply(){ return (S.ownerId?S.ownerId+"+":"")+S.owner+"@users.noreply.github.com"; }
function learnOwnerId(repo){
  var id=repo && repo.owner && repo.owner.id;
  if(id){ S.ownerId=String(id); lsSet("ee.ownerId", S.ownerId); }
}
function writeFile(path, data, sha, message, tok){
  var body={message:message, content:b64encode(JSON.stringify(data,null,2)+"\n"), branch:BRANCH,
    committer:{name:S.owner, email:noReply()}};
  if(sha) body.sha=sha;
  return gh("PUT", contents(path), {body:body, token:tok});
}

/* ---------- reading the notebook ---------- */
function applyBundle(b){
  if(!b || !Array.isArray(b.listings)) throw new Error("bad bundle");
  var L={};
  b.listings.forEach(function(l){ if(l && IDRE.test(String(l.id))) L[l.id]=l; });
  S.L=L;
  /* lists the screens walk hold objects only, so one odd entry in the notebook can never stop a screen from drawing */
  S.home=(b.home && typeof b.home==="object") ? b.home : {};
  S.home.read=objs(S.home.read); S.home.brief=objs(S.home.brief);
  var newest=S.reports[0] ? S.reports[0].date : null;
  S.reports=arr(b.reports).filter(function(r){ return r && okDate(r.date); }).map(function(r){ r.items=objs(r.items); return r; }).sort(function(a,b2){ return b2.date.localeCompare(a.date); });
  if(!S.reports[0] || S.reports[0].date!==newest) S.homeRep=0;
  S.skipped=objs(b.skipped);
  S.replies=(b.replies && typeof b.replies==="object") ? b.replies : {};
  S.built=b.built||null;
  S.map=mapOf(b.map);
  S.loaded=true;
  applySettings((S.home && S.home.app) || {});
}
/* The notebook says which areas and price steps the filters offer, where the drive-time line sits and which time zone the scan runs in. */
function usdK(n){ n=Number(n)||0; return n>=1000 ? "$"+(Math.round(n/100)/10)+"k" : "$"+n; }
function applySettings(a){
  TZ=undefined;
  if(typeof a.tz==="string"){ try{ new Intl.DateTimeFormat("en-US",{timeZone:a.tz}); TZ=a.tz; }catch(e){} }
  LIMIT=(Number(a.driveLimit)>0 && Number(a.driveLimit)<MAXMIN) ? Number(a.driveLimit) : 15;
  S.budget=(Array.isArray(a.budget) && a.budget.length===2 && a.budget[0]<a.budget[1]) ? [Number(a.budget[0]), Number(a.budget[1])] : null;
  S.lanes=(a.lanes && typeof a.lanes==="object" && !Array.isArray(a.lanes)) ? a.lanes : {};
  var areas=arr(a.areas).filter(function(x){ return x && typeof x.id==="string"; });
  if(!areas.length){
    var seen={};
    everything().forEach(function(l){ if(l.area && !seen[l.area]){ seen[l.area]=1; areas.push({id:String(l.area), label:String(l.area)}); } });
  }
  $("area").innerHTML='<option value="All">All areas</option>'+areas.map(function(x){ return '<option value="'+esc(x.id)+'">'+esc(x.label||x.id)+'</option>'; }).join("");
  $("area").value=areas.some(function(x){ return x.id===S.f.area; }) ? S.f.area : "All";
  S.f.area=$("area").value;
  var steps=arr(a.priceSteps).map(Number).filter(function(n){ return n>0; });
  $("maxp").innerHTML='<option value="0">Any price</option>'+steps.map(function(n){ return '<option value="'+n+'">Up to '+usdK(n)+'</option>'; }).join("");
  $("maxp").value=steps.indexOf(S.f.maxp)>-1 ? String(S.f.maxp) : "0";
  S.f.maxp=Number($("maxp").value);
  $("nearOnly").textContent="Within "+LIMIT+" min";
  Array.prototype.forEach.call(document.querySelectorAll("[data-near]"), function(b){ b.textContent="Within "+LIMIT+" min"; });
  if(typeof a.noteExample==="string" && a.noteExample) $("note").placeholder=a.noteExample;
}
function cleanStars(d){ var out={}, st=(d && d.stars)||{}; Object.keys(st).forEach(function(id){ if(IDRE.test(id)) out[id]=String(st[id]||""); }); return out; }
function cleanNotes(d){ return arr(d && d.notes).filter(function(n){ return n && typeof n.id==="string" && typeof n.text==="string"; }); }
function cleanPrefs(d){ var out={}; if(d && typeof d==="object") Object.keys(d).forEach(function(k){ if(k!=="v") out[k]=d[k]; }); return out; }
function rebuildMe(){
  var st=Object.assign({}, S.srv.stars), nt=S.srv.notes.slice(), pf=Object.assign({}, S.srv.prefs);
  S.queue.forEach(function(o){
    if(o.f==="stars"){ if(o.op==="set") st[o.id]=o.at; else delete st[o.id]; }
    else if(o.f==="notes"){
      if(o.op==="add"){ if(!nt.some(function(n){ return n.id===o.note.id; })) nt.push(o.note); }
      else nt=nt.filter(function(n){ return n.id!==o.id; });
    }
    else if(o.f==="prefs") pf[o.key]=o.value;
  });
  S.stars=st; S.prefs=pf;
  S.notes=nt.sort(function(a,b){ return String(b.at).localeCompare(String(a.at)); });
}
function saveMeCache(){ lsSet("ee.me", JSON.stringify(S.srv)); }
function sync(){
  if(S.syncing || !S.token) return Promise.resolve();
  S.syncing=true; chrome();
  /* When the board on this phone is already loaded, GitHub is asked only whether the notebook changed (its version tag
     travels with the request). A 304 answer means nothing to download, parse or store. */
  var tag=(S.loaded && lsGet("ee.bundle")) ? lsGet("ee.bundleEtag") : null;
  return Promise.all([
    gh("GET", contents("app.json")+"?ref="+encodeURIComponent(BRANCH), {raw:true, meta:true, etag:tag||null}),
    readFile(FILES.stars), readFile(FILES.notes), readFile(FILES.prefs)
  ]).then(function(r){
    if(!S.token) return;   /* the code was dropped while this was in flight: nothing from it may be kept */
    if(!r[0].notModified){
      applyBundle(JSON.parse(r[0].body));
      /* the tag is kept only when the bundle it belongs to was stored, so a 304 can never leave an older board in place */
      if(lsSet("ee.bundle", r[0].body) && r[0].etag) lsSet("ee.bundleEtag", r[0].etag); else lsDel("ee.bundleEtag");
    }
    S.srv={stars:cleanStars(r[1].data), notes:cleanNotes(r[2].data), prefs:cleanPrefs(r[3].data)};
    saveMeCache();
    S.fromCache=false; S.syncErr=null; S.lastSync=Date.now();
    lsSet("ee.lastSync", String(S.lastSync));
    S.imgFail={}; tidyMedia();
  }).catch(function(e){
    if(e.status===401){ lock("GitHub no longer accepts the access code on this phone. It expired or was cancelled. Create a new one and paste it here.", true); return; }
    S.syncErr = e.offline ? "offline" : (e.status===404 ? "missing" : (e.status===403 ? "denied" : "error"));
  }).then(function(){
    S.syncing=false; rebuildMe(); render();
    if(S.queue.length) flushSoon(400);
  });
}

/* ---------- writing: stars, notes, settings ---------- */
function saveQueue(){ lsSet("ee.queue", JSON.stringify(S.queue)); }
function enqueue(op){ S.queue.push(op); saveQueue(); S.saveErr=null; rebuildMe(); render(); flushSoon(1200); }
function flushSoon(ms){ clearTimeout(S.flushTimer); S.flushTimer=setTimeout(flush, ms); }
function applyOps(f, data, ops){
  var d;
  if(f==="stars"){
    d={v:1, stars:cleanStars(data)};
    ops.forEach(function(o){ if(o.op==="set") d.stars[o.id]=o.at; else delete d.stars[o.id]; });
  }else if(f==="notes"){
    d={v:1, notes:cleanNotes(data)};
    ops.forEach(function(o){
      if(o.op==="add"){ if(!d.notes.some(function(n){ return n.id===o.note.id; })) d.notes.push(o.note); }
      else d.notes=d.notes.filter(function(n){ return n.id!==o.id; });
    });
  }else if(f==="push"){
    d={v:1, subs:arr(data && data.subs).filter(function(s){ return s && typeof s.endpoint==="string"; })};
    ops.forEach(function(o){
      var ep=o.op==="set" ? o.sub.endpoint : o.endpoint;
      d.subs=d.subs.filter(function(s){ return s.endpoint!==ep; });
      if(o.op==="set") d.subs.push(o.sub);
    });
  }else{
    d=Object.assign({v:1}, cleanPrefs(data));
    ops.forEach(function(o){ d[o.key]=o.value; });
  }
  return d;
}
function commitMessage(f, ops){
  if(f==="stars"){
    if(ops.length===1){ var l=S.L[ops[0].id]; return (ops[0].op==="set"?"Starred ":"Unstarred ")+(l?l.addr:ops[0].id); }
    return "Stars: "+ops.length+" changes";
  }
  if(f==="notes") return ops.length===1 ? (ops[0].op==="add"?"Note for the morning scan":"Removed a note") : "Notes: "+ops.length+" changes";
  if(f==="push") return ops.some(function(o){ return o.op==="set"; }) ? "Notifications on for a device" : "Notifications off for a device";
  return "Changed a setting";
}
function flushFile(f, ops, attempt){
  return readFile(FILES[f]).then(function(cur){
    var next=applyOps(f, cur.data, ops);
    if(cur.data && JSON.stringify(next)===JSON.stringify(cur.data)) return next;
    return writeFile(FILES[f], next, cur.sha, commitMessage(f, ops)).then(function(){ return next; }, function(e){
      if((e.status===409 || e.status===422) && attempt<3) return flushFile(f, ops, attempt+1);
      throw e;
    });
  });
}
function flush(){
  if(S.flushing || !S.queue.length || !S.token) return;
  S.flushing=true; chrome();
  var order=["stars","notes","push","prefs"];
  var chain=S.ownerId ? Promise.resolve() : gh("GET","").then(learnOwnerId, function(){});
  order.forEach(function(f){
    chain=chain.then(function(){
      var ops=S.queue.filter(function(o){ return o.f===f; });
      if(!ops.length) return;
      return flushFile(f, ops, 1).then(function(next){
        S.queue=S.queue.filter(function(o){ return ops.indexOf(o)<0; }); saveQueue();
        if(f==="stars") S.srv.stars=cleanStars(next);
        else if(f==="notes") S.srv.notes=cleanNotes(next);
        else if(f==="prefs") S.srv.prefs=cleanPrefs(next);
        saveMeCache();
      });
    });
  });
  chain.then(function(){ S.saveErr=null; }, function(e){
    if(e.status===401){ lock("GitHub no longer accepts the access code on this phone. Create a new one and paste it here. Your unsaved changes are kept.", true); return; }
    S.saveErr = e.offline ? "offline" : ((e.status===403 || e.status===404) ? "denied" : "error");
  }).then(function(){
    S.flushing=false; rebuildMe(); render();
    if(S.queue.length && !S.saveErr) flushSoon(600);
  });
}
function toggleStar(id){
  if(!IDRE.test(id)) return;
  if(S.stars[id]){ S.starPop=null; enqueue({f:"stars", op:"del", id:id}); }
  else { S.starPop=id; enqueue({f:"stars", op:"set", id:id, at:new Date().toISOString()}); }
}
function saveNote(){
  var el=$("note"), t=el.value.trim();
  if(!t) return;
  var note={id:"n-"+Date.now().toString(36)+Math.random().toString(36).slice(2,6), text:t.slice(0,2000), at:new Date().toISOString()};
  var about=el.getAttribute("data-about");
  if(about && IDRE.test(about) && S.L[about]) note.about=about;
  el.value=""; el.removeAttribute("data-about");
  enqueue({f:"notes", op:"add", note:note});
  $("notestate").textContent="Saved. I will answer at the next scan.";
  setTimeout(function(){ $("notestate").textContent=""; }, 5000);
}

/* ---------- photos and map: what the bundle may carry, how the bytes arrive, and the frames the views draw ---------- */
/* A listing's photo entry, validated. Null when absent or malformed. */
function photoOf(l){
  var p=l && l.photo;
  if(!p || typeof p!=="object" || !PHRE.test(String(p.path)) || !PTYPES[p.type] || !SHARE.test(String(p.sha))) return null;
  var out={path:p.path, type:p.type, sha:p.sha, c:COLRE.test(String(p.c))?String(p.c):""};
  if(p.s && typeof p.s==="object" && PHRE.test(String(p.s.path)) && SHARE.test(String(p.s.sha))) out.s={path:p.s.path, sha:p.s.sha};
  return out;
}
function isInt(n, lo, hi){ return typeof n==="number" && isFinite(n) && Math.floor(n)===n && n>=lo && n<=hi; }
function imgType(path){ return /\.png$/i.test(path) ? "image/png" : "image/jpeg"; }
/* The map manifest from app.json, validated. Every path and sha is checked before it can be fetched. */
function mapOf(m){
  if(!m || typeof m!=="object") return null;
  if(!isInt(m.z,1,22) || !isInt(m.x0,0,4194304) || !isInt(m.y0,0,4194304) || !isInt(m.cols,1,256) || !isInt(m.rows,1,256) || !isInt(m.tile,64,1024)) return null;
  var tiles=[], seen={};
  arr(m.tiles).forEach(function(t){
    if(!t || !isInt(t.x,m.x0,m.x0+m.cols-1) || !isInt(t.y,m.y0,m.y0+m.rows-1) || !MPRE.test(String(t.path)) || !SHARE.test(String(t.sha))) return;
    var k=t.x+"-"+t.y; if(seen[k]) return; seen[k]=1;
    tiles.push({x:t.x, y:t.y, path:t.path, sha:t.sha, type:imgType(t.path)});
  });
  if(!tiles.length) return null;
  var small=(m.small && typeof m.small==="object" && MPRE.test(String(m.small.path)) && SHARE.test(String(m.small.sha))) ? {path:m.small.path, sha:m.small.sha, type:imgType(m.small.path)} : null;
  var near={}, ids=(m.near && m.near.ids && typeof m.near.ids==="object") ? m.near.ids : {};
  Object.keys(ids).forEach(function(id){ var e=ids[id]; if(IDRE.test(id) && e && typeof e==="object" && MPRE.test(String(e.path)) && SHARE.test(String(e.sha))) near[id]={path:e.path, sha:e.sha, type:imgType(e.path)}; });
  var attr=(typeof m.attribution==="string" && m.attribution.trim()) ? m.attribution.trim().slice(0,160) : ATTRIB;
  var rev=(typeof m.rev==="string" && m.rev) ? m.rev.slice(0,80) : tiles.length+":"+tiles[0].sha+":"+(small?small.sha:"");
  return {z:m.z, x0:m.x0, y0:m.y0, cols:m.cols, rows:m.rows, tile:m.tile, tiles:tiles, small:small, near:near, attribution:attr, rev:rev};
}
/* A listing's map point, when it has one that makes sense. */
function pointOf(l){
  var la=l && l.lat, lo=l && l.lon;
  if(typeof la!=="number" || typeof lo!=="number" || !isFinite(la) || !isFinite(lo) || la<-90 || la>90 || lo<-180 || lo>180) return null;
  return {lat:la, lon:lo};
}
/* Web Mercator onto the tile grid. ms is 1 at Area (a tile at half its pixel size, so 2x crisp) and 2 at Close. */
function proj(lat, lon, m, ms){
  var n=Math.pow(2,m.z), T=m.tile/2*ms, r=lat*Math.PI/180;
  return {x:((lon+180)/360*n-m.x0)*T, y:((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*n-m.y0)*T};
}
function projL(l, ms){ var p=pointOf(l); return (p && S.map) ? proj(p.lat, p.lon, S.map, ms) : null; }
function inGrid(l){
  var m=S.map, p=m ? projL(l,1) : null; if(!p) return false;
  var T=m.tile/2;
  return p.x>=0 && p.y>=0 && p.x<m.cols*T && p.y<m.rows*T;
}
function bbox(list, ms){
  var x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity, n=0;
  list.forEach(function(l){ var p=projL(l,ms); if(!p) return; n++; x0=Math.min(x0,p.x); y0=Math.min(y0,p.y); x1=Math.max(x1,p.x); y1=Math.max(y1,p.y); });
  return n ? {x:x0, y:y0, w:x1-x0, h:y1-y0} : null;
}
/* One <img> that the loader fills in. When the object URL is already known it is painted at once, with no fade. */
function imgTag(sha, path, type, cls, style){
  var known=S.img[sha];
  return '<img class="'+(cls||'')+(known?' in now':'')+'" data-sha="'+esc(sha)+'" data-path="'+esc(path)+'" data-type="'+esc(type)+'" alt="" decoding="async"'
    +(known?' src="'+esc(known)+'"':'')+(style?' style="'+style+'"':'')+'>';
}
/* A photo frame: a locked aspect box with the listing's colour or sand underneath and a glyph until a photo shows.
   `small` asks for the small file when there is one. `extra` is markup laid over the photo (pills, a star, a credit). */
function ph(l, cls, small, extra){
  var p=photoOf(l), src=p ? ((small && p.s) ? p.s : p) : null;
  return '<span class="ph'+(cls?' '+cls:'')+(src?' has':'')+(src && S.imgFail[src.sha]?' failed':'')+'"'+(p && p.c ? ' style="background:'+esc(p.c)+'"' : '')+'>'
    +glyph(l.type==="Land" ? "tree" : "house")
    +(src ? imgTag(src.sha, src.path, p.type, "") : '')
    +(extra||'')+'</span>';
}
/* A map pin: a teardrop with the rank for the top five, a dot for the rest, paper for pending, a star badge when starred. */
function pinInner(l){
  var top=l.status==="active" && l.rank>=1 && l.rank<=5;
  return '<svg viewBox="0 0 26 32" aria-hidden="true"><path class="body" d="M13 31C9 24 2 18.5 2 12a11 11 0 1 1 22 0c0 6.5-7 12-11 19z"/>'
    +(top ? '<text class="n" x="13" y="16.3">'+esc(l.rank)+'</text>' : '<circle class="d" cx="13" cy="12" r="3"/>')
    +(S.stars[l.id] ? '<path class="sb" transform="translate(17 -3) scale(.46)" d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8-4.2-4.1 5.8-.8z"/>' : '')+'</svg>';
}
function pinHtml(l, o){
  o=o||{};
  var cls="pin"+(o.small?" sm":"")+(l.status==="pending"?" pending":"")+(o.sel?" sel":"")+(o.play?" in":"");
  var style=(o.x!=null ? "left:"+o.x.toFixed(1)+"px;top:"+o.y.toFixed(1)+"px;" : "")+(o.play && o.delay ? "animation-delay:"+o.delay+"ms;" : "");
  if(o.tag==="span") return '<span class="'+cls+'" aria-hidden="true" style="'+style+'">'+pinInner(l)+'</span>';
  return '<button class="'+cls+'" type="button" data-pin="'+esc(l.id)+'" data-starred="'+(S.stars[l.id]?1:0)+'" aria-label="'+esc(l.addr)+'" style="'+style+'"'+(o.hidden?' hidden':'')+'>'+pinInner(l)+'</button>';
}

/* --- the loader: Cache storage first, then one fetch of the bytes through the contents API, at most 4 in flight per kind --- */
var IOP=null, IOM=null, LOADQ={photo:{n:0, wait:[]}, map:{n:0, wait:[]}}, LOADING={};
function imgKey(sha){ return location.origin+"/_img/"+sha; }
function cacheGet(key){
  return new Promise(function(res){
    try{
      if(!("caches" in window)) return res(null);
      caches.open(IMGCACHE).then(function(c){ return c.match(key); }).then(function(r){ return r ? r.blob() : null; }).then(res, function(){ res(null); });
    }catch(e){ res(null); }
  });
}
function cachePut(key, blob, type){
  return new Promise(function(res){
    try{
      if(!("caches" in window)) return res();
      caches.open(IMGCACHE).then(function(c){ return c.put(new Request(key), new Response(blob, {headers:{"Content-Type":type}})); }).then(res, function(){ res(); });
    }catch(e){ res(); }
  });
}
function fetchImg(sha, path, type){
  var key=imgKey(sha);
  return cacheGet(key).then(function(blob){
    if(blob) return blob;
    return gh("GET", contents(path)+"?ref="+encodeURIComponent(BRANCH), {bytes:true}).then(function(buf){
      var b=new Blob([buf], {type:type});
      return cachePut(key, b, type).then(function(){ return b; });
    });
  }).then(function(blob){ var u=URL.createObjectURL(blob); S.img[sha]=u; return u; });
}
function pump(q){ while(q.n<INFLIGHT && q.wait.length){ q.n++; (q.wait.shift())(); } }
function imgLoad(sha, path, type){
  if(S.img[sha]) return Promise.resolve(S.img[sha]);
  if(LOADING[sha]) return LOADING[sha];
  var q=LOADQ[/^board\/map\//.test(path) ? "map" : "photo"];
  var p=new Promise(function(res, rej){
    q.wait.push(function(){
      fetchImg(sha, path, type).then(function(u){ q.n--; pump(q); res(u); }, function(e){ q.n--; pump(q); rej(e); });
    });
    pump(q);
  });
  LOADING[sha]=p;
  var clear=function(){ delete LOADING[sha]; };
  p.then(clear, clear);
  return p;
}
function setSrc(img, url, now){
  if(img.getAttribute("src")) return;
  img.src=url;
  if(now || RM){ img.classList.add("in"); if(now) img.classList.add("now"); return; }
  var done=function(){ img.classList.add("in"); };
  if(img.decode) img.decode().then(done, done); else done();
}
function markFailed(img){ img.setAttribute("data-fail","1"); var f=img.parentNode; if(f && f.classList) f.classList.add("failed"); }
function eachImg(sha, fn){ Array.prototype.forEach.call(document.querySelectorAll('img[data-sha="'+sha+'"]:not([src])'), fn); }
function wantImg(img){
  var sha=img.getAttribute("data-sha")||"", path=img.getAttribute("data-path")||"", type=img.getAttribute("data-type")||"";
  if(!SHARE.test(sha) || !(PHRE.test(path) || MPRE.test(path)) || !PTYPES[type]){ markFailed(img); return; }
  imgLoad(sha, path, type).then(function(url){ eachImg(sha, function(i){ setSrc(i, url, false); }); },
    function(){ S.imgFail[sha]=1; eachImg(sha, markFailed); });
}
function onSeen(entries, io){
  entries.forEach(function(en){ if(en.isIntersecting || en.intersectionRatio>0){ io.unobserve(en.target); wantImg(en.target); } });
}
/* After every paint: images already known paint now, failed ones show the glyph, the rest load as they come near the screen. */
function hydrateImages(){
  if(!IOP && "IntersectionObserver" in window){
    IOP=new IntersectionObserver(onSeen, {rootMargin:"240px"});
    IOM=new IntersectionObserver(onSeen, {root:$("mappane"), rootMargin:"256px"});
  }
  Array.prototype.forEach.call(document.querySelectorAll("img[data-sha]:not([src]):not([data-fail])"), function(img){
    var sha=img.getAttribute("data-sha");
    if(S.img[sha]){ setSrc(img, S.img[sha], true); return; }
    if(S.imgFail[sha]){ markFailed(img); return; }
    if(img.eeObs) return;
    img.eeObs=true;
    if(!IOP){ wantImg(img); return; }
    (img.closest && img.closest("#mappane") ? IOM : IOP).observe(img);
  });
}
/* Housekeeping: after a sync, drop saved images the board no longer names. */
function bundleShas(){
  var set={}, m=S.map;
  everything().forEach(function(l){ var p=photoOf(l); if(p){ set[p.sha]=1; if(p.s) set[p.s.sha]=1; } });
  if(m){ m.tiles.forEach(function(t){ set[t.sha]=1; }); if(m.small) set[m.small.sha]=1; Object.keys(m.near).forEach(function(id){ set[m.near[id].sha]=1; }); }
  return set;
}
function dropUrl(sha){ if(S.img[sha]){ try{ URL.revokeObjectURL(S.img[sha]); }catch(e){} delete S.img[sha]; } }
function revokeAll(){ Object.keys(S.img).forEach(dropUrl); S.img={}; S.imgFail={}; }
function tidyMedia(){
  try{
    if(!("caches" in window)) return;
    var keep=bundleShas();
    caches.has(IMGCACHE).then(function(has){
      if(!has) return;
      return caches.open(IMGCACHE).then(function(c){ return c.keys().then(function(keys){
        keys.forEach(function(req){
          var sha=String(req.url).split("/").pop();
          if(keep[sha]) return;
          c.delete(req).then(null, function(){}); dropUrl(sha);
        });
      }); });
    }).then(null, function(){});
  }catch(e){}
}
function mediaCount(){
  if(!("caches" in window)){ S.mediaText="Images are not kept on this phone."; return; }
  Promise.resolve().then(function(){ return caches.has(IMGCACHE); }).then(function(has){
    if(!has) return 0;
    return caches.open(IMGCACHE).then(function(c){ return c.keys(); }).then(function(k){ return k.length; });
  }).then(function(n){
    var t=n+(n===1?" image":" images")+" saved on this phone.";
    if(t!==S.mediaText){ S.mediaText=t; if(S.overlay && S.overlay.type==="settings") $("set-media").textContent=t; }
  }).catch(function(){ S.mediaText="Images are not kept on this phone."; });
}
function clearMedia(){
  var done=function(){ revokeAll(); S.mediaText=null; render(); toast("Saved images cleared."); };
  try{ if("caches" in window){ caches.delete(IMGCACHE).then(done, done); return; } }catch(e){}
  done();
}

/* --- the Home map card: the overview image framed on the top five, with numbered pins --- */
/* Where to slide the image along one axis: the image (img long) must still cover the card (card long), a pin at p shows
   between m0 and m1. The centred position wins unless another shows more pins. */
function pickShift(ps, card, img, m0, m1, centre){
  var lo=Math.min(0, card-img), best=null, cands=[centre];
  ps.forEach(function(p){ cands.push(m0-p); cands.push(m1-p); });
  cands.forEach(function(t){
    t=Math.min(0, Math.max(lo, t));
    var n=0; ps.forEach(function(p){ if(p+t>=m0 && p+t<=m1) n++; });
    var d=Math.abs(t-centre);
    if(!best || n>best.n || (n===best.n && d<best.d)) best={t:t, n:n, d:d};
  });
  return best.t;
}
function renderHomeMap(){
  var el=$("homemap"), m=S.map, c=checked();
  var five=m ? active().sort(byRank).slice(0,5).filter(inGrid) : [];
  var frame=five.length>=2 ? five : (m ? active().filter(inGrid) : []);
  if(!m || !frame.length || !five.length){ el.hidden=true; el.innerHTML=""; el.removeAttribute("data-key"); return; }
  el.hidden=false;
  var W=el.clientWidth || Math.min(720, window.innerWidth)-32, H=200;
  S.homeW=W;
  var play=S.pinsPlayed!==c;
  var key=m.rev+"|"+W+"|"+five.map(function(l){ return l.id; }).join(",")+"|"+frame.length;
  if(!play && el.getAttribute("data-key")===key) return;
  el.setAttribute("data-key", key);
  var T=m.tile/2, gw=m.cols*T, gh=m.rows*T, b=bbox(frame,1);
  var bw=Math.max(1,b.w), bh=Math.max(1,b.h);
  var lo=Math.max(W/gw, H/gh), fit=Math.min((W-64)/bw, (H-64)/bh);
  var s=Math.max(lo, Math.min(fit, 1));                  /* cover the card, never above Area scale unless covering needs it */
  var iw=gw*s, ih=gh*s, pts=five.map(function(l){ return projL(l,1); });
  /* centre the box on the card; when the box is taller or wider than the card can show, slide to where the most pins show */
  var tx=pickShift(pts.map(function(p){ return p.x*s; }), W, iw, 11, W-11, W/2-(b.x+bw/2)*s);     /* a small pin is 22 wide and 27 tall above its tip */
  var ty=pickShift(pts.map(function(p){ return p.y*s; }), H, ih, 27, H-2, H/2-(b.y+bh/2)*s);
  var step=RM?0:Math.min(30, 400/Math.max(1,five.length));
  var pins=five.map(function(l,i){
    var p=projL(l,1), x=p.x*s+tx, y=p.y*s+ty;
    /* a pin whose head or tip would be cut by the card's edge is left off rather than drawn half */
    return pinHtml(l, {small:true, x:x, y:y, play:play, delay:Math.round(i*step), hidden:(x<11 || x>W-11 || y<27 || y>H-2)});
  }).join("");
  var tr="transform:translate("+tx.toFixed(1)+"px,"+ty.toFixed(1)+"px)";
  var img = m.small ? imgTag(m.small.sha, m.small.path, m.small.type, "mapimg", "width:"+iw.toFixed(1)+"px;height:"+ih.toFixed(1)+"px;"+tr)
    : '<span class="maptiles" style="'+tr+'">'+m.tiles.map(function(t){
        return imgTag(t.sha, t.path, t.type, "mtile", "left:"+((t.x-m.x0)*T*s).toFixed(1)+"px;top:"+((t.y-m.y0)*T*s).toFixed(1)+"px;width:"+(T*s).toFixed(2)+"px;height:"+(T*s).toFixed(2)+"px");
      }).join("")+'</span>';
  el.innerHTML=img+pins+'<span class="viewmap">'+glyph("map")+'View map</span><span class="attrib">'+esc(m.attribution)+'</span>';
  if(play) S.pinsPlayed=c;
}

/* --- the Map screen: the tile grid, pins, clusters, the peek card --- */
function mapShown(){
  var f=S.f, plain=f.type==="All" && !f.near && !S.mf.top && !S.mf.starred;
  return everything().filter(function(l){
    if(l.status==="gone") return false;
    if(l.status==="pending") return plain;
    if(f.type!=="All" && l.type!==f.type) return false;
    if(f.near && !(l.drive<=LIMIT)) return false;
    if(S.mf.top && !(l.rank>=1 && l.rank<=5)) return false;
    if(S.mf.starred && !S.stars[l.id]) return false;
    return true;
  }).filter(inGrid).sort(byRank);
}
/* Greedy clusters in rank order: a pin joins the first cluster whose anchor is within R CSS px. */
function clusterize(list, ms){
  var R=ms===2 ? 16 : 24, out=[];
  list.forEach(function(l){
    var p=projL(l,ms), c=null;
    for(var i=0;i<out.length;i++){ var dx=out[i].x-p.x, dy=out[i].y-p.y; if(dx*dx+dy*dy<=R*R){ c=out[i]; break; } }
    if(c) c.items.push(l); else out.push({x:p.x, y:p.y, items:[l]});
  });
  return out;
}
function paneCentre(ms){ var p=$("mappane"); return {x:(p.scrollLeft+p.clientWidth/2)/ms, y:(p.scrollTop+p.clientHeight/2)/ms}; }
function scrollPane(cx, cy, ms, smooth){
  var p=$("mappane"), l=Math.max(0, cx*ms-p.clientWidth/2), t=Math.max(0, cy*ms-p.clientHeight/2);
  if(smooth && !RM && p.scrollTo){ try{ p.scrollTo({left:l, top:t, behavior:"smooth"}); return; }catch(e){} }
  p.scrollLeft=l; p.scrollTop=t;
}
function buildStage(m, ms, list){
  var T=m.tile/2*ms, stage=$("mapstage"), h="";
  stage.style.width=(m.cols*T)+"px"; stage.style.height=(m.rows*T)+"px";
  m.tiles.forEach(function(t){
    h+=imgTag(t.sha, t.path, t.type, "mtile", "left:"+((t.x-m.x0)*T)+"px;top:"+((t.y-m.y0)*T)+"px;width:"+T+"px;height:"+T+"px");
  });
  var cl=clusterize(list, ms), n=0, step=RM?0:Math.min(30, 400/Math.max(1, cl.length));
  S.mapClusters=cl;
  cl.forEach(function(c){
    if(c.items.length===1){ var l=c.items[0]; h+=pinHtml(l, {x:c.x, y:c.y, sel:S.mapSel===l.id, play:true, delay:Math.round(n++*step)}); }
  });
  cl.forEach(function(c, i){
    if(c.items.length>1) h+='<button class="cluster in" type="button" data-cluster="'+i+'" style="left:'+c.x.toFixed(1)+'px;top:'+c.y.toFixed(1)+'px;animation-delay:'+Math.round(n++*step)+'ms" aria-label="'+c.items.length+' listings here">'+c.items.length+'</button>';
  });
  stage.innerHTML=h;
}
function resolveWant(w){ if(w.id){ var l=S.L[w.id]; return l ? projL(l,1) : null; } return {x:w.x, y:w.y}; }
function updateSel(stage){
  stage.classList.toggle("dimpins", !!S.mapSel);
  Array.prototype.forEach.call(stage.querySelectorAll(".pin"), function(p){
    var id=p.getAttribute("data-pin"), l=S.L[id]; if(!l) return;
    p.classList.toggle("sel", id===S.mapSel);
    var st=S.stars[id]?"1":"0";
    if(p.getAttribute("data-starred")!==st){ p.setAttribute("data-starred", st); p.innerHTML=pinInner(l); }
  });
}
var peekTimer=0;
function updatePeek(){
  var peek=$("peek"), html="", key="", l;
  if(S.mapPick!=null && S.mapClusters[S.mapPick] && S.mapClusters[S.mapPick].items.length>1){
    var c=S.mapClusters[S.mapPick]; key="c:"+S.mapPick;
    html='<div class="pick"><span class="eyebrow">'+c.items.length+' listings here</span>'+c.items.map(function(x){
      return '<button type="button" data-open="'+esc(x.id)+'">'+ph(x,"t44",true)+'<span class="pttl">'+esc(x.addr)+'</span><span class="num">'+usd(x.price)+'</span></button>'; }).join("")+'</div>';
  }else if(S.mapSel && (l=S.L[S.mapSel])){
    key="l:"+l.id+":"+(S.stars[l.id]?1:0);
    html='<button class="pbody" type="button" data-open="'+esc(l.id)+'">'+ph(l,"t72",true)
      +'<span class="ptext"><span class="pttl">'+esc(l.addr)+' '+pillFor(l)+'</span><span class="pplace">'+esc(l.place||"")+'</span>'
      +'<span class="pnums">'+usd(l.price)+'</span><span class="pnums sub">'+esc(l.acresNote||l.acres)+' ac'+(typeof l.drive==="number"?' · '+l.drive+' min':'')+'</span></span></button>'+starBtn(l.id,l.addr);
  }
  if(!html){ hidePeek(); return; }
  var was=peek.getAttribute("data-key")||"";
  if(peekTimer){ clearTimeout(peekTimer); peekTimer=0; }
  peek.classList.remove("leaving");
  if(was===key && !peek.hidden) return;
  var same=was.split(":").slice(0,2).join(":")===key.split(":").slice(0,2).join(":");   /* the same listing, only its star changed */
  peek.innerHTML='<div class="pc">'+html+'</div>';
  peek.setAttribute("data-key", key);
  if(peek.hidden) peek.hidden=false;
  else if(!same) replay(peek.firstChild, "swap");
  /* the floating controls move up out from under the card */
  var wrap=$("mapwrap"); wrap.style.setProperty("--peekh", (peek.offsetHeight+12)+"px"); wrap.classList.add("peeking");
}
function hidePeek(now){
  var peek=$("peek");
  if(peekTimer){ clearTimeout(peekTimer); peekTimer=0; }
  $("mapwrap").classList.remove("peeking");
  if(peek.hidden) return;
  var done=function(){ peekTimer=0; peek.hidden=true; peek.classList.remove("leaving"); peek.removeAttribute("data-key"); };
  if(now || RM){ done(); return; }
  peek.classList.add("leaving");
  peekTimer=setTimeout(done, 210);
}
function renderMap(){
  var has=!!S.map, m=S.map;
  $("mapchips").hidden=!has; $("mapwrap").hidden=!has; $("mapempty").hidden=has;
  setHeights();
  if(!has){ S.mapKey=null; hidePeek(true); return; }
  var ms=S.mapLevel==="close"?2:1, list=mapShown();
  if(S.mapSel && !list.some(function(l){ return l.id===S.mapSel; })){
    var sl=S.L[S.mapSel];
    if(sl && sl.status!=="gone" && inGrid(sl) && S.mapWant){ S.f.type="All"; S.f.near=false; S.mf.top=false; S.mf.starred=false; list=mapShown(); syncChips(); }
    else S.mapSel=null;
  }
  var ckey=[S.f.type, S.f.near?1:0, S.mf.top?1:0, S.mf.starred?1:0].join("|");
  var key=m.rev+"|"+ms+"|"+ckey+"|"+list.map(function(l){ return l.id; }).join(",");
  var stage=$("mapstage");
  $("chip-all").textContent="All · "+list.length;
  $("mapattrib").textContent=m.attribution;
  if(key!==S.mapKey){
    var old=(S.mapKey && S.mapMs) ? paneCentre(S.mapMs) : null, chipsChanged=S.mapCKey!==ckey;
    buildStage(m, ms, list);
    var c=null;
    if(S.mapWant){ c=resolveWant(S.mapWant); S.mapWant=null; }
    if(!c && old && !chipsChanged) c=old;
    if(!c){ var b=bbox(list,1); if(b) c={x:b.x+b.w/2, y:b.y+b.h/2}; }
    if(c) scrollPane(c.x, c.y, ms, false);
    if(S.mapKey) replay(stage, "fade");
    S.mapKey=key; S.mapCKey=ckey; S.mapMs=ms;
  }else if(S.mapWant){ var w=resolveWant(S.mapWant); S.mapWant=null; if(w) scrollPane(w.x, w.y, ms, true); }
  updateSel(stage); updatePeek();
}
function setLevel(level, cx, cy){
  if(cx!=null) S.mapWant={x:cx, y:cy};
  if(S.mapLevel===level && cx==null) return;
  S.mapLevel=level; render();
}
function fitPins(){
  var b=bbox(mapShown(), 1); if(!b) return;
  scrollPane(b.x+b.w/2, b.y+b.h/2, S.mapMs||1, true);
}
var lastTap=null;
function stageTap(e){
  var now=Date.now(), x=e?e.clientX:0, y=e?e.clientY:0;
  if(lastTap && now-lastTap.t<350 && Math.abs(x-lastTap.x)<30 && Math.abs(y-lastTap.y)<30){
    lastTap=null;
    var r=$("mapstage").getBoundingClientRect(), ms=S.mapMs||1;
    setLevel(S.mapLevel==="close"?"area":"close", (x-r.left)/ms, (y-r.top)/ms);
    return;
  }
  lastTap={t:now, x:x, y:y};
  if(S.mapSel || S.mapPick!=null){ S.mapSel=null; S.mapPick=null; render(); }
}

/* --- the sheet's "Where it is" block: the near crop with one pin at its centre, and two links --- */
function whereIs(l, sheet){
  var pt=pointOf(l); if(!pt) return "";
  var m=S.map, near=m && m.near[l.id], onMap=!!(m && inGrid(l));
  var crop=(near && onMap) ? '<button class="nearmap"'+(sheet?' id="nearmap"':'')+' type="button" data-map="'+esc(l.id)+'" aria-label="See '+esc(l.addr)+' on the map">'
      +imgTag(near.sha, near.path, near.type, "")+pinHtml(l,{tag:"span"})+'<span class="attrib">'+esc(m.attribution)+'</span></button>'
      +'<p class="fine">The pin is the listing\'s own map point. For land it is often the road frontage.</p>' : '';
  var apple="https://maps.apple.com/?ll="+pt.lat.toFixed(5)+","+pt.lon.toFixed(5)+"&q="+encodeURIComponent(String(l.addr||""))+"&z=15&t=h";
  var btns='<div class="btnrow'+(onMap?'':' one')+'">'
    +(onMap ? '<button class="btn ghost"'+(sheet?' id="seemap"':'')+' type="button" data-map="'+esc(l.id)+'">See on the map</button>' : '')
    +'<a class="btn ghost"'+(sheet?' id="applemaps"':'')+' href="'+esc(safeUrl(apple))+'" target="_blank" rel="noopener noreferrer">Open in Apple Maps</a></div>';
  return '<div class="whereis"><span class="eyebrow">Where it is</span>'+crop+btns+'</div>';
}

/* ---------- pieces shared by the views ---------- */
function checked(){ return S.home && okDate(S.home.checked) ? S.home.checked : null; }
function daysAgo(d){ var c=checked(); return (c && okDate(d)) ? dnum(c)-dnum(d) : 999; }
function everything(){ return Object.keys(S.L).map(function(k){ return S.L[k]; }); }
function active(){ return everything().filter(function(l){ return l.status==="active" && !laneOf(l); }); }
/* A lane is a second search beside the ranked board (the notebook names it; the id is a short word). Its listings carry no rank. */
function laneOf(l){ return (typeof l.lane==="string" && /^[a-z]{1,24}$/.test(l.lane)) ? l.lane : ""; }
function laneLabel(id){ var c=S.lanes[id]; return (c && typeof c.label==="string") ? c.label : id.charAt(0).toUpperCase()+id.slice(1); }
function byRank(a,b){ return (a.rank||999)-(b.rank||999); }
function ppa(l){ return l.acres ? l.price/l.acres : Infinity; }
function flagOf(l){
  if(l.status==="pending") return ["pending","Pending"];
  if(l.status==="gone") return ["gone","Off market"];
  if(l.flag) return ["back",String(l.flag)];
  if(okDate(l.seen) && daysAgo(l.seen)<3) return ["new","New"];
  if(okDate(l.chg) && daysAgo(l.chg)<=3) return ["cut","Price cut"];
  return null;
}
function pillFor(l){ var f=flagOf(l); return f ? '<span class="pill '+f[0]+'">'+esc(f[1])+'</span>' : ""; }
function ruler(l){
  if(typeof l.drive!=="number") return "";
  var pct=Math.min(100,Math.round(l.drive/MAXMIN*100));
  return '<span class="ruler'+(l.drive>LIMIT?' far':'')+'" role="img" aria-label="'+l.drive+' minutes from home. The line marks '+LIMIT+'."><i style="width:'+pct+'%"></i><b style="left:'+(LIMIT/MAXMIN*100).toFixed(2)+'%"></b></span>';
}
function starBtn(id,addr){
  var on=!!S.stars[id];
  return '<button class="star" type="button" data-star="'+esc(id)+'" aria-pressed="'+on+'" aria-label="'+(on?'Remove '+esc(addr)+' from':'Add '+esc(addr)+' to')+' my contenders">'+starSvg(S.starPop===id)+'</button>';
}
function nums(l){
  return '<span>'+usd(l.price)+'</span><span>'+esc(l.acresNote||l.acres)+' ac</span>'
    +(typeof l.drive==="number" ? '<span>'+l.drive+' min</span>'+ruler(l) : '');
}
/* One list row. badge: "rank" (numbered), "hollow" (pending) or "" (none). */
function row(l, badge, sub, clamp){
  var b = badge==="rank" ? '<span class="rk">'+esc(l.rank)+'</span>' : (badge==="hollow" ? '<span class="rk hollow" aria-hidden="true"></span>' : '');
  return '<li class="pickrow'+(b?'':' plain')+(l.status==="gone"?' off':'')+'">'
    +'<span class="thumb">'+ph(l,"thumb",true)+b+'</span>'
    +'<button class="openrow" type="button" data-open="'+esc(l.id)+'"><span class="ttl">'+esc(l.addr)+' '+pillFor(l)+'</span>'
    +(sub?'<span class="why'+(clamp?' clamp':'')+'">'+esc(sub)+'</span>':'')+'<span class="nums">'+nums(l)+'</span></button>'
    +starBtn(l.id,l.addr)+'</li>';
}
/* The photo's own source: the site its address points at, else the listing's site. */
function photoCredit(l){
  var u=String(l.photoSrc||"");
  if(/^https:\/\/[a-z0-9.-]*zillowstatic\.com\//i.test(u)) return "Zillow";
  if(/^https:\/\/[a-z0-9.-]*cdn-redfin\.com\//i.test(u)) return "Redfin";
  return l.src||"the listing site";
}
/* The full card. `sheet` drops the border (the sheet is the frame). The hero comes first either way. */
function card(l, sheet){
  var tags="";
  if(l.status==="active" && l.rank<=5) tags+='<span class="pill pick">Claude pick '+esc(l.rank)+'</span>';
  else if(l.status==="active" && l.rank) tags+='<span class="pill">Rank '+esc(l.rank)+'</span>';
  if(laneOf(l)) tags+='<span class="pill lane">'+esc(laneLabel(laneOf(l)))+'</span>';
  tags+='<span class="pill">'+esc(l.type||"Listing")+'</span>'+pillFor(l);
  var hero=ph(l, "hero", false, '<span class="shade"></span><span class="tags">'+tags+'</span>'+starBtn(l.id,l.addr)
    +(photoOf(l) ? '<span class="credit">Photo: '+esc(photoCredit(l))+'</span>' : ''));
  var third=l.sqft ? '<div><span class="v">'+usd(l.price/l.sqft)+'</span><span class="k">per sq ft</span></div>'
    : '<div><span class="v">'+(l.acres?usd(Math.round(ppa(l)/100)*100):"")+'</span><span class="k">per acre</span></div>';
  var house=l.sqft ? '<div class="house">'+esc(l.beds)+' bd · '+esc(l.baths)+' ba · '+Number(l.sqft).toLocaleString("en-US")+' sq ft · built '+esc(l.year)+'</div>' : '';
  var s=arr(l.s), meters="";
  if(s.length===4){
    meters='<div class="meters">'+METERS.map(function(m,i){
      var segs=""; for(var k=1;k<=5;k++) segs+='<i class="'+(k<=s[i]?'on':'')+'"></i>';
      return '<div class="meter"><span>'+m+'</span><span class="segs" role="img" aria-label="'+m+' '+Number(s[i])+' of 5">'+segs+'</span></div>';
    }).join("")+'</div>';
  }
  var note="";
  if(l.status==="pending") note='<div class="statusnote"><strong>Pending.</strong> '+esc(l.pendingNote||"Under contract.")+'</div>';
  if(l.status==="gone") note='<div class="statusnote gone"><strong>Off the board'+(okDate(l.goneDate)?' '+fmt(l.goneDate):'')+'.</strong> '+esc(l.goneNote||"")+'</div>';
  var drive=typeof l.drive==="number" ? '<div class="drive'+(l.drive>LIMIT?' far':'')+'"><div class="driveline"><span><span class="num">'+l.drive+' min</span> · '+esc(l.miles)+' mi from home</span>'
    +'<span class="hu">'+(l.drive>LIMIT?'Over '+LIMIT+' min':'Within '+LIMIT+' min')+'</span></div>'+ruler(l)+'</div>' : '';
  var lists=(arr(l.good).length||arr(l.watch).length) ? '<div class="lists"><ul class="good">'+arr(l.good).map(function(g){ return '<li>'+esc(g)+'</li>'; }).join("")+'</ul>'
      +'<ul class="watch">'+arr(l.watch).map(function(g){ return '<li>'+esc(g)+'</li>'; }).join("")+'</ul></div>' : '';
  var link=l.url ? '<a class="open" href="'+esc(safeUrl(l.url))+'" target="_blank" rel="noopener noreferrer">Open on '+esc(l.src||"the listing site")+'</a>' : '';
  return '<article class="card'+(sheet?' insheet':'')+'">'+hero+note
    +'<div><h3>'+esc(l.addr)+'</h3>'
    +'<div class="where">'+esc(l.place)+(l.county?' · '+esc(l.county)+' County':'')+'</div>'+drive
    +(l.driveNote?'<div class="drivenote">'+esc(l.driveNote)+'</div>':'')+'</div>'
    +'<div class="figs"><div><span class="v">'+usd(l.price)+'</span><span class="k">asking</span></div>'
    +'<div><span class="v">'+esc(l.acresNote||l.acres)+'</span><span class="k">acres</span></div>'+third+'</div>'
    +house
    +(l.take?'<p class="take">'+esc(l.take)+'</p>':'')
    +lists+meters+whereIs(l, sheet)
    +((l.listed||l.hist)?'<div class="hist">'+((l.listed && !/^Listed\b/.test(String(l.hist||"")))?'Listed '+esc(l.listed)+'. ':'')+esc(l.hist||"")+'</div>':'')
    +'<div class="foot">'+link
    +'<button class="btn ghost" type="button" data-noteabout="'+esc(l.id)+'">Ask Claude about this one</button>'
    +(l.mls?'<span class="mls">MLS '+esc(l.mls)+'</span>':'')+'</div>'
    +'</article>';
}
/* Status chips for a report: a dot coloured by kind, then "2 new". A quiet day gets one chip with the number checked. */
function reportChips(r){
  if(r.quiet) return '<span class="schip">'+(Number(r.checked)||0)+' checked</span>';
  var counts={};
  arr(r.items).forEach(function(it){ counts[it.kind]=(counts[it.kind]||0)+1; });
  return KORDER.filter(function(k){ return counts[k] && k!=="info" && k!=="rank"; }).map(function(k){
    return '<span class="schip '+k+'">'+counts[k]+' '+esc(KIND[k].toLowerCase())+'</span>'; }).join("");
}
function itemsHtml(r, max){
  var items=arr(r.items).slice().sort(function(a,b){
    var sa=(a.id && S.stars[a.id])?0:1, sb=(b.id && S.stars[b.id])?0:1;      /* his starred listings lead */
    return sa-sb || KORDER.indexOf(a.kind)-KORDER.indexOf(b.kind);
  });
  if(max) items=items.slice(0,max);
  return items.map(function(it){
    var k=KIND[it.kind] ? it.kind : "info", l=(it.id && S.L[it.id]) || null;
    var mine=(it.id && S.stars[it.id]) ? '<span class="pill mine">★ Starred</span> ' : '';
    var ttl=l ? '<button class="linkbtn" type="button" data-open="'+esc(it.id)+'">'+esc(it.title||l.addr)+'</button>' : esc(it.title||"");
    var th=(l && photoOf(l)) ? ph(l,"t44",true) : '';
    return '<li'+(th?' class="withph"':'')+'>'+th+'<span><span class="pill '+k+'">'+esc(KIND[k])+'</span> '+mine+'</span><span class="ttl">'+ttl+'</span><span>'+esc(it.text||"")+'</span></li>';
  }).join("");
}
function headline(r){ return r.headline || (r.quiet ? "No big updates." : ""); }
function mineList(){ return Object.keys(S.stars).map(function(id){ return S.L[id]; }).filter(Boolean).sort(byRank); }
function unseenReplies(){
  return S.notes.filter(function(n){ return S.replies[n.id] && !S.seenReplies[n.id]; }).length;
}
function greeting(){
  var h=louNow().hour, w=h<12 ? "morning" : (h<17 ? "afternoon" : "evening");
  var name=(S.home && S.home.app && typeof S.home.app.name==="string") ? S.home.app.name.trim() : "";
  return "Good "+w+(name ? ", "+name : "");
}
/* The listing whose photo leads the This morning card: the first report item (in KORDER) with a photo, else the top-ranked with one. */
function leadListing(r){
  var items=arr(r.items).slice().sort(function(a,b){ return KORDER.indexOf(a.kind)-KORDER.indexOf(b.kind); });
  for(var i=0;i<items.length;i++){ var l=items[i].id && S.L[items[i].id]; if(l && photoOf(l)) return l; }
  var top=active().sort(byRank).filter(photoOf);
  return top[0]||null;
}
/* Recent activity: what moved in the last week, newest first, at most eight. */
function recentList(){
  var c=checked(); if(!c) return [];
  var dates={};
  function mark(id, d){ if(!S.L[id] || !okDate(d)) return; if(!dates[id] || d>dates[id]) dates[id]=d; }
  everything().forEach(function(l){
    if(okDate(l.seen) && daysAgo(l.seen)<=7) mark(l.id, l.seen);
    if(okDate(l.chg) && daysAgo(l.chg)<=7) mark(l.id, l.chg);
    if(l.flag) mark(l.id, c);
  });
  S.reports.slice(0,3).forEach(function(r){ arr(r.items).forEach(function(it){ if(RECENTK[it.kind] && it.id) mark(String(it.id), r.date); }); });
  return Object.keys(dates).map(function(id){ return S.L[id]; }).sort(function(a,b){ return dates[b.id].localeCompare(dates[a.id]) || byRank(a,b); }).slice(0,8);
}
function recard(l){
  var f=flagOf(l), on=!!S.stars[l.id];
  return '<div class="recard">'
    +'<button class="rbody" type="button" data-open="'+esc(l.id)+'">'+ph(l,"wide",true, f?'<span class="pill '+f[0]+' rpill">'+esc(f[1])+'</span>':'')
    +'<span class="rtext"><span class="raddr">'+esc(l.addr)+'</span><span class="rplace">'+esc(l.place||"")+'</span>'
    +'<span class="rprice">'+usd(l.price)+'</span><span class="racres">'+esc(l.acresNote||l.acres)+' acres</span>'
    +(typeof l.drive==="number" ? '<span class="rdrive">'+glyph("car")+l.drive+' min</span>' : '')+'</span></button>'
    +'<button class="rstar" type="button" data-star="'+esc(l.id)+'" aria-pressed="'+on+'" aria-label="'+(on?'Remove '+esc(l.addr)+' from':'Add '+esc(l.addr)+' to')+' my contenders">'+starSvg(S.starPop===l.id)+'</button></div>';
}
/* folds: a button with aria-expanded and a .fold-body with data-open when open */
function setOpen(el, open){ if(open) el.setAttribute("data-open",""); else el.removeAttribute("data-open"); }
function applyHomeFold(){
  ["five","starred"].forEach(function(k){
    var open=S.homeFold===k;
    $("tile-"+k).setAttribute("aria-expanded", String(open));
    setOpen($("fold-"+k), open);
  });
}
/* set a number in a badge or tile and pop it when it changes */
function setNum(el, n){
  var t=String(n);
  if(el.textContent===t) return;
  var was=el.textContent!=="" && !el.hidden;
  el.textContent=t;
  if(was) replay(el, "pop");
}

/* ---------- views ---------- */
function scanNotice(){
  var c=checked(); if(!c) return "";
  var now=louNow(), behind=dnum(now.date)-dnum(c);
  if(behind<=0 || (behind===1 && now.hour<9)) return "";
  return '<div class="notice">'+(behind===1 ? "Today's scan has not landed yet. " : "No scan has landed since "+esc(fmt(c))+". ")
    +"This is the board from "+esc(fmtShort(c))+"."+(behind>1 ? " Tell Claude in the project chat." : "")+'</div>';
}
/* A report's day as the card names it: "Yesterday" when it is the day before today, else the day itself. */
function dayLabel(d, now){ return dnum(now.date)-dnum(d)===1 ? "Yesterday" : esc(fmtDay(d)); }
/* The report card on Home. Index 0 is the newest report ("This morning"); older ones are named by their day.
   Every card has the same parts (a summary line and a photo band even on a quiet day) so the stack keeps one height. */
function latestHtml(r, i){
  var now=louNow(), lead=leadListing(r), eb;
  if(i===0) eb = r.date===now.date ? "This morning" : "Latest report · "+dayLabel(r.date, now);
  else eb = dayLabel(r.date, now);
  return '<span class="eyebrow">'+eb+(r.n?' · no. '+esc(r.n):'')+'</span>'+G.chev
    +'<p class="headline">'+esc(headline(r))+'</p>'
    +(r.summary?'<p class="summary">'+esc(r.summary)+'</p>':'')
    +'<div class="schips">'+reportChips(r)+'</div>'
    +(lead ? ph(lead,"band",false) : '');
}
/* Every card is as tall as the tallest report card, measured off screen once per width and set of reports; the photo band
   takes the slack, so swiping never moves the dots and tiles under the card. */
var latestH={w:0, f:"", h:0, by:{}};   /* heights by card markup: a day's new card costs one layout, not one per report kept */
function hashStr(s){ var h=5381; for(var i=0;i<s.length;i++) h=((h<<5)+h+s.charCodeAt(i))|0; return h+":"+s.length; }
function latestHeight(){
  var box=$("latestbox"), latest=$("latest"), n=S.reports.length;
  if(!n){ box.style.removeProperty("--latest-h"); latestH.h=0; return; }
  var w=latest.clientWidth, f=(document.fonts && document.fonts.status)||"";
  if(latestH.w!==w || latestH.f!==f) latestH={w:w, f:f, h:0, by:{}};   /* a new width or newly loaded fonts change every height */
  var m=null, h=0;
  for(var k=0;k<n;k++){
    var html=latestHtml(S.reports[k], k).replace(/ data-sha="[^"]*"/g,""), key=hashStr(html);
    if(!hasOwn(latestH.by, key)){
      if(!m){ m=document.createElement("article"); m.className="latest measure"; m.setAttribute("aria-hidden","true"); box.appendChild(m); }
      m.innerHTML=html; latestH.by[key]=m.offsetHeight;
    }
    if(latestH.by[key]>h) h=latestH.by[key];
  }
  if(m) box.removeChild(m);
  latestH.h=h;
  box.style.setProperty("--latest-h", h+"px");
}
/* The card for S.homeRep, the stack hint when an older report exists, and one dot per report (a window of seven at most). */
function renderLatest(){
  var latest=$("latest"), n=S.reports.length;
  if(S.homeRep>=n) S.homeRep=Math.max(0, n-1);
  var i=S.homeRep, r=S.reports[i];
  latestHeight();
  if(r){
    latest.setAttribute("data-rep", r.date);
    latest.setAttribute("aria-label", "Open the report: "+headline(r));
    latest.innerHTML=latestHtml(r, i);
  }else{ latest.removeAttribute("data-rep"); latest.innerHTML='<p class="muted">No reports filed yet.</p>'; }
  $("latestbox").classList.toggle("stack", i<n-1);
  var dots="", shown=Math.min(n,7), start=Math.max(0, Math.min(i-3, n-shown));
  for(var k=0;k<shown;k++) dots+='<i'+(start+k===i?' class="on"':'')+'></i>';
  $("repdots").innerHTML = n>1 ? dots : "";
  $("allreports").hidden=!n;
}
function renderToday(){
  var a=active().sort(byRank), why=(S.home && S.home.why)||{}, r=S.reports[0];
  $("todaynotice").innerHTML=scanNotice();
  renderHomeMap();
  renderLatest();
  $("replystrip").hidden=!unseenReplies();

  var mine=mineList();
  var near=a.filter(function(l){ return l.drive<=LIMIT; }).length;
  var inRange=S.budget ? a.filter(function(l){ return l.price>=S.budget[0] && l.price<=S.budget[1]; }).length : 0;
  var changed={};
  if(r && r.date===checked()) arr(r.items).forEach(function(it){ if(it.id && S.stars[it.id] && S.L[it.id]) changed[it.id]=1; });
  var nchg=Object.keys(changed).length;
  setNum($("tile-starred-n"), mine.length);
  $("tile-starred-sub").textContent = !mine.length ? "Tap ☆ to add one" : (nchg ? nchg+" changed today" : "Your contenders");
  setNum($("tile-board-n"), a.length);
  $("tile-board-sub").textContent = near+" within "+LIMIT+" min"+(S.budget ? " · "+inRange+" at "+usdK(S.budget[0])+" to "+usdK(S.budget[1]) : "");

  $("five").innerHTML=a.slice(0,5).map(function(l){ return row(l, "rank", why[l.id]||l.take||"", true); }).join("")
    || '<li class="empty">No ranked listings yet.</li>';
  $("minehome").innerHTML=mine.length ? mine.slice(0,6).map(function(l){
      return '<li><button class="minirow" type="button" data-open="'+esc(l.id)+'"><span class="mstar" aria-hidden="true">'+starSvg(false)+'</span>'
        +'<span class="mttl">'+esc(l.addr)+' '+pillFor(l)+'</span>'
        +'<span class="mnum">'+usd(l.price)+(typeof l.drive==="number"?' · '+l.drive+' min':'')+'</span></button></li>';
    }).join("")
    +'<li class="more">'+(mine.length>6?'<span>And '+(mine.length-6)+' more</span>':'<span></span>')+'<button class="linkbtn small" type="button" data-view="starred">Open the folder</button></li>'
    : '<li class="none">Nothing starred yet. Tap ☆ on any listing.</li>';
  applyHomeFold();

  var rec=recentList();
  $("recent").hidden=!rec.length;
  $("rail").innerHTML=rec.map(recard).join("");

  var read=arr(S.home && S.home.read), bullet=function(x){ return '<li><strong>'+esc(x.b)+'</strong> '+esc(x.t)+'</li>'; };
  $("read").innerHTML=read.slice(0,1).map(bullet).join("");
  $("readrest").innerHTML=read.slice(1).map(bullet).join("");
  var more=$("readmore");
  more.hidden=read.length<2;
  more.textContent=S.readOpen ? "Show less" : "Read all "+read.length;
  more.setAttribute("aria-expanded", String(S.readOpen && read.length>1));
  setOpen($("fold-read"), S.readOpen && read.length>1);

  var sched=(S.home && typeof S.home.schedule==="string") ? S.home.schedule : "";
  var when=/\d{1,2}(:\d{2})?\s*[AaPp][Mm]/.exec(sched);
  $("footline").textContent="The brief · Coverage"+(sched ? " · Next scan "+(when?when[0]:sched) : "");

  /* seeing Home counts as reading the latest report */
  if(r && r.date!==S.seenReport && document.visibilityState!=="hidden"){
    S.seenReport=r.date; lsSet("ee.seenReport", r.date);
    try{ if(navigator.clearAppBadge) navigator.clearAppBadge().catch(function(){}); }catch(e){}
  }
}
function renderBoard(){
  var f=S.f;
  var rows=active().filter(function(l){
    if(f.type!=="All" && l.type!==f.type) return false;
    if(f.area!=="All" && l.area!==f.area) return false;
    if(f.maxp && l.price>f.maxp) return false;
    if(f.near && !(l.drive<=LIMIT)) return false;
    return true;
  });
  rows.sort(function(a,b){
    if(f.sort==="price") return a.price-b.price || byRank(a,b);
    if(f.sort==="acres") return b.acres-a.acres || byRank(a,b);
    if(f.sort==="ppa") return ppa(a)-ppa(b) || byRank(a,b);
    if(f.sort==="drive") return a.drive-b.drive || byRank(a,b);
    if(f.sort==="newest") return String(b.seen||"").localeCompare(String(a.seen||"")) || byRank(a,b);
    return byRank(a,b);
  });
  $("boardlist").innerHTML=rows.length ? rows.map(function(l){
    return row(l, "rank", (l.place||"")+" · "+(l.type||""));
  }).join("") : '<li class="empty">No listings match these filters.</li>';
  $("count").textContent=rows.length+" of "+active().length+" listings";
  var all=everything();
  var pend=all.filter(function(l){ return l.status==="pending" && !laneOf(l); }).sort(function(a,b){ return b.price-a.price; });
  var gone=all.filter(function(l){ return l.status==="gone"; }).sort(function(a,b){ return String(b.goneDate).localeCompare(String(a.goneDate)); });
  $("pendinglist").innerHTML=pend.map(function(l){ return row(l, "hollow", l.pendingNote||"Under contract.", true); }).join("") || '<li class="empty">Nothing pending.</li>';
  $("gonelist").innerHTML=gone.map(function(l){ return row(l, "", (okDate(l.goneDate)?fmtShort(l.goneDate)+". ":"")+(l.goneNote||""), true); }).join("") || '<li class="empty">Nothing yet.</li>';
  $("pendcount").textContent="("+pend.length+")";
  $("gonecount").textContent="("+gone.length+")";
  $("skipcount").textContent="("+S.skipped.length+")";
  $("skiplist").innerHTML=S.skipped.map(function(s){
    return '<li><span class="ttl">'+esc(s.listing)+'</span><span class="num muted">'+esc(s.price)+'</span><span>'+esc(s.reason)+'</span></li>';
  }).join("") || '<li class="muted small">Nothing skipped yet.</li>';
  /* each lane gets its own section: active first, then pending, biggest land first; the filters above do not touch it */
  var lanes={};
  all.forEach(function(l){ var k=laneOf(l); if(k && l.status!=="gone"){ (lanes[k]=lanes[k]||[]).push(l); } });
  var lkeys=Object.keys(lanes).sort();
  $("lanes").hidden=!lkeys.length;
  $("lanes").innerHTML=lkeys.map(function(k){
    var c=S.lanes[k]||{}, items=lanes[k].sort(function(a,b){ return (a.status==="pending"?1:0)-(b.status==="pending"?1:0) || (b.acres||0)-(a.acres||0); });
    return '<section class="lane" data-lane="'+esc(k)+'"><h3>'+esc(laneLabel(k))+' <span class="cnt">('+items.length+')</span></h3>'
      +(typeof c.note==="string" ? '<p class="small muted lanenote">'+esc(c.note)+'</p>' : '')
      +'<ol class="picks">'+items.map(function(l){ return row(l, l.status==="pending"?"hollow":"", l.status==="pending" ? (l.pendingNote||"Under contract.") : (l.place||"")+" · "+(l.type||""), true); }).join("")+'</ol></section>';
  }).join("");
  ["pending","gone","skip"].forEach(function(k){
    $("bf-"+k).setAttribute("aria-expanded", String(!!S.folds[k]));
    setOpen($("fold-"+k), !!S.folds[k]);
  });
}
function renderStarred(){
  var mine=mineList();
  if(!mine.length){
    $("minebody").innerHTML='<div class="empty">Your folder is empty. Tap the ☆ on any listing to put it here. I check starred listings first every morning and lead the report with any change.</div>';
    return;
  }
  var rows=mine.map(function(l){
    return '<tr><td>'+(photoOf(l)?ph(l,"",true):'')+'<button class="linkbtn" type="button" data-open="'+esc(l.id)+'">'+esc(l.addr)+'</button>'+(flagOf(l)?' '+pillFor(l):'')+'</td>'
      +'<td class="num">'+usd(l.price)+'</td><td class="num">'+esc(l.acres)+'</td>'
      +'<td class="num">'+(typeof l.drive==="number"?l.drive+' min':'')+'</td></tr>';
  }).join("");
  $("minebody").innerHTML='<div class="view">'
    +'<p class="lede">Everything you starred. I check these first every morning and tell you the day one changes.</p>'
    +(mine.length>1 ? '<div class="panel"><h3>Side by side</h3><table class="cmp"><thead><tr><th>Address</th><th>Asking</th><th>Acres</th><th>Drive</th></tr></thead><tbody>'+rows+'</tbody></table></div>' : '')
    +'<div class="grid">'+mine.map(function(l){ return card(l, false); }).join("")+'</div></div>';
}
var repShown=null;
function renderReports(){
  var detail = S.rep && S.reports.filter(function(x){ return x.date===S.rep; })[0];
  var showing=detail ? "detail" : "list";
  $("replistwrap").hidden=!!detail; $("repdetailwrap").hidden=!detail;
  if(repShown && repShown!==showing && !RM){
    var w=$(detail ? "repdetailwrap" : "replistwrap");
    w.classList.remove("enter-x","enter-back"); w.classList.add(detail ? "enter-x" : "enter-back");
  }
  repShown=showing;
  if(detail){
    var r=detail;
    $("repdetail").innerHTML='<span class="eyebrow">Report'+(r.n?' no. '+esc(r.n):'')+' · '+esc(fmt(r.date))+(r.checked?' · '+esc(r.checked)+' checked':'')+'</span>'
      +'<h2>'+esc(headline(r))+'</h2>'
      +(r.summary?'<p class="summary">'+esc(r.summary)+'</p>':'')
      +(arr(r.items).length?'<ul class="items">'+itemsHtml(r)+'</ul>':'<p class="muted small">Nothing new, no price changes and no status changes that day.</p>');
    return;
  }
  $("replist").innerHTML=S.reports.map(function(r, i){
    var unseen=(i===0 && r.date!==S.seenReport);
    return '<li><button class="repbtn'+(r.quiet?' quiet':'')+(unseen?' unseen':'')+'" type="button" data-rep="'+esc(r.date)+'">'
      +'<span class="d">'+esc(fmtDay(r.date))+'<small>'+(r.n?'no. '+esc(r.n):'')+'</small></span>'
      +'<span class="h">'+esc(headline(r))+'</span>'
      +'<span class="c">'+reportChips(r)+'</span></button></li>';
  }).join("") || '<li class="empty">No reports filed yet.</li>';
}
function renderAsk(){
  $("notes").innerHTML=S.notes.map(function(n){
    var rep=S.replies[n.id], done=!!(rep && rep.reply), day=String(n.at||"").slice(0,10);
    var about=(n.about && S.L[n.about]) ? '<button class="linkbtn small" type="button" data-open="'+esc(n.about)+'">'+esc(S.L[n.about].addr)+'</button>' : '';
    var waiting=S.queue.some(function(o){ return o.f==="notes" && o.op==="add" && o.note.id===n.id; });
    var sure=S.confirm==="note:"+n.id;
    return '<li><div class="meta"><span>'+esc(fmt(day))+'</span>'
      +'<span class="pill '+(done?'new':'pending')+'">'+(done?'Answered':(waiting?'Saving':'Waiting for the next scan'))+'</span></div>'
      +about+'<div class="body">'+esc(n.text)+'</div>'
      +(done?'<div class="reply"><b>Claude'+(okDate(rep.at)?' · '+esc(fmtShort(rep.at)):'')+'</b>'+esc(rep.reply)+'</div>':'')
      +'<div><button class="linkbtn small muted" type="button" data-delnote="'+esc(n.id)+'">'+(sure?'Tap again to remove':'Remove')+'</button></div></li>';
  }).join("") || '<li class="none">No notes yet.</li>';
  var chat=S.home && S.home.links && S.home.links.chat;
  if(typeof chat==="string" && /^https:\/\/claude\.ai\//.test(chat)){ $("chatlink").href=chat; $("chatlink").textContent="Open the project chat"; }
  /* opening Ask counts as reading the answers */
  var changed=false;
  S.notes.forEach(function(n){ if(S.replies[n.id] && !S.seenReplies[n.id]){ S.seenReplies[n.id]=1; changed=true; } });
  if(changed) lsSet("ee.seenReplies", JSON.stringify(S.seenReplies));
}
function renderBrief(){
  $("briefdl").innerHTML=arr(S.home && S.home.brief).map(function(x){ return '<div><dt>'+esc(x.k)+'</dt><dd>'+esc(x.v)+'</dd></div>'; }).join("")
    +(S.home && S.home.schedule ? '<div><dt>Next scan</dt><dd>'+esc(S.home.schedule)+'</dd></div>' : '');
  $("coverage").textContent=(S.home && S.home.coverage)||"";
}
function renderSettings(){
  $("set-conn").textContent="Connected to "+S.owner+" / "+(CFG.notebook||"east-end-notebook")+"."
    +(S.lastSync?" Last read "+clock(S.lastSync)+".":"");
  var q=S.queue.length;
  $("set-saves").textContent = q ? (q+(q===1?" change is":" changes are")+" waiting to save.") : "Everything is saved.";
  var st=$("set-pushstate"), btn=$("set-pushbtn"), quiet=$("set-quietrow");
  btn.hidden=true; quiet.hidden=true;
  $("set-install").hidden=!(isIOS() && !isStandalone());
  if(!CFG.vapidPublicKey){ st.textContent="Not set up yet. Claude is wiring this part next."; }
  else if(!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)){
    st.textContent = (isIOS() && !isStandalone()) ? "Open East End from your home screen to turn these on. Safari tabs cannot receive them."
      : "This browser cannot receive notifications.";
  }
  else if(Notification.permission==="denied"){ st.textContent="Notifications are blocked for this app in your phone's settings. Allow them there, then come back."; }
  else if(S.pushState==="on"){
    st.textContent="On for this "+deviceLabel()+". A tap on a notification opens this app.";
    btn.hidden=false; btn.textContent="Turn off on this "+deviceLabel(); btn.className="btn ghost";
    quiet.hidden=false; $("set-quiet").checked = S.prefs.quietPush!==false;
  }
  else { st.textContent="Get the morning report on this "+deviceLabel()+". A tap opens this app, not Claude."; btn.hidden=false; btn.textContent="Turn on notifications"; btn.className="btn"; }
  $("set-media").textContent=S.mediaText || "Checking saved images…";
  mediaCount();
  $("set-forget").textContent = S.confirm==="forget" ? "Tap again to forget it" : "Forget the access code";
  $("set-version").textContent="East End "+(CFG.version||"")+(S.built?" · board built "+fmtShort(String(S.built).slice(0,10))+" "+clock(S.built):"");
}

var VIEWS={today:renderToday, map:renderMap, board:renderBoard, starred:renderStarred, reports:renderReports, ask:renderAsk};

/* header, banner, tab bar: cheap, and safe to call any time */
function showDot(el, on){ el.hidden=!on; }
function syncChips(){
  Array.prototype.forEach.call(document.querySelectorAll(".chip-btn[data-type]"), function(x){ x.setAttribute("aria-pressed", String(x.getAttribute("data-type")===S.f.type)); });
  Array.prototype.forEach.call(document.querySelectorAll("#nearOnly,[data-near]"), function(x){ x.setAttribute("aria-pressed", String(S.f.near)); });
  $("chip-top").setAttribute("aria-pressed", String(S.mf.top));
  $("chip-starred").setAttribute("aria-pressed", String(S.mf.starred));
  Array.prototype.forEach.call(document.querySelectorAll("#mapzoom [data-level]"), function(x){ x.setAttribute("aria-pressed", String(x.getAttribute("data-level")===S.mapLevel)); });
  $("mapzoom").setAttribute("data-level", S.mapLevel);
}
function chrome(){
  if($("shell").hidden) return;
  var now=louNow(), c=checked(), eb=fmtDay(now.date);
  if(c){
    if(c===now.date) eb+=" · Scanned "+((S.home && S.home.checkedAt && clock(S.home.checkedAt, TZ))||"today");
    else eb+=" · Last scan "+fmtShort(c);
  }
  $("eyebrow").textContent=eb;
  var home=S.view==="today";
  $("title").textContent = home ? greeting() : (TITLES[S.view]||"");
  $("title").classList.toggle("greet", home);
  var tag=(S.loaded && S.home && S.home.app && typeof S.home.app.tagline==="string") ? S.home.app.tagline.trim() : "";
  $("tagline").hidden=!(home && tag); $("tagline").textContent=tag;
  $("refresh").classList.toggle("busy", S.syncing);
  var b=$("banner"), msg="", ok=false, retry=false;
  if(S.syncErr==="offline" && S.loaded) msg="Offline. Showing the board saved on this phone"+(lsGet("ee.lastSync")?" at "+clock(Number(lsGet("ee.lastSync"))):"")+".";
  else if(S.syncErr==="missing") msg="The notebook is connected, but it has no board in it yet.";
  else if(S.syncErr==="denied") msg="GitHub would not let this code read the notebook. It needs Contents access to "+(CFG.notebook||"east-end-notebook")+".";
  else if(S.syncErr==="error") { msg="The notebook did not answer. "; retry=true; }
  else if(S.saveErr==="denied") msg="This access code can read but not save. Create one with Contents set to Read and write. Your changes are kept on this phone.";
  else if(S.saveErr){ msg=S.queue.length+(S.queue.length===1?" change is":" changes are")+" waiting to save. "; retry=true; }
  b.hidden=!msg; b.className="notice"+(ok?" ok":"");
  b.innerHTML=esc(msg)+(retry?'<button type="button" data-retry="1">Try again</button>':'');
  var tab = S.view==="reports" ? "today" : S.view;
  Array.prototype.forEach.call(document.querySelectorAll(".tabbar button"), function(t){
    if(t.getAttribute("data-view")===tab) t.setAttribute("aria-current","page"); else t.removeAttribute("aria-current");
  });
  var nstar=Object.keys(S.stars).filter(function(id){ return S.L[id]; }).length;
  setNum($("cnt-starred"), nstar); showDot($("cnt-starred"), nstar>0);
  var latest=S.reports[0];
  showDot($("dot-today"), !!(latest && latest.date!==S.seenReport && S.view!=="today"));
  showDot($("dot-ask"), !!(unseenReplies() && S.view!=="ask"));
  syncChips();
}
/* the map pane's height is the screen minus the header, the chip row and the tab bar */
function setHeights(){
  var top=document.querySelector(".top"), ch=$("mapchips"), st=document.documentElement.style;
  if(top) st.setProperty("--headh", (top.offsetHeight+18)+"px");
  st.setProperty("--chiph", ((ch && !ch.hidden ? ch.offsetHeight : 0)+20)+"px");
}
/* views fade out over 120 ms and in over 220 ms; a sheet slides down and is hidden once the move ends */
var shownView=null;
function leaveView(el){
  el.classList.add("leave");
  el.leaveTimer=setTimeout(function(){ el.leaveTimer=0; el.classList.remove("leave"); el.hidden=true; }, 140);
}
function showSheets(ov){
  Object.keys(SHEETS).forEach(function(type){
    var el=$(SHEETS[type]), want=!!(ov && ov.type===type);
    if(want){
      if(el.leaveTimer){ clearTimeout(el.leaveTimer); el.leaveTimer=0; }
      el.classList.remove("leaving");
      if(el.hidden){ el.hidden=false; el.querySelector(".inner").scrollTop=0; }
    }else if(!el.hidden && !el.classList.contains("leaving")) leaveSheet(el);
  });
}
function leaveSheet(el){
  var inner=el.querySelector(".inner");
  function done(){
    if(!el.classList.contains("leaving")) return;
    el.classList.remove("leaving"); el.hidden=true;
    inner.style.transform=""; inner.style.transition=""; inner.style.willChange=""; el.style.removeProperty("--scrim-o");
    if(el.leaveTimer){ clearTimeout(el.leaveTimer); el.leaveTimer=0; }
    inner.removeEventListener("transitionend", done);
    S.overlayLeaving=!!document.querySelector(".sheet.leaving");
  }
  el.classList.add("leaving"); S.overlayLeaving=true;
  inner.addEventListener("transitionend", done);
  el.leaveTimer=setTimeout(done, RM?30:300);
}
function hideSheetsNow(){
  Object.keys(SHEETS).forEach(function(k){
    var el=$(SHEETS[k]); el.hidden=true; el.classList.remove("leaving");
    if(el.leaveTimer){ clearTimeout(el.leaveTimer); el.leaveTimer=0; }
  });
  S.overlayLeaving=false;
}
var raf=0;
function paint(){
  raf=0;
  if($("shell").hidden) return;
  var ld=$("loading"); ld.hidden=S.loaded;
  if(!S.loaded){
    var msg = S.syncing ? "" : (S.syncErr==="offline" ? "No connection. Open the app once while online and it keeps a copy for next time." : "Nothing to show yet.");
    $("loadmsg").hidden=!msg; $("loadmsg").textContent=msg;
    Array.prototype.forEach.call(ld.querySelectorAll(".skel"), function(s){ s.hidden=!!msg; });
  }
  Object.keys(VIEWS).forEach(function(v){
    var el=$("v-"+v), want=S.loaded && v===S.view;
    if(want){
      if(el.leaveTimer){ clearTimeout(el.leaveTimer); el.leaveTimer=0; el.classList.remove("leave"); }
      if(el.hidden){ el.hidden=false; if(!RM && shownView && shownView!==v) el.classList.add("enter"); if(v==="today") $("latest").classList.remove("rise"); }
    }else if(!el.hidden){
      if(!RM && S.loaded && shownView===v && !el.leaveTimer) leaveView(el); else { el.classList.remove("leave"); el.hidden=true; }
    }
  });
  shownView = S.loaded ? S.view : null;
  chrome();
  if(S.loaded) VIEWS[S.view]();
  if(S.view!=="map" || !S.loaded) hidePeek(true);
  var ov=S.overlay;
  showSheets(ov);
  document.documentElement.classList.toggle("locked", !!ov);
  if(ov && ov.type==="listing"){
    var l=S.L[ov.id];
    $("sheetbody").innerHTML = l ? card(l, true) : '<div class="empty">This listing is not on the board any more.</div>';
  }
  if(ov && ov.type==="settings") renderSettings();
  if(ov && ov.type==="brief") renderBrief();
  S.starPop=null;
  hydrateImages();
}
function render(){ if(!raf) raf=requestAnimationFrame(paint); }

/* ---------- getting around ---------- */
function parseHash(){
  var h=(location.hash||"").replace(/^#/,""), m;
  if((m=/^l-([A-Za-z0-9_-]{1,80})$/.exec(h))) return {overlay:{type:"listing", id:m[1]}};
  if(h==="settings") return {overlay:{type:"settings"}};
  if(h==="brief") return {overlay:{type:"brief"}};
  if((m=/^m-([A-Za-z0-9_-]{1,80})$/.exec(h))) return {view:"map", rep:null, mapSel:m[1]};
  if((m=/^r-(\d{4}-\d{2}-\d{2})$/.exec(h))) return {view:"reports", rep:m[1]};
  if(h==="home") return {view:"today", rep:null};
  if(hasOwn(VIEWS, h)) return {view:h, rep:null};
  return {view:"today", rep:null};
}
function applyHash(){
  var p=parseHash();
  if(p.overlay){ S.overlay=p.overlay; }
  else{
    S.overlay=null; S.overlayPushed=false; S.confirm=null;
    if(p.view!==S.view || p.rep!==S.rep) window.scrollTo(0,0);
    S.view=p.view; S.rep=p.rep;
    if(p.mapSel){ S.mapSel=p.mapSel; S.mapPick=null; S.mapLevel="close"; S.mapWant={id:p.mapSel}; }
    if(!p.rep) S.repPushed=false;
  }
  render();
}
function baseHash(){ return "#"+(S.view==="reports" && S.rep ? "r-"+S.rep : S.view); }
function replaceTo(hash){
  try{ history.replaceState(null,"",hash); }catch(e){ location.hash=hash; return; }
  applyHash();
}
function go(view){ if(hasOwn(VIEWS, view)) replaceTo("#"+view); window.scrollTo(0,0); }
function openReport(date){
  if(!okDate(date)) return;
  if(S.overlay){ S.view="reports"; S.rep=date; S.repPushed=false; replaceTo("#r-"+date); return; }
  S.repPushed=true; S.repFrom=S.view; location.hash="r-"+date;
}
function backToReports(){
  if(S.repPushed && S.repFrom==="reports"){ S.repPushed=false; history.back(); }
  else { S.repPushed=false; replaceTo("#reports"); }
}
function openOverlay(hash){ S.overlayPushed=true; location.hash=hash; }
function closeOverlay(){
  if(S.overlayPushed){ S.overlayPushed=false; history.back(); }
  else replaceTo(baseHash());
}

/* ---------- lock screen ---------- */
function codeLink(){
  return "https://github.com/settings/personal-access-tokens/new"
    +"?name="+encodeURIComponent("East End app")
    +"&description="+encodeURIComponent("Lets the East End app on my phone read and save my house hunt notebook.")
    +"&expires_in=366&contents=write";
}
var lockTimer=0;
function lock(message, wipe){
  S.token=null; lsDel("ee.token");
  if(wipe){
    /* GitHub refused the code, so nothing private stays on a phone that can no longer read the notebook. Queued changes are kept. */
    ["ee.bundle","ee.bundleEtag","ee.me","ee.lastSync","ee.seenReport","ee.seenReplies"].forEach(lsDel);
    try{ if("caches" in window) caches.delete(IMGCACHE).catch(function(){}); }catch(e){}
    revokeAll(); S.mediaText=null; S.mapKey=null;
    S.loaded=false; S.fromCache=false; S.L={}; S.reports=[]; S.home=null; S.map=null; S.srv={stars:{}, notes:[], prefs:{}};
  }
  clearTimeout(lockTimer);
  $("shell").hidden=true; $("shell").classList.remove("enter"); hideSheetsNow();
  document.documentElement.classList.remove("locked");
  var lk=$("lock"); lk.classList.remove("out"); lk.hidden=false;
  $("lock-make").href=codeLink();
  $("lock-repo").textContent=CFG.notebook||"east-end-notebook";
  $("lock-userfield").hidden=!!ownerFromAddress();
  if(!ownerFromAddress()) $("lock-user").value=lsGet("ee.owner")||"";
  var needInstall=isIOS() && !isStandalone() && lsGet("ee.browserok")!=="1";
  $("lock-install").hidden=!needInstall;
  $("lock-form").hidden=needInstall;
  var m=$("lock-msg"); m.hidden=!message; m.textContent=message||"";
  $("lock-code").value="";
}
function ownerFromAddress(){
  if(CFG.owner) return CFG.owner;
  var m=/^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
  return m ? m[1] : "";
}
function unlock(){
  var code=$("lock-code").value.trim(), m=$("lock-msg"), btn=$("lock-go");
  var own=ownerFromAddress() || $("lock-user").value.trim();
  function say(t){ m.hidden=false; m.textContent=t; }
  if(!own){ say("Enter your GitHub username."); return; }
  if(!code){ say("Paste your access code first."); return; }
  if(/\s/.test(code)){ say("That does not look like a full code. Copy it again from GitHub, with no spaces."); return; }
  S.owner=own; S.token=code;
  btn.disabled=true; btn.textContent="Checking…"; m.hidden=true;
  gh("GET","").then(function(r){
    learnOwnerId(r);
    lsSet("ee.token", code);
    if(!ownerFromAddress()) lsSet("ee.owner", own);
    $("lock-code").value="";
    showShell(true); applyHash();
    return sync();
  }, function(e){
    S.token=null;
    if(e.offline) say("No connection. Try again when you are online.");
    else if(e.status===401) say("GitHub did not accept that code. Check that you copied all of it.");
    else if(e.status===404) say("That code works, but it cannot see the notebook. When you create it, choose Only select repositories and pick "+(CFG.notebook||"east-end-notebook")+".");
    else if(e.status===403) say("GitHub refused that code for the notebook. Create a new one with the link below.");
    else say("GitHub did not answer ("+e.status+"). Try again in a minute.");
  }).then(function(){ btn.disabled=false; btn.textContent="Unlock"; });
}
/* the shell appears at once; with `fade` the lock screen fades out over it and the shell fades in */
function showShell(fade){
  var lk=$("lock"), sh=$("shell");
  sh.hidden=false;
  if(fade && !RM){
    sh.classList.add("enter"); lk.classList.add("out");
    clearTimeout(lockTimer);
    lockTimer=setTimeout(function(){ if(lk.classList.contains("out")){ lk.hidden=true; lk.classList.remove("out"); } }, 170);
  }else{ lk.hidden=true; lk.classList.remove("out"); }
}
function forget(){
  dropPush(S.token, lsGet("ee.push"));
  S.queue=[]; S.srv={stars:{}, notes:[], prefs:{}}; S.pushState="off";
  ["ee.token","ee.bundle","ee.bundleEtag","ee.me","ee.queue","ee.lastSync","ee.seenReport","ee.seenReplies","ee.homeFold","ee.push","ee.ownerId"].forEach(lsDel);
  try{ if("caches" in window) caches.delete(IMGCACHE).catch(function(){}); }catch(e){}
  revokeAll(); S.mediaText=null; S.pinsPlayed=null; S.mapKey=null; S.mapSel=null; S.mapPick=null; S.mapWant=null; S.mapClusters=[];
  S.loaded=false; S.L={}; S.reports=[]; S.home=null; S.map=null; S.overlay=null; S.overlayPushed=false; S.homeFold="";
  try{ history.replaceState(null,"","#today"); }catch(e){}
  lock("The access code is gone from this phone.");
}

/* ---------- notifications ---------- */
function pushReady(){ return !!CFG.vapidPublicKey && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
function subscribeNew(reg){ return reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:b64urlBytes(CFG.vapidPublicKey)}); }
/* False only when the subscription was made with a different notification key than the app carries now (the key was replaced). */
function keyMatches(sub){
  try{
    var k=sub && sub.options && sub.options.applicationServerKey;
    if(!k || !(k instanceof ArrayBuffer || ArrayBuffer.isView(k))) return true;
    var a=new Uint8Array(k), b=b64urlBytes(CFG.vapidPublicKey);
    if(a.length!==b.length) return false;
    for(var i=0;i<a.length;i++) if(a[i]!==b[i]) return false;
    return true;
  }catch(e){ return true; }
}
/* Notifications end with the code: the phone unsubscribes, then the notebook forgets this phone, using the code one last time. Best effort, never waited on. */
function dropPush(tok, ep){
  var done=function(){ if(tok && ep) return removeSub(tok, ep); };
  try{
    if(!pushReady()) return Promise.resolve().then(done).catch(function(){});
    return navigator.serviceWorker.ready.then(function(reg){ return reg.pushManager.getSubscription(); })
      .then(function(sub){ if(sub){ ep=ep||sub.endpoint; return sub.unsubscribe(); } }).catch(function(){})
      .then(done).catch(function(){});
  }catch(e){ return Promise.resolve(); }
}
function removeSub(tok, ep){
  return gh("GET", contents(FILES.push)+"?ref="+encodeURIComponent(BRANCH), {token:tok}).then(function(r){
    var data=JSON.parse(b64decode(r.content)), subs=arr(data && data.subs).filter(function(s){ return s && typeof s.endpoint==="string"; });
    var left=subs.filter(function(s){ return s.endpoint!==ep; });
    if(left.length===subs.length) return;
    return writeFile(FILES.push, {v:1, subs:left}, r.sha, "Notifications off: a phone forgot its code", tok);
  });
}
function checkPush(){
  if(!pushReady()){ S.pushState="off"; return; }
  navigator.serviceWorker.ready.then(function(reg){
    return reg.pushManager.getSubscription().then(function(sub){
      if(!(sub && !keyMatches(sub) && Notification.permission==="granted")) return sub;
      /* the notification key was replaced: subscribe again with the new one, so the morning message keeps arriving */
      var ep=sub.endpoint;
      return sub.unsubscribe().then(function(){ enqueue({f:"push", op:"del", endpoint:ep}); lsDel("ee.push"); return subscribeNew(reg); });
    });
  }).then(function(sub){
    S.pushState = (sub && Notification.permission==="granted") ? "on" : "off";
    if(sub && S.pushState==="on" && lsGet("ee.push")!==sub.endpoint) recordSub(sub);   /* the phone rotated its address */
    render();
  }).catch(function(){ S.pushState="off"; });
}
function recordSub(sub){
  var j=sub.toJSON();
  if(!j || !j.endpoint || !j.keys) return;
  enqueue({f:"push", op:"set", sub:{endpoint:j.endpoint, keys:{p256dh:j.keys.p256dh, auth:j.keys.auth}, at:new Date().toISOString(), device:deviceLabel()}});
  lsSet("ee.push", j.endpoint);
}
function pushOn(){
  if(!pushReady()) return;
  Promise.resolve(Notification.requestPermission()).then(function(perm){
    if(perm!=="granted"){ render(); return; }
    return navigator.serviceWorker.ready.then(function(reg){
      return reg.pushManager.getSubscription().then(function(sub){
        if(sub && keyMatches(sub)) return sub;
        if(!sub) return subscribeNew(reg);
        var ep=sub.endpoint;   /* made with a replaced key: the notebook forgets the old address too */
        return sub.unsubscribe().then(function(){ enqueue({f:"push", op:"del", endpoint:ep}); lsDel("ee.push"); return subscribeNew(reg); });
      });
    }).then(function(sub){ recordSub(sub); S.pushState="on"; toast("Notifications are on for this "+deviceLabel()+"."); render(); });
  }).catch(function(){ toast("Could not turn notifications on. Try again in a moment."); });
}
function pushOff(){
  if(!pushReady()) return;
  navigator.serviceWorker.ready.then(function(reg){ return reg.pushManager.getSubscription(); }).then(function(sub){
    if(!sub) return;
    var ep=sub.endpoint;
    return sub.unsubscribe().then(function(){ enqueue({f:"push", op:"del", endpoint:ep}); });
  }).catch(function(){}).then(function(){ lsDel("ee.push"); S.pushState="off"; render(); });
}

/* ---------- events ---------- */
document.addEventListener("click", function(e){
  var t=e.target, before=S.confirm;
  if(!t || !t.closest) return;
  onClick(t, e);
  /* a "tap again to confirm" button goes back to normal as soon as you tap anything else */
  if(before && S.confirm===before && !t.closest("[data-delnote],#set-forget")){ S.confirm=null; render(); }
});
function onClick(t, e){
  var el;
  if((el=t.closest("[data-star]"))){ toggleStar(el.getAttribute("data-star")); return; }
  if((el=t.closest("[data-noteabout]"))){
    var l=S.L[el.getAttribute("data-noteabout")];
    replaceTo("#ask"); window.scrollTo(0,0);
    if(l){ var n=$("note"); n.value="About "+l.addr+": "; n.setAttribute("data-about", l.id); setTimeout(function(){ try{ n.focus(); n.setSelectionRange(n.value.length,n.value.length); }catch(err){} }, 60); }
    return;
  }
  if((el=t.closest("[data-pin]"))){
    var pid=el.getAttribute("data-pin");
    if(el.closest("#homemap")){ openOverlay("l-"+pid); return; }
    if(S.mapSel===pid){ openOverlay("l-"+pid); return; }          /* a second tap on the selected pin opens the sheet */
    S.mapSel=pid; S.mapPick=null; render(); return;
  }
  if((el=t.closest("[data-cluster]"))){
    var ci=Number(el.getAttribute("data-cluster")), cc=S.mapClusters[ci]; if(!cc) return;
    var cms=S.mapMs||1;
    S.mapSel=null;
    if(S.mapLevel!=="close"){ S.mapPick=null; setLevel("close", cc.x/cms, cc.y/cms); }
    else { S.mapPick=ci; render(); }
    return;
  }
  if(t.closest("#homemap")){ go("map"); return; }
  if((el=t.closest("[data-map]"))){
    var mid=el.getAttribute("data-map");
    if(IDRE.test(mid) && S.L[mid]){ S.mapSel=mid; S.mapPick=null; S.mapLevel="close"; S.mapWant={id:mid}; replaceTo("#m-"+mid); window.scrollTo(0,0); }
    return;
  }
  if(t.closest("#mapfit")){ fitPins(); return; }
  if((el=t.closest("[data-level]"))){ setLevel(el.getAttribute("data-level")==="close" ? "close" : "area"); return; }
  if(t.closest("#mappane")){ stageTap(e); return; }
  if((el=t.closest("[data-open]"))){
    var id=el.getAttribute("data-open");
    if(S.overlay) replaceTo("#l-"+id); else openOverlay("l-"+id);
    return;
  }
  if((el=t.closest("[data-rep]"))){ openReport(el.getAttribute("data-rep")); return; }
  if((el=t.closest(".backbtn"))){ if(el.getAttribute("data-view")) go(el.getAttribute("data-view")); else backToReports(); return; }
  if((el=t.closest("[data-sheet]"))){ openOverlay(el.getAttribute("data-sheet")); return; }
  if((el=t.closest(".tile[aria-controls]"))){
    var tk=el.id.replace("tile-","");
    S.homeFold = S.homeFold===tk ? "" : tk; lsSet("ee.homeFold", S.homeFold); render(); return;
  }
  if((el=t.closest(".foldhead[aria-controls]"))){ var fk=el.id.replace("bf-",""); S.folds[fk]=!S.folds[fk]; render(); return; }
  if(t.closest("#readmore")){ S.readOpen=!S.readOpen; ssSet("ee.readOpen", S.readOpen?"1":""); render(); return; }
  if(t.closest("#seeall")){ S.f.sort="newest"; $("sort").value="newest"; go("board"); return; }
  if((el=t.closest("[data-view]"))){
    if(el.parentNode && el.parentNode.classList && el.parentNode.classList.contains("tabbar")) replay(el.querySelector("svg"), "pop");
    go(el.getAttribute("data-view")); return;
  }
  if((el=t.closest("[data-delnote]"))){
    var nid=el.getAttribute("data-delnote");
    if(S.confirm==="note:"+nid){ S.confirm=null; enqueue({f:"notes", op:"del", id:nid}); }
    else { S.confirm="note:"+nid; render(); }
    return;
  }
  if((el=t.closest(".chip-btn[data-type]"))){ S.f.type=el.getAttribute("data-type"); render(); return; }
  if(t.closest("#nearOnly") || t.closest("[data-near]")){ S.f.near=!S.f.near; render(); return; }
  if(t.closest("#chip-top")){ S.mf.top=!S.mf.top; render(); return; }
  if(t.closest("#chip-starred")){ S.mf.starred=!S.mf.starred; render(); return; }
  if(t.closest("#savenote")){ saveNote(); return; }
  if(t.closest("#refresh") || t.closest("#set-refresh")){ sync().then(function(){ if(!S.syncErr) toast("Board is up to date."); }); return; }
  if(t.closest("[data-retry]")){ S.saveErr=null; sync(); flushSoon(200); return; }
  if(t.closest("#gear")){ openOverlay("settings"); return; }
  if(t.closest("#sheetx") || t.closest("#setx") || t.closest("#briefx") || t===$("sheet") || t===$("settings") || t===$("briefsheet")){ closeOverlay(); return; }
  if(t.closest("#set-pushbtn")){ if(S.pushState==="on") pushOff(); else pushOn(); return; }
  if(t.closest("#set-clearmedia")){ clearMedia(); return; }
  if(t.closest("#set-forget")){ if(S.confirm==="forget"){ S.confirm=null; forget(); } else { S.confirm="forget"; render(); } return; }
  if(t.closest("#lock-skip")){ lsSet("ee.browserok","1"); $("lock-install").hidden=true; $("lock-form").hidden=false; return; }
}
document.addEventListener("keydown", function(e){
  if(e.key==="Escape" && S.overlay){ closeOverlay(); return; }
  var t=e.target;
  if(t && t.id==="latest" && (e.key==="ArrowRight" || e.key==="ArrowLeft")){     /* Right is the older report, as a swipe to the left is */
    e.preventDefault(); var dir=e.key==="ArrowRight" ? -1 : 1;
    showRep(S.homeRep+(dir<0?1:-1), dir); return;
  }
  if((e.key==="Enter" || e.key===" ") && t && t.getAttribute && t.getAttribute("role")==="button" && t.tagName!=="BUTTON"){ e.preventDefault(); t.click(); }
});
document.addEventListener("animationend", function(e){
  var el=e.target, n=e.animationName;
  if(!el || !el.classList) return;
  if(n==="enter" || n==="fade"){ el.classList.remove("enter"); el.classList.remove("swap"); }
  else if(n==="cardrise") el.classList.remove("rise");
  else if(n==="tabpop" || n==="starpop" || n==="pop") el.classList.remove("pop");
  else if(n==="enterx") el.classList.remove("enter-x");
  else if(n==="enterback") el.classList.remove("enter-back");
  else if(n==="pinin") el.classList.remove("in");            /* at rest the pin's own transform (selection, hover) takes over */
  else if(n==="stagein") el.classList.remove("fade");
});
document.addEventListener("animationcancel", function(e){          /* a view hidden mid-animation ends it without animationend */
  var el=e.target, v=el && el.closest ? el.closest(".view") : null;
  if(el && el.classList && e.animationName==="cardrise" && v && v.hidden) el.classList.remove("rise");   /* a new rise on a shown card keeps its class */
});
/* the Map pane: a pinch is ours, not the page's. Open pinch goes to Close at that point, a closed pinch back to Area. */
(function(){
  var pane=$("mappane"), gx=NaN, gy=NaN, sc=1;
  function stop(e){ e.preventDefault(); }
  pane.addEventListener("gesturestart", function(e){ stop(e); sc=1; gx=Number(e.clientX); gy=Number(e.clientY); });
  pane.addEventListener("gesturechange", function(e){ stop(e); sc=Number(e.scale)||1; });
  pane.addEventListener("gestureend", function(e){
    stop(e); var s=Number(e.scale)||sc;
    if(s>1.3 && S.mapLevel!=="close"){
      var r=$("mapstage").getBoundingClientRect(), ms=S.mapMs||1;
      var x=isFinite(gx)?gx:(r.left+pane.clientWidth/2), y=isFinite(gy)?gy:(r.top+pane.clientHeight/2);
      setLevel("close", (x-r.left)/ms, (y-r.top)/ms);
    }else if(s<0.77 && S.mapLevel!=="area") setLevel("area");
  });
  if("ResizeObserver" in window){
    new ResizeObserver(function(){
      var el=$("homemap");
      if(S.loaded && S.view==="today" && !el.hidden && el.clientWidth && el.clientWidth!==S.homeW){ renderHomeMap(); hydrateImages(); }
    }).observe($("homemap"));
  }
})();
$("lock-form").addEventListener("submit", function(e){ e.preventDefault(); unlock(); });
$("area").addEventListener("change", function(){ S.f.area=this.value; render(); });
$("maxp").addEventListener("change", function(){ S.f.maxp=Number(this.value); render(); });
$("sort").addEventListener("change", function(){ S.f.sort=this.value; render(); });
$("set-quiet").addEventListener("change", function(){ enqueue({f:"prefs", op:"set", key:"quietPush", value:!!this.checked}); });
window.addEventListener("hashchange", applyHash);
window.addEventListener("resize", function(){ if(!$("shell").hidden) setHeights(); });
window.addEventListener("online", function(){ if(S.token){ sync(); } });
document.addEventListener("visibilitychange", function(){
  if(document.visibilityState!=="visible" || !S.token) return;
  if(Date.now()-S.lastSync>120000) sync(); else { render(); if(S.queue.length) flushSoon(300); }
});
/* one empty passive listener so iOS draws :active states */
document.body.addEventListener("touchstart", function(){}, {passive:true});
try{
  var mq=window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  if(mq){ RM=!!mq.matches; var onRM=function(){ RM=!!mq.matches; }; if(mq.addEventListener) mq.addEventListener("change", onRM); else if(mq.addListener) mq.addListener(onRM); }
}catch(e){}
if(!FOLDOK) document.documentElement.classList.add("nofold");

/* ---------- sheets: drag down to dismiss ---------- */
var drag=null;
function sheetOpen(){ var ov=S.overlay; if(!ov) return null; var el=$(SHEETS[ov.type]); return (el && !el.hidden && !el.classList.contains("leaving")) ? el : null; }
document.addEventListener("touchstart", function(e){
  var sh=sheetOpen(); if(!sh || drag || e.touches.length!==1) return;
  var inner=sh.querySelector(".inner"), t=e.target;
  if(!inner.contains(t)) return;
  var onHead=!!(t.closest && (t.closest(".sheethead") || t.closest(".hero")));
  if(!onHead && inner.scrollTop>0) return;
  var p=e.touches[0];
  drag={sh:sh, inner:inner, x0:p.clientX, y0:p.clientY, dy:0, hist:[], decided:false};
}, {passive:true});
document.addEventListener("touchmove", function(e){
  if(!drag) return;
  var p=e.touches[0], dx=p.clientX-drag.x0, dy=p.clientY-drag.y0;
  if(!drag.decided){
    if(Math.abs(dx)<12 && Math.abs(dy)<12) return;
    drag.decided=true;
    if(Math.abs(dx)>Math.abs(dy) || dy<0){ drag=null; return; }     /* sideways or upward: the page or the list has it */
    if(!RM) drag.inner.style.willChange="transform";
  }
  if(dy<0) dy=0;
  drag.dy=dy; drag.hist.push([Date.now(), dy]);
  if(drag.hist.length>12) drag.hist.shift();
  if(!RM){
    drag.inner.style.transition="none";
    drag.inner.style.transform="translateY("+dy+"px)";
    drag.sh.style.setProperty("--scrim-o", String(Math.max(0, 1-dy/Math.max(1, window.innerHeight))));
  }
  if(e.cancelable) e.preventDefault();
}, {passive:false});
function endDrag(){
  var d=drag; drag=null;
  if(!d || !d.decided) return;
  var now=Date.now(), last=d.hist[d.hist.length-1], old=last, v=0;
  for(var i=d.hist.length-1;i>=0;i--){ if(now-d.hist[i][0]<=80) old=d.hist[i]; else break; }
  if(last && old && last!==old) v=(last[1]-old[1])/Math.max(1, last[0]-old[0]);
  d.inner.style.willChange="";
  if(d.dy>110 || v>0.6){
    if(!RM){
      d.inner.style.transition="transform var(--t-2) var(--ease-in)";
      d.inner.style.transform="translateY(100%)";
      d.sh.style.setProperty("--scrim-o","0");
    }
    closeOverlay();
  }else{
    d.inner.style.transition="transform var(--t-pop) var(--spring)";
    d.inner.style.transform="";
    d.sh.style.removeProperty("--scrim-o");
    setTimeout(function(){ d.inner.style.transition=""; }, 260);
  }
}
document.addEventListener("touchend", endDrag, {passive:true});
document.addEventListener("touchcancel", endDrag, {passive:true});

/* ---------- Home: the report card is a stack, swiped sideways between days ---------- */
/* dir is the way the finger went: -1 left (the older report rises), 1 right (the newer one). */
var swipe=null, swipeBlock=0, ghostTimer=0;
function dropGhost(){
  var g=document.querySelector("#latestbox .ghost");
  if(g && g.parentNode) g.parentNode.removeChild(g);
  if(ghostTimer){ clearTimeout(ghostTimer); ghostTimer=0; }
}
function canGo(dir){ var i=S.homeRep+(dir<0?1:-1); return i>=0 && i<S.reports.length; }
/* Switch the card to report i. The old card is cloned and recedes behind (smaller, fading, drifting on in the swipe's direction)
   while the real card is re-rendered and rises from below. fromX and fromS are where the finger left it. Reduced motion: a plain swap. */
function settleCard(){ var el=$("latest"); el.style.transition=""; el.style.transform=""; el.style.willChange=""; }
function showRep(i, dir, fromX, fromS){
  var latest=$("latest"), box=$("latestbox");
  if(i<0 || i>=S.reports.length || i===S.homeRep){ settleCard(); return; }    /* nothing to go to: the card sits back where it was */
  dropGhost();
  latest.classList.remove("rise");
  if(!RM){
    var g=latest.cloneNode(true), x=fromX||0;
    g.removeAttribute("id"); g.removeAttribute("role"); g.removeAttribute("tabindex"); g.removeAttribute("data-rep"); g.removeAttribute("aria-label");
    g.setAttribute("aria-hidden","true"); g.className="latest ghost";
    Array.prototype.forEach.call(g.querySelectorAll("img"), function(im){ im.removeAttribute("data-sha"); });   /* the loader must not pick these up */
    g.style.height=latest.offsetHeight+"px";
    g.style.transition="none";
    g.style.transform="translateX("+x.toFixed(1)+"px) scale("+(fromS||1)+")";
    box.appendChild(g);
    void g.offsetWidth;
    g.style.transition="transform 220ms var(--ease-out),opacity 220ms var(--ease-out)";
    g.style.transform="translateX("+(x+24*(dir<0?-1:1)).toFixed(1)+"px) scale(.92)";
    g.style.opacity="0";
    var gone=function(){ if(g.parentNode) g.parentNode.removeChild(g); if(ghostTimer){ clearTimeout(ghostTimer); ghostTimer=0; } };
    g.addEventListener("transitionend", gone);
    ghostTimer=setTimeout(gone, 400);
  }
  S.homeRep=i;
  latest.style.transition="none"; latest.style.transform=""; latest.style.willChange="";
  renderLatest();
  hydrateImages();
  void latest.offsetWidth;
  latest.style.transition="";
  if(!RM) latest.classList.add("rise");
}
(function(){
  var el=$("latest");
  try{ if(document.fonts && document.fonts.ready) document.fonts.ready.then(function(){ latestH.by={}; latestH.f=""; if(S.view==="today" && S.reports.length) renderLatest(); }); }catch(e){}
  window.addEventListener("resize", function(){ if(S.view==="today" && S.reports.length && el.clientWidth!==latestH.w) renderLatest(); });
  function touchById(list, id){ for(var k=0;k<list.length;k++) if(list[k].identifier===id) return list[k]; return null; }
  el.addEventListener("touchstart", function(e){
    if(swipe && swipe.decided) return;                            /* a second finger changes nothing: the first one's swipe goes on */
    if(e.touches.length!==1 || S.overlay){ swipe=null; return; }   /* two fingers, or a sheet is open */
    var p=e.touches[0];
    swipe={id:p.identifier, x0:p.clientX, y0:p.clientY, dx:0, x:0, s:1, end:false, decided:false, hist:[]};
  }, {passive:true});
  el.addEventListener("touchmove", function(e){
    var sw=swipe; if(!sw) return;
    var p=touchById(e.touches, sw.id); if(!p) return;
    var dx=p.clientX-sw.x0, dy=p.clientY-sw.y0;
    if(!sw.decided){
      if(Math.abs(dx)<12 && Math.abs(dy)<12) return;
      if(Math.abs(dy)>=Math.abs(dx)){ swipe=null; return; }     /* mostly up or down: the page scrolls */
      sw.decided=true; swipeBlock=0;
      dropGhost(); el.classList.remove("rise");
      if(!RM) el.style.willChange="transform";
    }
    if(e.cancelable) e.preventDefault();
    sw.end=!canGo(dx<0?-1:1);                                    /* past the newest or the oldest: resistance, no wraparound */
    var x=sw.end ? Math.max(-40, Math.min(40, dx/3)) : dx;
    sw.dx=dx; sw.x=x;
    sw.hist.push([Date.now(), dx]); if(sw.hist.length>12) sw.hist.shift();
    if(!RM){
      sw.s=1-0.05*Math.min(1, Math.abs(x)/180);
      el.style.transition="none";
      el.style.transform="translateX("+x.toFixed(1)+"px) scale("+sw.s.toFixed(3)+")";
    }
  }, {passive:false});
  function endSwipe(e){
    var sw=swipe; if(!sw) return;
    if(e && e.type==="touchend" && e.touches.length && !touchById(e.changedTouches, sw.id)) return;   /* another finger lifted, ours is still down */
    swipe=null;
    if(!sw.decided) return;
    swipeBlock=Date.now();                                       /* the click that follows a drag is not a tap */
    var now=Date.now(), last=sw.hist[sw.hist.length-1], old=last, v=0;
    for(var i=sw.hist.length-1;i>=0;i--){ if(now-sw.hist[i][0]<=80) old=sw.hist[i]; else break; }
    if(last && old && last!==old) v=(last[1]-old[1])/Math.max(1, last[0]-old[0]);
    var dir=sw.dx<0?-1:1, fast=Math.abs(v)>0.6 && (v<0)===(dir<0) && Math.abs(sw.dx)>20;
    el.style.willChange="";
    var cancelled=!!(e && e.type==="touchcancel");               /* the system took the finger: never a switch, the card snaps back */
    if(!cancelled && !sw.end && (Math.abs(sw.dx)>70 || fast)){
      var j=S.homeRep+(dir<0?1:-1);
      if(j>=0 && j<S.reports.length){ showRep(j, dir, sw.x, sw.s); return; }   /* the reports may have changed under the finger: then snap back */
    }
    if(RM){ settleCard(); return; }
    el.style.transition="transform 180ms var(--ease-out)";
    el.style.transform="";
    setTimeout(function(){ el.style.transition=""; }, 200);
  }
  el.addEventListener("touchend", endSwipe, {passive:true});
  el.addEventListener("touchcancel", endSwipe, {passive:true});
  el.addEventListener("click", function(e){
    if(swipeBlock && Date.now()-swipeBlock<400){ swipeBlock=0; e.preventDefault(); e.stopPropagation(); }
  }, true);
})();

/* ---------- service worker: offline shell, updates, notifications ---------- */
function startWorker(){
  if(!("serviceWorker" in navigator)) return;
  var hadController=!!navigator.serviceWorker.controller;
  navigator.serviceWorker.register("sw.js").then(function(){ checkPush(); }).catch(function(){});
  navigator.serviceWorker.addEventListener("controllerchange", function(){
    if(!hadController){ hadController=true; return; }                 /* first install: nothing to refresh */
    var typing=$("note") && $("note").value.trim();
    var once=false; try{ once=sessionStorage.getItem("ee.reloaded")==="1"; sessionStorage.setItem("ee.reloaded","1"); }catch(e){ once=true; }
    if(typing || once){ toast("An update is ready. It applies the next time you open the app.", 5000); return; }
    location.reload();
  });
  navigator.serviceWorker.addEventListener("message", function(e){
    var d=e.data||{};
    if(d.type==="open" && typeof d.url==="string"){
      try{ var u=new URL(d.url, location.href); if(u.origin===location.origin && u.hash) location.hash=u.hash; }catch(err){}
      if(S.token) sync();
    }
  });
}

/* ---------- start ---------- */
function boot(){
  S.owner=ownerFromAddress() || lsGet("ee.owner") || "";
  S.token=lsGet("ee.token");
  S.ownerId=lsGet("ee.ownerId")||null;
  S.queue=arr(lsJson("ee.queue", []));
  S.seenReport=lsGet("ee.seenReport");
  S.seenReplies=lsJson("ee.seenReplies", {}) || {};
  var fold=lsGet("ee.homeFold"); S.homeFold=(fold==="five" || fold==="starred") ? fold : "";
  S.readOpen=ssGet("ee.readOpen")==="1";
  startWorker();
  if(!S.token || !S.owner){ lock(""); return; }
  showShell(false);
  var cached=lsGet("ee.bundle");
  if(cached){ try{ applyBundle(JSON.parse(cached)); S.fromCache=true; }catch(e){ S.loaded=false; } }
  var me=lsJson("ee.me", null);
  if(me) S.srv={stars:cleanStars({stars:me.stars}), notes:cleanNotes({notes:me.notes}), prefs:cleanPrefs(me.prefs)};
  rebuildMe();
  applyHash();
  sync();
}
boot();
})();
