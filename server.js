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

// ── Merge helper (prevents overwrite on concurrent saves) ──
function mergeRepos(existing, incoming) {
  // Projects: union — never loses anyone's projects
  const projects = [...new Set([...(existing.projects||[]), ...(incoming.projects||[])])];

  // Test Cases: upsert by id — incoming wins for same id (latest edit wins)
  const casesMap = {};
  (existing.testCases||[]).forEach(c => casesMap[c.id] = c);
  (incoming.testCases||[]).forEach(c => casesMap[c.id] = c);

  // Test Runs: upsert by id
  const runsMap = {};
  (existing.testRuns||[]).forEach(r => runsMap[r.id] = r);
  (incoming.testRuns||[]).forEach(r => runsMap[r.id] = r);

  // Run Results: merge per run, then per case inside each run
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
    autoScannedProjects: [...new Set([...(existing.autoScannedProjects||[]), ...(incoming.autoScannedProjects||[])])]
  };
}

// Sync Granular Changes — always merges, never overwrites
app.post('/api/sync', async (req, res) => {
  try {
    const { projects, nextId, nextRunId, updatedCases, updatedRuns, updatedResults, fullRepoFallback } = req.body;
    if (db) {
      // Projects: $addToSet so we never lose a teammate's project
      if (projects && projects.length) {
        await db.collection('meta').updateOne(
          { id: 'main' },
          {
            $set: { nextId: nextId||1, nextRunId: nextRunId||1 },
            $addToSet: { projects: { $each: projects } }
          },
          { upsert: true }
        );
      } else if (nextId || nextRunId) {
        await db.collection('meta').updateOne(
          { id: 'main' },
          { $set: { nextId: nextId||1, nextRunId: nextRunId||1 } },
          { upsert: true }
        );
      }
      // Upsert Cases
      if (updatedCases && updatedCases.length) {
        const bulk = db.collection('testCases').initializeUnorderedBulkOp();
        updatedCases.forEach(c => { const doc={...c}; delete doc._id; bulk.find({ id: c.id }).upsert().updateOne({ $set: doc }); });
        await bulk.execute();
      }
      // Upsert Runs
      if (updatedRuns && updatedRuns.length) {
        const bulk = db.collection('testRuns').initializeUnorderedBulkOp();
        updatedRuns.forEach(r => { const doc={...r}; delete doc._id; bulk.find({ id: r.id }).upsert().updateOne({ $set: doc }); });
        await bulk.execute();
      }
      // Upsert Results — merge per-case, don't overwrite whole run
      if (updatedResults) {
        for (const [runId, data] of Object.entries(updatedResults)) {
          const existing = await db.collection('runResults').findOne({ id: runId });
          const merged = { ...(existing?.data||{}), ...data };
          await db.collection('runResults').updateOne({ id: runId }, { $set: { data: merged } }, { upsert: true });
        }
      }
      res.json({ ok: true });
    } else {
      // Local file fallback — MERGE, never overwrite
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
