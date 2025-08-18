Weiter zum Inhalt
Chatverlauf

Du:
ich habe folgenden code, der mit der api von ors verknüpft ist: 

// script.js
// Dynamic isochrones per workshop click + 15/30/45 vs 60 comparison popup + station filtering + toggle off on re-click

// ---------- CONFIG ----------
const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjJiMWZmNzYzNGZjMTRlYzlhODY0ZjMyOWE3ODFkNmVlIiwiaCI6Im11cm11cjY0In0=';
const WORKSHOPS_FILE = 'Workshops.geojson';
const NEXTBIKE_URLS = [
  'https://api.nextbike.net/maps/nextbike-official.json?countries=de',
  'https://api.nextbike.net/maps/nextbike-official.json?countries=at'
];

// ---------- MAP ----------
const map = L.map('map', { minZoom: 6, maxZoom: 18 }).setView([51.1657, 10.4515], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// ---------- ICONS ----------
const defaultIcon = L.icon({ iconUrl: 'Icons/nextbike_icon_32x32.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });
const breakIcon   = L.icon({ iconUrl: 'Icons/nextbike_break_icon_32x32.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });
const workshopIcon= L.icon({ iconUrl: 'Icons/Workshop.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });

// ---------- LAYERS ----------
const workshopsLayer = L.layerGroup().addTo(map);
const isoLayer15 = L.layerGroup().addTo(map);
const isoLayer30 = L.layerGroup().addTo(map);
const isoLayer45 = L.layerGroup().addTo(map);
const isoLayer60 = L.layerGroup().addTo(map);
const bikeCluster = L.markerClusterGroup({
  disableClusteringAtZoom: 15,
  iconCreateFunction: () => L.divIcon({
    html: <img src="Icons/nextbike_icon_32x32.png" width="32" height="32">,
    iconSize: [32,32], className: ''
  })
}).addTo(map);
const filteredBikeLayer = L.layerGroup().addTo(map);

L.control.layers(null, {
  'Werkstätten': workshopsLayer,
  'Fahrradstationen': bikeCluster,
  'Gefilterte Stationen': filteredBikeLayer,
  'Isochrone 15': isoLayer15,
  'Isochrone 30': isoLayer30,
  'Isochrone 45': isoLayer45,
  'Isochrone 60': isoLayer60
}).addTo(map);

// ---------- UI CONTROL ----------
const AnalysisControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'analysis-control');
    div.innerHTML = 
      <button id="btn15">Vergleich 15 vs 60</button>
      <button id="btn30">Vergleich 30 vs 60</button>
      <button id="btn45">Vergleich 45 vs 60</button>
      <button id="btnHeat">Heatmap an/aus</button>
      <div style="margin-top:6px;font-size:12px;color:#444">Klicke zuerst eine Werkstatt</div>
    ;
    L.DomEvent.disableClickPropagation(div);
    return div;
  }
});
map.addControl(new AnalysisControl({ position: 'topright' }));

// ---------- GLOBALS ----------
let stationsData = [];
let currentIso = {};
let currentWorkshop = null;  // {lon,lat,marker,props}
let tempWorkshopMode = false;
let tempWorkshops = []; // speichert ALLE temporären Marker

// Heatmap-Referenz
let heatLayer = null;
let heatVisible = true; // standardmäßig sichtbar (kann angepasst werden)

// ---------- HELPERS ----------
function parseCoordVal(v){
  if (v === undefined || v === null) return NaN;
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(',', '.'));
}
function stationPopupHtml(s){
  return <strong>${s.name ?? 'Station'}</strong><br>Verfügbare Räder: <strong>${s.bikes ?? 0}</strong>;
}
function centroidOfFeature(feature){
  try {
    const cent = turf.center(feature);
    const [lng, lat] = cent.geometry.coordinates;
    return [lat, lng];
  } catch {
    const bbox = turf.bbox(feature);
    return [(bbox[1]+bbox[3])/2, (bbox[0]+bbox[2])/2];
  }
}
function clearAll(){
  clearIsoLayers();
  filteredBikeLayer.clearLayers();
  currentIso = {};
  currentWorkshop = null;
}

// Rechtsklick: Alles zurücksetzen (belassen wir so, die Heatmap bleibt)
map.on('contextmenu', function () {
  isoLayer15.clearLayers();
  isoLayer30.clearLayers();
  isoLayer45.clearLayers();
  isoLayer60.clearLayers();
  filteredBikeLayer.clearLayers();
  currentWorkshop = null;
  currentIso = {};
  map.closePopup();
});

// ---------- LOAD STATIONS & HEATMAP ----------
async function loadStations(){
  stationsData = [];
  bikeCluster.clearLayers();
  const seenStations = new Set();

  try {
    // lade alle NEXTBIKE_URLS (DE + AT)
    for (const url of NEXTBIKE_URLS){
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const json = await res.json();
        json.countries?.forEach(country => {
          country.cities?.forEach(city => {
            city.places?.forEach(p => {
              const lat = parseCoordVal(p.lat);
              const lng = parseCoordVal(p.lng);
              const stationId = p.uid || ${lat},${lng};
              if (seenStations.has(stationId)) return;
              seenStations.add(stationId);

              const bikes = (typeof p.bikes === 'number')
                ? p.bikes
                : (Array.isArray(p.bikes) ? p.bikes.length : (p.bikes ?? 0));

              const feature = { lat, lng, bikes, name: p.name, raw: p };
              stationsData.push(feature);

              const icon = bikes === 0 ? breakIcon : defaultIcon;
              L.marker([lat, lng], { icon })
               .bindPopup(stationPopupHtml(feature))
               .addTo(bikeCluster);
            });
          });
        });
      } catch (err) {
        console.error('Error loading nextbike', err);
      }
    }

    // --- Heatmap-Gewichtung: stationsData -> heatData ---
    if (typeof L.heatLayer !== 'function') {
      console.warn('Leaflet.heat ist nicht geladen. Bitte <script src="https://unpkg.com/leaflet.heat/dist/leaflet-heat.js"></script> einfügen.');
    } else {
      // Bestimme höchsten bikes-Wert, damit wir normieren können
      const maxBikes = stationsData.reduce((m,s) => Math.max(m, (s.bikes||0)), 0);

      const heatData = stationsData.map(s => {
        // Gewicht ist Anzahl der verfügbaren Fahrräder (Dichte der Bikes)
        return [s.lat, s.lng, s.bikes || 0];
      });

      // Alte Heatmap entfernen
      if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);

      // Neue Heatmap hinzufügen mit max = maxBikes
      heatLayer = L.heatLayer(heatData, {
        radius: 25,
        blur: 15,
        maxZoom: 17,
        max: maxBikes > 0 ? maxBikes : 1
      });

      if (heatVisible) {
        heatLayer.addTo(map);
      }
    }

  } catch (err) {
    console.error('Fehler beim Laden der Stationen/Heatmap:', err);
  }
}

