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
