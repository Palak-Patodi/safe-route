const OPENCAGE_API_KEY = 'f70c1042f67043818d42e63b5d4a4e9d';

let map;
let routingControl;
let currentLiveLocation = null;
let routeActive = false;
let locationLoadedOnce = false;
let startRouteMarker = null;
let endRouteMarker = null;
let safetyData = [];
let allFetchedReports = [];
let renderedReportCount = 0;
const REPORT_BATCH_SIZE = 5;
const REPORT_FETCH_LIMIT = 50;
const ROUTE_PERSIST_MS = 10 * 60 * 1000;
let routeLayerGroup;
let routeClearTimeout = null;

// Use absolute URL whenever the page is NOT served by our own port-3000 server
const DEFAULT_API_BASE = (
  window.location.protocol === 'file:' ||
  window.location.port !== '3000'
) ? 'http://localhost:3000' : '';
const API_BASE = localStorage.getItem('apiBaseUrl') || DEFAULT_API_BASE;

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function getAuthToken() {
  return localStorage.getItem('firebaseIdToken');
}

function formatDuration(seconds) {
  const totalMinutes = Math.round(seconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }

  return `${(meters / 1000).toFixed(1)} km`;
}

function resetRouteExpiry() {
  if (routeClearTimeout) {
    clearTimeout(routeClearTimeout);
  }

  routeClearTimeout = setTimeout(() => {
    clearPersistedRoute();
  }, ROUTE_PERSIST_MS);
}

function clearPersistedRoute() {
  routeActive = false;

  if (routeClearTimeout) {
    clearTimeout(routeClearTimeout);
    routeClearTimeout = null;
  }

  if (routeLayerGroup) {
    routeLayerGroup.clearLayers();
  }

  if (routingControl) {
    routingControl.setWaypoints([]);
  }

  if (startRouteMarker && map) {
    map.removeLayer(startRouteMarker);
    startRouteMarker = null;
  }

  if (endRouteMarker && map) {
    map.removeLayer(endRouteMarker);
    endRouteMarker = null;
  }

  const safetyScoresElement = document.getElementById('safety-scores');
  if (safetyScoresElement) {
    safetyScoresElement.innerHTML = '';
  }

  const directionsEl = document.getElementById('route-directions');
  if (directionsEl) {
    directionsEl.innerHTML = '<p>Enter a start and destination above to see directions.</p>';
  }
}

function renderRouteDirections(route) {
  const el = document.getElementById('route-directions');
  if (!el) {
    return;
  }

  const steps = Array.isArray(route.instructions) ? route.instructions : [];
  const summary = route.summary || {};

  const stepsHtml = steps.length
    ? `<ol>${steps.map((s) => `<li>${s.text}<span class="step-dist">${formatDistance(s.distance || 0)}</span></li>`).join('')}</ol>`
    : '<p>Route found — no turn-by-turn steps available.</p>';

  el.innerHTML = `
    <h3>Directions</h3>
    <div class="route-summary">
      <span>${formatDistance(summary.totalDistance || 0)}</span>
      <span>${formatDuration(summary.totalTime || 0)}</span>
    </div>
    ${stepsHtml}
  `;
}

function drawPersistentRoute(route) {
  if (!map || !routeLayerGroup) {
    return;
  }

  routeLayerGroup.clearLayers();

  const latLngs = (route.coordinates || []).map((point) => [point.lat, point.lng]);
  if (!latLngs.length) {
    return;
  }

  L.polyline(latLngs, {
    color: '#ff9f43',
    weight: 14,
    opacity: 0.28,
    lineJoin: 'round'
  }).addTo(routeLayerGroup);

  L.polyline(latLngs, {
    color: '#2980b9',
    weight: 6,
    opacity: 0.95,
    lineJoin: 'round'
  }).addTo(routeLayerGroup);

  resetRouteExpiry();
}

function isVerifiedUserLoggedIn() {
  return localStorage.getItem('forceLoggedOut') !== 'true'
    && localStorage.getItem('authVerified') === 'true'
    && !!getAuthToken()
    && !!localStorage.getItem('firebaseUid');
}

