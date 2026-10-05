const OKC_FEED = "https://utility.arcgis.com/usrsvcs/servers/01c97e2928134efc93157d99f2d23047/rest/services/OpenData/Public_Safety/FeatureServer/0/query";
const DALLAS_FEED = "https://www.dallasopendata.com/resource/9fxf-t2tr.json?$limit=200";
const REFRESH_MS = 30000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CITY = {
  OKC: {
    name: "Oklahoma City",
    center: [35.4676, -97.5164],
    source: "OKC public incident feed",
    nearby: true,
    radio: [
      "OKC Fire Radio",
      "Oklahoma City Fire dispatch and fireground radio. This is not 911 caller audio.",
      "https://www.broadcastify.com/listen/feed/27252"
    ]
  },
  DAL: {
    name: "Dallas",
    center: [32.7767, -96.7970],
    source: "Dallas Police Active Calls",
    nearby: false,
    radio: [
      "Dallas Public Safety Radio",
      "Dallas-area public-safety radio availability varies by agency and channel.",
      "https://www.broadcastify.com/listen/ctid/2579"
    ]
  }
};

let city = "OKC";
let mode = "AUTO";
let items = [];
let filter = "ALL";
let sortMode = "PRIORITY";
let alerts = false;
let firstLoad = true;
let known = new Set();
let userLoc = null;
let watchId = null;
let unknown = new Set();
let leads = loadLeads();

const $ = id => document.getElementById(id);
const esc = value => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

