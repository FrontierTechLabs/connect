const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const path = require('path');

console.log("🔍 Starting Connect...");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

console.log("📁 Connecting to SQLite...");

// Use the volume path – change if needed
const dbPath = process.env.DB_PATH || './connect.db';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("❌ SQLite error:", err.message);
  } else {
    console.log("✅ SQLite connected at", dbPath);
  }
});

db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, recovery_phrase TEXT, display_name TEXT, city TEXT, bio TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, (err) => {
  if (err) console.error("❌ Users table error:", err.message);
  else console.log("✅ Users table ready");
});

db.run(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT, username TEXT, text TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`, (err) => {
  if (err) console.error("❌ Messages table error:", err.message);
  else console.log("✅ Messages table ready");
});

db.run(`CREATE TABLE IF NOT EXISTS rooms (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, type TEXT DEFAULT 'public', created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`, (err) => {
  if (err) console.error("❌ Rooms table error:", err.message);
  else console.log("✅ Rooms table ready");
});

db.run(`CREATE TABLE IF NOT EXISTS flags (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, flagged_by TEXT, reason TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`, (err) => {
  if (err) console.error("❌ Flags table error:", err.message);
  else console.log("✅ Flags table ready");
});

console.log("📁 Setting up file uploads...");
const storage = multer.diskStorage({ destination: './public/uploads/', filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname) });
const upload = multer({ storage });

// ---- HEALTHCHECK ROUTE (simple, no DB) ----
app.get('/health', (req, res) => {
  res.send('OK');
});

// ---- API: signup ----
app.post('/api/signup', (req, res) => {
  const { username, recovery_phrase, display_name } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  db.run('INSERT INTO users (username, recovery_phrase, display_name) VALUES (?, ?, ?)', [username, recovery_phrase || '', display_name || username], function(err) {
    if (err) return res.status(400).json({ error: 'Username taken' });
    res.json({ id: this.lastID, username });
  });
});

// ---- API: users ----
app.get('/api/users', (req, res) => db.all('SELECT id, username, display_name, city, bio FROM users', (err, rows) => res.json(rows)));

// ---- API: messages ----
app.get('/api/messages/:room', (req, res) => {
  const room = req.params.room || 'general';
  db.all('SELECT * FROM messages WHERE room = ? ORDER BY timestamp DESC LIMIT 50', [room], (err, rows) => res.json(rows.reverse()));
});

app.post('/api/messages', (req, res) => {
  const { room, username, text } = req.body;
  if (!username || !text) return res.status(400).json({ error: 'Missing fields' });
  db.run('INSERT INTO messages (room, username, text) VALUES (?, ?, ?)', [room || 'general', username, text], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    const newMsg = { id: this.lastID, room, username, text, timestamp: new Date().toISOString() };
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: 'message', data: newMsg })); });
    res.json(newMsg);
  });
});

// ---- API: upload ----
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ---- API: rooms ----
app.get('/api/rooms', (req, res) => db.all('SELECT * FROM rooms ORDER BY created_at DESC', (err, rows) => res.json(rows)));
app.post('/api/rooms', (req, res) => {
  const { name, type, created_by } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  db.run('INSERT INTO rooms (name, type, created_by) VALUES (?, ?, ?)', [name, type || 'public', created_by || 'system'], function(err) {
    if (err) return res.status(400).json({ error: 'Room exists' });
    res.json({ id: this.lastID, name });
  });
});

// ---- API: flags ----
app.get('/api/flags', (req, res) => db.all('SELECT * FROM flags ORDER BY timestamp DESC LIMIT 20', (err, rows) => res.json(rows)));
app.post('/api/flags', (req, res) => {
  const { message_id, flagged_by, reason } = req.body;
  db.run('INSERT INTO flags (message_id, flagged_by, reason) VALUES (?, ?, ?)', [message_id, flagged_by, reason], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID });
  });
});

// ---- WebSocket ----
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'join') { ws.room = data.room || 'general'; ws.username = data.username || 'anonymous'; ws.send(JSON.stringify({ type: 'joined', room: ws.room })); }
      if (data.type === 'typing') {
        wss.clients.forEach(client => { if (client !== ws && client.readyState === WebSocket.OPEN && client.room === ws.room) client.send(JSON.stringify({ type: 'typing', username: ws.username })); });
      }
    } catch (e) {}
  });
});

// ---- Fallback route for static frontend ----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Connect server running on port ${PORT}`);
  console.log(`🔗 Healthcheck: /health`);
});
// trigger deploy with volume
