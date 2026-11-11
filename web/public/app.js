'use strict';

const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.15/dist/hls.min.js';

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`ani:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`ani:${k}`, JSON.stringify(v));
    } catch {}
  },
};

const settings = { mode: 'sub', streamQuality: 'auto', dlQuality: '720', autoNext: true, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);

// titles/posters seen in search results, so later pages (and history) can show them
const meta = store.get('meta', {});
function remember(list) {
  for (const a of list) meta[a.id] = { ...meta[a.id], ...Object.fromEntries(Object.entries(a).filter(([, v]) => v != null)) };
  store.set('meta', meta);
}
const titleOf = (id) => meta[id]?.title || id.replace(/-\d+$/, '').replace(/-/g, ' ');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtSize = (b) => (b > 1 << 30 ? `${(b / (1 << 30)).toFixed(2)} GB` : `${Math.round(b / (1 << 20))} MB`);
const spinner = (label = '') => `<div class="empty"><div class="spinner"></div>${esc(label)}</div>`;
const errorBox = (e) => `<div class="empty error">${esc(e.message || e)}<div style="margin-top:12px"><button class="btn small" data-action="retry">Retry</button></div></div>`;
const modeSeg = (dubCount) => `
  <div class="seg" role="group" aria-label="Audio">
    <button data-action="mode" data-mode="sub" class="${settings.mode === 'sub' ? 'on' : ''}">Sub</button>
    <button data-action="mode" data-mode="dub" class="${settings.mode === 'dub' ? 'on' : ''}" ${dubCount === 0 ? 'disabled' : ''}>Dub</button>
  </div>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each episode becomes its own browser download. The server remuxes it while it streams, so nothing is
// stored on the laptop. Links are resolved first so a missing episode shows a message instead of a broken file.
async function sendToPhone(id, title, eps, mode) {
  let started = 0;
  for (const ep of eps) {
    try {
      await api(`/api/links?id=${encodeURIComponent(id)}&ep=${encodeURIComponent(ep)}&mode=${mode}`);
    } catch (e) {
      toast(`Episode ${ep}: ${e.message}`, 4000);
      continue;
    }
    const a = document.createElement('a');
    // no `download` attribute: it would override the server's Content-Disposition filename
    a.href = `/api/direct?${new URLSearchParams({ id, ep, mode, title, quality: settings.dlQuality })}`;
    document.body.append(a);
    a.click();
    a.remove();
    started++;
    if (eps.length > 1) toast(`Started ${started} of ${eps.length}…`);
    refreshBadge();
    if (started < eps.length) await sleep(1500);
  }
  if (started) toast(`${started} download${started > 1 ? 's' : ''} started. Progress is under Downloads.`, 4000);
}

// ---------- router ----------

let viewId = 0;
let cleanup = null;
function guard() {
  const id = viewId;
  return () => id !== viewId;
}