function parseOkc(value) {
  if (!value) return 0;
  const text = String(value).replace(/\s+/g, " ").trim();
  const match = text.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return 0;
  const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const monthName = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  let hour = Number(match[4]);
  if (match[6].toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (match[6].toUpperCase() === "AM" && hour === 12) hour = 0;
  return new Date(Number(match[3]), months[monthName], Number(match[2]), hour, Number(match[5]), 0, 0).getTime();
}

function parseDallas(row) {
  if (row.date_time) {
    const parsed = Date.parse(row.date_time);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (row.date && row.time) {
    const datePart = String(row.date).slice(0, 10);
    const parsed = Date.parse(`${datePart} ${row.time}`);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (row.date) {
    const parsed = Date.parse(row.date);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function fmt(timestamp) {
  if (!timestamp) return "Time unavailable";
  return new Date(timestamp).toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit"
  });
}

function age(timestamp) {
  if (!timestamp) return "time unavailable";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr${hours === 1 ? "" : "s"} ago`;
}

function category(text) {
  const value = String(text).toLowerCase();
  if (value.includes("fire") || value.includes("smoke")) return "FIRE";
  if (value.includes("accident") || value.includes("traffic") || value.includes("crash") || value.includes("vehicle")) return "TRAFFIC";
  if (value.includes("ems") || value.includes("medical") || value.includes("rescue")) return "EMS";
  return "PUBLIC";
}

function inferPriority(text) {
  const value = String(text).toLowerCase();
  if (value.includes("non-injury") || value.includes("non injury")) return 4;
  const p1 = ["active shooter","shooting","shots fired","person shot","gunshot","stabbing","homicide","armed robbery","officer down","officer involved","explosion","structure fire","struct fire","struc fire","residential fire","house fire","apartment fire","commercial fire","working fire","building fire"];
  const p2 = ["injury accident","accident with injury","traffic accident with injury","major accident","major crash","entrapment","rollover","vehicle fire","car fire","rescue","traffic/trans. acc. fr"];
  const p3 = ["alarm fire","fire alarm","automatic fire alarm","suspicious","disturbance","burglary","welfare check","traffic hazard","reckless driver"];
  if (p1.some(word => value.includes(word))) return 1;
  if (p2.some(word => value.includes(word))) return 2;
  if (p3.some(word => value.includes(word))) return 3;
  if (text) unknown.add(String(text).trim());
  return 4;
}

function pLabel(priority) {
  if (priority === 1) return "CRITICAL";
  if (priority === 2) return "HIGH";
  if (priority === 3) return "MEDIUM";
  return "ROUTINE";
}

function normOkc(feature) {
  const a = feature.attributes || {};
  const type = a.InfoTitle || a.Call_Type || "Public Safety Incident";
  const desc = a.Call_Type || a.InfoTitle || type;
  return {
    id: String(a.ObjectID ?? `${type}-${a.Reported_Time || Math.random()}`),
    type,
    desc,
    location: a.Address || "",
    ts: parseOkc(a.Reported_Time),
    priority: inferPriority(`${type} ${desc}`),
    category: category(`${type} ${desc}`),
    source: CITY.OKC.source,
    geo: feature.geometry && Number.isFinite(Number(feature.geometry.y)) && Number.isFinite(Number(feature.geometry.x))
      ? {lat:Number(feature.geometry.y), lon:Number(feature.geometry.x)} : null
  };
}

function normDallas(row, index) {
  const type = row.nature_of_call || "Dallas Police Active Call";
  const rawPriority = Number(row.priority);
  const priority = [1,2,3,4].includes(rawPriority) ? rawPriority : inferPriority(type);
  const location = [row.block, row.location].filter(Boolean).join(" ").trim();
  const id = [row.incident_number, row.unit_number, row.nature_of_call, index].filter(Boolean).join("-");
  return {
    id: id || String(Math.random()),
    type,
    desc: [row.division ? `${row.division} Division` : "", row.status || ""].filter(Boolean).join(" · "),
    location,
    ts: parseDallas(row),
    priority,
    category: category(type),
    source: CITY.DAL.source,
    geo: null
  };
}

function freshOkc(list) {
  return list.filter(item => item.ts && Date.now() - item.ts >= 0 && Date.now() - item.ts <= MAX_AGE_MS);
}

async function fetchOKC() {
  const query = new URLSearchParams({
    where:"1=1", outFields:"*", returnGeometry:"true", outSR:"4326", f:"json", resultRecordCount:"100", orderByFields:"ObjectID DESC"
  });
  const response = await fetch(`${OKC_FEED}?${query.toString()}`, {cache:"no-store"});
  if (!response.ok) throw new Error(`OKC HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || "OKC feed error");
  return freshOkc((data.features || []).map(normOkc));
}

async function fetchDallas() {
  const response = await fetch(DALLAS_FEED, {cache:"no-store", headers:{"Accept":"application/json"}});
  if (!response.ok) throw new Error(`Dallas HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("Dallas returned an unexpected response");
  const normalized = data.map(normDallas);
  normalized.sort((a,b) => (a.priority - b.priority) || (b.ts - a.ts));
  return normalized;
}

const toRad = value => value * Math.PI / 180;
function miles(a,b) {
  const R = 3958.7613;
  const dLat = toRad(b.lat-a.lat), dLon = toRad(b.lon-a.lon);
  const x = Math.sin(dLat/2)**2 + Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}
function dist(item) { return userLoc && item.geo ? miles(userLoc,item.geo) : null; }
function distText(distance) { if (distance === null) return ""; if (distance < .1) return "Less than 0.1 mi from you"; return `${distance < 10 ? distance.toFixed(1) : Math.round(distance)} mi from you`; }

function mapURL(item) {
  if (item.geo) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${item.geo.lat},${item.geo.lon}`)}`;
  if (item.location) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${item.location}, ${CITY[city].name}`)}`;
  return "#";
}

function assignment(item) {
  const minutes = (Date.now()-item.ts)/60000;
  if (item.location && ((item.priority===1 && minutes<=45) || (item.priority===2 && minutes<=30))) {
    return ["STRONG","🟢 STRONG LEAD FOR COVERAGE","assignment-strong"];
  }
  return ["MONITOR","⚪ MONITOR","assignment-monitor"];
}

function filtered() {
  return items.filter(item => filter === "ALL" || (filter === "P1" && item.priority===1) || item.category === filter);
}

function ordered(list) {
  const copy = [...list];
  if (sortMode === "NEWEST") return copy.sort((a,b)=>b.ts-a.ts);
  if (sortMode === "DISTANCE" && userLoc) return copy.sort((a,b)=>(dist(a)??99999)-(dist(b)??99999));
  return copy.sort((a,b)=>{
    const aa = assignment(a)[0] === "STRONG" ? 0 : 1;
    const ab = assignment(b)[0] === "STRONG" ? 0 : 1;
    return aa-ab || a.priority-b.priority || b.ts-a.ts;
  });
}

function setStatus(text,color) { $("statusText").textContent=text; $("statusDot").style.background=color; }
function summary() {
  const counts={1:0,2:0,3:0,4:0};
  items.forEach(item=>counts[item.priority]++);
  [1,2,3,4].forEach(n=>$("countP"+n).textContent=counts[n]);
}
function updateUnknown() {
  const values=[...unknown].slice(-20);
  $("unknownTypesList").innerHTML = values.length ? values.map(v=>`• ${esc(v)}`).join("<br>") : "None yet.";
}

function breaking() {
  const top=[...items].filter(item=>assignment(item)[0]==="STRONG").sort((a,b)=>b.ts-a.ts)[0];
  if (!top) { $("breakingWrap").style.display="none"; return; }
  const assign=assignment(top), distance=dist(top);
  $("breakingAssignment").innerHTML=`<span class="assignment-badge ${assign[2]}">${assign[1]}</span>`;
  $("breakingTitle").textContent=top.type;
  $("breakingMeta").textContent=`✅ OFFICIAL FEED · ${top.location||"Location unavailable"} · ${age(top.ts)}${distance!==null?` · ${distText(distance)}`:""}`;
  $("breakingActions").innerHTML=top.location?`<a class="action-btn blue" href="${esc(mapURL(top))}" target="_blank" rel="noopener noreferrer">🗺 MAP</a>`:"";
  $("breakingWrap").style.display="block";
}

function renderLive() {
  const list=ordered(filtered());
  const newest=[...items].sort((a,b)=>b.ts-a.ts)[0];
  $("incidentList").innerHTML=list.length?list.map(item=>{
    const assign=assignment(item), distance=dist(item);
    return `<article class="incident-card priority-p${item.priority}">
      <div class="incident-topline">
        ${newest&&item.id===newest.id?'<span class="badge badge-new">🔥 NEWEST</span>':""}
        <span class="badge badge-p${item.priority}">P${item.priority} — ${pLabel(item.priority)}</span>
        <span class="confirmed-badge">✅ OFFICIAL FEED</span>
      </div>
      <div class="incident-title">${esc(item.type)}</div>
      <span class="assignment-badge ${assign[2]}">${assign[1]}</span>
      ${distance!==null?`<div class="distance-line">📍 ${distText(distance)}</div>`:""}
      <div class="incident-meta">${age(item.ts)} · ${fmt(item.ts)}${item.desc?` · ${esc(item.desc)}`:""}</div>
      ${item.location?`<div class="incident-location">📍 ${esc(item.location)}</div>`:""}
      <div class="action-row">
        ${item.location?`<a class="action-btn blue" href="${esc(mapURL(item))}" target="_blank" rel="noopener noreferrer">🗺 MAP</a>`:""}
        ${item.category==="FIRE"&&CITY[city].radio?`<a class="action-btn red" href="${CITY[city].radio[2]}" target="_blank" rel="noopener noreferrer">🎧 RADIO</a>`:""}
      </div>
    </article>`;
  }).join(""):'<div class="empty-state">No incidents match this filter.</div>';
}

function renderMap() {
  $("mapIncidentList").innerHTML=items.length?items.map(item=>`<div class="map-list-card"><b>${esc(item.type)}</b><div class="incident-meta">✅ Official feed · ${age(item.ts)}</div>${item.location?`<div class="incident-location">📍 ${esc(item.location)}</div><a class="action-btn blue" href="${esc(mapURL(item))}" target="_blank" rel="noopener noreferrer">VIEW SCENE AREA</a>`:""}</div>`).join(""):'<div class="empty-state">No official incident locations.</div>';
}

function renderNearby() {
  if (!userLoc) { $("nearbySummary").textContent="Enable location to calculate distance."; $("nearbyList").innerHTML='<div class="empty-state">Location has not been enabled yet.</div>'; return; }
  if (!CITY[city].nearby) { $("nearbySummary").textContent=`${CITY[city].name} does not currently provide coordinates to this dashboard.`; $("nearbyList").innerHTML='<div class="empty-state">Nearby distance is not available for Dallas yet.</div>'; return; }
  const radius=Number($("nearbyRadius").value), nearbySort=$("nearbySort").value;
  let nearby=items.map(item=>({item,distance:dist(item)})).filter(row=>row.distance!==null&&(radius>=999||row.distance<=radius));
  if (nearbySort==="DISTANCE") nearby.sort((a,b)=>a.distance-b.distance);
  else if (nearbySort==="PRIORITY") nearby.sort((a,b)=>a.item.priority-b.item.priority||a.distance-b.distance);
  else nearby.sort((a,b)=>b.item.ts-a.item.ts);
  $("nearbySummary").textContent=`${nearby.length} official incident${nearby.length===1?"":"s"} in this view.`;
  $("nearbyList").innerHTML=nearby.length?nearby.map((row,index)=>`<div class="nearby-card"><b>#${index+1} NEAREST</b><div class="nearby-title">${esc(row.item.type)}</div><div class="distance-line">📍 ${distText(row.distance)}</div><div class="nearby-meta">P${row.item.priority} · ${age(row.item.ts)}${row.item.location?`<br>📍 ${esc(row.item.location)}`:""}</div><a class="action-btn blue" href="${esc(mapURL(row.item))}" target="_blank" rel="noopener noreferrer">🗺 MAP</a></div>`).join(""):'<div class="empty-state">No official incidents inside this radius.</div>';
}