function ensureShowMoreButton() {
  let button = document.getElementById('show-more-reports-btn');
  if (!button) {
    button = document.createElement('button');
    button.id = 'show-more-reports-btn';
    button.className = 'btn';
    button.textContent = 'Show More';
    button.style.marginTop = '10px';
    button.addEventListener('click', renderMoreReports);

    const reportList = document.getElementById('report-list');
    if (reportList && reportList.parentElement) {
      reportList.parentElement.appendChild(button);
    }
  }
  return button;
}

function updateShowMoreVisibility() {
  const button = ensureShowMoreButton();
  button.style.display = renderedReportCount < allFetchedReports.length ? 'inline-block' : 'none';
}

function renderMoreReports() {
  const reportList = document.getElementById('report-list');
  if (!reportList) {
    return;
  }

  const nextReports = allFetchedReports.slice(renderedReportCount, renderedReportCount + REPORT_BATCH_SIZE);
  nextReports.forEach((report) => {
    const listItem = document.createElement('li');
    listItem.innerHTML = `
      <h3>${report.type}</h3>
      <p><strong>Location:</strong> ${report.location}</p>
      <p><strong>Description:</strong> ${report.description}</p>
      <p><strong>Date:</strong> ${new Date(report.createdAt).toLocaleString()}</p>
    `;
    reportList.appendChild(listItem);
  });

  renderedReportCount += nextReports.length;
  updateShowMoreVisibility();
}

async function loadRecentReports() {
  const reportList = document.getElementById('report-list');
  if (!reportList) {
    return;
  }

  if (!currentLiveLocation) {
    allFetchedReports = [];
    renderedReportCount = 0;
    reportList.innerHTML = '<li>Detecting your location to load reports within 50 km...</li>';
    updateShowMoreVisibility();
    return;
  }

  reportList.innerHTML = '<li>Loading reports...</li>';

  try {
    const url = apiUrl(`/api/reports/nearby?lat=${currentLiveLocation.lat}&lng=${currentLiveLocation.lng}&radius=50&limit=${REPORT_FETCH_LIMIT}`);

    const response = await fetch(url);
    const result = await response.json();

    if (!result.success || !Array.isArray(result.reports) || result.reports.length === 0) {
      allFetchedReports = [];
      renderedReportCount = 0;
      reportList.innerHTML = currentLiveLocation
        ? '<li>No reports within 50 km of your location.</li>'
        : '<li>No reports yet.</li>';
      updateShowMoreVisibility();
      return;
    }

    allFetchedReports = result.reports;
    renderedReportCount = 0;
    reportList.innerHTML = '';
    renderMoreReports();
  } catch (err) {
    console.error('Error loading reports:', err);
    reportList.innerHTML = '<li>Could not reach server. Make sure <strong>node app.js</strong> is running, then open <a href="http://localhost:3000">http://localhost:3000</a>.</li>';
  }
}

function decodePolyline(str, precision) {
  const factor = Math.pow(10, precision || 6);
  const len = str.length;
  const result = [];
  let index = 0, lat = 0, lng = 0;
  while (index < len) {
    let b, shift = 0, res = 0;
    do { b = str.charCodeAt(index++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (res & 1) ? ~(res >> 1) : (res >> 1);
    shift = 0; res = 0;
    do { b = str.charCodeAt(index++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (res & 1) ? ~(res >> 1) : (res >> 1);
    result.push(L.latLng(lat / factor, lng / factor));
  }
  return result;
}

async function fetchOSRMRoute(startLatLng, endLatLng) {
  const resp = await fetch('https://valhalla1.openstreetmap.de/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      locations: [
        { lat: startLatLng.lat, lon: startLatLng.lng },
        { lat: endLatLng.lat, lon: endLatLng.lng }
      ],
      costing: 'auto',
      directions_options: { units: 'kilometers' }
    })
  });
  if (!resp.ok) throw new Error(`Router returned ${resp.status}`);
  const data = await resp.json();
  if (!data.trip) throw new Error('No route found');
  return data.trip;
}