const routes = [
  [/^#\/?$/, home],
  [/^#\/search\/(.+)$/, (q) => searchView(decodeURIComponent(q))],
  [/^#\/anime\/([^/]+)$/, (id) => animeView(decodeURIComponent(id))],
  [/^#\/watch\/([^/]+)\/([^/]+)$/, (id, ep) => watchView(decodeURIComponent(id), decodeURIComponent(ep))],
  [/^#\/downloads$/, downloadsView],
  [/^#\/settings$/, settingsView],
];

function render() {
  cleanup?.();
  cleanup = null;
  viewId++;
  app.onclick = null;
  app.onchange = null;
  window.scrollTo(0, 0);
  const hash = location.hash || '#/';
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) return view(...m.slice(1));
  }
  home();
}
window.addEventListener('hashchange', render);

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search-input').value.trim();
  if (!q) return;
  $('#search-input').blur();
  location.hash = `#/search/${encodeURIComponent(q)}`;
});

// ---------- views ----------

async function home() {
  const stale = guard();
  $('#search-input').value = '';
  app.innerHTML = `<h2 style="margin-top:4px">Continue watching</h2><div id="hist">${spinner()}</div>`;
  app.onclick = (e) => e.target.closest('[data-action="retry"]') && render();
  let hist;
  try {
    hist = await api('/api/history');
  } catch (e) {
    if (!stale()) $('#hist').innerHTML = errorBox(e);
    return;
  }
  if (stale()) return;
  if (!hist.length) {
    $('#hist').innerHTML = `<div class="empty">Nothing yet. Search for an anime to start watching.</div>`;
    return;
  }
  remember(hist.map((h) => ({ id: h.id, title: meta[h.id]?.title || h.title })));
  $('#hist').innerHTML = `<div class="list">${hist
    .map(
      (h) => `
      <a class="item" href="#/anime/${encodeURIComponent(h.id)}">
        ${meta[h.id]?.poster ? `<img src="${esc(meta[h.id].poster)}" alt="" style="width:40px;height:56px;object-fit:cover;border-radius:6px" loading="lazy">` : ''}
        <div class="body"><div class="title">${esc(h.title)}</div><div class="meta">Watched episode ${esc(h.ep)}</div></div>
        <span class="muted">›</span>
      </a>`,
    )
    .join('')}</div>`;
}

async function searchView(q) {
  const stale = guard();
  $('#search-input').value = q;
  app.innerHTML = `<h1>Results for “${esc(q)}”</h1><div id="results">${spinner()}</div>`;
  app.onclick = (e) => e.target.closest('[data-action="retry"]') && render();
  let results;
  try {
    results = await api(`/api/search?q=${encodeURIComponent(q)}`);
  } catch (e) {
    if (!stale()) $('#results').innerHTML = errorBox(e);
    return;
  }
  if (stale()) return;
  remember(results);
  $('#results').innerHTML = results.length
    ? `<div class="grid">${results
        .map(
          (a) => `
        <a class="card" href="#/anime/${encodeURIComponent(a.id)}">
          <div class="poster">
            ${a.poster ? `<img src="${esc(a.poster)}" alt="" loading="lazy">` : ''}
            <div class="tags">
              ${a.sub != null ? `<span class="tag">SUB ${a.sub}</span>` : ''}
              ${a.dub ? `<span class="tag">DUB ${a.dub}</span>` : ''}
              ${a.type ? `<span class="tag">${esc(a.type)}</span>` : ''}
            </div>
          </div>
          <div class="name">${esc(a.title)}</div>
        </a>`,
        )
        .join('')}</div>`
    : `<div class="empty">No results.</div>`;
}

async function animeView(id) {
  const stale = guard();
  const m = meta[id] || {};
  const title = titleOf(id);
  app.innerHTML = `
    <div class="hero">
      ${m.poster ? `<img src="${esc(m.poster)}" alt="">` : ''}
      <div class="info">
        <h1>${esc(title)}</h1>
        <div class="muted small">${[m.type, m.sub != null && `${m.sub} sub`, m.dub && `${m.dub} dub`].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
    </div>
    <div id="eps">${spinner('Loading episodes…')}</div>`;

  let eps, hist;
  app.onclick = (e) => e.target.closest('[data-action="retry"]') && render();
  try {
    [eps, hist] = await Promise.all([api(`/api/episodes?id=${encodeURIComponent(id)}`), api('/api/history').catch(() => [])]);
  } catch (e) {
    if (!stale()) $('#eps').innerHTML = errorBox(e);
    return;
  }
  if (stale()) return;
  if (!eps.length) {
    $('#eps').innerHTML = `<div class="empty">No episodes listed.</div>`;
    return;
  }

  const h = hist.find((x) => x.id === id);
  const lastIdx = h ? eps.indexOf(h.ep) : -1;
  const next = eps[lastIdx + 1];
  const selected = new Set();
  let selecting = false;
  const watchHref = (ep) => `#/watch/${encodeURIComponent(id)}/${encodeURIComponent(ep)}`;

  const draw = () => {
    $('#eps').innerHTML = `
      <div class="toolbar">
        ${next ? `<a class="btn primary" href="${watchHref(next)}">▶ ${lastIdx >= 0 ? 'Continue' : 'Start'} · Ep ${esc(next)}</a>` : `<span class="muted">All caught up</span>`}
        ${modeSeg(m.dub)}
        <span class="spacer"></span>
        <button class="btn small" data-action="select">${selecting ? 'Cancel' : 'Download…'}</button>
      </div>
      <div class="eps">${eps
        .map((ep, i) => {
          const cls = ['ep', i <= lastIdx && 'watched', i === lastIdx && 'current', selected.has(ep) && 'sel'].filter(Boolean).join(' ');
          return `<a class="${cls}" href="${watchHref(ep)}" data-ep="${esc(ep)}">${esc(ep)}</a>`;
        })
        .join('')}</div>
      ${
        selecting
          ? `<div class="selbar">
              <strong>${selected.size} selected</strong>
              <button class="btn small" data-action="all">All</button>
              ${lastIdx >= 0 && next ? `<button class="btn small" data-action="unwatched">Unwatched</button>` : ''}
              <span class="spacer"></span>
              <select class="btn small" data-action="dlq" aria-label="Download quality">
                ${['1080', '720', '360'].map((q) => `<option value="${q}" ${settings.dlQuality === q ? 'selected' : ''}>${q}p</option>`).join('')}
              </select>
              <button class="btn small" data-action="queue" ${selected.size ? '' : 'disabled'}>Save on laptop</button>
              <button class="btn small primary" data-action="download" ${selected.size ? '' : 'disabled'}>Download${selected.size > 1 ? ` ${selected.size}` : ''}</button>
            </div>`
          : ''
      }`;
  };
  draw();

  app.onclick = async (e) => {
    const t = e.target.closest('[data-action], [data-ep]');
    if (!t) return;
    if (t.dataset.ep && selecting) {
      e.preventDefault();
      selected.has(t.dataset.ep) ? selected.delete(t.dataset.ep) : selected.add(t.dataset.ep);
      return draw();
    }
    switch (t.dataset.action) {
      case 'mode':
        settings.mode = t.dataset.mode;
        saveSettings();
        return draw();
      case 'select':
        selecting = !selecting;
        selected.clear();
        return draw();
      case 'all':
        eps.forEach((ep) => selected.add(ep));
        return draw();
      case 'unwatched':
        selected.clear();
        eps.slice(lastIdx + 1).forEach((ep) => selected.add(ep));
        return draw();
      case 'download': {
        const list = eps.filter((ep) => selected.has(ep));
        selecting = false;
        selected.clear();
        draw();
        return sendToPhone(id, title, list, settings.mode);
      }
      case 'queue': {
        const list = eps.filter((ep) => selected.has(ep));
        try {
          await api('/api/downloads', { method: 'POST', body: { id, title, eps: list, mode: settings.mode, quality: settings.dlQuality } });
          toast(`Saving ${list.length} episode${list.length > 1 ? 's' : ''} on the laptop (${settings.dlQuality}p)`);
          selecting = false;
          selected.clear();
          draw();
          refreshBadge();
        } catch (err) {
          toast(err.message);
        }
      }
    }
  };
  app.onchange = (e) => {
    if (e.target.dataset.action === 'dlq') {
      settings.dlQuality = e.target.value;
      saveSettings();
    }
  };
}

let hlsLoading = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  return (hlsLoading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = HLS_JS;
    s.onload = () => resolve(window.Hls);
    s.onerror = () => {
      hlsLoading = null;
      reject(new Error('Could not load the video library (hls.js). Check the phone has internet.'));
    };
    document.head.append(s);
  }));
}

