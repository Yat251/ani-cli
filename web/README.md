# ani-web

A phone-friendly web UI over [ani-cli](https://github.com/pystardust/ani-cli): search, stream in the browser, and download episodes as MP4 to your phone.

It doesn't reimplement any scraping. `bridge.sh` loads the functions straight out of `../ani-cli` (this repo is a fork of ani-cli; the app lives in `web/`). When the site changes and upstream ships a fix, sync the fork (GitHub "Sync fork" or `gh repo sync`), then **Settings → Update** (a `git pull`) fixes this app too.

## Run

```sh
cd web
./start.sh            # serves on :7777
```

Open the printed `http://192.168.x.x:7777` on your phone (same Wi-Fi). Browser menu → "Add to Home screen" for an app icon.

Needs: `node` 18+, `curl`, `git`, `ffmpeg` (for downloads).

## How it works

| Piece | What it does |
| --- | --- |
| `bridge.sh` | `search` / `episodes` / `links` using ani-cli's own `hianime_*` functions |
| `server.js` | JSON API, signed HLS relay (adds the Referer the stream host requires), ffmpeg download queue, history, updates |
| `public/` | the UI (vanilla JS, hls.js from jsDelivr) |

- **Streaming**: playlists and segments go through `/hls/...` on the server, because browsers can't send the Referer the CDN checks. URLs are HMAC-signed so it isn't an open proxy.
- **Downloads**: "Download" sends episodes straight to the phone. The server runs ffmpeg and streams its output into the phone's download as it's made, so nothing is stored on the laptop. Files are MKV with English subtitles built in (VLC, MX Player). Select several episodes to download them all; up to 3 stream at once (`ANI_WEB_DIRECT_PARALLEL`), the rest wait. "Save on laptop" keeps a copy in `downloads/` instead.
- **History**: read/written in ani-cli's own history file, so `ani-cli -c` on the laptop and the app share progress.

## Settings (env vars)

| Var | Default |
| --- | --- |
| `PORT` | `7777` |
| `HOST` | `0.0.0.0` |
| `ANI_WEB_DOWNLOAD_DIR` | `./downloads` |
| `ANI_WEB_PARALLEL` | `2` concurrent saves on the laptop |
| `ANI_WEB_DIRECT_PARALLEL` | `3` concurrent downloads to phones |
| `ANI_CLI_DIR` | `..` (the repo root) |

The usual `ANI_CLI_HIST_DIR` / `XDG_STATE_HOME` are honoured for the history file.

## Without the laptop

- **Termux on Android**: ani-cli officially supports Termux. `pkg install nodejs git ffmpeg curl`, clone this repo, `cd web && ./start.sh`, open `http://localhost:7777` on the phone itself. No server needed.
- **A free/cheap VPS** (e.g. Oracle Cloud free tier): works the same, but add a login first — anyone with the URL could use it. Datacenter IPs may also get Cloudflare-blocked by the source site.
