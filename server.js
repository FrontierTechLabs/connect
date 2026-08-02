const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const bonjour = require('bonjour')();

console.log("🔍 Starting Connect – Full Edition");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// ---- SQLite (permanent storage) ----
const dbPath = process.env.DB_PATH || '/app/data/connect.db';
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error("❌ SQLite error:", err.message);
  else console.log("✅ SQLite connected at", dbPath);
});

// ---- Create all tables ----
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    recovery_phrase TEXT,
    display_name TEXT,
    city TEXT,
    bio TEXT,
    status TEXT,
    status_updated_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room TEXT,
    username TEXT,
    text TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    flagged INTEGER DEFAULT 0
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    type TEXT DEFAULT 'public',
    created_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS room_members (
    room_id INTEGER,
    username TEXT,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, username)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER,
    flagged_by TEXT,
    reason TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS statuses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT,
    text TEXT,
    image_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME
  )`);
  console.log("✅ All tables ready");
});

// ---- File uploads ----
const storage = multer.diskStorage({
  destination: './public/uploads/',
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// ---- Healthcheck ----
app.get('/health', (req, res) => res.send('OK'));

// ========== USERS ==========
app.post('/api/signup', (req, res) => {
  const { username, recovery_phrase, display_name } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  db.run('INSERT INTO users (username, recovery_phrase, display_name) VALUES (?, ?, ?)',
    [username, recovery_phrase || '', display_name || username],
    function(err) {
      if (err) return res.status(400).json({ error: 'Username taken' });
      res.json({ id: this.lastID, username });
    });
});

app.get('/api/users', (req, res) => {
  db.all('SELECT id, username, display_name, city, bio, status FROM users', (err, rows) => {
    res.json(rows || []);
  });
});

app.get('/api/users/search', (req, res) => {
  const q = req.query.q || '';
  db.all('SELECT id, username, display_name FROM users WHERE username LIKE ? OR display_name LIKE ?',
    [`%${q}%`, `%${q}%`], (err, rows) => res.json(rows || []));
});

app.get('/api/profile/:username', (req, res) => {
  db.get('SELECT username, display_name, city, bio, status FROM users WHERE username = ?',
    [req.params.username], (err, row) => res.json(row || {}));
});

app.put('/api/profile', (req, res) => {
  const { username, display_name, city, bio } = req.body;
  db.run('UPDATE users SET display_name = ?, city = ?, bio = ? WHERE username = ?',
    [display_name, city, bio, username], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    });
});

// ========== STATUS ==========
app.post('/api/status', (req, res) => {
  const { username, text, image_url } = req.body;
  if (!username || !text) return res.status(400).json({ error: 'Missing fields' });
  const expires_at = new Date(Date.now() + 24*60*60*1000).toISOString();
  db.run('INSERT INTO statuses (username, text, image_url, expires_at) VALUES (?, ?, ?, ?)',
    [username, text, image_url, expires_at], function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    });
});

app.get('/api/status/:username', (req, res) => {
  db.all('SELECT * FROM statuses WHERE username = ? AND expires_at > datetime("now") ORDER BY created_at DESC LIMIT 10',
    [req.params.username], (err, rows) => res.json(rows || []));
});

app.get('/api/status/following/:username', (req, res) => {
  // For MVP, return all recent statuses from users you follow
  // Simplified: return all statuses from all users
  db.all('SELECT * FROM statuses WHERE expires_at > datetime("now") ORDER BY created_at DESC LIMIT 50',
    (err, rows) => res.json(rows || []));
});

// ========== MESSAGES ==========
app.get('/api/messages/:room', (req, res) => {
  const room = req.params.room || 'general';
  db.all('SELECT * FROM messages WHERE room = ? AND flagged = 0 ORDER BY timestamp DESC LIMIT 100',
    [room], (err, rows) => res.json(rows.reverse()));
});

app.post('/api/messages', (req, res) => {
  const { room, username, text } = req.body;
  if (!username || !text) return res.status(400).json({ error: 'Missing fields' });
  db.run('INSERT INTO messages (room, username, text) VALUES (?, ?, ?)',
    [room || 'general', username, text],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const newMsg = { id: this.lastID, room, username, text, timestamp: new Date().toISOString() };
      wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({ type: 'message', data: newMsg }));
        }
      });
      res.json(newMsg);
    });
});

app.get('/api/messages/search', (req, res) => {
  const q = req.query.q || '';
  db.all('SELECT * FROM messages WHERE text LIKE ? ORDER BY timestamp DESC LIMIT 50',
    [`%${q}%`], (err, rows) => res.json(rows || []));
});

// ========== ROOMS ==========
app.get('/api/rooms', (req, res) => {
  db.all('SELECT * FROM rooms ORDER BY created_at DESC', (err, rows) => res.json(rows || []));
});

app.post('/api/rooms', (req, res) => {
  const { name, type, created_by } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  db.run('INSERT INTO rooms (name, type, created_by) VALUES (?, ?, ?)',
    [name, type || 'public', created_by || 'system'],
    function(err) {
      if (err) return res.status(400).json({ error: 'Room exists' });
      // Auto-join creator
      db.run('INSERT OR IGNORE INTO room_members (room_id, username) VALUES (?, ?)',
        [this.lastID, created_by || 'system']);
      res.json({ id: this.lastID, name });
    });
});

app.post('/api/rooms/join', (req, res) => {
  const { room_name, username } = req.body;
  db.get('SELECT id FROM rooms WHERE name = ?', [room_name], (err, room) => {
    if (err || !room) return res.status(404).json({ error: 'Room not found' });
    db.run('INSERT OR IGNORE INTO room_members (room_id, username) VALUES (?, ?)',
      [room.id, username], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      });
  });
});

app.get('/api/rooms/members/:room_name', (req, res) => {
  db.all('SELECT username FROM room_members WHERE room_id = (SELECT id FROM rooms WHERE name = ?)',
    [req.params.room_name], (err, rows) => res.json(rows || []));
});

// ========== FLAGS ==========
app.get('/api/flags', (req, res) => {
  db.all('SELECT f.*, m.text as message_text, m.username as message_author FROM flags f JOIN messages m ON f.message_id = m.id ORDER BY f.timestamp DESC LIMIT 50',
    (err, rows) => res.json(rows || []));
});

app.post('/api/flags', (req, res) => {
  const { message_id, flagged_by, reason } = req.body;
  if (!message_id || !flagged_by) return res.status(400).json({ error: 'Missing fields' });
  db.run('INSERT INTO flags (message_id, flagged_by, reason) VALUES (?, ?, ?)',
    [message_id, flagged_by, reason || 'No reason provided'],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      db.run('UPDATE messages SET flagged = 1 WHERE id = ?', [message_id]);
      res.json({ id: this.lastID });
    });
});

app.delete('/api/flags/:id', (req, res) => {
  db.run('DELETE FROM flags WHERE id = ?', [req.params.id], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ========== ADMIN ==========
app.get('/api/admin/stats', (req, res) => {
  db.get('SELECT COUNT(*) as users FROM users', (e1, users) => {
    db.get('SELECT COUNT(*) as rooms FROM rooms', (e2, rooms) => {
      db.get('SELECT COUNT(*) as messages FROM messages', (e3, messages) => {
        db.get('SELECT COUNT(*) as flags FROM flags WHERE timestamp > datetime("now", "-7 days")', (e4, recentFlags) => {
          res.json({
            users: users?.users || 0,
            rooms: rooms?.rooms || 0,
            messages: messages?.messages || 0,
            recentFlags: recentFlags?.flags || 0
          });
        });
      });
    });
  });
});

// ========== P2P SIGNALING ==========
wss.on('connection', (ws, req) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      console.log('📩 WS:', data.type);

      if (data.type === 'join') {
        ws.room = data.room || 'general';
        ws.username = data.username || 'anonymous';
        ws.send(JSON.stringify({ type: 'joined', room: ws.room }));
        // Broadcast list of users in room
        const users = [];
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === WebSocket.OPEN && c.room === ws.room) {
            users.push(c.username);
          }
        });
        ws.send(JSON.stringify({ type: 'users', users }));
      }

      if (data.type === 'signal') {
        // WebRTC signaling
        const target = data.target;
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN && client.username === target) {
            client.send(JSON.stringify({
              type: 'signal',
              from: ws.username,
              data: data.data
            }));
          }
        });
      }

      if (data.type === 'typing') {
        wss.clients.forEach(client => {
          if (client !== ws && client.readyState === WebSocket.OPEN && client.room === ws.room) {
            client.send(JSON.stringify({ type: 'typing', username: ws.username }));
          }
        });
      }
    } catch (e) {
      console.error('WS error:', e.message);
    }
  });
});

// ---- mDNS discovery ----
bonjour.publish({ name: 'Connect-' + (process.env.HOSTNAME || 'node'), type: 'connect', port: 8080 });
console.log('📡 mDNS published');

// ---- Static files ----
app.use(express.static('public'));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Connect server running on port ${PORT}`);
  console.log(`🔗 Healthcheck: /health`);
});
