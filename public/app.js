const REFRESH_INTERVAL = 30000;
const MAX_INCIDENT_AGE = 24 * 60 * 60 * 1000;

const CITY_PROFILES = {
  OKC: {
    name: "Oklahoma City",
    shortName: "OKC",
    center: { latitude: 35.4676, longitude: -97.5164 },
    confirmedLabel: "OKC public incident feed",
    supportsNearby: true,
    radio: {
      title: "OKC Fire Radio",
      copy: "Fire and dispatch radio traffic. This is not 911 caller audio. Treat radio information as unconfirmed until corroborated.",
      url: "https://www.broadcastify.com/listen/feed/27252"
    }
  },
  DAL: {
    name: "Dallas",
    shortName: "Dallas",
    center: { latitude: 32.7767, longitude: -96.7970 },
    confirmedLabel: "Dallas Police Active Calls",
    supportsNearby: false,
    radio: null
  }
};

let selectedCityMode = "AUTO";
let activeCityCode = "OKC";
let allIncidents = [];
let currentFilter = "ALL";
let currentSort = "PRIORITY";
let alertsEnabled = false;
let firstLoad = true;
let previousIncidentIds = new Set();
let radioLeads = loadSavedLeads();
let userLocation = null;
let locationWatchId = null;
let unknownCallTypes = new Set();

function normalizeOkcFeature(feature) {
  const a = feature.attributes || {};
  const timestamp = parseOkcReportedTime(a.Reported_Time);
  const coords = feature.geometry && Number.isFinite(Number(feature.geometry.x)) && Number.isFinite(Number(feature.geometry.y))
    ? { latitude: Number(feature.geometry.y), longitude: Number(feature.geometry.x) }
    : null;
  const type = a.InfoTitle || a.Call_Type || "Public Safety Incident";
  return {
    id: String(a.ObjectID ?? JSON.stringify(a)),
    cityCode: "OKC",
    type,
    description: a.Call_Type || a.InfoTitle || "No additional description available.",
    location: a.Address || null,
    timestamp,
    nativePriority: null,
    status: "Active",
    coords,
    raw: a
  };
}

function normalizeDallasRow(row) {
  const type = row.nature_of_call || "Dallas Police Active Call";
  const block = String(row.block || "").trim();
  const street = String(row.location || "").trim();
  const location = [block, street].filter(Boolean).join(" ") || null;
  return {
    id: String(row.incident_number || `${type}-${row.date_time || row.date || ""}-${location || ""}`),
    cityCode: "DAL",
    type,
    description: [row.division ? `${row.division} Division` : null, row.status ? `Status: ${row.status}` : null].filter(Boolean).join(" · ") || type,
    location,
    timestamp: parseDallasTime(row),
    nativePriority: normalizeDallasPriority(row.priority),
    status: row.status || "Active",
    coords: null,
    raw: row
  };
}

