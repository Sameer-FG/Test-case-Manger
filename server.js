// ============================================================
// Test Case Manager — Team Server
// Serves the HTML app and persists data to TestRepository.json
// All team members connect via http://[your-ip]:3000
// ============================================================
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const app       = express();
const PORT      = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'TestRepository.json');

// ── Middleware ──
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname, {
  index: 'index.html',
  setHeaders: (res, fp) => {
    if (fp.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

// ── API ──
app.get('/api/ping', (_, res) => res.json({ ok: true }));

app.get('/api/repo', (_, res) => {
  try {
    if (!fs.existsSync(DATA_FILE))
      return res.json({ projects: [], testCases: [], nextId: 1, autoScannedProjects: [] });
    res.json(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/repo', (req, res) => {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start ──
function getLocalIP() {
  for (const ifaces of Object.values(os.networkInterfaces()))
    for (const a of ifaces)
      if (a.family === 'IPv4' && !a.internal) return a.address;
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const w  = 50;
  const ln = '═'.repeat(w);
  console.log(`\n  ╔${ln}╗`);
  console.log(`  ║${'  🧪  Test Case Manager — Server Started  '.padEnd(w)}║`);
  console.log(`  ╠${ln}╣`);
  console.log(`  ║${ ('  ✅  Local:   http://localhost:' + PORT).padEnd(w)}║`);
  console.log(`  ║${ ('  🌐  Network: http://' + ip + ':' + PORT).padEnd(w)}║`);
  console.log(`  ╠${ln}╣`);
  console.log(`  ║${'  👥  Share the Network URL with your team!'.padEnd(w)}║`);
  console.log(`  ║${'  ⌨   Press Ctrl+C to stop the server.'.padEnd(w)}║`);
  console.log(`  ╚${ln}╝\n`);
});
