#!/usr/bin/env node
// ani-web: a phone-friendly web UI over ani-cli. Zero dependencies, Node 18+.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const APP_DIR = __dirname;
const PORT = Number(process.env.PORT) || 7777;
const HOST = process.env.HOST || '0.0.0.0';
const ANI_CLI_DIR = process.env.ANI_CLI_DIR || path.join(APP_DIR, '..');
const DOWNLOAD_DIR = process.env.ANI_WEB_DOWNLOAD_DIR || path.join(APP_DIR, 'downloads');
const HIST_FILE = path.join(
  process.env.ANI_CLI_HIST_DIR || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local/state'), 'ani-cli'),
  'ani-hsts',
);
const MAX_PARALLEL_DOWNLOADS = Number(process.env.ANI_WEB_PARALLEL) || 2;
const SUPERVISED = process.env.ANI_WEB_SUPERVISED === '1';
const RESTART_CODE = 75;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MIN = 60_000;

// ---------- ani-cli bridge ----------

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

function runBridge(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'sh',
      [path.join(APP_DIR, 'bridge.sh'), ...args],
      { env: { ...process.env, ANI_CLI_SCRIPT: path.join(ANI_CLI_DIR, 'ani-cli') }, timeout: 90_000, maxBuffer: 16 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stripAnsi(stderr).trim() || err.message));
        resolve(stdout);
      },
    );
  });
}

// the site is flaky (curl --max-time 10 trips regularly), so connection failures get one retry
async function bridge(args) {
  try {
    return await runBridge(args);
  } catch (e) {
    if (!/Connection error|Request failed/.test(e.message)) throw e;
    return runBridge(args);
  }
}

const cache = new Map();
function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  const value = fn();
  cache.set(key, { value, expires: Date.now() + ttl });
  value.catch(() => cache.delete(key));
  return value;
}

const toNum = (s) => (s && /^\d+$/.test(s) ? Number(s) : null);

const search = (q) =>
  cached(`s:${q.toLowerCase()}`, 10 * MIN, async () => {
    const out = await bridge(['search', q]);
    const results = [];
    const meta = new Map();
    for (const line of out.split('\n')) {
      const [kind, id, ...rest] = line.split('\t');
      if (!id) continue;
      if (kind === 'r') results.push({ id, title: rest.join('\t') });
      if (kind === 'm') meta.set(id, { poster: rest[0] || null, sub: toNum(rest[1]), dub: toNum(rest[2]), type: rest[3] || null });
    }
    return results.map((r) => ({ ...r, ...meta.get(r.id) }));
  });

const episodes = (id) =>
  cached(`e:${id}`, 15 * MIN, async () =>
    (await bridge(['episodes', id]))
      .split('\n')
      .map((l) => l.split('\t')[1])
      .filter(Boolean),
  );

const links = (id, ep, mode) =>
  cached(`l:${id}:${ep}:${mode}`, 30 * MIN, async () => {
    const out = await bridge(['links', id, ep, mode]);
    const r = { qualities: [] };
    for (const line of out.split('\n')) {
      const [k, a, b] = line.split('\t');
      if (k === 'link') r.qualities.push({ quality: a, url: b });
      else if (k) r[k] = a || null;
    }
    if (!r.qualities.length) throw new Error(`No ${mode} sources found`);
    return r;
  });

function pickQuality(qualities, wanted) {
  if (!wanted || wanted === 'best') return qualities[0];
  if (wanted === 'worst') return qualities[qualities.length - 1];
  // closest at or below what was asked for, so "360p" never quietly turns into a 1080p-sized download
  const target = parseInt(wanted, 10);
  const below = qualities.filter((q) => parseInt(q.quality, 10) <= target);
  return below[0] || qualities[qualities.length - 1];
}

// ---------- HLS relay ----------
// The stream host wants the embed site as Referer, which a browser page can't send,
// so playlists and segments go through here. URLs are HMAC-signed so this isn't an open proxy.

const SECRET = crypto.randomBytes(32);
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 22);