function parseOkcReportedTime(value) {
  if (!value) return 0;
  const text = String(value).replace(/\s+/g, " ").trim();
  const match = text.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return 0;
  const months = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
  const key = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  let hour = Number(match[4]);
  const ampm = match[6].toUpperCase();
  if (ampm === "PM" && hour !== 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  return new Date(Number(match[3]), months[key], Number(match[2]), hour, Number(match[5]), 0, 0).getTime();
}

function parseDallasTime(row) {
  if (row.date_time) {
    const t = new Date(row.date_time).getTime();
    if (Number.isFinite(t)) return t;
  }
  const dateText = String(row.date || "").trim();
  const timeText = String(row.time || "").trim();
  if (dateText) {
    const combined = `${dateText.split("T")[0]}T${timeText || "00:00:00"}`;
    const t = new Date(combined).getTime();
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

function normalizeDallasPriority(value) {
  const n = Number(String(value || "").match(/[1-4]/)?.[0]);
  return Number.isFinite(n) ? n : null;
}

async function fetchOkc() {
  const url = "https://utility.arcgis.com/usrsvcs/servers/01c97e2928134efc93157d99f2d23047/rest/services/OpenData/Public_Safety/FeatureServer/0/query";
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "*",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
    resultRecordCount: "100",
    orderByFields: "ObjectID DESC"
  });
  const response = await fetch(`${url}?${params.toString()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`OKC feed HTTP ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error.message || "OKC ArcGIS feed error");
  if (!Array.isArray(data.features)) throw new Error("OKC feed returned no feature list");
  return data.features.map(normalizeOkcFeature);
}

async function fetchDallas() {
  const url = "https://www.dallasopendata.com/resource/9fxf-t2tr.json?$limit=500";
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Dallas feed HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Dallas feed returned no records");
  return rows.map(normalizeDallasRow);
}

async function fetchCityIncidents(cityCode) {
  if (cityCode === "DAL") return fetchDallas();
  return fetchOkc();
}

function filterRecentIncidents(incidents) {
  if (activeCityCode === "DAL") {
    return incidents.filter(i => i.timestamp && Date.now() - i.timestamp <= MAX_INCIDENT_AGE);
  }
  return incidents.filter(i => i.timestamp && Date.now() - i.timestamp >= 0 && Date.now() - i.timestamp <= MAX_INCIDENT_AGE);
}

function getCategory(incident) {
  const text = `${incident.type} ${incident.description}`.toLowerCase();
  if (text.includes("fire") || text.includes("smoke")) return { code: "FIRE", label: "🔥 Fire" };
  if (text.includes("accident") || text.includes("traffic") || text.includes("crash") || text.includes("vehicle")) return { code: "TRAFFIC", label: "🚗 Traffic" };
  if (text.includes("rescue") || text.includes("medical") || text.includes("ambulance") || text.includes("ems")) return { code: "EMS", label: "🚑 EMS" };
  return { code: "PUBLIC", label: "🚨 Public Safety" };
}

function getPriority(incident) {
  if (incident.nativePriority && incident.nativePriority >= 1 && incident.nativePriority <= 4) {
    const labels = {1:"CRITICAL",2:"HIGH",3:"MEDIUM",4:"ROUTINE"};
    return { level: incident.nativePriority, code: `P${incident.nativePriority}`, label: labels[incident.nativePriority], native: true };
  }
  const text = `${incident.type} ${incident.description}`.toLowerCase();
  if (text.includes("non-injury") || text.includes("non injury")) return { level:4, code:"P4", label:"ROUTINE", native:false };
  const p1 = ["active shooter","shooting","shots fired","person shot","gunshot","stabbing","person stabbed","homicide","armed subject","armed robbery","officer down","officer involved","explosion","structure fire","struct fire","struc fire","residential fire","house fire","apartment fire","commercial fire","working fire","building fire"];
  const p2 = ["injury accident","accident with injury","traffic accident with injury","major accident","major crash","entrapment","rollover","vehicle fire","car fire","rescue","traffic/trans. acc. fr","major dist","ambulance"];
  const p3 = ["alarm fire","fire alarm","alarm fire auto","automatic fire alarm","suspicious","disturbance","burglary","welfare check","traffic hazard","reckless driver"];
  if (p1.some(w => text.includes(w))) return { level:1, code:"P1", label:"CRITICAL", native:false };
  if (p2.some(w => text.includes(w))) return { level:2, code:"P2", label:"HIGH", native:false };
  if (p3.some(w => text.includes(w))) return { level:3, code:"P3", label:"MEDIUM", native:false };
  unknownCallTypes.add(incident.type);
  return { level:4, code:"P4", label:"ROUTINE", native:false };
}

function getAssignmentStatus(incident) {
  const p = getPriority(incident);
  const age = getAgeMinutes(incident.timestamp);
  if (incident.location && p.level === 1 && age <= 45) return { code:"STRONG", label:"🟢 STRONG LEAD FOR COVERAGE", className:"assignment-strong", note:"Recent confirmed high-priority incident with location information available." };
  if (incident.location && p.level === 2 && age <= 30) return { code:"STRONG", label:"🟢 STRONG LEAD FOR COVERAGE", className:"assignment-strong", note:"Recent confirmed higher-priority incident with location information available." };
  return { code:"MONITOR", label:"⚪ MONITOR", className:"assignment-monitor", note:"Confirmed incident that does not currently meet the stronger coverage threshold." };
}

function formatIncidentDate(timestamp) {
  if (!timestamp) return "Date/time unavailable";
  return new Date(timestamp).toLocaleString("en-US", { weekday:"short", month:"short", day:"numeric", year:"numeric", hour:"numeric", minute:"2-digit" });
}

function getAgeMinutes(timestamp) {
  if (!timestamp) return 999999;
  return Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
}

function getAgeText(timestamp) {
  if (!timestamp) return "time unavailable";
  const m = getAgeMinutes(timestamp);
  if (m < 1) return "just now";
  if (m < 60) return `${m} ${m === 1 ? "min" : "mins"} ago`;
  const h = Math.floor(m / 60);
  return `${h} ${h === 1 ? "hr" : "hrs"} ago`;
}

function degreesToRadians(d) { return d * Math.PI / 180; }
function calculateDistanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.7613;
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(degreesToRadians(lat1))*Math.cos(degreesToRadians(lat2))*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}
function getIncidentDistance(i) {
  if (!userLocation || !i.coords) return null;
  return calculateDistanceMiles(userLocation.latitude, userLocation.longitude, i.coords.latitude, i.coords.longitude);
}
function formatDistance(miles) {
  if (miles === null || !Number.isFinite(miles)) return "";
  if (miles < .1) return "Less than 0.1 mi from you";
  if (miles < 10) return `${miles.toFixed(1)} mi from you`;
  return `${Math.round(miles)} mi from you`;
}

