require('dotenv').config({ quiet: true });
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

const MONGODB_URI = process.env.MONGODB_URI || '';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL || '';
const TEAM_KEY = process.env.TEAM_KEY || '';

let db = null;

// Connect to MongoDB
if (MONGODB_URI) {
  const client = new MongoClient(MONGODB_URI);
  client.connect().then(() => {
    db = client.db('testcaseManager');
    console.log('🔗 Connected to MongoDB');
  }).catch(err => console.error('MongoDB error:', err));
}

app.use(express.json({ limit: '50mb' }));
app.use(cors());
app.use(express.static(__dirname, { index: 'index.html', setHeaders: (res, fp) => { if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); } }));

// Auth Middleware — client already sends the team key as the Authorization
// header on every /api call (see index.html); this was previously a no-op,
// so any client could read/wipe data regardless of key. /ping and
// /check-auth stay open so health checks and the unlock screen still work.
app.use('/api', (req, res, next) => {
  if (!TEAM_KEY || req.path === '/ping' || req.path === '/check-auth') return next();
  if (req.headers.authorization !== TEAM_KEY) return res.status(401).json({ error: 'unauthorized' });
  next();
});

app.get('/api/ping', (_, res) => res.json({ ok: true, isDb: !!db }));
app.get('/api/check-auth', (req, res) => {
  if (!TEAM_KEY) return res.json({ locked: false, ok: true });
  res.json({ locked: true, ok: req.headers.authorization === TEAM_KEY });
});

