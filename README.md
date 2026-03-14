# Safe Route

Safe Route is a web app that helps users plan safer travel paths, view nearby incident reports, and submit new reports with authenticated accounts.

## What It Does

- Shows route planning on an interactive map.
- Displays safety scoring from local dataset points.
- Supports user signup/login with Firebase Authentication.
- Stores user profiles and incident reports in MongoDB.
- Loads nearby reports around the current location.
- Includes emergency-contact quick actions.

## Current Architecture

- Frontend: HTML, CSS, vanilla JavaScript
- Mapping: Leaflet + Leaflet Routing Machine
- Geocoding: OpenCage API
- Authentication: Firebase Auth (client + admin token verification)
- Backend API: Node.js + Express
- Database: MongoDB (via Mongoose)

## Project Structure

- `index.html`: Main dashboard page
- `login.html` and `signup.html`: Auth pages
- `scripts.js`: Frontend app logic (routing, geocoding, reporting, SOS)
- `styles.css`: Styling
- `app.js`: Express API server and static file host
- `safety_scores.json`: Safety score dataset used by the map UI
- `firebase-service-account.json`: Optional Firebase Admin credentials for backend

## Prerequisites

- Node.js 18+
- npm
- A MongoDB connection string
- Firebase project (for user authentication)

## Environment Variables

Create a `.env` file in the project root:

```env
MONGO_URI=your_mongodb_connection_string
PORT=3000
# Optional if not using firebase-service-account.json file
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account",...}
```

Notes:
- If `firebase-service-account.json` exists in the root, backend uses that first.
- Otherwise backend falls back to `FIREBASE_SERVICE_ACCOUNT_JSON`, then application default credentials.

## Installation

```bash
npm install
```

## Run Locally

```bash
node app.js
```

Then open:

- `http://localhost:3000`

## API Endpoints

Base URL: `http://localhost:3000`

- `POST /api/sync-user` (auth required)
	- Upserts user profile from Firebase identity.
- `POST /api/logout` (auth required)
	- Revokes Firebase refresh tokens for the user.
- `POST /api/reports` (auth required)
	- Creates incident report.
	- Rate limit: max 3 reports per hour per user.
- `GET /api/reports`
	- Gets recent reports (supports `limit`).
- `GET /api/reports/nearby?lat={lat}&lng={lng}&radius={km}&limit={n}`
	- Gets reports within distance radius.
- `GET /api/my-reports` (auth required)
	- Gets reports created by authenticated user.

Auth header format:

```http
Authorization: Bearer <firebase_id_token>
```

## Frontend Behavior Notes

- The app sets API base automatically:
	- If opened from `file://` or non-3000 port, it defaults to `http://localhost:3000`.
	- Can be overridden with `localStorage.apiBaseUrl`.
- Nearby reports are fetched around live location (default radius 50 km).
- Safety score markers are loaded from `safety_scores.json`.

## Security and Cleanup Recommendations

- Move hard-coded client API keys (for OpenCage/Firebase config) into a safer configuration flow.
- Do not commit real service-account keys to public repositories.


## Troubleshooting

- If reports fail to load, confirm backend is running on port 3000.
- If login works but API calls fail with 401, check Firebase ID token presence in local storage.
- If Mongo connection fails, verify `MONGO_URI` in `.env`.

## License

ISC