function getMapURL(incident) {
  if (incident.coords) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${incident.coords.latitude},${incident.coords.longitude}`)}`;
  if (!incident.location) return "#";
  const city = CITY_PROFILES[incident.cityCode]?.name || "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${incident.location}, ${city}`)}`;
}

function escapeHTML(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;");
}

function applyUserFilter(list) {
  if (currentFilter === "ALL") return list;
  if (currentFilter === "P1") return list.filter(i => getPriority(i).level === 1);
  return list.filter(i => getCategory(i).code === currentFilter);
}

function sortIncidents(list) {
  const copy = [...list];
  if (currentSort === "DISTANCE" && userLocation) {
    return copy.sort((a,b) => {
      const da = getIncidentDistance(a), db = getIncidentDistance(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
  }
  if (currentSort === "NEWEST") return copy.sort((a,b) => b.timestamp - a.timestamp);
  return copy.sort((a,b) => {
    const aa = getAssignmentStatus(a).code, ab = getAssignmentStatus(b).code;
    if (aa === "STRONG" && ab !== "STRONG") return -1;
    if (ab === "STRONG" && aa !== "STRONG") return 1;
    const pa = getPriority(a).level, pb = getPriority(b).level;
    return pa !== pb ? pa - pb : b.timestamp - a.timestamp;
  });
}

function updateSummary() {
  const counts = {1:0,2:0,3:0,4:0};
  allIncidents.forEach(i => counts[getPriority(i).level]++);
  document.getElementById("countP1").textContent = counts[1];
  document.getElementById("countP2").textContent = counts[2];
  document.getElementById("countP3").textContent = counts[3];
  document.getElementById("countP4").textContent = counts[4];
}

function updateBreakingStory() {
  const candidates = allIncidents.filter(i => getAssignmentStatus(i).code === "STRONG").sort((a,b) => b.timestamp - a.timestamp);
  const wrap = document.getElementById("breakingWrap");
  if (!candidates.length) { wrap.style.display = "none"; return; }
  const i = candidates[0], a = getAssignmentStatus(i), distance = getIncidentDistance(i);
  document.getElementById("breakingAssignment").innerHTML = `<div class="assignment-badge ${a.className}">${a.label}</div>`;
  document.getElementById("breakingTitle").textContent = i.type;
  document.getElementById("breakingMeta").textContent = `✅ Confirmed · ${i.location || "Location unavailable"} · ${getAgeText(i.timestamp)}${distance !== null ? ` · ${formatDistance(distance)}` : ""}`;
  const actions = document.getElementById("breakingActions");
  actions.innerHTML = "";
  if (i.location) actions.insertAdjacentHTML("beforeend", `<a class="action-btn blue" href="${escapeHTML(getMapURL(i))}" target="_blank" rel="noopener noreferrer">🗺 MAP</a>`);
  const radio = CITY_PROFILES[i.cityCode]?.radio;
  if (getCategory(i).code === "FIRE" && radio) actions.insertAdjacentHTML("beforeend", `<a class="action-btn red" href="${escapeHTML(radio.url)}" target="_blank" rel="noopener noreferrer">🎧 FIRE RADIO</a>`);
  wrap.style.display = "block";
}

function buildReportingNotes(i) {
  const p = getPriority(i), a = getAssignmentStatus(i), c = getCategory(i), d = getIncidentDistance(i);
  return [
    "BREAKING NEWS MONITOR","","VERIFICATION:",`CONFIRMED — ${CITY_PROFILES[i.cityCode].confirmedLabel}`,"","ASSIGNMENT STATUS:",a.label,"","INCIDENT:",i.type,"","CATEGORY:",c.label,"","PRIORITY:",`${p.code} — ${p.label}`,"","LOCATION:",i.location || "Location unavailable","","DISTANCE FROM ME:",d !== null ? formatDistance(d) : "Unavailable","","REPORTED:",formatIncidentDate(i.timestamp),"","DESCRIPTION:",i.description,"","REPORTING CHECKLIST:","• Confirm details with official agency updates","• Stay clear of emergency operations","• Do not cross police/fire lines","• Treat radio traffic as unconfirmed until corroborated","","SOURCE:",CITY_PROFILES[i.cityCode].confirmedLabel
  ].join("\n");
}

async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); alert("Copied."); return; } } catch (_) {}
  window.prompt("Copy this text:", text);
}