function proxyUrl(url, refr, kind) {
  const payload = Buffer.from(`${refr}\n${url}`).toString('base64url');
  let name = 'seg.ts';
  if (kind === 'playlist') name = 'index.m3u8';
  else {
    const base = new URL(url).pathname.split('/').pop();
    if (/\.(vtt|key|mp4|m4s|aac)$/i.test(base)) name = base;
  }
  return `/hls/${sign(payload)}/${payload}/${name}`;
}

function rewritePlaylist(text, baseUrl, refr) {
  const isMaster = text.includes('#EXT-X-STREAM-INF');
  return text
    .split(/\r?\n/)
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith('#')) {
        const kind = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF):/.test(t) ? 'playlist' : 'media';
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxyUrl(new URL(u, baseUrl).href, refr, kind)}"`);
      }
      return proxyUrl(new URL(t, baseUrl).href, refr, isMaster ? 'playlist' : 'media');
    })
    .join('\n');
}

async function fetchUpstream(url, headers, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { headers, signal, redirect: 'follow' });
      // the segment host hands out the odd transient 403
      if ((r.status === 403 || r.status >= 500) && attempt === 0) {
        r.body?.cancel().catch(() => {});
        continue;
      }
      return r;
    } catch (e) {
      if (attempt > 0 || signal?.aborted) throw e;
    }
  }
}

const SEGMENT_TYPES = { ts: 'video/mp2t', vtt: 'text/vtt; charset=utf-8', aac: 'audio/aac', mp4: 'video/mp4', m4s: 'video/iso.segment' };

async function handleHls(req, res, sig, payload, name) {
  if (sign(payload) !== sig) return sendJson(res, 403, { error: 'bad signature' });
  const [refr, url] = Buffer.from(payload, 'base64url').toString().split('\n');
  if (!/^https?:\/\//.test(url || '')) return sendJson(res, 400, { error: 'bad url' });

  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = { 'User-Agent': UA, Referer: refr };
  if (req.headers.range) headers.Range = req.headers.range;
  const up = await fetchUpstream(url, headers, ac.signal);

  if (name.endsWith('.m3u8')) {
    const text = await up.text();
    if (!up.ok || !text.startsWith('#EXTM3U')) return sendJson(res, 502, { error: `upstream playlist HTTP ${up.status}` });
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
    return res.end(rewritePlaylist(text, up.url || url, refr));
  }

  const out = { 'Content-Type': SEGMENT_TYPES[name.split('.').pop()] || up.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'max-age=3600' };
  for (const h of ['content-length', 'content-range', 'accept-ranges']) if (up.headers.has(h)) out[h] = up.headers.get(h);
  res.writeHead(up.status, out);
  if (!up.body) return res.end();
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}

function withProxies(l) {
  return {
    malId: l.mal_id,
    qualities: l.qualities.map((q) => ({ quality: q.quality, stream: proxyUrl(q.url, l.refr, 'playlist') })),
    master: l.master ? proxyUrl(l.master, l.refr, 'playlist') : null,
    subtitles: l.sub ? proxyUrl(l.sub, l.refr, 'media') : null,
  };
}

// ---------- history (same file and format as ani-cli, so `ani-cli -c` stays in sync) ----------

async function readHistory() {
  let text = '';
  try {
    text = await fsp.readFile(HIST_FILE, 'utf8');
  } catch {}
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ep, id, ...t] = l.split('\t');
      return { ep, id, title: t.join(' ') };
    })
    .filter((h) => h.id && h.ep);
}

async function writeHistory(id, title, ep) {
  const clean = (s) => String(s).replace(/[\t\n]/g, ' ');
  // most recent goes last; ani-cli doesn't care about order
  const items = (await readHistory()).filter((h) => h.id !== id);
  items.push({ ep: clean(ep), id: clean(id), title: clean(title) });
  await fsp.mkdir(path.dirname(HIST_FILE), { recursive: true });
  await fsp.writeFile(`${HIST_FILE}.web`, items.map((h) => `${h.ep}\t${h.id}\t${h.title}\n`).join(''));
  await fsp.rename(`${HIST_FILE}.web`, HIST_FILE);
}

// ---------- downloads ----------