async function watchView(id, ep) {
  const stale = guard();
  const title = titleOf(id);
  const mode = settings.mode;
  const key = `${id}|${ep}|${mode}`;
  const href = (e) => `#/watch/${encodeURIComponent(id)}/${encodeURIComponent(e)}`;

  app.innerHTML = `
    <div class="player" id="player"><div class="player-state"><div><div class="spinner"></div>Finding ${esc(mode)} stream…</div></div></div>
    <h1 style="margin-top:14px"><a href="#/anime/${encodeURIComponent(id)}">${esc(title)}</a></h1>
    <div class="muted">Episode ${esc(ep)}</div>
    <div class="toolbar" id="controls"></div>`;

  let hls = null;
  let saveTimer = null;
  cleanup = () => {
    hls?.destroy();
    clearInterval(saveTimer);
    const v = $('#player video');
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
  };

  let eps = [];
  let data;
  const showError = (e) => {
    if (stale()) return;
    $('#player').innerHTML = `<div class="player-state"><div><div class="error">${esc(e.message || e)}</div>
      <div class="row" style="justify-content:center;margin-top:12px">
        <button class="btn small" data-action="retry">Retry</button>
        <button class="btn small" data-action="mode" data-mode="${mode === 'sub' ? 'dub' : 'sub'}">Try ${mode === 'sub' ? 'dub' : 'sub'}</button>
      </div></div></div>`;
  };

  const drawControls = () => {
    const i = eps.indexOf(ep);
    const prev = eps[i - 1];
    const next = eps[i + 1];
    $('#controls').innerHTML = `
      ${prev ? `<a class="btn small" href="${href(prev)}">‹ Ep ${esc(prev)}</a>` : ''}
      ${next ? `<a class="btn small" href="${href(next)}">Ep ${esc(next)} ›</a>` : ''}
      ${modeSeg(meta[id]?.dub)}
      <select class="btn small" id="quality" aria-label="Quality" hidden></select>
      <span class="spacer"></span>
      <button class="btn small" data-action="download">⬇ Download</button>`;
    return next;
  };

  app.onclick = async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    if (t.dataset.action === 'retry') return render();
    if (t.dataset.action === 'mode') {
      settings.mode = t.dataset.mode;
      saveSettings();
      return render();
    }
    if (t.dataset.action === 'download') return sendToPhone(id, title, [ep], mode);
  };

  try {
    [eps, data] = await Promise.all([
      api(`/api/episodes?id=${encodeURIComponent(id)}`),
      api(`/api/links?id=${encodeURIComponent(id)}&ep=${encodeURIComponent(ep)}&mode=${mode}`),
    ]);
  } catch (e) {
    $('#controls') && !stale() && drawControls();
    return showError(e);
  }
  if (stale()) return;
  const next = drawControls();

  const video = document.createElement('video');
  video.controls = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.preload = 'auto';
  if (data.subtitles) {
    const track = document.createElement('track');
    Object.assign(track, { kind: 'subtitles', label: 'English', srclang: 'en', src: data.subtitles, default: true });
    video.append(track);
  }
  $('#player').replaceChildren(video);

  const qualitySel = $('#quality');
  const setOptions = (opts, selected) => {
    qualitySel.innerHTML = opts.map(([v, label]) => `<option value="${v}" ${String(v) === String(selected) ? 'selected' : ''}>${label}</option>`).join('');
    qualitySel.hidden = opts.length < 2;
  };
  const swapSource = (url) => {
    const t = video.currentTime;
    const playing = !video.paused;
    const restore = () => {
      video.currentTime = t;
      if (playing) video.play().catch(() => {});
    };
    if (hls) {
      hls.once(window.Hls.Events.MANIFEST_PARSED, () => video.addEventListener('loadedmetadata', restore, { once: true }));
      hls.loadSource(url);
    } else {
      video.addEventListener('loadedmetadata', restore, { once: true });
      video.src = url;
    }
  };

  let Hls = null;
  try {
    Hls = await loadHls();
  } catch (e) {
    if (!video.canPlayType('application/vnd.apple.mpegurl')) return showError(e);
  }
  if (stale()) return;

  const wanted = settings.streamQuality;
  if (Hls?.isSupported()) {
    hls = new Hls({ maxBufferLength: 60, enableWorker: true });
    let recovered = 0;
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (recovered++ < 3 && d.type === Hls.ErrorTypes.NETWORK_ERROR) return hls.startLoad();
      if (recovered++ < 3 && d.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
      showError(new Error(`Playback failed (${d.details}). Try another quality or retry.`));
    });
    if (data.master) {
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        const levels = hls.levels.map((l, i) => [i, l.height]).sort((a, b) => b[1] - a[1]);
        const match = levels.find(([, h]) => String(h) === wanted);
        if (match) hls.currentLevel = match[0];
        setOptions([[-1, 'Auto'], ...levels.map(([i, h]) => [i, `${h}p`])], match ? match[0] : -1);
      });
      qualitySel.onchange = () => {
        hls.currentLevel = Number(qualitySel.value);
        settings.streamQuality = qualitySel.value === '-1' ? 'auto' : String(hls.levels[Number(qualitySel.value)].height);
        saveSettings();
      };
      hls.loadSource(data.master);
    } else {
      const start = data.qualities.find((q) => q.quality === wanted) || data.qualities[0];
      setOptions(data.qualities.map((q) => [q.quality, `${q.quality}p`]), start.quality);
      qualitySel.onchange = () => swapSource(data.qualities.find((q) => q.quality === qualitySel.value).stream);
      hls.loadSource(start.stream);
    }
    hls.attachMedia(video);
  } else {
    // iOS Safari: native HLS picks quality itself from the master playlist
    video.src = data.master || data.qualities[0].stream;
    if (!data.master) {
      setOptions(data.qualities.map((q) => [q.quality, `${q.quality}p`]), data.qualities[0].quality);
      qualitySel.onchange = () => swapSource(data.qualities.find((q) => q.quality === qualitySel.value).stream);
    }
  }

  const positions = store.get('pos', {});
  const resumeAt = positions[key] || 0;
  video.addEventListener(
    'loadedmetadata',
    () => {
      if (resumeAt > 10 && (!video.duration || resumeAt < video.duration - 30)) {
        video.currentTime = resumeAt;
        toast(`Resumed at ${fmtTime(resumeAt)}`);
      }
    },
    { once: true },
  );
  video.addEventListener(
    'playing',
    () => api('/api/history', { method: 'POST', body: { id, title, ep } }).catch(() => {}),
    { once: true },
  );
  saveTimer = setInterval(() => {
    if (video.paused || !video.duration) return;
    const pos = store.get('pos', {});
    if (video.currentTime > video.duration - 60) delete pos[key];
    else pos[key] = Math.floor(video.currentTime);
    const keys = Object.keys(pos);
    if (keys.length > 300) delete pos[keys[0]];
    store.set('pos', pos);
  }, 5000);
  video.addEventListener('ended', () => {
    if (settings.autoNext && next && !stale()) location.hash = href(next);
  });
  video.play().catch(() => {});
}