// ---------- LOAD WORKSHOPS ----------
async function loadWorkshops(){
  try {
    const res = await fetch(WORKSHOPS_FILE);
    const gj = await res.json();
    workshopsLayer.clearLayers();
    L.geoJSON(gj, {
      pointToLayer: (feature, latlng) => {
        let lon = parseCoordVal(feature.geometry.coordinates[0]);
        let lat = parseCoordVal(feature.geometry.coordinates[1]);
        const marker = L.marker([lat, lon], { icon: workshopIcon });
        const title = feature.properties?.Systeme ?? feature.properties?.Stadt ?? 'Werkstatt';
        const addr  = feature.properties?.Adresse ?? '';

        marker.bindPopup(<strong>${title}</strong><br>${addr}<br><em>Klicken für Isochrone</em>);

        marker.on('click', async () => selectWorkshop(marker, lon, lat, title, addr, feature.properties));

        return marker;
      }
    }).addTo(workshopsLayer);
  } catch (err) { console.error('Load workshops error', err); }
}

// ---------- SELECT WORKSHOP ----------
async function selectWorkshop(marker, lon, lat, title, addr, props) {
  if (currentWorkshop && currentWorkshop.marker === marker) return;

  currentWorkshop = { lon, lat, marker, props };
  try {
    await computeIsochronesForWorkshop(lon, lat);
    showIso(60);
    marker.setPopupContent(<strong>${title}</strong><br>${addr}<br><em>Isochrone (60min) geladen</em>);
    map.setView([lat, lon], 13);
  } catch (e) {
    marker.setPopupContent(<strong>${title}</strong><br>${addr}<br><span style="color:red">Isochronen Fehler</span>);
  }
}

// ---------- COMPUTE ISOCHRONES ----------
async function computeIsochronesForWorkshop(lon, lat){
  const ranges = [15*60, 30*60, 45*60, 60*60];
  const url = 'https://api.openrouteservice.org/v2/isochrones/cycling-regular';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': ORS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json, application/geo+json'
    },
    body: JSON.stringify({ locations: [[lon, lat]], range: ranges })
  });
  const isojson = await res.json();
  currentIso = {};
  isojson.features.forEach(f => {
    const mins = Number(f.properties?.value) / 60;
    currentIso[mins] = { type: 'FeatureCollection', features: [f] };
  });
}

// ---------- SHOW / CLEAR ISO LAYERS ----------
function clearIsoLayers(){
  isoLayer15.clearLayers();
  isoLayer30.clearLayers();
  isoLayer45.clearLayers();
  isoLayer60.clearLayers();
}
function showIso(mins){
  const featureCollection = currentIso[mins];
  if (!featureCollection) return;
  const style = { color: mins === 60 ? '#0000FF' : (mins===15? '#7CFC00' : mins===30? '#FFA500' : '#FF0000'), weight: 1, fillOpacity: 0.18 };
  const layerMap = { 15: isoLayer15, 30: isoLayer30, 45: isoLayer45, 60: isoLayer60 };
  L.geoJSON(featureCollection, { style }).addTo(layerMap[mins]);
}

// ---------- COUNT & SHOW BIKES INSIDE ----------
function getStationsInFeature(featureCollection){
  if (!featureCollection || !featureCollection.features.length) return [];
  const poly = featureCollection.features[0];
  return stationsData.filter(s => {
    const pt = turf.point([s.lng, s.lat]);
    return turf.booleanPointInPolygon(pt, poly);
  });
}

// ---------- BUTTON HANDLERS ----------
let comparePopups = [];

async function handleCompare(minSmall){
  if (!currentWorkshop || !currentIso[60]) {
    alert('Bitte zuerst eine Werkstatt klicken.');
    return;
  }
  const smallIso = currentIso[minSmall];
  const bigIso = currentIso[60];
  if (!smallIso || !bigIso) return;

  filteredBikeLayer.clearLayers();

  L.geoJSON(smallIso, { style: { color:'#00A', weight:1, fillOpacity:0.2 } }).addTo(
    minSmall === 15 ? isoLayer15 : minSmall === 30 ? isoLayer30 : isoLayer45
  );
  L.geoJSON(bigIso, { style: { color:'#0000FF', weight:1, fillOpacity:0.12 } }).addTo(isoLayer60);

  const smallStations = getStationsInFeature(smallIso);
  smallStations.forEach(s => {
    const icon = s.bikes === 0 ? breakIcon : defaultIcon;
    L.marker([s.lat, s.lng], { icon }).bindPopup(stationPopupHtml(s)).addTo(filteredBikeLayer);
  });

  const smallCount = smallStations.reduce((sum,s)=>sum+(s.bikes||0),0);
  const bigCount   = getStationsInFeature(bigIso).reduce((sum,s)=>sum+(s.bikes||0),0);

  const popupLatLng = centroidOfFeature(bigIso);
  const popupHtml =
    <div style="font-weight:600">Vergleich ${minSmall}min vs 60min</div> +
    <div>🚲 ${minSmall}min: <strong>${smallCount}</strong> verfügbare Räder</div> +
    <div>🚲 60min: <strong>${bigCount}</strong> verfügbare Räder</div>;

  L.popup({ maxWidth: 320, autoClose: false, closeOnClick: false })
    .setLatLng(popupLatLng)
    .setContent(popupHtml)
    .addTo(map);
}

// Event-Handler für Compare + Heat Toggle
document.addEventListener('click', (ev) => {
  if (ev.target.id === 'btn15') handleCompare(15);
  if (ev.target.id === 'btn30') handleCompare(30);
  if (ev.target.id === 'btn45') handleCompare(45);

  if (ev.target.id === 'btnHeat') {
    if (!heatLayer) {
      alert('Heatmap noch nicht initialisiert — bitte Seite neu laden oder Stationsdaten neu laden.');
      return;
    }
    if (map.hasLayer(heatLayer)) {
      map.removeLayer(heatLayer);
      heatVisible = false;
      ev.target.textContent = 'Heatmap an';
    } else {
      heatLayer.addTo(map);
      heatVisible = true;
      ev.target.textContent = 'Heatmap aus';
    }
  }
});

// ---------- TEMP WORKSHOP BUTTON ----------
const TempWorkshopControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'analysis-control');
    div.innerHTML = <button id="btnTempWorkshop">Neue Werkstatt setzen</button>;
    L.DomEvent.disableClickPropagation(div);
    return div;
  }
});
map.addControl(new TempWorkshopControl({ position: 'topleft' }));

map.on('click', async (e) => {
  if (!tempWorkshopMode) {
    if (!e.originalEvent.target.closest('.leaflet-popup') && !e.originalEvent.target.closest('.analysis-control')) {
      // clearAll();
    }
    return;
  }
  tempWorkshopMode = false;
  map.getContainer().style.cursor = '';

  const { lat, lng } = e.latlng;
  const marker = L.marker([lat, lng], { icon: workshopIcon }).addTo(map);
  tempWorkshops.push(marker);

  marker.bindPopup(
    <strong>Temporäre Werkstatt</strong><br> +
    Klicken für Isochrone.<br> +
    <em>Kann jederzeit wieder ausgewählt werden</em>
  );

  marker.on('click', () => selectWorkshop(marker, lng, lat, 'Temporäre Werkstatt', '', { Adresse: 'Temporär gesetzt' }));

  await selectWorkshop(marker, lng, lat, 'Temporäre Werkstatt', '', { Adresse: 'Temporär gesetzt' });
});

