require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { MongoClient } = require('mongodb');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'TestRepository.json');

const TEAM_KEY = process.env.TEAM_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || '';

let db = null;

// Connect to MongoDB
if (MONGODB_URI) {
  const client = new MongoClient(MONGODB_URI);
  client.connect().then(() => {
    db = client.db('testcaseManager');
    console.log('🔗 Connected to MongoDB Atlas');
  }).catch(err => console.error('MongoDB error:', err));
}

app.use(express.json({ limit: '20mb' }));
app.use(cors());
app.use(express.static(__dirname, { index: 'index.html', setHeaders: (res, fp) => { if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));

// Auth Middleware
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS' || req.path === '/ping' || req.path === '/check-auth') return next();
  if (TEAM_KEY && req.headers['authorization'] !== TEAM_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

app.get('/api/ping', (_, res) => res.json({ ok: true, isDb: !!db }));
app.get('/api/check-auth', (req, res) => res.json({ locked: !!TEAM_KEY, ok: req.headers['authorization'] === TEAM_KEY }));

// GET Repo
app.get('/api/repo', async (_, res) => {
  try {
    if (db) {
      const meta = await db.collection('meta').findOne({ id: 'main' }) || { projects: [], nextId: 1, nextRunId: 1 };
      const testCases = await db.collection('testCases').find({}).toArray();
      const testRuns = await db.collection('testRuns').find({}).toArray();
      const runResultsArr = await db.collection('runResults').find({}).toArray();
      const runResults = {}; runResultsArr.forEach(r => runResults[r.id] = r.data);
      res.json({ projects: meta.projects||[], nextId: meta.nextId||1, nextRunId: meta.nextRunId||1, testCases, testRuns, runResults });
    } else {
      if (!fs.existsSync(DATA_FILE)) return res.json({ projects: [], testCases: [], testRuns: [], runResults: {}, nextId: 1, nextRunId: 1 });
      res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync Granular Changes OR replace file
app.post('/api/sync', async (req, res) => {
  try {
    const { projects, nextId, nextRunId, updatedCases, updatedRuns, updatedResults, fullRepoFallback } = req.body;
    if (db) {
      // Upsert Meta
      if(projects) await db.collection('meta').updateOne({ id: 'main' }, { $set: { projects, nextId, nextRunId } }, { upsert: true });
      // Upsert Cases
      if(updatedCases && updatedCases.length) {
        const bulk = db.collection('testCases').initializeUnorderedBulkOp();
        updatedCases.forEach(c => { const doc={...c}; delete doc._id; bulk.find({ id: c.id }).upsert().updateOne({ $set: doc }); });
        await bulk.execute();
      }
      // Upsert Runs
      if(updatedRuns && updatedRuns.length) {
        const bulk = db.collection('testRuns').initializeUnorderedBulkOp();
        updatedRuns.forEach(r => { const doc={...r}; delete doc._id; bulk.find({ id: r.id }).upsert().updateOne({ $set: doc }); });
        await bulk.execute();
      }
      // Upsert Results
      if(updatedResults) {
        const bulk = db.collection('runResults').initializeUnorderedBulkOp();
        Object.entries(updatedResults).forEach(([runId, data]) => { bulk.find({ id: runId }).upsert().updateOne({ $set: { data } }); });
        if(bulk.batches && bulk.batches.length) await bulk.execute();
      }
      res.json({ ok: true });
    } else {
      // Local file fallback
      if(fullRepoFallback) fs.writeFileSync(DATA_FILE, JSON.stringify(fullRepoFallback, null, 2), 'utf8');
      res.json({ ok: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Slack Webhook Proxy
app.post('/api/slack', async (req, res) => {
  if (!SLACK_WEBHOOK) return res.json({ skipped: true });
  try {
    await axios.post(SLACK_WEBHOOK, req.body);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start Server
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const a of ifaces) if (a.family === 'IPv4' && !a.internal) return a.address;
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const ln = '═'.repeat(50);
  console.log(`\n  ╔${ln}╗`);
  console.log(`  ║${'  🧪  Test Case Manager — Server Started  '.padEnd(50)}║`);
  console.log(`  ╠${ln}╣`);
  console.log(`  ║${ ('  ✅  Local:   http://localhost:' + PORT).padEnd(50)}║`);
  console.log(`  ║${ ('  🌐  Network: http://' + ip + ':' + PORT).padEnd(50)}║`);
  console.log(`  ╚${ln}╝\n`);
});