const jobs = new Map();
const queue = [];
let running = 0;

const safeName = (s) => s.replace(/:\s*/g, ' - ').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 180);
const episodeFile = (title, ep, mode) => `${safeName(`${title} - Episode ${ep}${mode === 'dub' ? ' (Dub)' : ''}`)}.mkv`;
// RFC 6266: a plain ASCII filename for old clients plus filename* for the real one. encodeURIComponent leaves
// ' ( ) * alone, but filename* forbids them, and Chrome ignores the whole header over a single apostrophe.
function attachmentHeader(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// kind: 'laptop' = saved into DOWNLOAD_DIR, 'phone' = streamed straight to the requesting browser
const publicJob = (j) => ({
  id: j.id, kind: j.kind, animeId: j.animeId, title: j.title, ep: j.ep, mode: j.mode, quality: j.quality,
  status: j.status, progress: j.progress, error: j.error, file: j.file, createdAt: j.createdAt,
});

const newJob = (fields) => ({ id: crypto.randomUUID(), status: 'queued', progress: 0, error: null, file: null, sent: 0, createdAt: Date.now(), ...fields });

function enqueue({ animeId, title, ep, mode, quality }) {
  const dup = [...jobs.values()].find(
    (j) => j.kind === 'laptop' && j.animeId === animeId && j.ep === ep && j.mode === mode && ['queued', 'resolving', 'downloading'].includes(j.status),
  );
  if (dup) return dup;
  const job = newJob({ kind: 'laptop', animeId, title, ep, mode, quality });
  jobs.set(job.id, job);
  queue.push(job);
  pump();
  return job;
}

function pump() {
  while (running < MAX_PARALLEL_DOWNLOADS && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    running++;
    runJob(job)
      .catch((e) => {
        if (job.status === 'cancelled') return;
        job.status = 'failed';
        job.error = e.message;
      })
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function playlistDuration(url, refr) {
  const r = await fetchUpstream(url, { 'User-Agent': UA, Referer: refr });
  const text = await r.text();
  let total = 0;
  for (const m of text.matchAll(/#EXTINF:([\d.]+)/g)) total += Number(m[1]);
  return total;
}

async function runJob(job) {
  job.status = 'resolving';
  const l = await links(job.animeId, job.ep, job.mode);
  const q = pickQuality(l.qualities, job.quality);
  job.quality = q.quality;
  job.duration = await playlistDuration(q.url, l.refr).catch(() => 0);

  const name = episodeFile(job.title, job.ep, job.mode);
  const final = path.join(DOWNLOAD_DIR, name);
  const part = `${final}.part`;
  await fsp.mkdir(DOWNLOAD_DIR, { recursive: true });
  if (job.status === 'cancelled') return;
  job.status = 'downloading';
  try {
    await runFfmpeg(job, ffmpegArgs(q.url, l, part, true));
  } catch (e) {
    // a broken subtitle file shouldn't cost the whole episode
    if (!l.sub || job.status === 'cancelled') throw e;
    job.progress = 0;
    await runFfmpeg(job, ffmpegArgs(q.url, l, part, false));
  }
  await fsp.rename(part, final);
  job.status = 'done';
  job.progress = 1;
  job.file = name;
}

// Output is MKV: it holds subtitles as a normal track (MP4 needs the mov_text encoder, which Fedora's
// ffmpeg-free lacks) and it can be written to a pipe, so an episode can go to the phone while it downloads.
function ffmpegArgs(videoUrl, l, out, withSubs) {
  const hlsInput = (url) => ['-extension_picky', '0', '-user_agent', UA, '-referer', l.refr, '-i', url];
  const args = ['-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:3', '-y', ...hlsInput(videoUrl)];
  const maps = ['-map', '0:v:0'];
  let n = 1;
  if (l.audio) {
    args.push(...hlsInput(l.audio));
    maps.push('-map', `${n++}:a:0`);
  } else maps.push('-map', '0:a:0?');
  const subs = withSubs && l.sub;
  if (subs) {
    args.push('-user_agent', UA, '-referer', l.refr, '-i', l.sub);
    maps.push('-map', `${n++}:s:0`);
  }
  // a piped MKV header needs the AAC config up front, which the HLS segments only reveal mid-stream,
  // so audio is re-encoded (about 45 s of CPU per episode); video is copied untouched
  args.push(...maps, '-c', 'copy', '-c:a', 'aac', '-b:a', '160k');
  if (subs) args.push('-c:s', 'srt', '-metadata:s:s:0', 'language=eng', '-disposition:s:0', 'default');
  args.push('-f', 'matroska', out);
  return args;
}

// sink: a writable to pipe the video into (the phone's response); without it ffmpeg writes its own output file
function runFfmpeg(job, args, sink) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', sink ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    job.proc = proc;
    let err = '';
    proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    proc.stdio[3].on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m && job.duration) job.progress = Math.min(0.99, Number(m.pop().split('=')[1]) / 1e6 / job.duration);
    });
    if (sink) {
      proc.stdout.on('data', (d) => (job.sent += d.length));
      proc.stdout.pipe(sink, { end: false });
    }
    proc.on('error', reject);
    proc.on('close', (code) => {
      job.proc = null;
      if (code === 0) return resolve();
      const out = args[args.length - 1];
      if (out !== 'pipe:1') fsp.rm(out, { force: true }).catch(() => {});
      reject(new Error(job.status === 'cancelled' ? 'cancelled' : `ffmpeg failed: ${err.trim().split('\n').pop() || `exit ${code}`}`));
    });
  });
}