document.addEventListener('click', (ev) => {
  if (ev.target.id === 'btnTempWorkshop') {
    tempWorkshopMode = true;
    map.getContainer().style.cursor = 'crosshair';
    alert('Klicke auf die Karte, um eine neue Werkstatt zu setzen.');
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Delete' && currentWorkshop) {
    const isTemp = tempWorkshops.includes(currentWorkshop.marker);
    if (isTemp) {
      map.removeLayer(currentWorkshop.marker);
      tempWorkshops = tempWorkshops.filter(m => m !== currentWorkshop.marker);
      clearAll();
    }
  }
});

// ---------- INIT ----------
(async function init(){
  await Promise.all([ loadStations(), loadWorkshops() ]);
})();

kannst du die isochronen anfrage aktuallisieren hiermit?

  curl -X POST \
  'https://api.openrouteservice.org/v2/isochrones/driving-car' \
  -H 'Content-Type: application/json; charset=utf-8' \
  -H 'Accept: application/json, application/geo+json, application/gpx+xml, img/png; charset=utf-8' \
  -H 'Authorization: eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjJiMWZmNzYzNGZjMTRlYzlhODY0ZjMyOWE3ODFkNmVlIiwiaCI6Im11cm11cjY0In0=' \
  -d '{"locations":[[8.681495,49.41461],[8.686507,49.41943]],"range":[300,200],"intersections":"true","interval":90,"location_type":"start","range_type":"time","smoothing":0}'

es soll isochronen von 90 minten anzeigen, die mit dem auto erreichbar sind für die werkstätten
ChatGPT:
Alles klar 👍 – aktuell fragt dein Code Isochronen mit cycling-regular und festen Ranges (15,30,45,60 Minuten) ab.
Du möchtest das so ändern, dass:

Modus: driving-car (Auto statt Fahrrad)

Range: 90 Minuten (5400 Sekunden)

Werkstatt-Klick erzeugt nur diese Isochrone

Ich passe dir die Funktion computeIsochronesForWorkshop und die Darstellung an:

// ---------- COMPUTE ISOCHRONES ----------
// nur 90 Minuten Isochrone (Auto)
async function computeIsochronesForWorkshop(lon, lat){
  const url = 'https://api.openrouteservice.org/v2/isochrones/driving-car';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': ORS_API_KEY,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json, application/geo+json'
    },
    body: JSON.stringify({
      locations: [[lon, lat]],
      range: [90 * 60],          // 90 Minuten = 5400 Sekunden
      intersections: true,
      location_type: "start",
      range_type: "time",
      smoothing: 0
    })
  });

  const isojson = await res.json();
  currentIso = {};
  isojson.features.forEach(f => {
    const mins = Number(f.properties?.value) / 60;
    currentIso[mins] = { type: 'FeatureCollection', features: [f] };
  });
}

// ---------- SHOW ISO LAYER ----------
// nur noch 90 Minuten sichtbar
function clearIsoLayers(){
  isoLayer15.clearLayers();
  isoLayer30.clearLayers();
  isoLayer45.clearLayers();
  isoLayer60.clearLayers();
}
function showIso(mins){
  const featureCollection = currentIso[mins];
  if (!featureCollection) return;
  const style = { color: '#0000FF', weight: 2, fillOpacity: 0.2 };
  L.geoJSON(featureCollection, { style }).addTo(isoLayer60);
}
👉 Änderungen im Überblick:

driving-car API verwendet

nur eine Range (90 Minuten)

showIso zeigt ausschließlich die 90-Minuten-Isochrone (in Blau)

unnötige Buttons btn15, btn30, btn45 kannst du entfernen oder deaktivieren

Möchtest du, dass ich den Rest des Codes (UI-Buttons etc.) auch gleich anpasse, sodass nur noch ein "90 Minuten Auto-Isochrone anzeigen" Button bleibt?

Du:
gib mir den kompletten code
ChatGPT:
Alles klar – hier ist dein kompletter Code, angepasst für Auto-Isochronen mit 90 Minuten.
Ich habe alle alten 15/30/45/60-Funktionen entfernt und die UI auf nur eine Isochrone (90 Minuten) reduziert.
Die Heatmap, Werkstätten und temporäre Werkstätten habe ich drin gelassen.

// script.js
// Isochrone Auto (90min) + Heatmap + Stationen + Werkstätten + temporäre Werkstätten

// ---------- CONFIG ----------
const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjJiMWZmNzYzNGZjMTRlYzlhODY0ZjMyOWE3ODFkNmVlIiwiaCI6Im11cm11cjY0In0=';
const WORKSHOPS_FILE = 'Workshops.geojson';
const NEXTBIKE_URLS = [
  'https://api.nextbike.net/maps/nextbike-official.json?countries=de',
  'https://api.nextbike.net/maps/nextbike-official.json?countries=at'
];

