const status = document.querySelector('#status');
const categories = {
  metro: ['Metro', '#f756a9', true],
  tram: ['Tram', '#ff9642', false],
  bus: ['Bus', '#55cdf9', false],
  filobus: ['Filobus', '#6dffa1', false],
  treno: ['Treni suburbani', '#bd9dff', false],
  altro: ['Altri mezzi', '#ddd', false]
};
const metroColors = { M1: '#ff5e69', M2: '#6dffa1', M3: '#ffe36b', M4: '#56a6ff', M5: '#ec9bff' };

if (window.L) startMap();
else showStatus('Mappa non disponibile. Ricarica la pagina.');

async function getData(file) {
  const response = await fetch('data/' + file);
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

async function startMap() {
  const map = L.map('map', { preferCanvas: true, zoomAnimation: false, maxZoom: 19 });
  const [border, food, transit] = await Promise.allSettled(
    ['confine.json', 'kebab.json', 'linee.json'].map(getData)
  );
  if (border.status === 'rejected') {
    showStatus('Confine di Milano non disponibile. Ricarica la pagina.');
    return;
  }

  const ring = border.value.coordinates[0].map(([lon, lat]) => [lat, lon]);
  const city = L.latLngBounds(ring);
  const mapBounds = city.pad(0.18);
  const fitCity = () => map.fitBounds(city, { padding: [17, 17], animate: false });
  fitCity();
  map.setMinZoom(Math.max(1, map.getZoom()));
  map.setMaxBounds(mapBounds);
  map.on('resize', () => {
    map.setMinZoom(1);
    const zoom = map.getBoundsZoom(city, false, L.point(34, 34));
    map.setMinZoom(Math.max(1, zoom));
    map.panInsideBounds(mapBounds, { animate: false });
  });

  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, noWrap: true,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://dati.comune.milano.it/dataset/ds929-orari-del-trasporto-pubblico-locale-nel-comune-di-milano-in-formato-gtfs">GTFS Milano / AMAT</a>'
  }).addTo(map);

  // Clip the base map only. The map pane, popups and controls retain normal input and layout.
  const clipTiles = () => {
    const tilePane = tiles.getContainer();
    const origin = map.containerPointToLayerPoint([0, 0]);
    const rect = map.getContainer().getBoundingClientRect();
    const paneRect = tilePane.getBoundingClientRect();
    const polygon = ring.map(point => {
      const pixel = map.latLngToLayerPoint(point).subtract(origin);
      return (pixel.x + rect.left - paneRect.left) + 'px ' +
        (pixel.y + rect.top - paneRect.top) + 'px';
    });
    tilePane.style.clipPath = 'polygon(' + polygon.join(',') + ')';
  };
  let clipFrame;
  map.on('move zoom viewreset', () => {
    if (clipFrame) return;
    clipFrame = requestAnimationFrame(() => {
      clipFrame = undefined;
      clipTiles();
    });
  });
  clipTiles();
  L.polyline(ring, { interactive: false, color: '#dfff28', weight: 2, opacity: 0.9 }).addTo(map);

  const transitLayers = {};
  if (transit.status === 'fulfilled') {
    const groups = new Map();
    for (const { ref, name, kind, paths } of transit.value.routes) {
      const [label, color, enabled] = categories[kind];
      if (!groups.has(kind)) {
        const group = L.layerGroup();
        groups.set(kind, group);
        transitLayers[label] = group;
        if (enabled) group.addTo(map);
      }
      L.polyline(paths.map(key => transit.value.shapes[key]), {
        color: metroColors[ref] && kind === 'metro' ? metroColors[ref] : color,
        opacity: kind === 'bus' ? 0.55 : 0.88,
        weight: kind === 'metro' ? 4 : kind === 'bus' ? 2 : 3
      }).bindPopup(labelPopup(ref, name)).addTo(groups.get(kind));
    }
  }

  const icon = L.icon({
    iconUrl: 'assets/img/kebab-pin.webp', iconSize: [34, 42], iconAnchor: [17, 39],
    popupAnchor: [0, -39], className: 'kebab-pin'
  });
  const kebabLayer = L.markerClusterGroup({
    maxClusterRadius: 42, showCoverageOnHover: false, zoomToBoundsOnClick: true,
    spiderfyOnMaxZoom: true, animate: false,
    iconCreateFunction: cluster => L.divIcon({
      className: 'kebab-cluster', html: String(cluster.getChildCount()), iconSize: [31, 31]
    })
  });
  const places = food.status === 'fulfilled' ? food.value : [];
  let nearest = [];
  let userMarker;
  let activeIndex = 0;
  let waiting = false;

  for (const place of places) {
    const marker = L.marker(place.point, { icon, alt: place.name, title: place.name });
    marker.bindPopup(() => {
      const popup = labelPopup(place.name, place.address);
      const index = nearest.findIndex(entry => entry.place === place);
      if (index !== -1) {
        activeIndex = index;
        const distance = nearest[index].distance;
        popup.append(element('p', distanceLabel(distance) + ' in linea d’aria'));
        const nav = element('div', '', 'nearby-nav');
        nav.append(element('span', (index + 1) + ' / ' + nearest.length));
        if (nearest.length > 1) {
          const next = element('button', 'Prossimo kebab');
          next.type = 'button';
          next.addEventListener('click', () => openNearby((index + 1) % nearest.length));
          nav.append(next);
        }
        popup.append(nav);
      }
      return popup;
    });
    place.marker = marker;
    kebabLayer.addLayer(marker);
  }
  if (places.length) {
    kebabLayer.addTo(map);
    transitLayers.Kebab = kebabLayer;
  }
  if (Object.keys(transitLayers).length) {
    const layerControl = L.control.layers({}, transitLayers).addTo(map);
    layerControl.getContainer().querySelector('.leaflet-control-layers-toggle')
      .setAttribute('aria-label', 'Livelli della mappa');
  }

  addMapButton('↺', 'Vista Milano', fitCity);
  const locate = addMapButton('⌖', 'Kebab vicino a me', () => requestLocation(true)).querySelector('button');
  locate.disabled = !places.length;
  if (!places.length) showStatus('Dati dei kebab non disponibili.');
  else if (transit.status === 'rejected') showStatus('Linee dei mezzi non disponibili.');
  if (places.length && navigator.geolocation) requestLocation(false);

  function addMapButton(symbol, label, action) {
    const control = L.control({ position: 'topleft' });
    control.onAdd = () => {
      const container = element('div', '', 'leaflet-bar map-action');
      const button = element('button', symbol);
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.addEventListener('click', action);
      L.DomEvent.disableClickPropagation(container);
      container.append(button);
      return container;
    };
    return control.addTo(map).getContainer();
  }

  function requestLocation(explicit) {
    if (waiting) return;
    if (!navigator.geolocation) {
      showStatus('Geolocalizzazione non disponibile in questo browser.');
      return;
    }
    if (nearest.length && explicit) {
      openNearby(activeIndex);
      return;
    }
    waiting = true;
    if (explicit) showStatus('Ricerca della posizione…');
    locate.disabled = true;
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      waiting = false;
      locate.disabled = false;
      const point = L.latLng(coords.latitude, coords.longitude);
      nearest = places.map(place => ({ place, distance: point.distanceTo(place.point) }))
        .sort((a, b) => a.distance - b.distance).slice(0, 8);
      showStatus('');
      if (pointInCity(point, ring)) {
        userMarker?.remove();
        userMarker = L.circleMarker(point, {
          radius: 7, color: '#fff', weight: 3, fillColor: '#00c8ff', fillOpacity: 1
        }).bindPopup('La tua posizione').addTo(map);
      }
      openNearby(0);
    }, error => {
      waiting = false;
      locate.disabled = false;
      if (explicit) showStatus(error.code === 1
        ? 'Per trovare i kebab vicini, consenti la posizione nelle impostazioni del sito.'
        : 'Posizione non disponibile. Riprova.');
    }, { timeout: 12000, maximumAge: 60000 });
  }

  function openNearby(index) {
    activeIndex = index;
    const { marker } = nearest[index].place;
    if (!map.hasLayer(kebabLayer)) kebabLayer.addTo(map);
    kebabLayer.zoomToShowLayer(marker, () => marker.openPopup());
  }
}

function pointInCity({ lat, lng }, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [aLat, aLng] = ring[i];
    const [bLat, bLng] = ring[j];
    if ((aLat > lat) !== (bLat > lat) &&
        lng < (bLng - aLng) * (lat - aLat) / (bLat - aLat) + aLng) inside = !inside;
  }
  return inside;
}

function distanceLabel(meters) {
  return meters < 1000 ? Math.round(meters) + ' m'
    : (meters / 1000).toLocaleString('it', { maximumFractionDigits: 1 }) + ' km';
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function labelPopup(title, description) {
  const content = element('div', '', 'place-popup');
  content.append(element('strong', title));
  if (description) content.append(element('small', description));
  return content;
}

function showStatus(message) {
  status.textContent = message;
  status.hidden = !message;
}