function createIncidentCard(i, newestId) {
  const p = getPriority(i), c = getCategory(i), a = getAssignmentStatus(i), d = getIncidentDistance(i);
  const cardClass = `priority-p${p.level}`;
  const badgeClass = `badge-p${p.level}`;
  const radio = CITY_PROFILES[i.cityCode]?.radio;
  const card = document.createElement("article");
  card.className = `incident-card ${cardClass}`;
  card.innerHTML = `
    <div class="incident-main">
      <div class="incident-topline">
        ${i.id === newestId ? '<span class="badge badge-new">🔥 NEWEST</span>' : ''}
        <span class="badge ${badgeClass}">${p.code} — ${p.label}</span>
        <span class="confirmed-badge">✅ CONFIRMED</span>
        <span class="category-label">${escapeHTML(c.label)}</span>
      </div>
      <div class="incident-title">${escapeHTML(i.type)}</div>
      <div class="assignment-badge ${a.className}">${a.label}</div>
      <div class="assignment-note">${escapeHTML(a.note)}</div>
      ${d !== null ? `<div class="distance-line">📍 ${escapeHTML(formatDistance(d))}</div>` : ''}
      <div class="incident-meta">${escapeHTML(getAgeText(i.timestamp))} · ${escapeHTML(formatIncidentDate(i.timestamp))}</div>
      ${i.location ? `<div class="incident-location">📍 ${escapeHTML(i.location)}</div>` : ''}
      <div class="action-row">
        ${i.location ? `<a class="action-btn blue" href="${escapeHTML(getMapURL(i))}" target="_blank" rel="noopener noreferrer">🗺 MAP</a>` : ''}
        ${c.code === "FIRE" && radio ? `<a class="action-btn red" href="${escapeHTML(radio.url)}" target="_blank" rel="noopener noreferrer">🎧 RADIO</a>` : ''}
        <button class="action-btn reporting-btn" type="button">📋 NOTES</button>
        <button class="action-btn details-btn" type="button">DETAILS</button>
      </div>
    </div>
    <div class="details-panel">
      <div class="detail-row"><div class="detail-label">Verification</div><div class="detail-value">✅ Confirmed through ${escapeHTML(CITY_PROFILES[i.cityCode].confirmedLabel)}.</div></div>
      <div class="detail-row"><div class="detail-label">Description</div><div class="detail-value">${escapeHTML(i.description)}</div></div>
      <div class="detail-row"><div class="detail-label">Status</div><div class="detail-value">${escapeHTML(i.status)}</div></div>
      <div class="detail-row"><div class="detail-label">Incident ID</div><div class="detail-value">${escapeHTML(i.id)}</div></div>
    </div>`;
  const panel = card.querySelector(".details-panel");
  const detailBtn = card.querySelector(".details-btn");
  detailBtn.addEventListener("click", () => { const open = panel.classList.toggle("open"); detailBtn.textContent = open ? "HIDE" : "DETAILS"; });
  card.querySelector(".reporting-btn").addEventListener("click", () => copyText(buildReportingNotes(i)));
  return card;
}