// ---------- MAP ----------
const map = L.map('map', { minZoom: 6, maxZoom: 18 }).setView([51.1657, 10.4515], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// ---------- ICONS ----------
const defaultIcon = L.icon({ iconUrl: 'Icons/nextbike_icon_32x32.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });
const breakIcon   = L.icon({ iconUrl: 'Icons/nextbike_break_icon_32x32.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });
const workshopIcon= L.icon({ iconUrl: 'Icons/Workshop.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });

// ---------- LAYERS ----------
const workshopsLayer = L.layerGroup().addTo(map);
const isoLayer90 = L.layerGroup().addTo(map);
const bikeCluster = L.markerClusterGroup({
  disableClusteringAtZoom: 15,
  iconCreateFunction: () => L.divIcon({
    html: `<img src="Icons/nextbike_icon_32x32.png" width="32" height="32">`,
    iconSize: [32,32], className: ''
  })
}).addTo(map);
const filteredBikeLayer = L.layerGroup().addTo(map);

L.control.layers(null, {
  'Werkstätten': workshopsLayer,
  'Fahrradstationen': bikeCluster,
  'Gefilterte Stationen': filteredBikeLayer,
  'Isochrone 90min (Auto)': isoLayer90
}).addTo(map);

// ---------- UI CONTROL ----------
const AnalysisControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'analysis-control');
    div.innerHTML = `
      <button id="btnHeat">Heatmap an/aus</button>
      <div style="margin-top:6px;font-size:12px;color:#444">Klicke zuerst eine Werkstatt</div>
    `;
    L.DomEvent.disableClickPropagation(div);
    return div;
  }
});
map.addControl(new AnalysisControl({ position: 'topright' }));

// ---------- GLOBALS ----------
let stationsData = [];
let currentIso = {};
let currentWorkshop = null;  // {lon,lat,marker,props}
let tempWorkshopMode = false;
let tempWorkshops = []; // speichert ALLE temporären Marker

// Heatmap-Referenz
let heatLayer = null;
let heatVisible = true; // standardmäßig sichtbar

// ---------- HELPERS ----------
function parseCoordVal(v){
  if (v === undefined || v === null) return NaN;
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(',', '.'));
}
function stationPopupHtml(s){
  return `<strong>${s.name ?? 'Station'}</strong><br>Verfügbare Räder: <strong>${s.bikes ?? 0}</strong>`;
}
function centroidOfFeature(feature){
  try {
    const cent = turf.center(feature);
    const [lng, lat] = cent.geometry.coordinates;
    return [lat, lng];
  } catch {
    const bbox = turf.bbox(feature);
    return [(bbox[1]+bbox[3])/2, (bbox[0]+bbox[2])/2];
  }
}
function clearAll(){
  clearIsoLayers();
  filteredBikeLayer.clearLayers();
  currentIso = {};
  currentWorkshop = null;
}

// Rechtsklick: Alles zurücksetzen
map.on('contextmenu', function () {
  isoLayer90.clearLayers();
  filteredBikeLayer.clearLayers();
  currentWorkshop = null;
  currentIso = {};
  map.closePopup();
});

// ---------- LOAD STATIONS & HEATMAP ----------
async function loadStations(){
  stationsData = [];
  bikeCluster.clearLayers();
  const seenStations = new Set();

  try {
    for (const url of NEXTBIKE_URLS){
      try {
        const res = await fetch(url);
        if (!res.ok) continue;
        const json = await res.json();
        json.countries?.forEach(country => {
          country.cities?.forEach(city => {
            city.places?.forEach(p => {
              const lat = parseCoordVal(p.lat);
              const lng = parseCoordVal(p.lng);
              const stationId = p.uid || `${lat},${lng}`;
              if (seenStations.has(stationId)) return;
              seenStations.add(stationId);

              const bikes = (typeof p.bikes === 'number')
                ? p.bikes
                : (Array.isArray(p.bikes) ? p.bikes.length : (p.bikes ?? 0));

              const feature = { lat, lng, bikes, name: p.name, raw: p };
              stationsData.push(feature);

              const icon = bikes === 0 ? breakIcon : defaultIcon;
              L.marker([lat, lng], { icon })
               .bindPopup(stationPopupHtml(feature))
               .addTo(bikeCluster);
            });
          });
        });
      } catch (err) {
        console.error('Error loading nextbike', err);
      }
    }

    if (typeof L.heatLayer !== 'function') {
      console.warn('Leaflet.heat ist nicht geladen.');
    } else {
      const maxBikes = stationsData.reduce((m,s) => Math.max(m, (s.bikes||0)), 0);
      const heatData = stationsData.map(s => [s.lat, s.lng, s.bikes || 0]);

      if (heatLayer && map.hasLayer(heatLayer)) map.removeLayer(heatLayer);

      heatLayer = L.heatLayer(heatData, {
        radius: 25,
        blur: 15,
        maxZoom: 17,
        max: maxBikes > 0 ? maxBikes : 1
      });

      if (heatVisible) heatLayer.addTo(map);
    }

  } catch (err) {
    console.error('Fehler beim Laden der Stationen/Heatmap:', err);
  }
}

// ---------- LOAD WORKSHOPS ----------
async function loadWorkshops(){
  try {
    const res = await fetch(WORKSHOPS_FILE);
    const gj = await res.json();
    workshopsLayer.clearLayers();
    L.geoJSON(gj, {
      pointToLayer: (feature, latlng) => {
        let lon = parseCoordVal(feature.geometry.coordinates[0]);
        let lat = parseCoordVal(feature.geometry.coordinates[1]);
        const marker = L.marker([lat, lon], { icon: workshopIcon });
        const title = feature.properties?.Systeme ?? feature.properties?.Stadt ?? 'Werkstatt';
        const addr  = feature.properties?.Adresse ?? '';

        marker.bindPopup(`<strong>${title}</strong><br>${addr}<br><em>Klicken für Isochrone</em>`);

        marker.on('click', async () => selectWorkshop(marker, lon, lat, title, addr, feature.properties));

        return marker;
      }
    }).addTo(workshopsLayer);
  } catch (err) { console.error('Load workshops error', err); }
}

// ---------- SELECT WORKSHOP ----------
async function selectWorkshop(marker, lon, lat, title, addr, props) {
  if (currentWorkshop && currentWorkshop.marker === marker) return;

  currentWorkshop = { lon, lat, marker, props };
  try {
    await computeIsochronesForWorkshop(lon, lat);
    showIso(90);
    marker.setPopupContent(`<strong>${title}</strong><br>${addr}<br><em>Isochrone (90min Auto) geladen</em>`);
    map.setView([lat, lon], 11);
  } catch (e) {
    marker.setPopupContent(`<strong>${title}</strong><br>${addr}<br><span style="color:red">Isochronen Fehler</span>`);
  }
}

// ---------- COMPUTE ISOCHRONES ----------
// nur 90 Minuten Isochrone (Auto)
async function computeIsochronesForWorkshop(lon, lat){
  const url = 'https://api.openrouteservice.org/v2/isochrones/driving-car';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': ORS_API_KEY,
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json, application/geo+json'
    },
    body: JSON.stringify({
      locations: [[lon, lat]],
      range: [90 * 60],          // 90 Minuten = 5400 Sekunden
      intersections: true,
      location_type: "start",
      range_type: "time",
      smoothing: 0
    })
  });

  const isojson = await res.json();
  currentIso = {};
  isojson.features.forEach(f => {
    const mins = Number(f.properties?.value) / 60;
    currentIso[mins] = { type: 'FeatureCollection', features: [f] };
  });
}

// ---------- SHOW / CLEAR ISO LAYERS ----------
function clearIsoLayers(){
  isoLayer90.clearLayers();
}
function showIso(mins){
  const featureCollection = currentIso[mins];
  if (!featureCollection) return;
  const style = { color: '#0000FF', weight: 2, fillOpacity: 0.2 };
  L.geoJSON(featureCollection, { style }).addTo(isoLayer90);
}

// ---------- BUTTON HANDLERS ----------
document.addEventListener('click', (ev) => {
  if (ev.target.id === 'btnHeat') {
    if (!heatLayer) {
      alert('Heatmap noch nicht initialisiert.');
      return;
    }
    if (map.hasLayer(heatLayer)) {
      map.removeLayer(heatLayer);
      heatVisible = false;
      ev.target.textContent = 'Heatmap an';
    } else {
      heatLayer.addTo(map);
      heatVisible = true;
      ev.target.textContent = 'Heatmap aus';
    }
  }
});

// ---------- TEMP WORKSHOP BUTTON ----------
const TempWorkshopControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'analysis-control');
    div.innerHTML = `<button id="btnTempWorkshop">Neue Werkstatt setzen</button>`;
    L.DomEvent.disableClickPropagation(div);
    return div;
  }
});
map.addControl(new TempWorkshopControl({ position: 'topleft' }));

map.on('click', async (e) => {
  if (!tempWorkshopMode) {
    return;
  }
  tempWorkshopMode = false;
  map.getContainer().style.cursor = '';

  const { lat, lng } = e.latlng;
  const marker = L.marker([lat, lng], { icon: workshopIcon }).addTo(map);
  tempWorkshops.push(marker);

  marker.bindPopup(
    `<strong>Temporäre Werkstatt</strong><br>` +
    `Klicken für Isochrone.<br>` +
    `<em>Kann jederzeit wieder ausgewählt werden</em>`
  );

  marker.on('click', () => selectWorkshop(marker, lng, lat, 'Temporäre Werkstatt', '', { Adresse: 'Temporär gesetzt' }));

  await selectWorkshop(marker, lng, lat, 'Temporäre Werkstatt', '', { Adresse: 'Temporär gesetzt' });
});

