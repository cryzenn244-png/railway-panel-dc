const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const yauzl = require('yauzl');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BOTS_DIR = path.join(DATA_DIR, 'bots');
const MAX_UPLOAD_MB = Math.min(100, Math.max(1, Number(process.env.MAX_UPLOAD_MB || 50)));
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error('FATAL: Set ADMIN_PASSWORD to a unique password of at least 12 characters.');
  process.exit(1);
}
if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error('FATAL: Set SESSION_SECRET to a random value of at least 32 characters.');
  process.exit(1);
}
fs.mkdirSync(BOTS_DIR, { recursive: true });

app.use(helmet({ contentSecurityPolicy: {
  directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"],
    baseUri: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"]
  }
}}));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(session({
  name: 'aurabot.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: 'auto', sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public'), { index: false, maxAge: '1h' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 3, fields: 5, parts: 8 },
  fileFilter: (_req, file, cb) => {
    // Avoid path-based filenames from client; only allow ordinary project filenames.
    const name = path.basename(file.originalname || '');
    if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      return cb(new Error('Invalid filename.'));
    }
    cb(null, true);
  }
});

const processes = new Map();
const logs = new Map();

function safeId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(id);
}
function botDir(id) {
  if (!safeId(id)) throw new Error('Invalid bot ID.');
  const dir = path.resolve(BOTS_DIR, id);
  if (!dir.startsWith(BOTS_DIR + path.sep)) throw new Error('Invalid path.');
  return dir;
}
function safeFilename(name) {
  if (typeof name !== 'string' || !name || name.length > 180 ||
      name === '.' || name === '..' || name.includes('/') || name.includes('\\') ||
      name.includes('\0') || name.startsWith('.')) throw new Error('Invalid filename.');
  return name;
}
function requireAuth(req, res, next) {
  if (!req.session.authenticated) return res.status(401).json({ error: 'Please log in again.' });
  next();
}
function logLine(id, text) {
  const arr = logs.get(id) || [];
  arr.push({ time: new Date().toISOString(), text: String(text).slice(0, 2000) });
  if (arr.length > 300) arr.splice(0, arr.length - 300);
  logs.set(id, arr);
}
function listBots() {
  return fs.readdirSync(BOTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && safeId(d.name))
    .map(d => {
      const id = d.name;
      const running = processes.has(id);
      const names = fs.readdirSync(botDir(id)).filter(n => {
        try { const p = path.join(botDir(id), safeFilename(n)); return fs.statSync(p).isFile(); } catch { return false; }
      });
      return { id, name: id, running, files: names.length };
    });
}
function createBotId(name) {
  const clean = String(name || 'my-bot').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  return (clean || 'my-bot') + '-' + crypto.randomBytes(3).toString('hex');
}
function extractZipBuffer(buffer, targetDir) {
  return new Promise((resolve, reject) => {
    const filesWritten = [];
    let finished = false;
    const fail = (err) => {
      if (finished) return;
      finished = true;
      reject(err);
    };
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zipfile) => {
      if (err) return fail(err);
      let entries = 0, totalBytes = 0;
      zipfile.on('error', fail);
      zipfile.on('end', () => {
        if (!finished) { finished = true; resolve(filesWritten); }
      });
      zipfile.on('entry', entry => {
        entries++;
        if (entries > 500) return fail(new Error('ZIP contains too many entries (limit 500).'));
        const raw = entry.fileName;
        if (!raw || raw.includes('\\') || raw.startsWith('/') || /^[a-zA-Z]:/.test(raw) ||
            raw.split('/').some(part => part === '..')) return fail(new Error('ZIP contains an unsafe path.'));
        if (raw.endsWith('/')) { zipfile.readEntry(); return; }
        const parts = raw.split('/').filter(Boolean);
        if (!parts.length || parts.some(p => p === '.' || p.startsWith('.'))) return fail(new Error('Hidden or invalid paths are not allowed in ZIP uploads.'));
        const normalized = path.posix.normalize(raw);
        if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) return fail(new Error('ZIP path traversal blocked.'));
        const outPath = path.resolve(targetDir, ...parts);
        if (!outPath.startsWith(path.resolve(targetDir) + path.sep)) return fail(new Error('ZIP path traversal blocked.'));
        const isDir = (entry.externalFileAttributes >>> 16 & 0o170000) === 0o120000;
        if (isDir) return fail(new Error('Symbolic links are not allowed in ZIP uploads.'));
        const declared = Number(entry.uncompressedSize || 0);
        totalBytes += declared;
        if (declared > MAX_UPLOAD_BYTES || totalBytes > MAX_UPLOAD_BYTES * 4) return fail(new Error('ZIP expands beyond the allowed size.'));
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        zipfile.openReadStream(entry, (streamErr, stream) => {
          if (streamErr) return fail(streamErr);
          const out = fs.createWriteStream(outPath, { flags: 'wx', mode: 0o600 });
          let actual = 0;
          stream.on('data', chunk => {
            actual += chunk.length;
            if (actual > MAX_UPLOAD_BYTES || actual > declared + 1024) stream.destroy(new Error('ZIP entry size mismatch or limit exceeded.'));
          });
          stream.on('error', fail);
          out.on('error', fail);
          out.on('finish', () => {
            filesWritten.push(parts.join('/'));
            zipfile.readEntry();
          });
          stream.pipe(out);
        });
      });
      zipfile.readEntry();
    });
  });
}

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/me', (req, res) => res.json({ authenticated: !!req.session.authenticated, username: req.session.authenticated ? ADMIN_USERNAME : null, maxUploadMB: MAX_UPLOAD_MB }));
app.post('/api/login', (req, res, next) => {
  const { username, password } = req.body || {};
  const supplied = typeof password === 'string' && password.length <= 300 ? Buffer.from(password) : Buffer.alloc(0);
  const expected = Buffer.from(ADMIN_PASSWORD);
  const passwordMatches = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  if (typeof username !== 'string' || username !== ADMIN_USERNAME || !passwordMatches) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  req.session.regenerate(err => {
    if (err) return next(err);
    req.session.authenticated = true;
    res.json({ ok: true });
  });
});
app.post('/api/logout', requireAuth, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/bots', requireAuth, (_req, res) => res.json({ bots: listBots() }));
app.post('/api/bots', requireAuth, (req, res) => {
  const id = createBotId(req.body?.name);
  fs.mkdirSync(botDir(id), { recursive: true, mode: 0o700 });
  logLine(id, 'Bot workspace created.');
  res.json({ bot: { id, name: id, running: false, files: 0 } });
});
app.get('/api/bots/:id/files', requireAuth, (req, res) => {
  try {
    const dir = botDir(req.params.id);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot not found.' });
    const files = [];
    function walk(folder, rel = '') {
      for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
        if (item.name.startsWith('.')) continue;
        const p = path.join(folder, item.name);
        const r = rel ? rel + '/' + item.name : item.name;
        if (item.isDirectory()) walk(p, r);
        else if (item.isFile()) files.push({ name: r, size: fs.statSync(p).size });
      }
    }
    walk(dir);
    res.json({ files });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/bots/:id/upload', requireAuth, upload.array('files', 20), async (req, res) => {
  const id = req.params.id;
  try {
    const dir = botDir(id);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot not found.' });
    if (!req.files?.length) return res.status(400).json({ error: 'Choose at least one file.' });
    const results = [];
    for (const file of req.files) {
      const original = safeFilename(file.originalname);
      if (original.toLowerCase().endsWith('.zip')) {
        const tmp = path.join(dir, '.upload-' + crypto.randomBytes(8).toString('hex'));
        fs.mkdirSync(tmp, { mode: 0o700 });
        try {
          const extracted = await extractZipBuffer(file.buffer, tmp);
          // If archive contains a single top-level folder, keep it as uploaded; do not overwrite existing files.
          for (const rel of extracted) {
            const from = path.join(tmp, ...rel.split('/'));
            const to = path.join(dir, ...rel.split('/'));
            fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
            if (fs.existsSync(to)) throw new Error('File already exists: ' + rel + '. Remove or rename it before uploading.');
            fs.renameSync(from, to);
          }
          results.push({ name: original, extracted: extracted.length });
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      } else {
        const out = path.join(dir, original);
        if (fs.existsSync(out)) return res.status(409).json({ error: 'File already exists: ' + original + '. Rename or delete it first.' });
        fs.writeFileSync(out, file.buffer, { flag: 'wx', mode: 0o600 });
        results.push({ name: original });
      }
    }
    logLine(id, 'Uploaded ' + results.length + ' item(s).');
    res.json({ ok: true, results });
  } catch (e) { res.status(400).json({ error: e.message || 'Upload failed.' }); }
});
app.get('/api/bots/:id/file', requireAuth, (req, res) => {
  try {
    const id = req.params.id;
    const rel = String(req.query.name || '');
    if (!rel || rel.includes('\\') || rel.startsWith('/') || rel.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new Error('Invalid path.');
    const base = botDir(id);
    const target = path.resolve(base, ...rel.split('/'));
    if (!target.startsWith(base + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return res.status(404).json({ error: 'File not found.' });
    res.download(target, path.basename(target));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/bots/:id/file', requireAuth, (req, res) => {
  try {
    const dir = botDir(req.params.id);
    const rel = String(req.body?.name || '');
    if (!rel || rel.includes('\\') || rel.startsWith('/') || rel.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'))) throw new Error('Invalid path.');
    const target = path.resolve(dir, ...rel.split('/'));
    if (!target.startsWith(dir + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return res.status(404).json({ error: 'File not found.' });
    fs.unlinkSync(target);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/bots/:id/logs', requireAuth, (req, res) => {
  try { botDir(req.params.id); res.json({ logs: logs.get(req.params.id) || [] }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/bots/:id/start', requireAuth, (req, res) => {
  const id = req.params.id;
  try {
    const dir = botDir(id);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Bot not found.' });
    if (processes.has(id)) return res.status(409).json({ error: 'Bot is already running.' });
    const entry = String(req.body?.entry || 'index.js');
    if (entry.includes('/') || entry.includes('\\') || entry.startsWith('.') || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,150}$/.test(entry)) return res.status(400).json({ error: 'Entry file must be in the bot root and use a simple filename.' });
    const full = path.join(dir, entry);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return res.status(400).json({ error: 'Entry file not found.' });
    const ext = path.extname(entry).toLowerCase();
    let command, args;
    if (ext === '.js' || ext === '.cjs') { command = process.execPath; args = [full]; }
    else if (ext === '.py') { command = 'python3'; args = [full]; }
    else return res.status(400).json({ error: 'Supported entry files: .js, .cjs, .py. Ensure Python is available in the host.' });
    logLine(id, '$ ' + command + ' ' + entry);
    const child = spawn(command, args, { cwd: dir, env: { ...process.env, NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'] });
    processes.set(id, child);
    child.stdout.on('data', d => logLine(id, d.toString()));
    child.stderr.on('data', d => logLine(id, d.toString()));
    child.on('error', e => { logLine(id, 'Process error: ' + e.message); processes.delete(id); });
    child.on('exit', (code, signal) => { logLine(id, `Process exited (code=${code}, signal=${signal || 'none'}).`); processes.delete(id); });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/bots/:id/stop', requireAuth, (req, res) => {
  const child = processes.get(req.params.id);
  if (!child) return res.status(409).json({ error: 'Bot is not running.' });
  child.kill('SIGTERM');
  logLine(req.params.id, 'Stop requested.');
  res.json({ ok: true });
});
app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File exceeds ${MAX_UPLOAD_MB} MB limit.` : err.message;
    return res.status(400).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Server error. Check deployment logs.' });
});
const server = app.listen(PORT, '0.0.0.0', () => console.log(`AuraBot Panel listening on ${PORT}`));
function shutdown() {
  for (const child of processes.values()) child.kill('SIGTERM');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