function renderLiveFeed() {
  const container = document.getElementById("incidentList");
  let visible = sortIncidents(applyUserFilter(allIncidents));
  container.innerHTML = "";
  if (!visible.length) { container.innerHTML = '<div class="empty-state">No incidents match this filter.</div>'; return; }
  const newestId = [...allIncidents].sort((a,b) => b.timestamp - a.timestamp)[0]?.id || "";
  visible.forEach(i => container.appendChild(createIncidentCard(i, newestId)));
}

function renderNearby() {
  const list = document.getElementById("nearbyList");
  const summary = document.getElementById("nearbySummary");
  const profile = CITY_PROFILES[activeCityCode];
  if (!profile.supportsNearby) {
    summary.textContent = `${profile.name} is live, but this dataset does not provide incident coordinates for distance sorting yet.`;
    list.innerHTML = '<div class="empty-state">Nearby distance is unavailable for this city source right now. The LIVE feed still works.</div>';
    return;
  }
  if (!userLocation) { summary.textContent = "Enable location to calculate distance."; list.innerHTML = '<div class="empty-state">Location has not been enabled yet.</div>'; return; }
  const radius = Number(document.getElementById("nearbyRadius").value);
  const sort = document.getElementById("nearbySort").value;
  let nearby = allIncidents.map(i => ({ incident:i, distance:getIncidentDistance(i) })).filter(x => x.distance !== null).filter(x => radius >= 999 || x.distance <= radius);
  if (sort === "DISTANCE") nearby.sort((a,b) => a.distance - b.distance);
  else if (sort === "PRIORITY") nearby.sort((a,b) => getPriority(a.incident).level - getPriority(b.incident).level || a.distance - b.distance);
  else nearby.sort((a,b) => b.incident.timestamp - a.incident.timestamp);
  summary.textContent = `${nearby.length} confirmed ${nearby.length === 1 ? "incident" : "incidents"}${radius >= 999 ? " with coordinates available." : ` within ${radius} ${radius === 1 ? "mile" : "miles"}.`}`;
  list.innerHTML = "";
  if (!nearby.length) { list.innerHTML = '<div class="empty-state">No confirmed incidents with usable coordinates are inside this radius right now.</div>'; return; }
  nearby.forEach((x,index) => {
    const i = x.incident, p = getPriority(i), a = getAssignmentStatus(i), c = getCategory(i), radio = CITY_PROFILES[i.cityCode]?.radio;
    const card = document.createElement("article");
    card.className = "nearby-card";
    card.innerHTML = `<div class="nearby-rank">#${index+1} NEAREST CONFIRMED INCIDENT</div><div class="nearby-distance">📍 ${escapeHTML(formatDistance(x.distance))}</div><div class="nearby-title">${escapeHTML(i.type)}</div><div class="assignment-badge ${a.className}">${a.label}</div><div class="nearby-meta">✅ Confirmed · ${p.code} · ${escapeHTML(c.label)}<br>${escapeHTML(getAgeText(i.timestamp))}${i.location ? `<br>📍 ${escapeHTML(i.location)}` : ''}</div><div class="action-row">${i.location ? `<a class="action-btn blue" href="${escapeHTML(getMapURL(i))}" target="_blank" rel="noopener noreferrer">🗺 MAP</a>` : ''}${c.code === "FIRE" && radio ? `<a class="action-btn red" href="${escapeHTML(radio.url)}" target="_blank" rel="noopener noreferrer">🎧 RADIO</a>` : ''}<button class="action-btn nearby-notes" type="button">📋 NOTES</button></div>`;
    card.querySelector(".nearby-notes").addEventListener("click", () => copyText(buildReportingNotes(i)));
    list.appendChild(card);
  });
}