function applyOSRMRoute(trip, startLatLng, endLatLng) {
  const coords = decodePolyline(trip.legs[0].shape);
  drawPersistentRoute({ coordinates: coords });
  if (coords.length > 1) {
    map.fitBounds(L.latLngBounds(coords), { padding: [30, 30] });
  }
  const maneuvers = trip.legs[0].maneuvers || [];
  const instructions = maneuvers.map((m) => ({
    text: m.instruction,
    distance: (m.length || 0) * 1000
  }));
  renderRouteDirections({
    summary: {
      totalDistance: (trip.summary.length || 0) * 1000,
      totalTime: trip.summary.time || 0
    },
    instructions
  });
}

function initMap() {
  if (!document.getElementById('map')) {
    return;
  }

  map = L.map('map').setView([28.6139, 77.209], 13);
  routeLayerGroup = L.layerGroup().addTo(map);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  // routingControl is kept only so existing code that calls setWaypoints/clearWaypoints still works
  routingControl = {
    setWaypoints: () => {},
    getPlan: () => ({ setWaypoints: () => {} })
  };
}

function setupFamilyContactModal() {
  if (document.getElementById('family-contact-modal')) {
    return;
  }

  const modalContainer = document.createElement('div');
  modalContainer.id = 'family-contact-modal';
  modalContainer.style = `
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.7);
    z-index: 9999;
    justify-content: center;
    align-items: center;
  `;

  const modalContent = document.createElement('div');
  modalContent.style = `
    background-color: white;
    padding: 20px;
    border-radius: 10px;
    width: 80%;
    max-width: 400px;
  `;

  modalContent.innerHTML = `
    <h3 style="margin-top: 0;">Enter Emergency Contact</h3>
    <p>Please enter the phone number for your emergency contact.</p>
    <input type="tel" id="emergency-contact-number" placeholder="Phone number with country code" style="width: 100%; padding: 8px; margin-bottom: 15px;">
    <div style="display: flex; justify-content: space-between;">
      <button id="save-contact" style="background: #2980b9; color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer;">Save &amp; Call</button>
      <button id="close-modal" style="background: #95a5a6; color: white; padding: 10px 15px; border: none; border-radius: 5px; cursor: pointer;">Cancel</button>
    </div>
  `;

  modalContainer.appendChild(modalContent);
  document.body.appendChild(modalContainer);

  document.getElementById('close-modal').addEventListener('click', () => {
    document.getElementById('family-contact-modal').style.display = 'none';
  });

  document.getElementById('save-contact').addEventListener('click', () => {
    const phoneNumber = document.getElementById('emergency-contact-number').value;
    if (!phoneNumber) {
      alert('Please enter a valid phone number');
      return;
    }

    localStorage.setItem('emergencyContact', phoneNumber);
    const cleanNumber = phoneNumber.replace(/[+\s()-]/g, '');
    initiateWhatsAppCall(cleanNumber);
    document.getElementById('family-contact-modal').style.display = 'none';
  });
}

function addSOSButton() {
  const sosButton = document.createElement('button');
  sosButton.innerHTML = '🚨 SOS';
  sosButton.style = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: red;
    color: white;
    border: none;
    padding: 15px 20px;
    font-size: 18px;
    cursor: pointer;
    border-radius: 10px;
    z-index: 1000;
  `;
  sosButton.onclick = sendSOS;
  document.body.appendChild(sosButton);
}

function sendSOS() {
  if (!navigator.geolocation) {
    alert('Geolocation is not supported by this browser.');
    return;
  }

  navigator.geolocation.getCurrentPosition((position) => {
    const userLocation = {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude
    };
    alert('SOS Alert Sent! Sending emergency WhatsApp message.');
    sendSOSToEmergencyContact(userLocation);
  }, () => {
    alert('Location access denied! Please enable location services.');
  });
}

function sendSOSToEmergencyContact(location) {
  const savedContact = localStorage.getItem('emergencyContact');
  if (!savedContact) {
    alert('No emergency contact saved. Please set one first.');
    return;
  }

  const cleanNumber = savedContact.replace(/\D/g, '');
  const mapLink = `https://www.google.com/maps?q=${location.latitude},${location.longitude}`;
  const message = `EMERGENCY! I need help. My location: ${mapLink}`;
  window.open(`https://wa.me/${cleanNumber}?text=${encodeURIComponent(message)}`, '_blank');
}