function renderRadio() {
  const radio=CITY[city].radio;
  $("radioTitle").textContent=radio[0];
  $("radioCopy").textContent=radio[1];
  $("radioButton").href=radio[2];
}

async function load() {
  setStatus("CHECKING","#ffb723");
  try {
    const rows=city==="OKC"?await fetchOKC():await fetchDallas();
    checkAlerts(rows);
    items=rows;
    summary(); updateUnknown(); breaking(); renderLive(); renderMap(); renderNearby();
    $("incidentCount").textContent=`${rows.length} incident${rows.length===1?"":"s"}`;
    setStatus("LIVE","#39c96a");
    $("lastChecked").textContent=`Official feed checked: ${new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",second:"2-digit"})}`;
  } catch (error) {
    console.error(error);
    items=[]; summary(); breaking(); renderMap(); renderNearby();
    setStatus("FEED ERROR","#e73b33");
    $("lastChecked").textContent=error.message;
    $("incidentList").innerHTML=`<div class="empty-state"><b>${esc(CITY[city].name)} feed did not load.</b><br><br>${esc(error.message)}<br><br>Try REFRESH. If Dallas alone fails, the Dallas OpenData feed may be temporarily delayed or unavailable.</div>`;
  }
}

function nearest(latitude,longitude) {
  let best="OKC", bestDistance=Infinity;
  Object.entries(CITY).forEach(([code,profile])=>{
    const d=miles({lat:latitude,lon:longitude},{lat:profile.center[0],lon:profile.center[1]});
    if (d<bestDistance) {bestDistance=d; best=code;}
  });
  return best;
}