// GET Repo
app.get('/api/repo', async (_, res) => {
  try {
    if (db) {
      const meta = await db.collection('meta').findOne({ id: 'main' }) || { projects: [], categories: [], nextId: 1, nextRunId: 1 };
      const testCases = await db.collection('testCases').find({}).toArray();
      const testRuns = await db.collection('testRuns').find({}).toArray();
      const runResultsArr = await db.collection('runResults').find({}).toArray();
      const runResults = {}; runResultsArr.forEach(r => runResults[r.id] = r.data);
      res.json({ projects: meta.projects||[], categories: meta.categories||[], nextId: meta.nextId||1, nextRunId: meta.nextRunId||1, testCases, testRuns, runResults });
    } else {
      if (!fs.existsSync(DATA_FILE)) return res.json({ projects: [], testCases: [], testRuns: [], runResults: {}, nextId: 1, nextRunId: 1 });
      res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Merge helper (prevents overwrite on concurrent saves)
function mergeRepos(existing, incoming) {
  const projects = [...new Set([...(existing.projects||[]), ...(incoming.projects||[])])];
  const casesMap = {};
  (existing.testCases||[]).forEach(c => casesMap[c.id + '|' + c.project] = c);
  (incoming.testCases||[]).forEach(c => casesMap[c.id + '|' + c.project] = c);
  const runsMap = {};
  (existing.testRuns||[]).forEach(r => runsMap[r.id] = r);
  (incoming.testRuns||[]).forEach(r => runsMap[r.id] = r);
  const runResults = {};
  const allRunIds = new Set([...Object.keys(existing.runResults||{}), ...Object.keys(incoming.runResults||{})]);
  for (const rid of allRunIds) {
    runResults[rid] = { ...(existing.runResults?.[rid]||{}), ...(incoming.runResults?.[rid]||{}) };
  }
  return {
    projects,
    testCases: Object.values(casesMap),
    testRuns: Object.values(runsMap),
    runResults,
    nextId: Math.max(existing.nextId||1, incoming.nextId||1),
    nextRunId: Math.max(existing.nextRunId||1, incoming.nextRunId||1),
    categories: incoming.categories || existing.categories || [],
    autoScannedProjects: [...new Set([...(existing.autoScannedProjects||[]), ...(incoming.autoScannedProjects||[])])]
  };
}

// Sync Granular Changes
app.post('/api/sync', async (req, res) => {
  try {
    const { projects, categories, nextId, nextRunId, updatedCases, updatedRuns, updatedResults, fullRepoFallback } = req.body;
    if (db) {
      const updateObj = { $set: { nextId: nextId||1, nextRunId: nextRunId||1 } };
      if (categories && categories.length) updateObj.$set.categories = categories;
      if (projects && projects.length) updateObj.$addToSet = { projects: { $each: projects } };
      await db.collection('meta').updateOne({ id: 'main' }, updateObj, { upsert: true });

      // Upsert Cases — use compound key {id, project} so TC-001 in different projects are distinct
      if (updatedCases && updatedCases.length) {
        const bulk = db.collection('testCases').initializeUnorderedBulkOp();
        updatedCases.forEach(c => {
          const doc = {...c}; delete doc._id;
          bulk.find({ id: c.id, project: c.project }).upsert().updateOne({ $set: doc });
        });
        await bulk.execute();
      }

      // Delete Cases
      if (req.body.deletedCases && req.body.deletedCases.length) {
        await db.collection('testCases').deleteMany({ id: { $in: req.body.deletedCases } });
      }

      // Upsert Runs
      if (updatedRuns && updatedRuns.length) {
        const bulk = db.collection('testRuns').initializeUnorderedBulkOp();
        updatedRuns.forEach(r => { const doc={...r}; delete doc._id; bulk.find({ id: r.id }).upsert().updateOne({ $set: doc }); });
        await bulk.execute();
      }

      // Upsert Results
      if (updatedResults) {
        for (const [runId, data] of Object.entries(updatedResults)) {
          const existing = await db.collection('runResults').findOne({ id: runId });
          const merged = { ...(existing?.data||{}), ...data };
          await db.collection('runResults').updateOne({ id: runId }, { $set: { data: merged } }, { upsert: true });
        }
      }

      // Delete Runs
      if (req.body.deletedRuns && req.body.deletedRuns.length) {
        await db.collection('testRuns').deleteMany({ id: { $in: req.body.deletedRuns } });
        await db.collection('runResults').deleteMany({ id: { $in: req.body.deletedRuns } });
      }

      res.json({ ok: true });
    } else {
      // Local file fallback
      if (fullRepoFallback) {
        let existing = { projects:[], testCases:[], testRuns:[], runResults:{}, nextId:1, nextRunId:1 };
        if (fs.existsSync(DATA_FILE)) {
          try { existing = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch(e) {}
        }
        const merged = mergeRepos(existing, fullRepoFallback);
        fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2), 'utf8');
      }
      res.json({ ok: true });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Full Restore — atomically replaces ALL data (wipe + insert)
app.post('/api/restore', async (req, res) => {
  try {
    const { repo } = req.body;
    if (!repo) return res.status(400).json({ error: 'No repo data provided' });
    if (db) {
      await db.collection('testCases').deleteMany({});
      await db.collection('testRuns').deleteMany({});
      await db.collection('runResults').deleteMany({});
      if (repo.testCases && repo.testCases.length) {
        const docs = repo.testCases.map(c => { const d={...c}; delete d._id; return d; });
        await db.collection('testCases').insertMany(docs);
      }
      if (repo.testRuns && repo.testRuns.length) {
        const docs = repo.testRuns.map(r => { const d={...r}; delete d._id; return d; });
        await db.collection('testRuns').insertMany(docs);
      }
      for (const [runId, data] of Object.entries(repo.runResults || {})) {
        await db.collection('runResults').updateOne({ id: runId }, { $set: { data } }, { upsert: true });
      }
      await db.collection('meta').updateOne({ id: 'main' }, {
        $set: { projects: repo.projects||[], categories: repo.categories||[], nextId: repo.nextId||1, nextRunId: repo.nextRunId||1 }
      }, { upsert: true });
      res.json({ ok: true, restored: (repo.testCases||[]).length });
    } else {
      fs.writeFileSync(DATA_FILE, JSON.stringify(repo, null, 2), 'utf8');
      res.json({ ok: true, restored: (repo.testCases||[]).length });
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
