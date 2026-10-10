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
var TITLES = {today:"Today", board:"The board", starred:"My contenders", reports:"Daily reports", ask:"Ask Claude"};
var FILES = {stars:"me/stars.json", notes:"me/notes.json", push:"me/push.json", prefs:"me/prefs.json"};
var IDRE = /^[A-Za-z0-9_-]{1,80}$/;

var S = {
  token:null, owner:"",
  loaded:false, fromCache:false, lastSync:0, syncing:false, syncErr:null,
  home:null, L:{}, reports:[], skipped:[], replies:{}, built:null,
  srv:{stars:{}, notes:[], prefs:{}},          /* what the notebook holds */
  stars:{}, notes:[], prefs:{},                /* that, plus changes still waiting to save */
  queue:[], flushing:false, saveErr:null, flushTimer:0,
  view:"today", rep:null, repPushed:false, overlay:null, overlayPushed:false,
  f:{type:"All", area:"All", maxp:0, sort:"rank", near:false},
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
function lsGet(k){ try{ return localStorage.getItem(k); }catch(e){ return null; } }
function lsSet(k,v){ try{ localStorage.setItem(k,v); return true; }catch(e){ return false; } }
function lsDel(k){ try{ localStorage.removeItem(k); }catch(e){} }
function lsJson(k,fallback){ try{ var v=JSON.parse(lsGet(k)); return v==null?fallback:v; }catch(e){ return fallback; } }
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
var toastTimer=0;
function toast(msg, ms){
  var t=$("toast"); t.textContent=msg; t.hidden=false;
  clearTimeout(toastTimer); toastTimer=setTimeout(function(){ t.hidden=true; }, ms||3200);
}

/* ---------- GitHub: the only place this app sends anything ---------- */
function repoUrl(path){ return API+"/repos/"+encodeURIComponent(S.owner)+"/"+encodeURIComponent(CFG.notebook||"east-end-notebook")+(path||""); }
function contents(path){ return "/contents/"+path.split("/").map(encodeURIComponent).join("/"); }
function gh(method, path, opt){
  opt=opt||{};
  var headers={"Authorization":"Bearer "+S.token, "Accept":opt.raw?"application/vnd.github.raw+json":"application/vnd.github+json"};
  var init={method:method, headers:headers, cache:"no-store"};
  if(opt.body){ headers["Content-Type"]="application/json"; init.body=JSON.stringify(opt.body); }
  var ctl=("AbortController" in window)?new AbortController():null, timer=0;
  if(ctl){ init.signal=ctl.signal; timer=setTimeout(function(){ ctl.abort(); }, 20000); }
  return fetch(repoUrl(path), init).then(function(res){
    clearTimeout(timer);
    if(res.ok) return opt.raw ? res.text() : res.json();
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
function writeFile(path, data, sha, message){
  var body={message:message, content:b64encode(JSON.stringify(data,null,2)+"\n"), branch:BRANCH};
  if(sha) body.sha=sha;
  return gh("PUT", contents(path), {body:body});
}

/* ---------- reading the notebook ---------- */
function applyBundle(b){
  if(!b || !Array.isArray(b.listings)) throw new Error("bad bundle");
  var L={};
  b.listings.forEach(function(l){ if(l && IDRE.test(String(l.id))) L[l.id]=l; });
  S.L=L;
  S.home=b.home||{};
  S.reports=arr(b.reports).filter(function(r){ return r && okDate(r.date); }).sort(function(a,b2){ return b2.date.localeCompare(a.date); });
  S.skipped=arr(b.skipped);
  S.replies=(b.replies && typeof b.replies==="object") ? b.replies : {};
  S.built=b.built||null;
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
  return Promise.all([
    gh("GET", contents("app.json")+"?ref="+encodeURIComponent(BRANCH), {raw:true}),
    readFile(FILES.stars), readFile(FILES.notes), readFile(FILES.prefs)
  ]).then(function(r){
    applyBundle(JSON.parse(r[0]));
    lsSet("ee.bundle", r[0]);
    S.srv={stars:cleanStars(r[1].data), notes:cleanNotes(r[2].data), prefs:cleanPrefs(r[3].data)};
    saveMeCache();
    S.fromCache=false; S.syncErr=null; S.lastSync=Date.now();
    lsSet("ee.lastSync", String(S.lastSync));
  }).catch(function(e){
    if(e.status===401){ lock("GitHub no longer accepts the access code on this phone. It expired or was cancelled. Create a new one and paste it here."); return; }
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
  var order=["stars","notes","push","prefs"], chain=Promise.resolve();
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
    if(e.status===401){ lock("GitHub no longer accepts the access code on this phone. Create a new one and paste it here. Your unsaved changes are kept."); return; }
    S.saveErr = e.offline ? "offline" : ((e.status===403 || e.status===404) ? "denied" : "error");
  }).then(function(){
    S.flushing=false; rebuildMe(); render();
    if(S.queue.length && !S.saveErr) flushSoon(600);
  });
}
function toggleStar(id){
  if(!IDRE.test(id)) return;
  if(S.stars[id]) enqueue({f:"stars", op:"del", id:id});
  else enqueue({f:"stars", op:"set", id:id, at:new Date().toISOString()});
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

/* ---------- pieces shared by the views ---------- */
function checked(){ return S.home && okDate(S.home.checked) ? S.home.checked : null; }
function daysAgo(d){ var c=checked(); return (c && okDate(d)) ? dnum(c)-dnum(d) : 999; }
function everything(){ return Object.keys(S.L).map(function(k){ return S.L[k]; }); }
function active(){ return everything().filter(function(l){ return l.status==="active"; }); }
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
  return '<button class="star" type="button" data-star="'+esc(id)+'" aria-pressed="'+on+'" aria-label="'+(on?'Remove '+esc(addr)+' from':'Add '+esc(addr)+' to')+' my contenders">'+(on?'★':'☆')+'</button>';
}
function nums(l){
  return '<span>'+usd(l.price)+'</span><span>'+esc(l.acresNote||l.acres)+' ac</span>'
    +(typeof l.drive==="number" ? '<span>'+l.drive+' min</span>'+ruler(l) : '');
}
function row(l, badge, sub, clamp){
  return '<li class="pickrow'+(badge?'':' plain')+'">'+(badge||'')
    +'<button class="openrow" type="button" data-open="'+esc(l.id)+'"><span class="ttl">'+esc(l.addr)+' '+pillFor(l)+'</span>'
    +(sub?'<span class="why'+(clamp?' clamp':'')+'">'+esc(sub)+'</span>':'')+'<span class="nums">'+nums(l)+'</span></button>'
    +starBtn(l.id,l.addr)+'</li>';
}
function rankBadge(l){ return '<span class="rk'+(l.rank>9?' two':'')+'">'+esc(l.rank)+'</span>'; }
function card(l){
  var tags="";
  if(l.status==="active" && l.rank<=5) tags+='<span class="pill pick">Claude pick '+esc(l.rank)+'</span>';
  else if(l.status==="active" && l.rank) tags+='<span class="pill">Rank '+esc(l.rank)+'</span>';
  tags+='<span class="pill">'+esc(l.type||"Listing")+'</span>'+pillFor(l);
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
  return '<article class="card">'
    +'<div class="top2"><div class="tags">'+tags+'</div>'+starBtn(l.id,l.addr)+'</div>'
    +'<div><h3>'+esc(l.addr)+'</h3>'
    +'<div class="where">'+esc(l.place)+(l.county?' · '+esc(l.county)+' County':'')+'</div>'+drive
    +(l.driveNote?'<div class="drivenote">'+esc(l.driveNote)+'</div>':'')+'</div>'
    +note
    +'<div class="figs"><div><span class="v">'+usd(l.price)+'</span><span class="k">asking</span></div>'
    +'<div><span class="v">'+esc(l.acresNote||l.acres)+'</span><span class="k">acres</span></div>'+third+'</div>'
    +house
    +(l.take?'<p class="take">'+esc(l.take)+'</p>':'')
    +lists+meters
    +((l.listed||l.hist)?'<div class="hist">'+(l.listed?'Listed '+esc(l.listed)+'. ':'')+esc(l.hist||"")+'</div>':'')
    +'<div class="foot">'+link
    +'<button class="btn ghost" type="button" data-noteabout="'+esc(l.id)+'">Ask Claude about this one</button>'
    +(l.mls?'<span class="mls">MLS '+esc(l.mls)+'</span>':'')+'</div>'
    +'</article>';
}
function reportChips(r){
  var counts={};
  arr(r.items).forEach(function(it){ counts[it.kind]=(counts[it.kind]||0)+1; });
  return KORDER.filter(function(k){ return counts[k] && k!=="info" && k!=="rank"; }).map(function(k){
    return '<span class="pill '+k+'">'+counts[k]+' '+esc(KIND[k].toLowerCase())+'</span>'; }).join("");
}
function itemsHtml(r, max){
  var items=arr(r.items).slice().sort(function(a,b){
    var sa=(a.id && S.stars[a.id])?0:1, sb=(b.id && S.stars[b.id])?0:1;      /* his starred listings lead */
    return sa-sb || KORDER.indexOf(a.kind)-KORDER.indexOf(b.kind);
  });
  if(max) items=items.slice(0,max);
  return items.map(function(it){
    var k=KIND[it.kind] ? it.kind : "info";
    var mine=(it.id && S.stars[it.id]) ? '<span class="pill mine">★ Starred</span> ' : '';
    var ttl=(it.id && S.L[it.id]) ? '<button class="linkbtn" type="button" data-open="'+esc(it.id)+'">'+esc(it.title||S.L[it.id].addr)+'</button>' : esc(it.title||"");
    return '<li><span><span class="pill '+k+'">'+esc(KIND[k])+'</span> '+mine+'</span><span class="ttl">'+ttl+'</span><span>'+esc(it.text||"")+'</span></li>';
  }).join("");
}
function headline(r){ return r.headline || (r.quiet ? "No big updates." : ""); }
function mineList(){ return Object.keys(S.stars).map(function(id){ return S.L[id]; }).filter(Boolean).sort(byRank); }
function unseenReplies(){
  return S.notes.filter(function(n){ return S.replies[n.id] && !S.seenReplies[n.id]; }).length;
}

/* ---------- views ---------- */
function scanNotice(){
  var c=checked(); if(!c) return "";
  var now=louNow(), behind=dnum(now.date)-dnum(c);
  if(behind<=0 || (behind===1 && now.hour<9)) return "";
  return '<div class="notice">'+(behind===1 ? "Today's scan has not landed yet. " : "No scan has landed since "+esc(fmt(c))+". ")
    +"This is the board from "+esc(fmtShort(c))+"."+(behind>1 ? " Tell Claude in the project chat." : "")+'</div>';
}
function renderToday(){
  var a=active().sort(byRank), why=(S.home && S.home.why)||{}, now=louNow();
  $("todaynotice").innerHTML=scanNotice();
  var r=S.reports[0];
  if(r){
    var n=arr(r.items).length, chips=reportChips(r);
    $("latest").innerHTML='<span class="eyebrow">'+(r.date===now.date?"This morning's report":"Latest report · "+esc(fmtDay(r.date)))+(r.n?' · no. '+esc(r.n):'')+'</span>'
      +'<p class="headline">'+esc(headline(r))+'</p>'
      +(r.summary?'<p class="muted small">'+esc(r.summary)+'</p>':'')
      +(chips?'<div class="chipsline">'+chips+'</div>':'')
      +(n?'<ul class="items">'+itemsHtml(r,4)+'</ul>':'')
      +'<div class="rowbtns"><button class="btn ghost" type="button" data-rep="'+esc(r.date)+'">'+(n>4?'Open the full report ('+n+' items)':'Open this report')+'</button></div>';
  }else $("latest").innerHTML='<p class="muted">No reports filed yet.</p>';

  var all=everything();
  var near=a.filter(function(l){ return l.drive<=LIMIT; }).length;
  var inRange=S.budget ? a.filter(function(l){ return l.price>=S.budget[0] && l.price<=S.budget[1]; }).length : 0;
  var pend=all.filter(function(l){ return l.status==="pending"; }).length;
  $("tally").innerHTML=a.length ? '<span><b>'+a.length+'</b> on the board</span><span><b>'+near+'</b> within '+LIMIT+' min</span>'
    +(S.budget?'<span><b>'+inRange+'</b> at '+usdK(S.budget[0])+' to '+usdK(S.budget[1])+'</span>':'')+'<span><b>'+pend+'</b> pending</span>' : '';

  var mine=mineList();
  $("mineblock").hidden=!mine.length;
  $("minehome").innerHTML=mine.slice(0,6).map(function(l){
    return '<li><button class="minirow" type="button" data-open="'+esc(l.id)+'"><span class="mstar" aria-hidden="true">★</span>'
      +'<span class="mttl">'+esc(l.addr)+' '+pillFor(l)+'</span>'
      +'<span class="mnum">'+usd(l.price)+(typeof l.drive==="number"?' · '+l.drive+' min':'')+'</span></button></li>';
  }).join("")+(mine.length>6?'<li class="muted small">And '+(mine.length-6)+' more in the folder.</li>':'');

  $("five").innerHTML=a.slice(0,5).map(function(l){
    return row(l, rankBadge(l), (l.place||"")+". "+(why[l.id]||l.take||"")+".");
  }).join("") || '<li class="empty">No ranked listings yet.</li>';
  $("read").innerHTML=arr(S.home && S.home.read).map(function(x){ return '<li><strong>'+esc(x.b)+'</strong> '+esc(x.t)+'</li>'; }).join("");
  $("brief").innerHTML=arr(S.home && S.home.brief).map(function(x){ return '<div><dt>'+esc(x.k)+'</dt><dd>'+esc(x.v)+'</dd></div>'; }).join("")
    +(S.home && S.home.schedule ? '<div><dt>Next scan</dt><dd>'+esc(S.home.schedule)+'</dd></div>' : '');
  $("coverage").textContent=(S.home && S.home.coverage)||"";

  /* seeing Today counts as reading the latest report */
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
    return row(l, rankBadge(l), (l.place||"")+" · "+(l.type||""));
  }).join("") : '<li class="empty">No listings match these filters.</li>';
  $("count").textContent=rows.length+" of "+active().length+" listings";
  var all=everything();
  $("pendinglist").innerHTML=all.filter(function(l){ return l.status==="pending"; }).sort(function(a,b){ return b.price-a.price; }).map(function(l){
    return row(l, "", l.pendingNote||"Under contract.", true);
  }).join("") || '<li class="empty">Nothing pending.</li>';
  $("gonelist").innerHTML=all.filter(function(l){ return l.status==="gone"; }).sort(function(a,b){ return String(b.goneDate).localeCompare(String(a.goneDate)); }).map(function(l){
    return row(l, "", (okDate(l.goneDate)?fmtShort(l.goneDate)+". ":"")+(l.goneNote||""), true);
  }).join("") || '<li class="empty">Nothing yet.</li>';
  $("skipcount").textContent=S.skipped.length+" looked at and left off";
  $("skiplist").innerHTML=S.skipped.map(function(s){
    return '<li><span class="ttl">'+esc(s.listing)+'</span><span class="num muted">'+esc(s.price)+'</span><span>'+esc(s.reason)+'</span></li>';
  }).join("");
}
function renderStarred(){
  var mine=mineList();
  if(!mine.length){
    $("minebody").innerHTML='<div class="empty">Your folder is empty. Tap the ☆ on any listing to put it here. I check starred listings first every morning and lead the report with any change.</div>';
    return;
  }
  var rows=mine.map(function(l){
    return '<tr><td><button class="linkbtn" type="button" data-open="'+esc(l.id)+'">'+esc(l.addr)+'</button>'+(flagOf(l)?' '+pillFor(l):'')+'</td>'
      +'<td class="num">'+usd(l.price)+'</td><td class="num">'+esc(l.acres)+'</td>'
      +'<td class="num">'+(typeof l.drive==="number"?l.drive+' min':'')+'</td></tr>';
  }).join("");
  $("minebody").innerHTML='<div class="view">'
    +'<p class="lede">Everything you starred. I check these first every morning and tell you the day one changes.</p>'
    +(mine.length>1 ? '<div class="panel"><h3>Side by side</h3><table class="cmp"><thead><tr><th>Address</th><th>Asking</th><th>Acres</th><th>Drive</th></tr></thead><tbody>'+rows+'</tbody></table></div>' : '')
    +'<div class="grid">'+mine.map(card).join("")+'</div></div>';
}
function renderReports(){
  var detail = S.rep && S.reports.filter(function(x){ return x.date===S.rep; })[0];
  $("replistwrap").hidden=!!detail; $("repdetailwrap").hidden=!detail;
  if(detail){
    var r=detail;
    $("repdetail").innerHTML='<span class="eyebrow">Report'+(r.n?' no. '+esc(r.n):'')+' · '+esc(fmt(r.date))+(r.checked?' · '+esc(r.checked)+' listings checked':'')+'</span>'
      +'<h2>'+esc(headline(r))+'</h2>'
      +(r.summary?'<p>'+esc(r.summary)+'</p>':'')
      +(arr(r.items).length?'<ul class="items">'+itemsHtml(r)+'</ul>':'<p class="muted">Nothing new, no price changes and no status changes that day.</p>');
    return;
  }
  $("replist").innerHTML=S.reports.map(function(r){
    return '<li><button class="repbtn'+(r.quiet?' quiet':'')+'" type="button" data-rep="'+esc(r.date)+'">'
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
  $("set-forget").textContent = S.confirm==="forget" ? "Tap again to forget it" : "Forget the access code";
  $("set-version").textContent="East End "+(CFG.version||"")+(S.built?" · board built "+fmtShort(String(S.built).slice(0,10))+" "+clock(S.built):"");
}

var VIEWS={today:renderToday, board:renderBoard, starred:renderStarred, reports:renderReports, ask:renderAsk};

/* header, banner, tab bar: cheap, and safe to call any time */
function chrome(){
  if($("shell").hidden) return;
  var now=louNow(), c=checked(), eb=fmtDay(now.date);
  if(c){
    if(c===now.date) eb+=" · Scanned "+((S.home && S.home.checkedAt && clock(S.home.checkedAt, TZ))||"this morning");
    else eb+=" · Last scan "+fmtShort(c);
  }
  $("eyebrow").textContent=eb;
  $("title").textContent=TITLES[S.view]||"";
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
  Array.prototype.forEach.call(document.querySelectorAll(".tabbar button"), function(t){
    if(t.getAttribute("data-view")===S.view) t.setAttribute("aria-current","page"); else t.removeAttribute("aria-current");
  });
  var nstar=Object.keys(S.stars).filter(function(id){ return S.L[id]; }).length;
  $("cnt-starred").hidden=!nstar; $("cnt-starred").textContent=nstar;
  var latest=S.reports[0];
  $("dot-today").hidden=!(latest && latest.date!==S.seenReport && S.view!=="today");
  $("dot-ask").hidden=!(unseenReplies() && S.view!=="ask");
}
var raf=0;
function paint(){
  raf=0;
  if($("shell").hidden) return;
  $("loading").hidden=S.loaded;
  if(!S.loaded){
    $("loading").textContent = S.syncing ? "Opening your notebook…"
      : (S.syncErr==="offline" ? "No connection. Open the app once while online and it keeps a copy for next time." : "Nothing to show yet.");
  }
  Object.keys(VIEWS).forEach(function(v){ $("v-"+v).hidden=!(S.loaded && v===S.view); });
  if(S.loaded) VIEWS[S.view]();
  chrome();
  var ov=S.overlay;
  $("sheet").hidden=!(ov && ov.type==="listing");
  $("settings").hidden=!(ov && ov.type==="settings");
  document.documentElement.classList.toggle("locked", !!ov);
  if(ov && ov.type==="listing"){
    var l=S.L[ov.id];
    $("sheetbody").innerHTML = l ? card(l) : '<div class="empty">This listing is not on the board any more.</div>';
  }
  if(ov && ov.type==="settings") renderSettings();
}
function render(){ if(!raf) raf=requestAnimationFrame(paint); }

/* ---------- getting around ---------- */
function parseHash(){
  var h=(location.hash||"").replace(/^#/,""), m;
  if((m=/^l-([A-Za-z0-9_-]{1,80})$/.exec(h))) return {overlay:{type:"listing", id:m[1]}};
  if(h==="settings") return {overlay:{type:"settings"}};
  if((m=/^r-(\d{4}-\d{2}-\d{2})$/.exec(h))) return {view:"reports", rep:m[1]};
  if(VIEWS[h]) return {view:h, rep:null};
  return {view:"today", rep:null};
}
function applyHash(){
  var p=parseHash();
  if(p.overlay){ S.overlay=p.overlay; }
  else{
    S.overlay=null; S.overlayPushed=false; S.confirm=null;
    if(p.view!==S.view || p.rep!==S.rep) window.scrollTo(0,0);
    S.view=p.view; S.rep=p.rep;
    if(!p.rep) S.repPushed=false;
  }
  render();
}
function baseHash(){ return "#"+(S.view==="reports" && S.rep ? "r-"+S.rep : S.view); }
function replaceTo(hash){
  try{ history.replaceState(null,"",hash); }catch(e){ location.hash=hash; return; }
  applyHash();
}
function go(view){ if(VIEWS[view]) replaceTo("#"+view); window.scrollTo(0,0); }
function openReport(date){
  if(!okDate(date)) return;
  if(S.overlay){ S.view="reports"; S.rep=date; replaceTo("#r-"+date); return; }
  S.repPushed=true; location.hash="r-"+date;
}
function backToReports(){
  if(S.repPushed){ S.repPushed=false; history.back(); }
  else replaceTo("#reports");
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
function lock(message){
  S.token=null; lsDel("ee.token");
  $("shell").hidden=true; $("sheet").hidden=true; $("settings").hidden=true;
  document.documentElement.classList.remove("locked");
  $("lock").hidden=false;
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
  gh("GET","").then(function(){
    lsSet("ee.token", code);
    if(!ownerFromAddress()) lsSet("ee.owner", own);
    $("lock-code").value="";
    showShell(); applyHash();
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
function showShell(){ $("lock").hidden=true; $("shell").hidden=false; }
function forget(){
  S.queue=[]; S.srv={stars:{}, notes:[], prefs:{}};
  ["ee.token","ee.bundle","ee.me","ee.queue","ee.lastSync","ee.seenReport","ee.seenReplies"].forEach(lsDel);
  S.loaded=false; S.L={}; S.reports=[]; S.home=null; S.overlay=null; S.overlayPushed=false;
  try{ history.replaceState(null,"","#today"); }catch(e){}
  lock("The access code is gone from this phone.");
}

/* ---------- notifications ---------- */
function pushReady(){ return !!CFG.vapidPublicKey && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }
function checkPush(){
  if(!pushReady()){ S.pushState="off"; return; }
  navigator.serviceWorker.ready.then(function(reg){ return reg.pushManager.getSubscription(); }).then(function(sub){
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
        return sub || reg.pushManager.subscribe({userVisibleOnly:true, applicationServerKey:b64urlBytes(CFG.vapidPublicKey)});
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
  onClick(t);
  /* a "tap again to confirm" button goes back to normal as soon as you tap anything else */
  if(before && S.confirm===before && !t.closest("[data-delnote],#set-forget")){ S.confirm=null; render(); }
});
function onClick(t){
  var el;
  if((el=t.closest("[data-star]"))){ toggleStar(el.getAttribute("data-star")); return; }
  if((el=t.closest("[data-noteabout]"))){
    var l=S.L[el.getAttribute("data-noteabout")];
    replaceTo("#ask"); window.scrollTo(0,0);
    if(l){ var n=$("note"); n.value="About "+l.addr+": "; n.setAttribute("data-about", l.id); setTimeout(function(){ try{ n.focus(); n.setSelectionRange(n.value.length,n.value.length); }catch(err){} }, 60); }
    return;
  }
  if((el=t.closest("[data-open]"))){
    var id=el.getAttribute("data-open");
    if(S.overlay) replaceTo("#l-"+id); else openOverlay("l-"+id);
    return;
  }
  if((el=t.closest("[data-rep]"))){ openReport(el.getAttribute("data-rep")); return; }
  if((el=t.closest(".backbtn"))){ backToReports(); return; }
  if((el=t.closest("[data-view]"))){ go(el.getAttribute("data-view")); return; }
  if((el=t.closest("[data-delnote]"))){
    var nid=el.getAttribute("data-delnote");
    if(S.confirm==="note:"+nid){ S.confirm=null; enqueue({f:"notes", op:"del", id:nid}); }
    else { S.confirm="note:"+nid; render(); }
    return;
  }
  if((el=t.closest(".chip-btn[data-type]"))){
    S.f.type=el.getAttribute("data-type");
    Array.prototype.forEach.call(document.querySelectorAll(".chip-btn[data-type]"),function(x){ x.setAttribute("aria-pressed", String(x===el)); });
    render(); return;
  }
  if(t.closest("#nearOnly")){ S.f.near=!S.f.near; $("nearOnly").setAttribute("aria-pressed", String(S.f.near)); render(); return; }
  if(t.closest("#savenote")){ saveNote(); return; }
  if(t.closest("#refresh") || t.closest("#set-refresh")){ sync().then(function(){ if(!S.syncErr) toast("Board is up to date."); }); return; }
  if(t.closest("[data-retry]")){ S.saveErr=null; sync(); flushSoon(200); return; }
  if(t.closest("#gear")){ openOverlay("settings"); return; }
  if(t.closest("#sheetx") || t.closest("#setx") || t===$("sheet") || t===$("settings")){ closeOverlay(); return; }
  if(t.closest("#set-pushbtn")){ if(S.pushState==="on") pushOff(); else pushOn(); return; }
  if(t.closest("#set-forget")){ if(S.confirm==="forget"){ S.confirm=null; forget(); } else { S.confirm="forget"; render(); } return; }
  if(t.closest("#lock-skip")){ lsSet("ee.browserok","1"); $("lock-install").hidden=true; $("lock-form").hidden=false; return; }
}
document.addEventListener("keydown", function(e){ if(e.key==="Escape" && S.overlay) closeOverlay(); });
$("lock-form").addEventListener("submit", function(e){ e.preventDefault(); unlock(); });
$("area").addEventListener("change", function(){ S.f.area=this.value; render(); });
$("maxp").addEventListener("change", function(){ S.f.maxp=Number(this.value); render(); });
$("sort").addEventListener("change", function(){ S.f.sort=this.value; render(); });
$("set-quiet").addEventListener("change", function(){ enqueue({f:"prefs", op:"set", key:"quietPush", value:!!this.checked}); });
window.addEventListener("hashchange", applyHash);
window.addEventListener("online", function(){ if(S.token){ sync(); } });
document.addEventListener("visibilitychange", function(){
  if(document.visibilityState!=="visible" || !S.token) return;
  if(Date.now()-S.lastSync>120000) sync(); else { render(); if(S.queue.length) flushSoon(300); }
});

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
  S.queue=arr(lsJson("ee.queue", []));
  S.seenReport=lsGet("ee.seenReport");
  S.seenReplies=lsJson("ee.seenReplies", {}) || {};
  startWorker();
  if(!S.token || !S.owner){ lock(""); return; }
  showShell();
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