async function changeCity() {
  mode=$("citySelect").value;
  if (mode==="AUTO") {
    city=userLoc?nearest(userLoc.lat,userLoc.lon):"OKC";
    $("cityModeNote").textContent=userLoc?`AUTO detected nearest supported city: ${CITY[city].name}.`:"AUTO needs location. Using Oklahoma City until location is enabled.";
  } else {
    city=mode;
    $("cityModeNote").textContent=`${CITY[city].name} selected.`;
  }
  $("confirmedSourceLabel").textContent=CITY[city].source;
  renderRadio();
  firstLoad=true;
  known=new Set();
  await load();
}

function startLocation() {
  if (!navigator.geolocation) { $("locationStatus").textContent="Location is not supported by this browser."; return; }
  $("locationStatus").textContent="Requesting location…";
  watchId=navigator.geolocation.watchPosition(async position=>{
    userLoc={lat:position.coords.latitude,lon:position.coords.longitude};
    $("locationStatus").textContent=`📍 Location active · accuracy about ${Math.round(position.coords.accuracy*3.28084)} ft.`;
    $("stopLocationButton").disabled=false;
    $("useLocationButton").textContent="📍 LOCATION ACTIVE";
    if (mode==="AUTO") await changeCity(); else {renderNearby(); renderLive(); breaking();}
  }, error=>{
    $("locationStatus").textContent=error.code===1?"Location permission denied.":"Unable to determine location.";
  }, {enableHighAccuracy:true,timeout:15000,maximumAge:15000});
}

function stopLocation() {
  if (watchId!==null) navigator.geolocation.clearWatch(watchId);
  watchId=null; userLoc=null;
  $("stopLocationButton").disabled=true;
  $("useLocationButton").textContent="📍 USE MY LOCATION";
  $("locationStatus").textContent="Location is off.";
  renderNearby(); renderLive(); breaking();
}