function renderMapList() {
  const container = document.getElementById("mapIncidentList");
  container.innerHTML = "";
  if (!allIncidents.length) { container.innerHTML = '<div class="empty-state">No confirmed incident locations available.</div>'; return; }
  [...allIncidents].sort((a,b) => b.timestamp-a.timestamp).forEach(i => {
    if (!i.location) return;
    const a = getAssignmentStatus(i), d = getIncidentDistance(i);
    const card = document.createElement("div"); card.className = "map-list-card";
    card.innerHTML = `<div class="map-list-title">${escapeHTML(i.type)}</div><div class="assignment-badge ${a.className}">${a.label}</div>${d !== null ? `<div class="distance-line">📍 ${escapeHTML(formatDistance(d))}</div>` : ''}<div class="map-list-location">✅ Confirmed<br>📍 ${escapeHTML(i.location)}<br>${escapeHTML(getAgeText(i.timestamp))}</div><a class="action-btn blue" style="display:inline-block;margin-top:10px" href="${escapeHTML(getMapURL(i))}" target="_blank" rel="noopener noreferrer">VIEW SCENE AREA</a>`;
    container.appendChild(card);
  });
}

function loadSavedLeads() { try { const saved = localStorage.getItem("breakingNewsRadioLeads"); const parsed = saved ? JSON.parse(saved) : []; return Array.isArray(parsed) ? parsed : []; } catch (_) { return []; } }
function saveLeads() { try { localStorage.setItem("breakingNewsRadioLeads", JSON.stringify(radioLeads)); } catch (_) {} }
function addRadioLead() {
  const type = document.getElementById("leadType").value.trim();
  if (!type) { alert("Enter what you heard first."); return; }
  radioLeads.unshift({ id:String(Date.now()), type, area:document.getElementById("leadArea").value.trim(), source:document.getElementById("leadSource").value, notes:document.getElementById("leadNotes").value.trim(), timestamp:Date.now(), cityCode:activeCityCode });
  saveLeads(); document.getElementById("leadType").value=""; document.getElementById("leadArea").value=""; document.getElementById("leadNotes").value=""; renderRadioLeads();
}
function deleteRadioLead(id) { if (!window.confirm("Delete this radio lead?")) return; radioLeads = radioLeads.filter(x => x.id !== id); saveLeads(); renderRadioLeads(); }
function getSafeLeadWording(lead) { return `Radio or app activity indicates a possible ${lead.type}${lead.area ? ` in the ${lead.area} area` : ""}. I have not independently confirmed the details yet.`; }
function renderRadioLeads() {
  const container = document.getElementById("leadList"); container.innerHTML = "";
  if (!radioLeads.length) { container.innerHTML = '<div class="empty-state">No unconfirmed leads saved.</div>'; return; }
  radioLeads.forEach(lead => {
    const safe = getSafeLeadWording(lead); const card = document.createElement("article"); card.className="radio-lead-card";
    card.innerHTML = `<span class="unconfirmed-badge">⚠️ UNCONFIRMED RADIO ACTIVITY</span><div class="assignment-badge assignment-verify">🟡 VERIFY BEFORE REPORTING DETAILS</div><div class="assignment-note">Treat this as an early lead only.</div><div class="lead-title">${escapeHTML(lead.type)}</div><div class="lead-meta">Heard: ${escapeHTML(getAgeText(lead.timestamp))}<br>Source: ${escapeHTML(lead.source)}${lead.area ? `<br>General area: ${escapeHTML(lead.area)}` : ''}</div>${lead.notes ? `<div class="lead-note">${escapeHTML(lead.notes)}</div>` : ''}<div class="safe-language"><div class="safe-title">Safer wording for live/video</div><div class="safe-copy">“${escapeHTML(safe)}”</div></div><div class="action-row"><button class="action-btn copy-safe" type="button">📋 COPY WORDING</button><button class="action-btn delete-lead" type="button">DELETE</button></div>`;
    card.querySelector(".copy-safe").addEventListener("click", () => copyText(safe)); card.querySelector(".delete-lead").addEventListener("click", () => deleteRadioLead(lead.id)); container.appendChild(card);
  });
}