document.addEventListener('click', (ev) => {
  if (ev.target.id === 'btnTempWorkshop') {
    tempWorkshopMode = true;
    map.getContainer().style.cursor = 'crosshair';
    alert('Klicke auf die Karte, um eine neue Werkstatt zu setzen.');
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Delete' && currentWorkshop) {
    const isTemp = tempWorkshops.includes(currentWorkshop.marker);
    if (isTemp) {
      map.removeLayer(currentWorkshop.marker);
      tempWorkshops = tempWorkshops.filter(m => m !== currentWorkshop.marker);
      clearAll();
    }
  }
});

// ---------- INIT ----------
(async function init(){
  await Promise.all([ loadStations(), loadWorkshops() ]);
})();
Damit bekommst du beim Klick auf eine Werkstatt nur noch eine Isochrone (90 Minuten, Auto) angezeigt.
Soll ich dir noch Buttons für verschiedene Fahrzeiten (z. B. 30, 60, 90 Minuten) mit driving-car einbauen?

Du:
// script.js
// Dynamic isochrones per workshop click + 15/30/45 vs 60 comparison popup + station filtering + toggle off on re-click

// ---------- CONFIG ----------
const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjJiMWZmNzYzNGZjMTRlYzlhODY0ZjMyOWE3ODFkNmVlIiwiaCI6Im11cm11cjY0In0=';
const WORKSHOPS_FILE = 'Workshops.geojson';
const NEXTBIKE_URLS = [
  'https://api.nextbike.net/maps/nextbike-official.json?countries=de',
  'https://api.nextbike.net/maps/nextbike-official.json?countries=at'
];

// ---------- MAP ----------
const map = L.map('map', { minZoom: 6, maxZoom: 18 }).setView([51.1657, 10.4515], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// ---------- ICONS ----------
const defaultIcon = L.icon({ iconUrl: 'Icons/nextbike_icon_32x32.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });
const breakIcon   = L.icon({ iconUrl: 'Icons/nextbike_break_icon_32x32.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });
const workshopIcon= L.icon({ iconUrl: 'Icons/Workshop.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });

// ---------- LAYERS ----------
const workshopsLayer = L.layerGroup().addTo(map);
const isoLayer15 = L.layerGroup().addTo(map);
const isoLayer30 = L.layerGroup().addTo(map);
const isoLayer45 = L.layerGroup().addTo(map);
const isoLayer60 = L.layerGroup().addTo(map);
const bikeCluster = L.markerClusterGroup({
  disableClusteringAtZoom: 15,
  iconCreateFunction: () => L.divIcon({
    html: <img src="Icons/nextbike_icon_32x32.png" width="32" height="32">,
    iconSize: [32,32], className: ''
  })
}).addTo(map);
const filteredBikeLayer = L.layerGroup().addTo(map);

L.control.layers(null, {
  'Werkstätten': workshopsLayer,
  'Fahrradstationen': bikeCluster,
  'Gefilterte Stationen': filteredBikeLayer,
  'Isochrone 15': isoLayer15,
  'Isochrone 30': isoLayer30,
  'Isochrone 45': isoLayer45,
  'Isochrone 60': isoLayer60
}).addTo(map);

// ---------- UI CONTROL ----------
const AnalysisControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'analysis-control');
    div.innerHTML = 
      <button id="btn15">Vergleich 15 vs 60</button>
      <button id="btn30">Vergleich 30 vs 60</button>
      <button id="btn45">Vergleich 45 vs 60</button>
      <div style="margin-top:6px;font-size:12px;color:#444">Klicke zuerst eine Werkstatt</div>
    ;
    L.DomEvent.disableClickPropagation(div);
    return div;
  }
});
map.addControl(new AnalysisControl({ position: 'topright' }));

// ---------- GLOBALS ----------
let stationsData = [];
let currentIso = {};
let currentWorkshop = null;  // {lon,lat,marker,props}
let tempWorkshopMode = false;
let tempWorkshops = []; // speichert ALLE temporären Marker

// ---------- HELPERS ----------
function parseCoordVal(v){
  if (v === undefined || v === null) return NaN;
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(',', '.'));
}
function stationPopupHtml(s){
  return <strong>${s.name ?? 'Station'}</strong><br>Verfügbare Räder: <strong>${s.bikes ?? 0}</strong>;
}
function centroidOfFeature(feature){
  try {
    const cent = turf.center(feature);
    const [lng, lat] = cent.geometry.coordinates;
    return [lat, lng];
  } catch {
    const bbox = turf.bbox(feature);
    return [(bbox[1]+bbox[3])/2, (bbox[0]+bbox[2])/2];
  }
}
function clearAll(){
  clearIsoLayers();
  filteredBikeLayer.clearLayers();
  currentIso = {};
  currentWorkshop = null;
}

// Rechtsklick: Alles zurücksetzen
map.on('contextmenu', function () {
  // Alle Isochronen-Layer leeren
  isoLayer15.clearLayers();
  isoLayer30.clearLayers();
  isoLayer45.clearLayers();
  isoLayer60.clearLayers();

  // Gefilterte Bikes entfernen
  filteredBikeLayer.clearLayers();

  // Aktuelle Auswahl zurücksetzen
  currentWorkshop = null;
  currentIso = {};

  // Alle offenen Popups schließen
  map.closePopup();
});


// ---------- LOAD STATIONS ----------
async function loadStations(){
  stationsData = [];
  bikeCluster.clearLayers();
  const seenStations = new Set();
  for (const url of NEXTBIKE_URLS){
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      json.countries?.forEach(country => {
        country.cities?.forEach(city => {
          city.places?.forEach(p => {
            const stationId = p.uid || ${p.lat},${p.lng};
            if (seenStations.has(stationId)) return;
            seenStations.add(stationId);

            const lat = parseCoordVal(p.lat);
            const lng = parseCoordVal(p.lng);
            const bikes = (typeof p.bikes === 'number') ? p.bikes : (Array.isArray(p.bikes) ? p.bikes.length : (p.bikes ?? 0));
            const feature = { lat, lng, bikes, name: p.name, raw: p };
            stationsData.push(feature);
            const icon = bikes === 0 ? breakIcon : defaultIcon;
            L.marker([lat, lng], { icon }).bindPopup(stationPopupHtml(feature)).addTo(bikeCluster);
          });
        });
      });
    } catch (err) { console.error('Error loading nextbike', err); }
  }
}

// ---------- LOAD WORKSHOPS ----------
async function loadWorkshops(){
  try {
    const res = await fetch(WORKSHOPS_FILE);
    const gj = await res.json();
    workshopsLayer.clearLayers();
    L.geoJSON(gj, {
      pointToLayer: (feature, latlng) => {
        let lon = parseCoordVal(feature.geometry.coordinates[0]);
        let lat = parseCoordVal(feature.geometry.coordinates[1]);
        const marker = L.marker([lat, lon], { icon: workshopIcon });
        const title = feature.properties?.Systeme ?? feature.properties?.Stadt ?? 'Werkstatt';
        const addr  = feature.properties?.Adresse ?? '';

        marker.bindPopup(<strong>${title}</strong><br>${addr}<br><em>Klicken für Isochrone</em>);

        marker.on('click', async () => selectWorkshop(marker, lon, lat, title, addr, feature.properties));

        return marker;
      }
    }).addTo(workshopsLayer);
  } catch (err) { console.error('Load workshops error', err); }
}

// ---------- SELECT WORKSHOP ----------
async function selectWorkshop(marker, lon, lat, title, addr, props) {
  // wenn derselbe Marker erneut angeklickt wird → nichts machen
  if (currentWorkshop && currentWorkshop.marker === marker) return;

  currentWorkshop = { lon, lat, marker, props };
  // clearIsoLayers(); // entfernt – alte Isochronen bleiben sichtbar (geändert)
  try {
    await computeIsochronesForWorkshop(lon, lat);
    showIso(60);
    marker.setPopupContent(<strong>${title}</strong><br>${addr}<br><em>Isochrone (60min) geladen</em>);
    map.setView([lat, lon], 13);
  } catch (e) {
    marker.setPopupContent(<strong>${title}</strong><br>${addr}<br><span style="color:red">Isochronen Fehler</span>);
  }
}

// ---------- COMPUTE ISOCHRONES ----------
async function computeIsochronesForWorkshop(lon, lat){
  const ranges = [15*60, 30*60, 45*60, 60*60];
  const url = 'https://api.openrouteservice.org/v2/isochrones/cycling-regular';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': ORS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json, application/geo+json'
    },
    body: JSON.stringify({ locations: [[lon, lat]], range: ranges })
  });
  const isojson = await res.json();
  currentIso = {};
  isojson.features.forEach(f => {
    const mins = Number(f.properties?.value) / 60;
    currentIso[mins] = { type: 'FeatureCollection', features: [f] };
  });
}