const MAX_DIRECT = Number(process.env.ANI_WEB_DIRECT_PARALLEL) || 3;
let directRunning = 0;
const directWaiting = [];
function acquireDirect() {
  if (directRunning < MAX_DIRECT) {
    directRunning++;
    return Promise.resolve();
  }
  return new Promise((resolve) => directWaiting.push(resolve));
}
function releaseDirect() {
  const next = directWaiting.shift();
  if (next) next();
  else directRunning--;
}

// GET /api/direct: the episode is remuxed and sent to the phone as it downloads, nothing is kept here
async function handleDirect(req, res, { id, ep, mode, quality, title }) {
  // resolve before sending headers, so a missing episode is a normal JSON error rather than a broken file
  const l = await links(id, ep, mode);
  const q = pickQuality(l.qualities, quality);
  const name = episodeFile(title, ep, mode);
  const headers = {
    'Content-Type': 'video/x-matroska',
    'Content-Disposition': attachmentHeader(name),
    'Cache-Control': 'no-store',
  };
  if (req.method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }

  const job = newJob({ kind: 'phone', animeId: id, title, ep, mode, quality: q.quality, file: name });
  jobs.set(job.id, job);
  res.writeHead(200, headers);
  res.flushHeaders();
  let closed = false;
  res.on('close', () => {
    closed = true;
    if (job.status === 'done') return;
    if (job.status !== 'cancelled') {
      job.status = 'failed';
      job.error = 'The phone stopped the download';
    }
    job.proc?.kill('SIGKILL');
  });

  await acquireDirect();
  try {
    if (closed || job.status === 'cancelled') return res.destroy();
    job.status = 'resolving';
    job.duration = await playlistDuration(q.url, l.refr).catch(() => 0);
    if (closed || job.status === 'cancelled') return res.destroy();
    job.status = 'downloading';
    try {
      await runFfmpeg(job, ffmpegArgs(q.url, l, 'pipe:1', true), res);
    } catch (e) {
      // subtitle trouble shows up before any video is written; retry once without them
      if (job.sent || !l.sub || closed) throw e;
      await runFfmpeg(job, ffmpegArgs(q.url, l, 'pipe:1', false), res);
    }
    job.status = 'done';
    job.progress = 1;
    res.end();
  } catch (e) {
    if (!closed && job.status !== 'cancelled') {
      job.status = 'failed';
      job.error = e.message;
    }
    // ending without the full body makes the phone mark the download as failed instead of saving a cut-off file
    res.destroy();
  } finally {
    releaseDirect();
  }
}