function sendSOStoServer(location) {
  fetch('/sos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(location)
  })
    .then((response) => response.json())
    .then((data) => console.log(data.message))
    .catch((error) => console.error('Error sending SOS to server:', error));
}

function sendSOSEmail(location) {
  const userEmail = localStorage.getItem('userEmail') || 'palakpatodi06@gmail.com';
  const subject = 'EMERGENCY SOS ALERT!';
  const body = `EMERGENCY! I need help at this location:\nLatitude: ${location.latitude}\nLongitude: ${location.longitude}\nMap link: https://www.google.com/maps/search/?api=1&query=${location.latitude},${location.longitude}`;
  window.location.href = `mailto:${userEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function addEmergencyContacts() {
  const contactsDiv = document.createElement('div');
  contactsDiv.innerHTML = `
    <div style="position: fixed; bottom: 80px; right: 20px; z-index: 1000;">
      <button onclick="callPolice()" style="background: blue; color: white; margin-bottom: 5px; padding: 10px;">👮 Call Police</button>
      <button onclick="callFamily()" style="background: green; color: white; padding: 10px;">📞 Call Family</button>
    </div>
  `;
  document.body.appendChild(contactsDiv);
}

function callPolice() {
  window.location.href = 'tel:100';
}

function initiateWhatsAppCall(phoneNumber) {
  const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  if (isMobile) {
    window.location.href = `whatsapp://call?phone=${phoneNumber}`;
  } else {
    window.open(`https://web.whatsapp.com/send?phone=${phoneNumber}`, '_blank');
  }
}

function callFamily() {
  const savedContact = localStorage.getItem('emergencyContact');
  if (savedContact) {
    initiateWhatsAppCall(savedContact);
  } else {
    const modal = document.getElementById('family-contact-modal');
    if (modal) {
      modal.style.display = 'flex';
    }
  }
}

function panMap(latOffset, lngOffset) {
  if (!map) {
    return;
  }
  const center = map.getCenter();
  map.setView([center.lat + latOffset, center.lng + lngOffset], map.getZoom());
}

function geocodeAddress(address, callback) {
  fetch(`https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(address)}&key=${OPENCAGE_API_KEY}`)
    .then((response) => response.json())
    .then((data) => {
      if (data.results.length > 0) {
        const { lat, lng } = data.results[0].geometry;
        callback([lat, lng]);
      } else {
        alert('Address not found.');
      }
    })
    .catch((error) => {
      console.error('Error geocoding address:', error);
      alert('Error geocoding address.');
    });
}

function loadSafetyData() {
  fetch('safety_scores.json')
    .then((response) => response.json())
    .then((data) => {
      safetyData = data;
      addHotspots();
    })
    .catch((error) => {
      console.error('Error loading safety data:', error);
    });
}

function addHotspots() {
  if (!map || !Array.isArray(safetyData)) {
    return;
  }

  safetyData.forEach((entry) => {
    const { Latitude, Longitude, safety_score: safetyScore } = entry;

    let color;
    if (safetyScore > 90) {
      color = '#77DD77';
    } else if (safetyScore > 80) {
      color = '#B2B27F';
    } else if (safetyScore > 70) {
      color = '#FDFD96';
    } else if (safetyScore > 60) {
      color = '#F6C4C4';
    } else {
      color = '#FFB3B3';
    }

    L.circle([Latitude, Longitude], {
      color,
      fillColor: color,
      fillOpacity: 0.2,
      radius: 5000
    }).addTo(map)
      .bindPopup(`<b>Safety Score: ${Number(safetyScore).toFixed(2)}</b>`);
  });
}