// ---------- SHOW / CLEAR ISO LAYERS ----------
function clearIsoLayers(){
  isoLayer15.clearLayers();
  isoLayer30.clearLayers();
  isoLayer45.clearLayers();
  isoLayer60.clearLayers();
}
function showIso(mins){
  // clearIsoLayers(); // entfernt – nicht mehr automatisch löschen, damit mehrere Isochronen sichtbar bleiben. (geändert)
  const featureCollection = currentIso[mins];
  if (!featureCollection) return;
  const style = { color: mins === 60 ? '#0000FF' : (mins===15? '#7CFC00' : mins===30? '#FFA500' : '#FF0000'), weight: 1, fillOpacity: 0.18 };
  const layerMap = { 15: isoLayer15, 30: isoLayer30, 45: isoLayer45, 60: isoLayer60 };
  L.geoJSON(featureCollection, { style }).addTo(layerMap[mins]);
}

// ---------- COUNT & SHOW BIKES INSIDE ----------
function getStationsInFeature(featureCollection){
  if (!featureCollection || !featureCollection.features.length) return [];
  const poly = featureCollection.features[0];
  return stationsData.filter(s => {
    const pt = turf.point([s.lng, s.lat]);
    return turf.booleanPointInPolygon(pt, poly);
  });
}

// ---------- BUTTON HANDLERS ----------
// Vergleichs-Popups zwischenspeichern
let comparePopups = [];

async function handleCompare(minSmall){
  if (!currentWorkshop || !currentIso[60]) {
    alert('Bitte zuerst eine Werkstatt klicken.');
    return;
  }
  const smallIso = currentIso[minSmall];
  const bigIso = currentIso[60];
  if (!smallIso || !bigIso) return;

  // clearIsoLayers(); // entfernt – alte Isochronen bleiben erhalten (geändert)
  filteredBikeLayer.clearLayers();

  L.geoJSON(smallIso, { style: { color:'#00A', weight:1, fillOpacity:0.2 } }).addTo(
    minSmall === 15 ? isoLayer15 : minSmall === 30 ? isoLayer30 : isoLayer45
  );
  L.geoJSON(bigIso, { style: { color:'#0000FF', weight:1, fillOpacity:0.12 } }).addTo(isoLayer60);

  const smallStations = getStationsInFeature(smallIso);
  smallStations.forEach(s => {
    const icon = s.bikes === 0 ? breakIcon : defaultIcon;
    L.marker([s.lat, s.lng], { icon }).bindPopup(stationPopupHtml(s)).addTo(filteredBikeLayer);
  });

  const smallCount = smallStations.reduce((sum,s)=>sum+(s.bikes||0),0);
  const bigCount   = getStationsInFeature(bigIso).reduce((sum,s)=>sum+(s.bikes||0),0);

  const popupLatLng = centroidOfFeature(bigIso);
  const popupHtml =
    <div style="font-weight:600">Vergleich ${minSmall}min vs 60min</div> +
    <div>🚲 ${minSmall}min: <strong>${smallCount}</strong> verfügbare Räder</div> +
    <div>🚲 60min: <strong>${bigCount}</strong> verfügbare Räder</div>;

  // geändert – Popups schließen sich nicht mehr automatisch und werden einfach zur Karte hinzugefügt
  L.popup({ maxWidth: 320, autoClose: false, closeOnClick: false })
    .setLatLng(popupLatLng)
    .setContent(popupHtml)
    .addTo(map);
}

document.addEventListener('click', (ev) => {
  if (ev.target.id === 'btn15') handleCompare(15);
  if (ev.target.id === 'btn30') handleCompare(30);
  if (ev.target.id === 'btn45') handleCompare(45);
});

// ---------- TEMP WORKSHOP BUTTON ----------
const TempWorkshopControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'analysis-control');
    div.innerHTML = <button id="btnTempWorkshop">Neue Werkstatt setzen</button>;
    L.DomEvent.disableClickPropagation(div);
    return div;
  }
});
map.addControl(new TempWorkshopControl({ position: 'topleft' }));

map.on('click', async (e) => {
  if (!tempWorkshopMode) {
    // Deselect durch Klick auf leere Karte
    if (!e.originalEvent.target.closest('.leaflet-popup') && !e.originalEvent.target.closest('.analysis-control')) {
      // clearAll(); // entfernt – Klick auf Karte löscht nun nicht mehr automatisch Isochronen/Popups (geändert)
    }
    return;
  }
  tempWorkshopMode = false;
  map.getContainer().style.cursor = '';

  const { lat, lng } = e.latlng;
  const marker = L.marker([lat, lng], { icon: workshopIcon }).addTo(map);
  tempWorkshops.push(marker);

  marker.bindPopup(
    <strong>Temporäre Werkstatt</strong><br> +
    Klicken für Isochrone.<br> +
    <em>Kann jederzeit wieder ausgewählt werden</em>
  );

  marker.on('click', () => selectWorkshop(marker, lng, lat, 'Temporäre Werkstatt', '', { Adresse: 'Temporär gesetzt' }));

  // Sofort auswählen und Isochrone laden
  await selectWorkshop(marker, lng, lat, 'Temporäre Werkstatt', '', { Adresse: 'Temporär gesetzt' });
});

document.addEventListener('click', (ev) => {
  if (ev.target.id === 'btnTempWorkshop') {
    tempWorkshopMode = true;
    map.getContainer().style.cursor = 'crosshair';
    alert('Klicke auf die Karte, um eine neue Werkstatt zu setzen.');
  }
});

// ganz unten nach INIT() hinzufügen
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Delete' && currentWorkshop) {
    // prüfen ob die aktuelle Werkstatt temporär ist
    const isTemp = tempWorkshops.includes(currentWorkshop.marker);
    if (isTemp) {
      map.removeLayer(currentWorkshop.marker);
      tempWorkshops = tempWorkshops.filter(m => m !== currentWorkshop.marker);
      clearAll();
    }
  }
});

// ---------- INIT ----------
(async function init(){
  await Promise.all([ loadStations(), loadWorkshops() ]);
})();