function cancelJob(job) {
  if (['done', 'failed', 'cancelled'].includes(job.status)) {
    jobs.delete(job.id);
    return;
  }
  job.status = 'cancelled';
  job.proc?.kill('SIGTERM');
}

async function listFiles() {
  let names = [];
  try {
    names = await fsp.readdir(DOWNLOAD_DIR);
  } catch {}
  const files = [];
  for (const name of names.filter((n) => /\.(mkv|mp4)$/.test(n))) {
    const st = await fsp.stat(path.join(DOWNLOAD_DIR, name));
    files.push({ name, size: st.size, mtime: st.mtimeMs });
  }
  return files.sort((a, b) => b.mtime - a.mtime);
}

function resolveDownload(name) {
  const p = path.join(DOWNLOAD_DIR, path.basename(name));
  return /\.(mkv|mp4)$/.test(p) ? p : null;
}

// ---------- updates ----------

function git(dir, ...args) {
  return new Promise((resolve, reject) =>
    execFile('git', ['-C', dir, ...args], { timeout: 60_000 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim()),
    ),
  );
}

const lastFetch = new Map();
async function repoStatus(dir, force) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    if (force || !lastFetch.has(dir) || Date.now() - lastFetch.get(dir) > 30 * MIN) {
      await git(dir, 'fetch', '--quiet');
      lastFetch.set(dir, Date.now());
    }
    const behind = Number(await git(dir, 'rev-list', '--count', 'HEAD..@{u}'));
    const head = await git(dir, 'log', '-1', '--format=%h %s (%cr)');
    return { behind, head };
  } catch (e) {
    return { error: e.message };
  }
}

async function aniCliVersion() {
  try {
    return (await fsp.readFile(path.join(ANI_CLI_DIR, 'ani-cli'), 'utf8')).match(/^version_number="([^"]+)"/m)?.[1] || null;
  } catch {
    return null;
  }
}

async function versionInfo(force) {
  const [aniCli, app] = await Promise.all([repoStatus(ANI_CLI_DIR, force), repoStatus(APP_DIR, force)]);
  return { aniCli: { version: await aniCliVersion(), ...aniCli }, app, canRestart: SUPERVISED };
}

async function update() {
  const log = [];
  for (const [label, dir] of [['ani-cli', ANI_CLI_DIR], ['ani-web', APP_DIR]]) {
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const before = await git(dir, 'rev-parse', 'HEAD');
    await git(dir, 'pull', '--ff-only');
    const after = await git(dir, 'rev-parse', 'HEAD');
    log.push({ repo: label, changed: before !== after, holdsApp: (APP_DIR + path.sep).startsWith(path.resolve(dir) + path.sep) });
  }
  cache.clear();
  // ani-web may live inside the ani-cli checkout (web/ in the fork), so one pull can update both
  const appChanged = log.some((l) => l.holdsApp && l.changed);
  log.forEach((l) => delete l.holdsApp);
  return { log, restarting: appChanged && SUPERVISED, restartNeeded: appChanged && !SUPERVISED, ...(await versionInfo(false)) };
}

// ---------- http ----------

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1 << 20) throw new Error('body too large');
  }
  return data ? JSON.parse(data) : {};
}

const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.png': 'image/png' };
const PUBLIC_DIR = path.join(APP_DIR, 'public');

