const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

console.log("🔍 Starting Connect...");
console.log("📡 PORT:", process.env.PORT || 3000);

const supabaseUrl = process.env.SUPABASE_URL || 'https://qedktepkjztappjgllpa.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFlZGt0ZXBranp0YXBwamdsbHBhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MTc4OTY1OSwiZXhwIjoyMDk3MzY1NjU5fQ.PAZr4gelAcS5PJ8wy4QE9bFn6S9XwyW-hE3Pr1EsaTE';
console.log("🔑 Supabase URL:", supabaseUrl ? "Set" : "Missing");
const supabase = createClient(supabaseUrl, supabaseKey);

// ---- Healthcheck route ----
app.get('/api/rooms', async (req, res) => {
  try {
    const { data } = await supabase.from('rooms').select('*').limit(1);
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- API: register ----
app.post('/api/register', async (req, res) => {
  const { username, deviceFingerprint, recoveryPhrase } = req.body;
  if (!username || !deviceFingerprint) return res.status(400).json({ error: 'Missing fields' });
  const did = 'did:connect:' + require('crypto').randomBytes(8).toString('hex');
  const salt = require('crypto').randomBytes(16).toString('hex');
  const hash = require('crypto').createHash('sha256').update(recoveryPhrase + salt).digest('hex');

  try {
    const { error } = await supabase.from('users').insert({ did, username, device_fingerprint: deviceFingerprint, created_at: Date.now() });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Username taken' });
      throw error;
    }
    await supabase.from('recovery').insert({ did, phrase_hash: hash, salt });
    res.json({ success: true, did, recoveryPhrase });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- API: login ----
app.post('/api/login', async (req, res) => {
  const { username, deviceFingerprint } = req.body;
  try {
    const { data, error } = await supabase.from('users').select('did, device_fingerprint').eq('username', username).single();
    if (error || !data) return res.status(404).json({ error: 'User not found' });
    if (data.device_fingerprint !== deviceFingerprint) {
      return res.status(403).json({ error: 'New device detected. Please recover your identity.' });
    }
    res.json({ success: true, did: data.did });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API: recover ----
app.post('/api/recover', async (req, res) => {
  const { username, recoveryPhrase, deviceFingerprint } = req.body;
  try {
    const { data: user, error: userErr } = await supabase.from('users').select('did').eq('username', username).single();
    if (userErr || !user) return res.status(404).json({ error: 'User not found' });
    const { data: rec, error: recErr } = await supabase.from('recovery').select('phrase_hash, salt').eq('did', user.did).single();
    if (recErr || !rec) return res.status(404).json({ error: 'No recovery phrase set' });
    const hash = require('crypto').createHash('sha256').update(recoveryPhrase + rec.salt).digest('hex');
    if (hash !== rec.phrase_hash) return res.status(401).json({ error: 'Invalid recovery phrase' });
    await supabase.from('users').update({ device_fingerprint: deviceFingerprint }).eq('did', user.did);
    res.json({ success: true, did: user.did });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API: rooms (list) ----
app.get('/api/rooms', async (req, res) => {
  try {
    const { data } = await supabase.from('rooms').select('*').order('created_at', { ascending: false });
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API: create room ----
app.post('/api/rooms', async (req, res) => {
  const { name, type, adminDid } = req.body;
  const id = uuidv4();
  try {
    await supabase.from('rooms').insert({ id, name, type, admin_did: adminDid, created_at: Date.now() });
    await supabase.from('room_members').insert({ room_id: id, did: adminDid, joined_at: Date.now() });
    res.json({ success: true, roomId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API: join room ----
app.post('/api/rooms/join', async (req, res) => {
  const { roomId, did } = req.body;
  try {
    await supabase.from('room_members').insert({ room_id: roomId, did, joined_at: Date.now() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API: messages ----
app.get('/api/messages/:roomId', async (req, res) => {
  try {
    const { data } = await supabase.from('messages').select('*').eq('room_id', req.params.roomId).order('timestamp', { ascending: true }).limit(200);
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messages', async (req, res) => {
  const { roomId, did, text, imageUrl } = req.body;
  const id = uuidv4();
  try {
    await supabase.from('messages').insert({ id, room_id: roomId, did, text, image_url: imageUrl, timestamp: Date.now() });
    res.json({ success: true, messageId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API: search ----
app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  try {
    const { data } = await supabase.from('messages').select('*').ilike('text', `%${q}%`).order('timestamp', { ascending: false }).limit(50);
    res.json(data || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API: profile ----
app.get('/api/profile/:did', async (req, res) => {
  try {
    const { data } = await supabase.from('users').select('username, bio, last_seen, status').eq('did', req.params.did).single();
    res.json(data || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/profile', async (req, res) => {
  const { did, bio, status } = req.body;
  try {
    await supabase.from('users').update({ bio, status, last_seen: Date.now() }).eq('did', did);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API: flag ----
app.post('/api/flag', async (req, res) => {
  const { messageId, flaggedBy, reason } = req.body;
  try {
    await supabase.from('flags').insert({ message_id: messageId, flagged_by: flaggedBy, reason, timestamp: Date.now() });
    await supabase.from('messages').update({ flagged: true }).eq('id', messageId);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- API: admin stats ----
app.get('/api/admin/stats', async (req, res) => {
  try {
    const { count: users } = await supabase.from('users').select('*', { count: 'exact', head: true });
    const { count: rooms } = await supabase.from('rooms').select('*', { count: 'exact', head: true });
    const { count: flagged } = await supabase.from('messages').select('*', { count: 'exact', head: true }).eq('flagged', true);
    res.json({ users: users || 0, rooms: rooms || 0, flagged: flagged || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Fallback route for static frontend ----
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Connect running on port ${PORT}`));