hier ist v1 nochmal. veränder v1, sodass die 90min isocrhone hinzukommt als button, bzw. angezeigt wird als vergelich. ändere statt fahrrad auf auto vie bei v2. was du bereits erstellt hast. aber ändere nicht zuviel an v1 behalte die gleiche sturktur bei 
ChatGPT:
Verstanden 👍
Ich passe deine v1 minimal an:

Transportmode → "driving-car" statt "cycling-regular"

Zusätzliche Isochrone 90 Minuten → extra Layer, Button, Vergleichslogik

Restliche Struktur bleibt gleich, nur wo nötig ergänzt

Hier der angepasste Code:

// script.js
// Dynamic isochrones per workshop click + 15/30/45/90 vs 60 comparison popup + station filtering + toggle off on re-click

// ---------- CONFIG ----------
const ORS_API_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjJiMWZmNzYzNGZjMTRlYzlhODY0ZjMyOWE3ODFkNmVlIiwiaCI6Im11cm11cjY0In0=';
const WORKSHOPS_FILE = 'Workshops.geojson';
const NEXTBIKE_URLS = [
  'https://api.nextbike.net/maps/nextbike-official.json?countries=de',
  'https://api.nextbike.net/maps/nextbike-official.json?countries=at'
];

// ---------- MAP ----------
const map = L.map('map', { minZoom: 6, maxZoom: 18 }).setView([51.1657, 10.4515], 6);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© OpenStreetMap contributors'
}).addTo(map);

// ---------- ICONS ----------
const defaultIcon = L.icon({ iconUrl: 'Icons/nextbike_icon_32x32.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });
const breakIcon   = L.icon({ iconUrl: 'Icons/nextbike_break_icon_32x32.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });
const workshopIcon= L.icon({ iconUrl: 'Icons/Workshop.png', iconSize: [32,32], iconAnchor: [16,32], popupAnchor: [0,-32] });

// ---------- LAYERS ----------
const workshopsLayer = L.layerGroup().addTo(map);
const isoLayer15 = L.layerGroup().addTo(map);
const isoLayer30 = L.layerGroup().addTo(map);
const isoLayer45 = L.layerGroup().addTo(map);
const isoLayer60 = L.layerGroup().addTo(map);
const isoLayer90 = L.layerGroup().addTo(map);
const bikeCluster = L.markerClusterGroup({
  disableClusteringAtZoom: 15,
  iconCreateFunction: () => L.divIcon({
    html: `<img src="Icons/nextbike_icon_32x32.png" width="32" height="32">`,
    iconSize: [32,32], className: ''
  })
}).addTo(map);
const filteredBikeLayer = L.layerGroup().addTo(map);

L.control.layers(null, {
  'Werkstätten': workshopsLayer,
  'Fahrradstationen': bikeCluster,
  'Gefilterte Stationen': filteredBikeLayer,
  'Isochrone 15': isoLayer15,
  'Isochrone 30': isoLayer30,
  'Isochrone 45': isoLayer45,
  'Isochrone 60': isoLayer60,
  'Isochrone 90': isoLayer90
}).addTo(map);

// ---------- UI CONTROL ----------
const AnalysisControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'analysis-control');
    div.innerHTML = `
      <button id="btn15">Vergleich 15 vs 60</button>
      <button id="btn30">Vergleich 30 vs 60</button>
      <button id="btn45">Vergleich 45 vs 60</button>
      <button id="btn90">Vergleich 90 vs 60</button>
      <div style="margin-top:6px;font-size:12px;color:#444">Klicke zuerst eine Werkstatt</div>
    `;
    L.DomEvent.disableClickPropagation(div);
    return div;
  }
});
map.addControl(new AnalysisControl({ position: 'topright' }));

// ---------- GLOBALS ----------
let stationsData = [];
let currentIso = {};
let currentWorkshop = null;
let tempWorkshopMode = false;
let tempWorkshops = [];

// ---------- HELPERS ----------
function parseCoordVal(v){
  if (v === undefined || v === null) return NaN;
  if (typeof v === 'number') return v;
  return parseFloat(String(v).replace(',', '.'));
}
function stationPopupHtml(s){
  return `<strong>${s.name ?? 'Station'}</strong><br>Verfügbare Räder: <strong>${s.bikes ?? 0}</strong>`;
}
function centroidOfFeature(feature){
  try {
    const cent = turf.center(feature);
    const [lng, lat] = cent.geometry.coordinates;
    return [lat, lng];
  } catch {
    const bbox = turf.bbox(feature);
    return [(bbox[1]+bbox[3])/2, (bbox[0]+bbox[2])/2];
  }
}
function clearAll(){
  clearIsoLayers();
  filteredBikeLayer.clearLayers();
  currentIso = {};
  currentWorkshop = null;
}

// Rechtsklick reset
map.on('contextmenu', function () {
  isoLayer15.clearLayers();
  isoLayer30.clearLayers();
  isoLayer45.clearLayers();
  isoLayer60.clearLayers();
  isoLayer90.clearLayers();
  filteredBikeLayer.clearLayers();
  currentWorkshop = null;
  currentIso = {};
  map.closePopup();
});

// ---------- LOAD STATIONS ----------
async function loadStations(){
  stationsData = [];
  bikeCluster.clearLayers();
  const seenStations = new Set();
  for (const url of NEXTBIKE_URLS){
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const json = await res.json();
      json.countries?.forEach(country => {
        country.cities?.forEach(city => {
          city.places?.forEach(p => {
            const stationId = p.uid || `${p.lat},${p.lng}`;
            if (seenStations.has(stationId)) return;
            seenStations.add(stationId);

            const lat = parseCoordVal(p.lat);
            const lng = parseCoordVal(p.lng);
            const bikes = (typeof p.bikes === 'number') ? p.bikes : (Array.isArray(p.bikes) ? p.bikes.length : (p.bikes ?? 0));
            const feature = { lat, lng, bikes, name: p.name, raw: p };
            stationsData.push(feature);
            const icon = bikes === 0 ? breakIcon : defaultIcon;
            L.marker([lat, lng], { icon }).bindPopup(stationPopupHtml(feature)).addTo(bikeCluster);
          });
        });
      });
    } catch (err) { console.error('Error loading nextbike', err); }
  }
}

// ---------- LOAD WORKSHOPS ----------
async function loadWorkshops(){
  try {
    const res = await fetch(WORKSHOPS_FILE);
    const gj = await res.json();
    workshopsLayer.clearLayers();
    L.geoJSON(gj, {
      pointToLayer: (feature, latlng) => {
        let lon = parseCoordVal(feature.geometry.coordinates[0]);
        let lat = parseCoordVal(feature.geometry.coordinates[1]);
        const marker = L.marker([lat, lon], { icon: workshopIcon });
        const title = feature.properties?.Systeme ?? feature.properties?.Stadt ?? 'Werkstatt';
        const addr  = feature.properties?.Adresse ?? '';

        marker.bindPopup(`<strong>${title}</strong><br>${addr}<br><em>Klicken für Isochrone</em>`);
        marker.on('click', async () => selectWorkshop(marker, lon, lat, title, addr, feature.properties));
        return marker;
      }
    }).addTo(workshopsLayer);
  } catch (err) { console.error('Load workshops error', err); }
}