function serveFile(req, res, file, headers = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: 'not found' });
    const type = STATIC_TYPES[path.extname(file)] || { '.mkv': 'video/x-matroska', '.mp4': 'video/mp4' }[path.extname(file)] || 'application/octet-stream';
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...headers };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      const start = m[1] ? Number(m[1]) : Math.max(0, st.size - Number(m[2]));
      const end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...base, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${st.size}` });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...base, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const q = (k) => url.searchParams.get(k)?.trim() || '';
  const need = (...keys) => {
    const missing = keys.filter((k) => !q(k));
    if (missing.length) throw Object.assign(new Error(`missing ${missing.join(', ')}`), { status: 400 });
  };

  let m;
  if ((m = p.match(/^\/hls\/([\w-]+)\/([\w-]+)\/([\w.-]+)$/))) return handleHls(req, res, m[1], m[2], m[3]);

  if (p === '/api/search') {
    need('q');
    return sendJson(res, 200, await search(q('q')));
  }
  if (p === '/api/episodes') {
    need('id');
    return sendJson(res, 200, await episodes(q('id')));
  }
  if (p === '/api/links') {
    need('id', 'ep');
    return sendJson(res, 200, withProxies(await links(q('id'), q('ep'), q('mode') === 'dub' ? 'dub' : 'sub')));
  }
  if (p === '/api/history') {
    if (req.method === 'POST') {
      const b = await readBody(req);
      if (!b.id || !b.ep || !b.title) return sendJson(res, 400, { error: 'id, title, ep required' });
      await writeHistory(b.id, b.title, b.ep);
    }
    return sendJson(res, 200, (await readHistory()).reverse());
  }
  if (p === '/api/downloads') {
    if (req.method === 'POST') {
      const b = await readBody(req);
      const eps = Array.isArray(b.eps) ? b.eps : [b.ep];
      if (!b.id || !b.title || !eps.length || eps.some((e) => !e)) return sendJson(res, 400, { error: 'id, title, eps required' });
      for (const ep of eps) enqueue({ animeId: b.id, title: b.title, ep: String(ep), mode: b.mode === 'dub' ? 'dub' : 'sub', quality: b.quality || '720' });
    }
    return sendJson(res, 200, { jobs: [...jobs.values()].map(publicJob).reverse(), files: await listFiles() });
  }
  if (p === '/api/direct') {
    need('id', 'ep', 'title');
    return handleDirect(req, res, {
      id: q('id'), ep: q('ep'), title: q('title'), mode: q('mode') === 'dub' ? 'dub' : 'sub', quality: q('quality') || '720',
    });
  }
  if ((m = p.match(/^\/api\/downloads\/([\w-]+)$/)) && req.method === 'DELETE') {
    const job = jobs.get(m[1]);
    if (job) cancelJob(job);
    return sendJson(res, 200, { ok: true });
  }
  if ((m = p.match(/^\/files\/(.+)$/))) {
    const file = resolveDownload(decodeURIComponent(m[1]));
    if (!file) return sendJson(res, 404, { error: 'not found' });
    if (req.method === 'DELETE') {
      await fsp.rm(file, { force: true });
      for (const j of jobs.values()) if (j.file === path.basename(file)) jobs.delete(j.id);
      return sendJson(res, 200, { ok: true });
    }
    const headers = url.searchParams.has('dl')
      ? { 'Content-Disposition': attachmentHeader(path.basename(file)) }
      : {};
    return serveFile(req, res, file, headers);
  }
  if (p === '/api/version') return sendJson(res, 200, await versionInfo(url.searchParams.has('refresh')));
  if (p === '/api/update' && req.method === 'POST') {
    const result = await update();
    sendJson(res, 200, result);
    if (result.restarting) setTimeout(() => process.exit(RESTART_CODE), 300);
    return;
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  const file = path.join(PUBLIC_DIR, path.normalize(p === '/' ? '/index.html' : p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 404, { error: 'not found' });
  return serveFile(req, res, file, { 'Cache-Control': 'no-cache' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) return res.destroy();
    sendJson(res, e.status || 502, { error: e.message });
  });
});

// leftovers from a crash or restart mid-download
fsp.readdir(DOWNLOAD_DIR).then(
  (names) => names.filter((n) => n.endsWith('.part')).forEach((n) => fsp.rm(path.join(DOWNLOAD_DIR, n), { force: true })),
  () => {},
);

if (!fs.existsSync(path.join(ANI_CLI_DIR, 'ani-cli'))) {
  console.error(`ani-cli not found in ${ANI_CLI_DIR}. Run ./start.sh (it clones it) or set ANI_CLI_DIR.`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i.address}:${PORT}`);
  console.log(`ani-web running\n  this machine: http://localhost:${PORT}\n${lan.map((u) => `  phone (same Wi-Fi): ${u}`).join('\n')}`);
  console.log(`  downloads: ${DOWNLOAD_DIR}\n  history: ${HIST_FILE}`);
});
