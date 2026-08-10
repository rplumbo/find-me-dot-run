const COURSE_ROUTE_URL = 'data/superior100-route.geojson';
const AID_STATIONS_URL = 'data/superior100-aid-stations.json';
const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

let courseMap = null;
let courseBounds = null;

function showMapError(message) {
  document.getElementById('map-loading').classList.add('hidden');
  const error = document.getElementById('map-error');
  error.textContent = message;
  error.classList.remove('hidden');
}

function buildBounds(coordinates) {
  return coordinates.reduce(
    (bounds, coordinate) => bounds.extend(coordinate),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0])
  );
}

function fitFullCourse({ animate = true } = {}) {
  if (!courseMap || !courseBounds) return;
  const compact = window.matchMedia('(max-width: 520px)').matches;
  courseMap.fitBounds(courseBounds, {
    padding: compact
      ? { top: 30, right: 24, bottom: 62, left: 24 }
      : { top: 42, right: 56, bottom: 54, left: 56 },
    duration: animate ? 650 : 0,
    maxZoom: 11,
  });
}

function addStationMarkers(stations) {
  stations.forEach(station => {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'course-station-marker';
    marker.title = station.name;
    marker.setAttribute('aria-label', station.name);

    const pin = document.createElement('span');
    pin.className = 'course-station-pin';
    pin.setAttribute('aria-hidden', 'true');
    marker.appendChild(pin);

    const popupContent = document.createElement('span');
    popupContent.textContent = station.name;

    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: true,
      offset: 18,
    }).setDOMContent(popupContent);

    new maplibregl.Marker({ element: marker, anchor: 'bottom' })
      .setLngLat([station.coordinate.longitude, station.coordinate.latitude])
      .setPopup(popup)
      .addTo(courseMap);
  });
}

async function initCourseMap() {
  if (!window.maplibregl) {
    showMapError('This browser cannot display the interactive course map.');
    return;
  }

  try {
    const [routeResponse, stationsResponse] = await Promise.all([
      fetch(COURSE_ROUTE_URL),
      fetch(AID_STATIONS_URL),
    ]);
    if (!routeResponse.ok || !stationsResponse.ok) {
      throw new Error('Course data could not be loaded.');
    }

    const route = await routeResponse.json();
    const stations = await stationsResponse.json();
    const coordinates = route.features?.[0]?.geometry?.coordinates;
    if (!Array.isArray(coordinates) || !coordinates.length || !Array.isArray(stations)) {
      throw new Error('Course data is not in the expected format.');
    }

    courseBounds = buildBounds(coordinates);
    courseMap = new maplibregl.Map({
      container: 'course-map',
      style: MAP_STYLE_URL,
      center: [-91.09, 47.41],
      zoom: 8.2,
      attributionControl: false,
      maxPitch: 0,
      pitchWithRotate: false,
    });

    courseMap.dragRotate.disable();
    courseMap.touchZoomRotate.disableRotation();
    courseMap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    courseMap.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

    const loadTimeout = window.setTimeout(() => {
      if (!courseMap.loaded()) {
        showMapError('The basemap could not be loaded. Check your connection and reload.');
      }
    }, 12000);

    courseMap.on('load', () => {
      window.clearTimeout(loadTimeout);
      courseMap.addSource('superior-100-route', {
        type: 'geojson',
        data: route,
      });
      courseMap.addLayer({
        id: 'superior-100-route-casing',
        type: 'line',
        source: 'superior-100-route',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#fffaf0',
          'line-opacity': 0.92,
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 5, 11, 7, 15, 10],
        },
      });
      courseMap.addLayer({
        id: 'superior-100-route',
        type: 'line',
        source: 'superior-100-route',
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#d94835',
          'line-opacity': 0.96,
          'line-width': ['interpolate', ['linear'], ['zoom'], 7, 3, 11, 4.5, 15, 7],
        },
      });

      addStationMarkers(stations);
      fitFullCourse({ animate: false });
      document.getElementById('map-loading').classList.add('hidden');
      document.body.dataset.mapReady = 'true';
    });
  } catch (error) {
    showMapError(error.message || 'The course map could not be loaded.');
  }
}

document.getElementById('fit-route-btn').addEventListener('click', () => fitFullCourse());
window.addEventListener('resize', () => {
  if (courseMap) courseMap.resize();
});
document.addEventListener('DOMContentLoaded', initCourseMap);