// ---------- SELECT WORKSHOP ----------
async function selectWorkshop(marker, lon, lat, title, addr, props) {
  if (currentWorkshop && currentWorkshop.marker === marker) return;
  currentWorkshop = { lon, lat, marker, props };
  try {
    await computeIsochronesForWorkshop(lon, lat);
    showIso(60);
    marker.setPopupContent(`<strong>${title}</strong><br>${addr}<br><em>Isochrone (60min) geladen</em>`);
    map.setView([lat, lon], 13);
  } catch (e) {
    marker.setPopupContent(`<strong>${title}</strong><br>${addr}<br><span style="color:red">Isochronen Fehler</span>`);
  }
}

// ---------- COMPUTE ISOCHRONES ----------
async function computeIsochronesForWorkshop(lon, lat){
  const ranges = [15*60, 30*60, 45*60, 60*60, 90*60];
  const url = 'https://api.openrouteservice.org/v2/isochrones/driving-car';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': ORS_API_KEY,
      'Content-Type': 'application/json',
      'Accept': 'application/json, application/geo+json'
    },
    body: JSON.stringify({ locations: [[lon, lat]], range: ranges })
  });
  const isojson = await res.json();
  currentIso = {};
  isojson.features.forEach(f => {
    const mins = Number(f.properties?.value) / 60;
    currentIso[mins] = { type: 'FeatureCollection', features: [f] };
  });
}

// ---------- SHOW / CLEAR ISO LAYERS ----------
function clearIsoLayers(){
  isoLayer15.clearLayers();
  isoLayer30.clearLayers();
  isoLayer45.clearLayers();
  isoLayer60.clearLayers();
  isoLayer90.clearLayers();
}
function showIso(mins){
  const featureCollection = currentIso[mins];
  if (!featureCollection) return;
  const style = { 
    color: mins === 90 ? '#8A2BE2' : mins === 60 ? '#0000FF' : (mins===15? '#7CFC00' : mins===30? '#FFA500' : '#FF0000'),
    weight: 1, fillOpacity: 0.18 
  };
  const layerMap = { 15: isoLayer15, 30: isoLayer30, 45: isoLayer45, 60: isoLayer60, 90: isoLayer90 };
  L.geoJSON(featureCollection, { style }).addTo(layerMap[mins]);
}

// ---------- COUNT & SHOW BIKES ----------
function getStationsInFeature(featureCollection){
  if (!featureCollection || !featureCollection.features.length) return [];
  const poly = featureCollection.features[0];
  return stationsData.filter(s => {
    const pt = turf.point([s.lng, s.lat]);
    return turf.booleanPointInPolygon(pt, poly);
  });
}

// ---------- BUTTON HANDLERS ----------
async function handleCompare(minSmall){
  if (!currentWorkshop || !currentIso[60]) {
    alert('Bitte zuerst eine Werkstatt klicken.');
    return;
  }
  const smallIso = currentIso[minSmall];
  const bigIso = currentIso[60];
  if (!smallIso || !bigIso) return;

  filteredBikeLayer.clearLayers();

  L.geoJSON(smallIso, { style: { color:'#00A', weight:1, fillOpacity:0.2 } }).addTo(
    minSmall === 15 ? isoLayer15 : minSmall === 30 ? isoLayer30 : minSmall === 45 ? isoLayer45 : isoLayer90
  );
  L.geoJSON(bigIso, { style: { color:'#0000FF', weight:1, fillOpacity:0.12 } }).addTo(isoLayer60);

  const smallStations = getStationsInFeature(smallIso);
  smallStations.forEach(s => {
    const icon = s.bikes === 0 ? breakIcon : defaultIcon;
    L.marker([s.lat, s.lng], { icon }).bindPopup(stationPopupHtml(s)).addTo(filteredBikeLayer);
  });

  const smallCount = smallStations.reduce((sum,s)=>sum+(s.bikes||0),0);
  const bigCount   = getStationsInFeature(bigIso).reduce((sum,s)=>sum+(s.bikes||0),0);

  const popupLatLng = centroidOfFeature(bigIso);
  const popupHtml =
    `<div style="font-weight:600">Vergleich ${minSmall}min vs 60min</div>` +
    `<div>🚗 ${minSmall}min: <strong>${smallCount}</strong> verfügbare Räder</div>` +
    `<div>🚗 60min: <strong>${bigCount}</strong> verfügbare Räder</div>`;

  L.popup({ maxWidth: 320, autoClose: false, closeOnClick: false })
    .setLatLng(popupLatLng)
    .setContent(popupHtml)
    .addTo(map);
}

document.addEventListener('click', (ev) => {
  if (ev.target.id === 'btn15') handleCompare(15);
  if (ev.target.id === 'btn30') handleCompare(30);
  if (ev.target.id === 'btn45') handleCompare(45);
  if (ev.target.id === 'btn90') handleCompare(90);
});

// ---------- TEMP WORKSHOP ----------
const TempWorkshopControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'analysis-control');
    div.innerHTML = `<button id="btnTempWorkshop">Neue Werkstatt setzen</button>`;
    L.DomEvent.disableClickPropagation(div);
    return div;
  }
});
map.addControl(new TempWorkshopControl({ position: 'topleft' }));

map.on('click', async (e) => {
  if (!tempWorkshopMode) return;
  tempWorkshopMode = false;
  map.getContainer().style.cursor = '';

  const { lat, lng } = e.latlng;
  const marker = L.marker([lat, lng], { icon: workshopIcon }).addTo(map);
  tempWorkshops.push(marker);

  marker.bindPopup(`<strong>Temporäre Werkstatt</strong><br>Klicken für Isochrone.<br><em>Kann jederzeit wieder ausgewählt werden</em>`);
  marker.on('click', () => selectWorkshop(marker, lng, lat, 'Temporäre Werkstatt', '', { Adresse: 'Temporär gesetzt' }));

  await selectWorkshop(marker, lng, lat, 'Temporäre Werkstatt', '', { Adresse: 'Temporär gesetzt' });
});

document.addEventListener('click', (ev) => {
  if (ev.target.id === 'btnTempWorkshop') {
    tempWorkshopMode = true;
    map.getContainer().style.cursor = 'crosshair';
    alert('Klicke auf die Karte, um eine neue Werkstatt zu setzen.');
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Delete' && currentWorkshop) {
    const isTemp = tempWorkshops.includes(currentWorkshop.marker);
    if (isTemp) {
      map.removeLayer(currentWorkshop.marker);
      tempWorkshops = tempWorkshops.filter(m => m !== currentWorkshop.marker);
      clearAll();
    }
  }
});

// ---------- INIT ----------
(async function init(){
  await Promise.all([ loadStations(), loadWorkshops() ]);
})();
👉 Änderungen gegenüber deiner v1:

driving-car statt cycling-regular

isoLayer90 hinzugefügt (mit Lila-Farbe #8A2BE2)

Button "Vergleich 90 vs 60"

computeIsochronesForWorkshop berücksichtigt 90 Minuten

Willst du, dass ich zusätzlich auch einen direkten Button „zeige nur Isochrone 90“ einfüge (wie bei 60min beim Klick)?




Keine ausgewähltKeine ausgewählt
ChatGPT kann Fehler machen. Überprüfe wichtige Informationen. Siehe Cookie-Voreinstellungen.
