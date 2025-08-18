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
  'Isochrone 60': isoLayer60
}).addTo(map);

// ---------- UI CONTROL ----------
const AnalysisControl = L.Control.extend({
  onAdd: function () {
    const div = L.DomUtil.create('div', 'analysis-control');
    div.innerHTML = `
      <button id="btn15">Vergleich 15 vs 60</button>
      <button id="btn30">Vergleich 30 vs 60</button>
      <button id="btn45">Vergleich 45 vs 60</button>
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
let heatVisible = true; // standardmäßig sichtbar (kann angepasst werden)

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
  const ranges = [15*60, 30*60, 45*60, 60*60];
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
    `<div style="font-weight:600">Vergleich ${minSmall}min vs 60min</div>` +
    `<div>🚲 ${minSmall}min: <strong>${smallCount}</strong> verfügbare Räder</div>` +
    `<div>🚲 60min: <strong>${bigCount}</strong> verfügbare Räder</div>`;

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
    div.innerHTML = `<button id="btnTempWorkshop">Neue Werkstatt setzen</button>`;
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