function getSafetyScore(lat, lng, callback) {
  let closestScore = 0;
  let minDistance = Infinity;

  safetyData.forEach((entry) => {
    const distance = Math.sqrt(
      Math.pow(entry.Latitude - lat, 2) + Math.pow(entry.Longitude - lng, 2)
    );

    if (distance < minDistance) {
      minDistance = distance;
      closestScore = entry.safety_score;
    }
  });

  callback(closestScore);
}

function findRoute() {
  const startInputElement = document.getElementById('start');
  const destinationElement = document.getElementById('destination');
  const safetyScoresElement = document.getElementById('safety-scores');

  if (!destinationElement || !startInputElement || !routingControl) {
    return;
  }

  const startInput = startInputElement.value;
  const destination = destinationElement.value;

  if (!destination) {
    clearPersistedRoute();
    alert('Please enter a destination.');
    return;
  }

  const directionsEl = document.getElementById('route-directions');
  if (directionsEl) {
    directionsEl.innerHTML = '<p>Calculating route…</p>';
  }

  const processRoute = async (startCoords, endCoords) => {
    routeActive = true;
    resetRouteExpiry();

    if (startRouteMarker) { map.removeLayer(startRouteMarker); }
    if (endRouteMarker) { map.removeLayer(endRouteMarker); }
    startRouteMarker = L.marker(startCoords).addTo(map).bindPopup('Start');
    endRouteMarker = L.marker(endCoords).addTo(map).bindPopup('Destination');

    // Fit map to show both markers while route loads
    map.fitBounds(L.latLngBounds([startCoords, endCoords]).pad(0.3));

    addHotspots();

    if (safetyScoresElement) {
      getSafetyScore(startCoords[0], startCoords[1], (startScore) => {
        getSafetyScore(endCoords[0], endCoords[1], (endScore) => {
          safetyScoresElement.innerHTML =
            `Safety Score for Start: ${startScore.toFixed(2)}<br>Safety Score for Destination: ${endScore.toFixed(2)}`;
        });
      });
    }

    try {
      const osrmRoute = await fetchOSRMRoute(
        L.latLng(startCoords[0], startCoords[1]),
        L.latLng(endCoords[0], endCoords[1])
      );
      applyOSRMRoute(
        osrmRoute,
        L.latLng(startCoords[0], startCoords[1]),
        L.latLng(endCoords[0], endCoords[1])
      );
    } catch (err) {
      console.error('Routing failed:', err);
      const el = document.getElementById('route-directions');
      if (el) {
        el.innerHTML = `<p style="color:red;">Could not calculate route: ${err.message}.<br>Check your internet connection and try again.</p>`;
      }
    }
  };

  geocodeAddress(destination, (endCoords) => {
    if (!startInput || startInput.toLowerCase() === 'my location') {
      if (currentLiveLocation) {
        processRoute([currentLiveLocation.lat, currentLiveLocation.lng], endCoords);
      } else {
        clearPersistedRoute();
        alert('Live location not available yet. Please wait or enter a start location.');
      }
    } else {
      geocodeAddress(startInput, (startCoords) => {
        processRoute(startCoords, endCoords);
      });
    }
  });
}