function playAlertSound(force=false) {
  if (!alertsEnabled && !force) return;
  try { const AC = window.AudioContext || window.webkitAudioContext; const ctx = new AC(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); osc.connect(gain); gain.connect(ctx.destination); osc.frequency.value=880; gain.gain.value=.15; osc.start(); osc.stop(ctx.currentTime+.35); } catch (_) {}
}
function enableAlerts() { alertsEnabled=true; const b=document.getElementById("enableAlertsButton"); b.textContent="🔊 ALERTS ENABLED"; b.style.background="#29964f"; document.getElementById("alertsStatus").textContent="Alerts are enabled for new P1 official incidents."; playAlertSound(true); }
function checkForNewP1(list) { const ids = new Set(); list.forEach(i => { ids.add(i.id); if (!firstLoad && !previousIncidentIds.has(i.id) && getPriority(i).level === 1) playAlertSound(); }); previousIncidentIds=ids; firstLoad=false; }

function renderUnknownTypes() {
  const el = document.getElementById("unknownTypesList");
  const values = [...unknownCallTypes].sort();
  el.innerHTML = values.length ? values.map(v => `• ${escapeHTML(v)}`).join("<br>") : "None yet.";
}

function renderRadioPanel() {
  const profile = CITY_PROFILES[activeCityCode];
  const title = document.getElementById("radioTitle"), copy = document.getElementById("radioCopy"), button = document.getElementById("radioButton");
  if (profile.radio) { title.textContent = profile.radio.title; copy.textContent = profile.radio.copy; button.href = profile.radio.url; button.style.display = "inline-block"; }
  else { title.textContent = `${profile.name} Radio`; copy.textContent = "No verified radio link has been connected for this city profile yet. The official incident feed remains available."; button.style.display = "none"; }
}

function renderEverything() {
  updateSummary(); updateBreakingStory(); renderLiveFeed(); renderNearby(); renderMapList(); renderRadioLeads(); renderUnknownTypes(); renderRadioPanel();
  document.getElementById("incidentCount").textContent = `${allIncidents.length} ${allIncidents.length === 1 ? "incident" : "incidents"}`;
  document.getElementById("confirmedSourceLabel").textContent = CITY_PROFILES[activeCityCode].confirmedLabel;
  document.getElementById("mapPanelNote").textContent = `Locations below come from ${CITY_PROFILES[activeCityCode].confirmedLabel}.`;
}

function setStatus(status) {
  const text=document.getElementById("statusText"), dot=document.getElementById("statusDot");
  if (status === "LIVE") { text.textContent="LIVE"; dot.style.background="#39c96a"; return; }
  if (status === "CHECKING") { text.textContent="CHECKING"; dot.style.background="#ffb723"; return; }
  text.textContent="FEED ERROR"; dot.style.background="#e73b33";
}

async function loadIncidents() {
  setStatus("CHECKING");
  try {
    unknownCallTypes = new Set();
    const data = await fetchCityIncidents(activeCityCode);
    allIncidents = filterRecentIncidents(data);
    checkForNewP1(allIncidents);
    renderEverything();
    setStatus("LIVE");
    document.getElementById("lastChecked").textContent = `${CITY_PROFILES[activeCityCode].shortName} feed checked: ${new Date().toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",second:"2-digit"})}`;
  } catch (error) {
    console.error(error); setStatus("ERROR"); document.getElementById("lastChecked").textContent = `Unable to refresh ${CITY_PROFILES[activeCityCode].name}: ${error.message}`;
  }
}

function nearestCityCode(lat, lon) {
  let best = "OKC", bestMiles = Infinity;
  Object.entries(CITY_PROFILES).forEach(([code,p]) => { const d=calculateDistanceMiles(lat,lon,p.center.latitude,p.center.longitude); if (d < bestMiles) { bestMiles=d; best=code; } });
  return best;
}

