const express = require('express');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const { initializeApp, applicationDefault, cert, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

dotenv.config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('MongoDB connected'))
  .catch((err) => console.error('MongoDB connection error:', err));

function initializeFirebaseAdmin() {
  if (getApps().length > 0) {
    return;
  }

  const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');
  if (fs.existsSync(serviceAccountPath)) {
    const serviceAccount = require(serviceAccountPath);
    initializeApp({ credential: cert(serviceAccount) });
    return;
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    initializeApp({ credential: cert(serviceAccount) });
    return;
  }

  initializeApp({ credential: applicationDefault() });
}

initializeFirebaseAdmin();

const UserSchema = new mongoose.Schema({
  firebaseUid: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: '' },
  email: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
  lastLoginAt: { type: Date, default: Date.now }
});

const ReportSchema = new mongoose.Schema({
  type: { type: String, required: true },
  description: { type: String, required: true },
  location: { type: String, required: true },
  latitude: { type: Number, required: true },
  longitude: { type: Number, required: true },
  userUid: { type: String, required: true, index: true },
  userEmail: { type: String, default: 'anonymous' },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Report = mongoose.models.Report || mongoose.model('Report', ReportSchema);

async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ success: false, message: 'Missing Firebase token' });
  }

  try {
    const decoded = await getAuth().verifyIdToken(token, true);
    req.user = decoded;
    return next();
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return res.status(401).json({ success: false, message: 'Invalid or expired token' });
  }
}

function parseLimit(rawValue, fallback = 50, max = 200) {
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function calculateDistanceKm(lat1, lng1, lat2, lng2) {
  const toRadians = (value) => (value * Math.PI) / 180;
  const earthRadiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLng = toRadians(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2))
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

app.post('/api/sync-user', verifyFirebaseToken, async (req, res) => {
  try {
    const firebaseUid = req.user.uid;
    const email = req.user.email || req.body.email || '';
    const name = req.body.name || req.user.name || (email ? email.split('@')[0] : '');

    const user = await User.findOneAndUpdate(
      { firebaseUid },
      {
        $set: {
          firebaseUid,
          email,
          name,
          updatedAt: new Date(),
          lastLoginAt: new Date()
        },
        $setOnInsert: {
          createdAt: new Date()
        }
      },
      { new: true, upsert: true }
    );

    return res.status(200).json({ success: true, user });
  } catch (error) {
    console.error('Error syncing user:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/logout', verifyFirebaseToken, async (req, res) => {
  try {
    await getAuth().revokeRefreshTokens(req.user.uid);
    return res.status(200).json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error revoking tokens during logout:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.post('/api/reports', verifyFirebaseToken, async (req, res) => {
  try {
    const { type, description, location, latitude, longitude } = req.body;

    if (!type || !description || !location || latitude == null || longitude == null) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: type, description, location, latitude, longitude'
      });
    }

    // Layer 2 — server-side rate limiting: max 3 reports per hour per Firebase UID
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentCount = await Report.countDocuments({
      userUid: req.user.uid,
      createdAt: { $gte: oneHourAgo }
    });
    if (recentCount >= 3) {
      return res.status(429).json({
        success: false,
        message: 'Rate limit exceeded. You can submit at most 3 reports per hour. Please try again later.'
      });
    }

    const report = await Report.create({
      type,
      description,
      location,
      latitude: Number.parseFloat(latitude),
      longitude: Number.parseFloat(longitude),
      userUid: req.user.uid,
      userEmail: req.user.email || 'anonymous'
    });

    return res.status(201).json({ success: true, report });
  } catch (error) {
    console.error('Error creating report:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 50, 200);
    const reports = await Report.find().sort({ createdAt: -1 }).limit(limit);
    return res.status(200).json({ success: true, reports });
  } catch (error) {
    console.error('Error fetching reports:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/reports/nearby', async (req, res) => {
  try {
    const { lat, lng, radius = 10 } = req.query;
    if (!lat || !lng) {
      return res.status(400).json({ success: false, message: 'lat and lng are required' });
    }

    const latNum = Number.parseFloat(lat);
    const lngNum = Number.parseFloat(lng);
    const radiusKm = Number.parseFloat(radius);

    if (Number.isNaN(latNum) || Number.isNaN(lngNum) || Number.isNaN(radiusKm)) {
      return res.status(400).json({ success: false, message: 'lat, lng and radius must be numbers' });
    }

    const latRadiusDeg = radiusKm / 111;
    const lngRadiusDeg = radiusKm / (111 * Math.cos((latNum * Math.PI) / 180));
    const limit = parseLimit(req.query.limit, 50, 200);

    const candidateReports = await Report.find({
      latitude: { $gte: latNum - latRadiusDeg, $lte: latNum + latRadiusDeg },
      longitude: { $gte: lngNum - lngRadiusDeg, $lte: lngNum + lngRadiusDeg }
    }).sort({ createdAt: -1 });

    const reports = candidateReports
      .filter((report) => calculateDistanceKm(latNum, lngNum, report.latitude, report.longitude) <= radiusKm)
      .slice(0, limit);

    return res.status(200).json({ success: true, reports });
  } catch (error) {
    console.error('Error fetching nearby reports:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.get('/api/my-reports', verifyFirebaseToken, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 50, 200);
    const reports = await Report.find({ userUid: req.user.uid }).sort({ createdAt: -1 }).limit(limit);
    return res.status(200).json({ success: true, reports });
  } catch (error) {
    console.error('Error fetching user reports:', error);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
