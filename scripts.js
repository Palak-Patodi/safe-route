const OPENCAGE_API_KEY = 'f70c1042f67043818d42e63b5d4a4e9d';
// OSRM API - completely free, no API key required
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';

let map;
let routingControl;
let currentLiveLocation = null;
let routeActive = false;
let locationLoadedOnce = false;
let startRouteMarker = null;
let endRouteMarker = null;
let districtData = []; // Store all district data from CSV
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

  // Build detailed step list with distance for each step
  const stepsHtml = steps.length
    ? `<ol class="route-steps">${steps.map((s, idx) => {
        const stepDistance = formatDistance(s.distance || 0);
        const stepDuration = s.duration ? formatDuration(s.duration) : '';
        const durationText = stepDuration ? ` (${stepDuration})` : '';
        return `<li class="route-step">
          <span class="step-text">${s.text}</span>
          <span class="step-dist">${stepDistance}${durationText}</span>
        </li>`;
      }).join('')}</ol>`
    : '<p>Route found — no turn-by-turn steps available.</p>';

  el.innerHTML = `
    <h3>Directions</h3>
    <div class="route-summary">
      <div class="summary-item">
        <strong>📍 Distance:</strong> ${formatDistance(summary.totalDistance || 0)}
      </div>
      <div class="summary-item">
        <strong>⏱ Duration:</strong> ${formatDuration(summary.totalTime || 0)}
      </div>
    </div>
    <h4>Turn-by-Turn Instructions:</h4>
    ${stepsHtml}
  `;
  
  // Add CSS for better styling
  if (!document.getElementById('route-directions-css')) {
    const style = document.createElement('style');
    style.id = 'route-directions-css';
    style.textContent = `
      #route-directions {
        max-height: 600px;
        overflow-y: auto;
        padding: 15px;
        background: white;
        border-radius: 8px;
      }
      .route-summary {
        background: #f0f7ff;
        padding: 12px;
        border-radius: 4px;
        margin: 10px 0;
        border-left: 4px solid #4CAF50;
      }
      .summary-item {
        padding: 5px 0;
        font-size: 14px;
      }
      .route-steps {
        padding-left: 20px;
        margin: 15px 0;
      }
      .route-step {
        padding: 8px;
        margin: 5px 0;
        background: #f9f9f9;
        border-radius: 4px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-left: 3px solid #4CAF50;
      }
      .step-text {
        flex: 1;
        font-size: 13px;
        color: #333;
      }
      .step-dist {
        background: #4CAF50;
        color: white;
        padding: 4px 8px;
        border-radius: 3px;
        font-size: 12px;
        font-weight: bold;
        margin-left: 10px;
        white-space: nowrap;
      }
    `;
    document.head.appendChild(style);
  }
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

  // Draw outer glow effect
  L.polyline(latLngs, {
    color: '#ff9f43',
    weight: 20,
    opacity: 0.3,
    lineJoin: 'round',
    lineCap: 'round'
  }).addTo(routeLayerGroup);

  // Draw main route line (prominent blue)
  L.polyline(latLngs, {
    color: '#2980b9',
    weight: 8,
    opacity: 1,
    lineJoin: 'round',
    lineCap: 'round'
  }).addTo(routeLayerGroup);

  // Draw highlight line
  L.polyline(latLngs, {
    color: '#3498db',
    weight: 4,
    opacity: 0.7,
    lineJoin: 'round',
    lineCap: 'round'
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

async function fetchOSRMRoute(startLatLng, endLatLng, retryCount = 0) {
  // Validate coordinates
  if (!startLatLng || !endLatLng) {
    throw new Error('Invalid start or end location');
  }
  
  let startLat = startLatLng.lat;
  let startLng = startLatLng.lng;
  let endLat = endLatLng.lat;
  let endLng = endLatLng.lng;
  
  // Check if coordinates are numbers
  if (typeof startLat !== 'number' || typeof startLng !== 'number' || 
      typeof endLat !== 'number' || typeof endLng !== 'number') {
    throw new Error('Start or destination coordinates are invalid (not numbers)');
  }
  
  // Check for NaN
  if (isNaN(startLat) || isNaN(startLng) || isNaN(endLat) || isNaN(endLng)) {
    throw new Error('Start or destination coordinates contain NaN values');
  }
  
  // Check geographic bounds
  if (startLat < -90 || startLat > 90 || startLng < -180 || startLng > 180 ||
      endLat < -90 || endLat > 90 || endLng < -180 || endLng > 180) {
    throw new Error('Start or destination coordinates are outside valid geographic bounds');
  }
  
  // Check if start and end are too close
  const distance = Math.sqrt(Math.pow(endLat - startLat, 2) + Math.pow(endLng - startLng, 2));
  if (distance < 0.0001) {
    throw new Error('Start and destination are too close to each other');
  }
  
  console.log(`Requesting route (attempt ${retryCount + 1}) from [${startLat.toFixed(4)}, ${startLng.toFixed(4)}] to [${endLat.toFixed(4)}, ${endLng.toFixed(4)}]`);
  
  try {
    // Use OSRM API - completely free, no API key required
    // Format: /route/v1/driving/lng1,lat1;lng2,lat2
    const osrmUrl = `${OSRM_URL}/${startLng},${startLat};${endLng},${endLat}?steps=true&geometries=geojson&overview=full&annotations=distance,duration`;
    
    console.log('Requesting route from OSRM...');
    
    const resp = await fetch(osrmUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!resp.ok) {
      const errorData = await resp.text();
      console.error('OSRM Router error response:', errorData);
      throw new Error(`Routing service error ${resp.status}`);
    }
    
    const data = await resp.json();
    
    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      if (retryCount < 2) {
        console.log(`No route found (attempt ${retryCount + 1}/3). Trying again...`);
        return fetchOSRMRoute(startLatLng, endLatLng, retryCount + 1);
      }
      throw new Error(data.message || 'No route found between these locations. Try different addresses.');
    }
    
    const route = data.routes[0];
    
    // OSRM returns coordinates as [lng, lat] in geometry.coordinates
    // Convert to [lat, lng] for our map
    const coordinates = route.geometry.coordinates.map((coord) => [coord[1], coord[0]]);
    
    // Extract detailed turn-by-turn instructions from OSRM steps
    const allSteps = [];
    (route.legs || []).forEach((leg, legIdx) => {
      if (leg.steps && Array.isArray(leg.steps)) {
        leg.steps.forEach((step, stepIdx) => {
          let instruction = 'Continue';
          const roadName = step.name || '';
          
          // Skip trivial steps (< 500m "Continue" with no road name)
          if (!step.maneuver && step.distance < 500 && !roadName) {
            return;
          }
          
          // Build instruction from maneuver information
          if (step.maneuver) {
            const { type, modifier } = step.maneuver;
            
            switch (type) {
              case 'turn':
                if (modifier === 'left') instruction = 'Turn left';
                else if (modifier === 'right') instruction = 'Turn right';
                else if (modifier === 'sharp left') instruction = 'Sharp left turn';
                else if (modifier === 'sharp right') instruction = 'Sharp right turn';
                else if (modifier === 'slight left') instruction = 'Bear left';
                else if (modifier === 'slight right') instruction = 'Bear right';
                else instruction = 'Turn';
                break;
              case 'arrive':
                instruction = 'Destination reached';
                break;
              case 'roundabout':
              case 'rotary':
                instruction = 'Enter roundabout';
                break;
              case 'exit_rotary':
              case 'exit_roundabout':
                instruction = 'Exit roundabout';
                break;
              case 'end_of_road':
                instruction = 'Road ends';
                break;
              case 'merge':
                instruction = 'Merge';
                break;
              case 'fork':
                instruction = 'Fork';
                break;
              case 'notification':
              case 'waypoint':
                if (roadName) instruction = `Proceed to ${roadName}`;
                else return; // Skip empty notifications
                break;
              case 'continue':
              default:
                instruction = roadName ? `Continue on ${roadName}` : 'Continue';
            }
            
            // Add road name for non-continue instructions
            if (roadName && !instruction.includes(' on ') && instruction !== 'Destination reached') {
              instruction += ` on ${roadName}`;
            }
          } else if (roadName) {
            // No maneuver info but has road name
            instruction = `Continue on ${roadName}`;
          }
          
          // Skip empty instructions
          if (!instruction || instruction === 'Continue') {
            return;
          }
          
          allSteps.push({
            text: instruction,
            distance: step.distance || 0,
            duration: step.duration || 0,
            name: roadName
          });
        });
      }
    });

    const trip = {
      legs: [{
        shape: coordinates, // Array of [lat, lng] coordinates
        steps: allSteps
      }],
      summary: {
        length: route.distance || 0,
        time: route.duration || 0,
        totalDistance: route.distance || 0,
        totalTime: route.duration || 0
      },
      instructions: allSteps // All detailed steps
    };
    
    console.log('Route found successfully!', { 
      distance: (route.distance / 1000).toFixed(2) + ' km', 
      duration: (route.duration / 60).toFixed(0) + ' min' 
    });
    return trip;
    
  } catch (err) {
    if (err instanceof TypeError && err.message.includes('fetch')) {
      throw new Error('Network error: Cannot reach routing service. Check your internet connection.');
    }
    throw err;
  }
}

function applyOSRMRoute(trip, startLatLng, endLatLng) {
  // Handle both encoded polyline and direct coordinates
  let coords = [];
  
  if (typeof trip.legs[0].shape === 'string') {
    // Encoded polyline (from old Valhalla format)
    coords = decodePolyline(trip.legs[0].shape);
  } else if (Array.isArray(trip.legs[0].shape)) {
    // Direct array of coordinates from OSRM
    // Format: [[lat, lng], [lat, lng], ...]
    coords = trip.legs[0].shape.map(coord => {
      if (Array.isArray(coord)) {
        return L.latLng(coord[0], coord[1]);
      }
      return coord;
    });
  }
  
  // Draw the route polyline on map
  drawPersistentRoute({ coordinates: coords });
  
  // Fit map to show entire route
  if (coords.length > 1) {
    map.fitBounds(L.latLngBounds(coords), { padding: [30, 30] });
  }
  
  // Show all safety heatmaps
  addHotspots();
  
  // Extract turn-by-turn instructions (OSRM returns full steps)
  let instructions = [];
  
  if (trip.instructions && Array.isArray(trip.instructions)) {
    // Use the detailed steps extracted from OSRM
    instructions = trip.instructions.map(inst => ({
      text: inst.text || inst.name || 'Continue',
      distance: inst.distance || 0,
      duration: inst.duration || 0
    }));
  }
  
  // Render directions
  renderRouteDirections({
    summary: {
      totalDistance: trip.summary.totalDistance || trip.summary.length || 0,
      totalTime: trip.summary.totalTime || trip.summary.time || 0
    },
    instructions: instructions,
    routeCoords: coords
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
  // Use bounds centered on India (Delhi region) to help geocoding
  const indiaLat = 28.7; // Delhi latitude
  const indiaLng = 77.1; // Delhi longitude
  const boundingBox = `${indiaLat - 2},${indiaLng - 2},${indiaLat + 2},${indiaLng + 2}`;
  
  const params = new URLSearchParams({
    q: address,
    key: OPENCAGE_API_KEY,
    bounds: boundingBox,
    countrycode: 'in',
    limit: 5
  });
  
  fetch(`https://api.opencagedata.com/geocode/v1/json?${params.toString()}`)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Geocoding API returned ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      if (data.results && data.results.length > 0) {
        // Try to use the result - validate it
        let validResult = null;
        for (let i = 0; i < Math.min(data.results.length, 3); i++) {
          const result = data.results[i];
          const { lat, lng } = result.geometry;
          
          if (typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng)) {
            if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
              validResult = { lat, lng, result };
              break;
            }
          }
        }
        
        if (validResult) {
          console.log(`Geocoded "${address}" to [${validResult.lat}, ${validResult.lng}]`);
          console.log('Result details:', validResult.result);
          callback([validResult.lat, validResult.lng]);
        } else {
          throw new Error('All geocoding results had invalid coordinates');
        }
      } else {
        alert(`Address "${address}" not found in India. Please try a different address.`);
      }
    })
    .catch((error) => {
      console.error('Error geocoding address:', error);
      alert(`Geocoding error: ${error.message}. For best results, try a full address with city.`);
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

function loadDistrictData() {
  // Use PapaParse library (already included in index.html) to properly parse CSV
  fetch('safety%20scores.csv')
    .then((response) => response.text())
    .then((csvText) => {
      // Parse CSV with PapaParse
      Papa.parse(csvText, {
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: function(results) {
          console.log('CSV Parsing complete. Rows:', results.data.length);
          
          const districts = [];
          
          results.data.forEach((row, idx) => {
            // Check if row has required fields
            if (row.district && row.Latitude && row.Longitude && row.safety_score !== undefined) {
              // Handle both "Latitude"/"Longitude" and "latitude"/"longitude" keys
              const lat = row.Latitude || row.latitude;
              const lng = row.Longitude || row.longitude;
              const score = row.safety_score;
              
              const lat_num = parseFloat(lat);
              const lng_num = parseFloat(lng);
              const score_num = parseFloat(score);
              
              if (!isNaN(lat_num) && !isNaN(lng_num) && !isNaN(score_num)) {
                const district = {
                  state: row.state || '',
                  name: row.district.trim(),
                  lat: lat_num,
                  lng: lng_num,
                  safety_score: score_num
                };
                
                districts.push(district);
              }
            }
          });
          
          districtData = districts;
          console.log('Successfully loaded ' + districts.length + ' districts');
          if (districts.length > 0) {
            console.log('Sample district:', districts[0]);
          }
        },
        error: function(error) {
          console.error('CSV parsing error:', error);
        }
      });
    })
    .catch((error) => {
      console.error('Error loading district data:', error);
    });
}

function getDistrictSuggestions(input) {
  if (!input || input.length < 1) return [];
  
  return districtData
    .filter(d => d.name.toLowerCase().includes(input.toLowerCase()))
    .slice(0, 10)
    .map(d => d.name);
}

function addHotspots() {
  if (!map) {
    return;
  }

  // Clear existing heatmap layers
  if (window.heatmapLayer) {
    map.removeLayer(window.heatmapLayer);
  }

  // Create layer group for heatmap
  const heatmapGroup = L.layerGroup();

  // Add district circles with safety score colors
  if (Array.isArray(districtData) && districtData.length > 0) {
    districtData.forEach((district) => {
      let color;
      const score = district.safety_score;
      
      if (score > 90) {
        color = '#77DD77'; // Green - Very Safe
      } else if (score > 80) {
        color = '#B2B27F'; // Yellow-Green - Safe
      } else if (score > 70) {
        color = '#FDFD96'; // Yellow - Moderate
      } else if (score > 60) {
        color = '#F6C4C4'; // Light Red - Unsafe
      } else {
        color = '#FFB3B3'; // Red - Very Unsafe
      }

      L.circle([district.lat, district.lng], {
        color: color,
        fillColor: color,
        fillOpacity: 0.35,
        radius: 8000, // Larger radius for better visibility
        weight: 2
      }).addTo(heatmapGroup)
        .bindPopup(`
          <b>${district.name}</b><br>
          State: ${district.state}<br>
          Safety Score: <strong style="color: ${color}; font-size: 16px;">${Number(district.safety_score).toFixed(2)}</strong>
        `, { minWidth: 200 });
    });
  }

  // Add individual point data as smaller circles (if available)
  if (Array.isArray(safetyData) && safetyData.length > 0) {
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
        color: color,
        fillColor: color,
        fillOpacity: 0.15,
        radius: 3000,
        weight: 1
      }).addTo(heatmapGroup)
        .bindPopup(`Safety Score: ${Number(safetyScore).toFixed(2)}`);
    });
  }

  heatmapGroup.addTo(map);
  window.heatmapLayer = heatmapGroup;
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
  const startInput = document.getElementById('start');
  const destInput = document.getElementById('destination');
  const safetyScoresElement = document.getElementById('safety-scores');

  if (!startInput || !destInput || !routingControl) {
    alert('Please wait for app to load...');
    return;
  }

  const startDistrictName = startInput.value.trim();
  const destDistrictName = destInput.value.trim();

  if (!startDistrictName || !destDistrictName) {
    alert('Please enter both start and destination districts.');
    return;
  }

  if (startDistrictName.toLowerCase() === destDistrictName.toLowerCase()) {
    alert('Please select different start and destination districts.');
    return;
  }

  const directionsEl = document.getElementById('route-directions');
  if (directionsEl) {
    directionsEl.innerHTML = '<p>Searching for districts…</p>';
  }

  // Find matching districts (case-insensitive)
  const startDistrict = districtData.find(d => d.name.toLowerCase() === startDistrictName.toLowerCase());
  const endDistrict = districtData.find(d => d.name.toLowerCase() === destDistrictName.toLowerCase());

  if (!startDistrict) {
    const similar = districtData.filter(d => d.name.toLowerCase().includes(startDistrictName.toLowerCase())).slice(0, 5);
    let message = `District "${startDistrictName}" not found. `;
    if (similar.length > 0) {
      message += `Did you mean: ${similar.map(d => d.name).join(', ')}?`;
    } else {
      message += `Check the spelling. Available districts starting with "${startDistrictName[0]}": ${districtData.filter(d => d.name[0].toLowerCase() === startDistrictName[0].toLowerCase()).slice(0, 5).map(d => d.name).join(', ')}...`;
    }
    alert(message);
    return;
  }

  if (!endDistrict) {
    const similar = districtData.filter(d => d.name.toLowerCase().includes(destDistrictName.toLowerCase())).slice(0, 5);
    let message = `District "${destDistrictName}" not found. `;
    if (similar.length > 0) {
      message += `Did you mean: ${similar.map(d => d.name).join(', ')}?`;
    } else {
      message += `Check the spelling. Available districts starting with "${destDistrictName[0]}": ${districtData.filter(d => d.name[0].toLowerCase() === destDistrictName[0].toLowerCase()).slice(0, 5).map(d => d.name).join(', ')}...`;
    }
    alert(message);
    return;
  }

  const startCoords = [startDistrict.lat, startDistrict.lng];
  const endCoords = [endDistrict.lat, endDistrict.lng];

  routeActive = true;
  resetRouteExpiry();

  if (startRouteMarker) { map.removeLayer(startRouteMarker); }
  if (endRouteMarker) { map.removeLayer(endRouteMarker); }
  
  startRouteMarker = L.marker(startCoords).addTo(map).bindPopup(`<b>${startDistrict.name}</b><br>Safety: ${startDistrict.safety_score.toFixed(2)}`);
  endRouteMarker = L.marker(endCoords).addTo(map).bindPopup(`<b>${endDistrict.name}</b><br>Safety: ${endDistrict.safety_score.toFixed(2)}`);

  // Fit map to show both markers
  map.fitBounds(L.latLngBounds([startCoords, endCoords]).pad(0.3));

  addHotspots();

  // Show district safety scores
  if (safetyScoresElement) {
    safetyScoresElement.innerHTML =
      `<strong>Safety Scores:</strong><br>${startDistrict.name}: ${startDistrict.safety_score.toFixed(2)}<br>${endDistrict.name}: ${endDistrict.safety_score.toFixed(2)}`;
  }

  // Calculate route
  (async () => {
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
  })();
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
  loadDistrictData();
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