async function downloadsView() {
  const stale = guard();
  app.innerHTML = `<h1>Downloads</h1>
    <p class="muted small">“Download” sends episodes straight to your phone as MKV files with English subtitles built in. They play with subtitles in VLC or MX Player. Keep this page or the browser open until they finish.</p>
    <div id="dl">${spinner()}</div>`;
  let timer;
  cleanup = () => clearTimeout(timer);

  const statusText = (j) =>
    ({
      queued: 'Queued',
      resolving: 'Finding stream…',
      downloading: `${j.kind === 'phone' ? 'Sending to phone' : 'Saving on laptop'} ${Math.round(j.progress * 100)}%`,
      done: j.kind === 'phone' ? 'Sent to phone' : 'Done',
      failed: `Failed: ${j.error}`,
      cancelled: 'Cancelled',
    })[j.status] || j.status;

  const draw = async () => {
    let d;
    try {
      d = await api('/api/downloads');
    } catch (e) {
      if (!stale()) $('#dl').innerHTML = errorBox(e);
      return;
    }
    if (stale()) return;
    // finished phone transfers stay listed as a confirmation; finished laptop saves show up under "On the laptop"
    const jobs = d.jobs.filter((j) => j.status !== 'done' || j.kind === 'phone');
    const busy = jobs.some((j) => ['queued', 'resolving', 'downloading'].includes(j.status));
    $('#dl').innerHTML = `
      ${
        jobs.length
          ? `<h2>Queue</h2><div class="list">${jobs
              .map(
                (j) => `
          <div class="item">
            <div class="body">
              <div class="title">${esc(j.title)} · Ep ${esc(j.ep)}</div>
              <div class="meta ${j.status === 'failed' ? 'status-failed' : j.status === 'done' ? 'status-done' : ''}">${esc(j.mode)} · ${esc(j.quality)}p · ${esc(statusText(j))}</div>
              ${j.status === 'downloading' || j.status === 'resolving' ? `<div class="bar"><i style="width:${Math.round(j.progress * 100)}%"></i></div>` : ''}
            </div>
            <button class="btn small" data-action="cancel" data-id="${esc(j.id)}">${['queued', 'resolving', 'downloading'].includes(j.status) ? 'Cancel' : 'Clear'}</button>
          </div>`,
              )
              .join('')}</div>`
          : ''
      }
      <h2>On the laptop</h2>
      ${
        d.files.length
          ? `<div class="list">${d.files
              .map((f) => {
                const u = `/files/${encodeURIComponent(f.name)}`;
                return `
          <div class="item" style="flex-wrap:wrap">
            <div class="body" style="flex-basis:100%">
              <div class="title">${esc(f.name.replace(/\.(mkv|mp4)$/, ''))}</div>
              <div class="meta">${fmtSize(f.size)}</div>
            </div>
            <div class="row" style="width:100%">
              <a class="btn small primary" href="${u}?dl=1" download="${esc(f.name)}">Save to phone</a>
              <span class="spacer"></span>
              <button class="btn small danger" data-action="delete" data-name="${esc(f.name)}">Delete</button>
            </div>
          </div>`;
              })
              .join('')}</div>`
          : `<div class="empty">Nothing saved on the laptop. Use “Save on laptop” when picking episodes to keep copies here.</div>`
      }`;
    setBadge(jobs.filter((j) => ['queued', 'resolving', 'downloading'].includes(j.status)).length);
    timer = setTimeout(draw, busy ? 1500 : 6000);
  };

  app.onclick = async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    try {
      if (t.dataset.action === 'retry') return render();
      if (t.dataset.action === 'cancel') await api(`/api/downloads/${t.dataset.id}`, { method: 'DELETE' });
      if (t.dataset.action === 'delete') {
        if (!confirm(`Delete “${t.dataset.name}” from the server?`)) return;
        await api(`/files/${encodeURIComponent(t.dataset.name)}`, { method: 'DELETE' });
      }
      clearTimeout(timer);
      draw();
    } catch (err) {
      toast(err.message);
    }
  };
  draw();
}