async function submitReport(event) {
  event.preventDefault();

  if (!isVerifiedUserLoggedIn()) {
    localStorage.removeItem('firebaseIdToken');
    localStorage.removeItem('firebaseUid');
    localStorage.removeItem('authVerified');
    alert('Please login first to submit a report.');
    window.location.href = 'login.html';
    return;
  }

  const token = getAuthToken();

  if (!navigator.geolocation) {
    alert('Geolocation is not supported by your browser.');
    return;
  }

  navigator.geolocation.getCurrentPosition(async (position) => {
    const incidentType = document.getElementById('incident-type')?.value;
    const incidentDescription = document.getElementById('incident-description')?.value;
    const manualLocation = document.getElementById('incident-location')?.value?.trim();
    const latitude = position.coords.latitude;
    const longitude = position.coords.longitude;

    if (!incidentType || !incidentDescription) {
      alert('Please fill in all required fields.');
      return;
    }

    let placeName = manualLocation || `Lat: ${latitude}, Lng: ${longitude}`;
    let reportLatitude = latitude;
    let reportLongitude = longitude;

    if (manualLocation) {
      try {
        const manualGeoRes = await fetch(`https://api.opencagedata.com/geocode/v1/json?q=${encodeURIComponent(manualLocation)}&key=${OPENCAGE_API_KEY}`);
        const manualGeoData = await manualGeoRes.json();
        if (manualGeoData.results.length > 0) {
          placeName = manualGeoData.results[0].formatted;
          reportLatitude = manualGeoData.results[0].geometry.lat;
          reportLongitude = manualGeoData.results[0].geometry.lng;
        } else {
          alert('Could not find that incident location. Please enter a more specific place.');
          return;
        }
      } catch (err) {
        console.warn('Manual location geocoding failed.');
        alert('Could not verify the incident location. Please try again with a clearer place name.');
        return;
      }
    } else {
      try {
        const geoRes = await fetch(`https://api.opencagedata.com/geocode/v1/json?q=${latitude}+${longitude}&key=${OPENCAGE_API_KEY}`);
        const geoData = await geoRes.json();
        if (geoData.results.length > 0) {
          placeName = geoData.results[0].formatted;
        }
      } catch (err) {
        console.warn('Geocoding failed, using coordinates as location name.');
      }
    }

    try {
      const response = await fetch(apiUrl('/api/reports'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          type: incidentType,
          description: incidentDescription,
          location: placeName,
          latitude: reportLatitude,
          longitude: reportLongitude
        })
      });

      const resultText = await response.text();
      let result = {};
      try {
        result = resultText ? JSON.parse(resultText) : {};
      } catch (parseError) {
        console.warn('Non-JSON response from report API:', resultText.slice(0, 120));
      }

      if (response.status === 401) {
        localStorage.removeItem('firebaseIdToken');
        localStorage.removeItem('firebaseUid');
        alert('Your session expired. Please login again.');
        window.location.href = 'login.html';
        return;
      }

      if (response.status === 429) {
        alert(result.message || 'Rate limit reached: you can submit at most 3 reports per hour. Please try again later.');
        return;
      }

      if (result.success) {
        alert('Report submitted and saved to database!');
        const reportForm = document.getElementById('report-form');
        if (reportForm) {
          reportForm.reset();
        }
        loadRecentReports();
      } else {
        alert(`Failed to save report: ${result.message}`);
      }
    } catch (err) {
      console.error('Error submitting report:', err);
      alert('Could not reach the server. Please check your connection.');
    }
  }, (error) => {
    let errorMsg = 'Location access denied or unavailable.';
    if (error && error.code === error.PERMISSION_DENIED) {
      errorMsg = 'Location access denied. Please enable location permissions.';
    }
    alert(errorMsg);
  });
}

function showLiveLocation() {
  if (!navigator.geolocation || !map) {
    return;
  }

  navigator.geolocation.watchPosition((position) => {
    const { latitude, longitude } = position.coords;
    currentLiveLocation = { lat: latitude, lng: longitude };

    const startInput = document.getElementById('start');
    if (startInput && !startInput.value) {
      startInput.value = 'My Location';
    }

    if (!routeActive) {
      map.setView([latitude, longitude], 15);
    }

    if (!window.userMarker) {
      window.userMarker = L.marker([latitude, longitude]).addTo(map)
        .bindPopup('📍 You are here');
      if (!routeActive) {
        window.userMarker.openPopup();
      }
    } else {
      window.userMarker.setLatLng([latitude, longitude]);
    }

    // On the first GPS fix, reload the report feed with nearby filter
    if (!locationLoadedOnce) {
      locationLoadedOnce = true;
      loadRecentReports();
    }
  }, (error) => {
    console.error('Geolocation error:', error);
  }, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 10000
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initMap();
  loadSafetyData();
  addSOSButton();
  addEmergencyContacts();
  setupFamilyContactModal();
  showLiveLocation();
  loadRecentReports();

  const routeButton = document.getElementById('find-route-btn');
  if (routeButton) {
    routeButton.addEventListener('click', findRoute);
  }

  const reportForm = document.getElementById('report-form');
  if (reportForm) {
    reportForm.addEventListener('submit', submitReport);
  }
});