async function applyCityMode() {
  const select = document.getElementById("citySelect"); selectedCityMode = select.value;
  if (selectedCityMode !== "AUTO") { activeCityCode = selectedCityMode; document.getElementById("cityModeNote").textContent = `${CITY_PROFILES[activeCityCode].name} official source selected.`; await loadIncidents(); return; }
  if (userLocation) { activeCityCode = nearestCityCode(userLocation.latitude,userLocation.longitude); document.getElementById("cityModeNote").textContent = `AUTO detected nearest supported city: ${CITY_PROFILES[activeCityCode].name}.`; await loadIncidents(); return; }
  activeCityCode = "OKC";
  document.getElementById("cityModeNote").textContent = "AUTO needs location for city switching. Using Oklahoma City until location is enabled.";
  await loadIncidents();
}

function updateLocationStatus(message) { document.getElementById("locationStatus").textContent = message; }
function startLocation() {
  if (!navigator.geolocation) { updateLocationStatus("Location is not supported by this browser."); return; }
  updateLocationStatus("Requesting your location…");
  locationWatchId = navigator.geolocation.watchPosition(async position => {
    userLocation = { latitude:position.coords.latitude, longitude:position.coords.longitude, accuracy:position.coords.accuracy };
    updateLocationStatus(`📍 Location active · accuracy approximately ${Math.round(position.coords.accuracy*3.28084)} ft · distances update as you move.`);
    document.getElementById("stopLocationButton").disabled=false; document.getElementById("useLocationButton").textContent="📍 LOCATION ACTIVE";
    if (selectedCityMode === "AUTO") {
      const detected = nearestCityCode(userLocation.latitude,userLocation.longitude);
      if (detected !== activeCityCode) { activeCityCode = detected; document.getElementById("cityModeNote").textContent = `AUTO detected nearest supported city: ${CITY_PROFILES[activeCityCode].name}.`; await loadIncidents(); return; }
    }
    renderNearby(); renderLiveFeed(); updateBreakingStory();
  }, error => {
    const msg = error.code===1 ? "Location permission was denied. Allow location access and try again." : error.code===2 ? "Your location is temporarily unavailable." : "Location request timed out. Try again."; updateLocationStatus(msg);
  }, { enableHighAccuracy:true, timeout:15000, maximumAge:15000 });
}
function stopLocation() { if (locationWatchId !== null) navigator.geolocation.clearWatch(locationWatchId); locationWatchId=null; userLocation=null; document.getElementById("stopLocationButton").disabled=true; document.getElementById("useLocationButton").textContent="📍 USE MY LOCATION"; updateLocationStatus("Location is off. Your position is no longer being used."); renderNearby(); renderLiveFeed(); updateBreakingStory(); }

function switchTab(tab) {
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab===tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
  document.getElementById(`panel-${tab}`)?.classList.add("active");
  if (tab === "nearby") renderNearby();
  window.scrollTo({top:0,behavior:"smooth"});
}

document.querySelectorAll(".filter-btn").forEach(button => button.addEventListener("click", () => { document.querySelectorAll(".filter-btn").forEach(b=>b.classList.remove("active")); button.classList.add("active"); currentFilter=button.dataset.filter; renderLiveFeed(); }));
document.getElementById("sortSelect").addEventListener("change", e => { currentSort=e.target.value; if (currentSort==="DISTANCE" && !userLocation) { switchTab("nearby"); updateLocationStatus("Enable location first to sort incidents by distance."); return; } renderLiveFeed(); });
document.getElementById("citySelect").addEventListener("change", applyCityMode);
document.getElementById("useLocationButton").addEventListener("click", startLocation);
document.getElementById("stopLocationButton").addEventListener("click", stopLocation);
document.getElementById("nearbyRadius").addEventListener("change", renderNearby);
document.getElementById("nearbySort").addEventListener("change", renderNearby);
document.getElementById("addLeadButton").addEventListener("click", addRadioLead);
document.getElementById("enableAlertsButton").addEventListener("click", enableAlerts);
document.getElementById("testAlertButton").addEventListener("click", () => { alertsEnabled=true; playAlertSound(true); alert("P1 alert test played. This did not create a real incident."); });
document.querySelectorAll(".nav-btn").forEach(button => button.addEventListener("click", () => switchTab(button.dataset.tab)));

renderRadioLeads();
renderNearby();
applyCityMode();
setInterval(loadIncidents, REFRESH_INTERVAL);