async function settingsView() {
  const stale = guard();
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('');
  app.innerHTML = `
    <h1>Settings</h1>
    <div class="panel">
      <label>Default audio <select class="btn small" data-key="mode">${opt([['sub', 'Sub'], ['dub', 'Dub']], settings.mode)}</select></label>
      <label>Streaming quality <select class="btn small" data-key="streamQuality">${opt([['auto', 'Auto'], ['1080', '1080p'], ['720', '720p'], ['360', '360p']], settings.streamQuality)}</select></label>
      <label>Download quality <select class="btn small" data-key="dlQuality">${opt([['1080', '1080p (~1 GB/ep)'], ['720', '720p (~400 MB/ep)'], ['360', '360p (~150 MB/ep)']], settings.dlQuality)}</select></label>
      <label>Auto-play next episode <input type="checkbox" data-key="autoNext" ${settings.autoNext ? 'checked' : ''}></label>
    </div>
    <h2>Updates</h2>
    <div class="panel" id="updates">${spinner()}</div>
    <h2>On your phone</h2>
    <div class="panel small muted">
      Open <strong>${esc(location.origin)}</strong> on your phone while it's on the same Wi-Fi as the server.
      Use the browser menu → “Add to Home screen” to get an app icon.
    </div>`;

  app.onchange = (e) => {
    const k = e.target.dataset.key;
    if (!k) return;
    settings[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    saveSettings();
    toast('Saved');
  };

  const repoLine = (label, r, extra = '') => {
    if (!r) return '';
    if (r.error) return `<div class="item"><div class="body"><div class="title">${label}${extra}</div><div class="meta error">${esc(r.error)}</div></div></div>`;
    return `<div class="item"><div class="body"><div class="title">${label}${extra}</div>
      <div class="meta">${esc(r.head || '')}</div>
      <div class="meta ${r.behind ? '' : 'status-done'}">${r.behind ? `${r.behind} update${r.behind > 1 ? 's' : ''} available` : 'Up to date'}</div></div></div>`;
  };

  const drawUpdates = async (refresh, note = '') => {
    let v;
    try {
      v = await api(`/api/version${refresh ? '?refresh' : ''}`);
    } catch (e) {
      if (!stale()) $('#updates').innerHTML = `<div class="error">${esc(e.message)}</div>`;
      return;
    }
    if (stale()) return;
    const behind = (v.aniCli?.behind || 0) + (v.app?.behind || 0);
    $('#update-badge').hidden = !behind;
    $('#updates').innerHTML = `
      <div class="list">
        ${repoLine('ani-cli', v.aniCli, v.aniCli.version ? ` v${esc(v.aniCli.version)}` : '')}
        ${repoLine('ani-web', v.app)}
      </div>
      ${note ? `<p class="small">${note}</p>` : ''}
      <div class="row" style="margin-top:12px">
        <button class="btn small" data-action="check">Check now</button>
        <button class="btn small primary" data-action="update" ${behind ? '' : 'disabled'}>Update</button>
      </div>
      <p class="muted small">Pulls the latest ani-cli from GitHub, same as <code>ani-cli -U</code>, so scraper fixes reach this app without reinstalling.</p>`;
  };

  app.onclick = async (e) => {
    const t = e.target.closest('[data-action]');
    if (!t) return;
    if (t.dataset.action === 'check') {
      t.disabled = true;
      t.textContent = 'Checking…';
      return drawUpdates(true);
    }
    if (t.dataset.action === 'update') {
      t.disabled = true;
      t.textContent = 'Updating…';
      try {
        const r = await api('/api/update', { method: 'POST' });
        if (r.restarting) {
          $('#updates').innerHTML = spinner('Updated. Restarting server…');
          await waitForServer();
          return location.reload();
        }
        drawUpdates(false, r.restartNeeded ? 'ani-web was updated. Restart the server to apply it.' : 'Updated.');
      } catch (err) {
        drawUpdates(false, `<span class="error">${esc(err.message)}</span>`);
      }
    }
  };
  drawUpdates(false);
}

async function waitForServer() {
  await new Promise((r) => setTimeout(r, 1500));
  for (let i = 0; i < 30; i++) {
    try {
      await api('/api/version');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------- badges ----------

function setBadge(n) {
  const b = $('#dl-badge');
  b.hidden = !n;
  b.textContent = n;
}
async function refreshBadge() {
  try {
    const d = await api('/api/downloads');
    setBadge(d.jobs.filter((j) => ['queued', 'resolving', 'downloading'].includes(j.status)).length);
  } catch {}
}
setInterval(refreshBadge, 10_000);
refreshBadge();
api('/api/version')
  .then((v) => ($('#update-badge').hidden = !((v.aniCli?.behind || 0) + (v.app?.behind || 0))))
  .catch(() => {});

render();