function loadLeads() { try { return JSON.parse(localStorage.getItem("bnmLeads")||"[]"); } catch { return []; } }
function saveLeads() { localStorage.setItem("bnmLeads",JSON.stringify(leads)); }
function renderLeads() {
  if (!leads.length) { $("leadList").innerHTML='<div class="empty-state">No unconfirmed leads saved.</div>'; return; }
  $("leadList").innerHTML=leads.map(lead=>`<article class="radio-lead-card"><span class="unconfirmed-badge">⚠️ UNCONFIRMED</span><div class="incident-title">${esc(lead.type)}</div><div class="lead-meta">${esc(lead.source)} · ${age(lead.ts)}${lead.area?`<br>${esc(lead.area)}`:""}</div>${lead.notes?`<div class="lead-note">${esc(lead.notes)}</div>`:""}<div class="safe-language"><div class="safe-title">SAFER WORDING</div><div class="safe-copy">Radio/app information indicates a possible ${esc(lead.type)}${lead.area?` in the ${esc(lead.area)} area`:""}. I have not independently confirmed the details yet.</div></div><button class="action-btn delete-lead" data-id="${lead.id}">DELETE</button></article>`).join("");
  document.querySelectorAll(".delete-lead").forEach(button=>button.onclick=()=>{leads=leads.filter(lead=>lead.id!==button.dataset.id);saveLeads();renderLeads();});
}
function addLead() {
  const type=$("leadType").value.trim();
  if (!type) {alert("Enter what you heard first."); return;}
  leads.unshift({id:String(Date.now()),type,area:$("leadArea").value.trim(),source:$("leadSource").value,notes:$("leadNotes").value.trim(),ts:Date.now()});
  saveLeads(); $("leadType").value=""; $("leadArea").value=""; $("leadNotes").value=""; renderLeads();
}

function beep() {
  try {
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    const context=new AudioContextClass(), oscillator=context.createOscillator(), gain=context.createGain();
    oscillator.connect(gain); gain.connect(context.destination); oscillator.frequency.value=880; gain.gain.value=.15; oscillator.start(); oscillator.stop(context.currentTime+.35);
  } catch {}
}

function checkAlerts(rows) {
  const ids=new Set(rows.map(row=>row.id));
  if (!firstLoad&&alerts) rows.forEach(row=>{if(!known.has(row.id)&&row.priority===1)beep();});
  known=ids; firstLoad=false;
}

function tab(name) {
  document.querySelectorAll(".nav-btn").forEach(button=>button.classList.toggle("active",button.dataset.tab===name));
  document.querySelectorAll(".tab-panel").forEach(panel=>panel.classList.remove("active"));
  $("panel-"+name).classList.add("active");
  if (name==="nearby") renderNearby();
  window.scrollTo({top:0,behavior:"smooth"});
}

$("citySelect").onchange=changeCity;
document.querySelectorAll(".filter-btn").forEach(button=>button.onclick=()=>{document.querySelectorAll(".filter-btn").forEach(other=>other.classList.remove("active"));button.classList.add("active");filter=button.dataset.filter;renderLive();});
$("sortSelect").onchange=event=>{sortMode=event.target.value;if(sortMode==="DISTANCE"&&!userLoc){tab("nearby");$("locationStatus").textContent="Enable location first to sort by distance.";}else renderLive();};
$("useLocationButton").onclick=startLocation;
$("stopLocationButton").onclick=stopLocation;
$("nearbyRadius").onchange=renderNearby;
$("nearbySort").onchange=renderNearby;
$("addLeadButton").onclick=addLead;
$("enableAlertsButton").onclick=()=>{alerts=true;$("enableAlertsButton").textContent="🔊 ALERTS ENABLED";$("alertsStatus").textContent="Alerts are enabled for new P1 incidents while this page is open.";beep();};
$("testAlertButton").onclick=()=>{beep();$("alertsStatus").textContent="Test alert played. No real incident was created.";};
document.querySelectorAll(".nav-btn").forEach(button=>button.onclick=()=>tab(button.dataset.tab));

renderLeads();
renderRadio();
changeCity();
setInterval(()=>load(),REFRESH_MS);
