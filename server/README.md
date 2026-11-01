# Comments API (Fly.io)

Anyone can post a rating and notes about a field/FBO, a MOA/restricted/warning
area, or an IR/VR/SR route; the owner reads the log and deletes what's needed
at `https://<app>.fly.dev/admin`.

- `app.js` — the API (plain `node:http`, no dependencies). `store.js` is an
  append-only JSON-lines file on a Fly volume. `validate.js` cleans input.
- Spam controls: a hidden honeypot field, a minimum fill time, 5 posts / 10 min
  and 30 / day per poster, a global cap, no links allowed, 8 KB body limit, and
  CORS limited to the site's origin. Posters are only stored as a salted hash
  (shown in the admin log so you can delete everything from one poster).
- Tests: `tests/unit/comments-server.test.js` (run with the rest of `npm run test:unit`).

## One-time setup

You need the [`fly` CLI](https://fly.io/docs/flyctl/install/) and to be logged in (`fly auth login`).

```sh
cd server
fly apps create xc-gpt-comments            # or pick another name and edit fly.toml + data/curated/config.json
fly volumes create comments_data --region dfw --size 1 -a xc-gpt-comments
fly secrets set ADMIN_TOKEN="$(openssl rand -hex 24)" -a xc-gpt-comments   # then look it up: fly ssh console -C 'printenv ADMIN_TOKEN'
fly deploy                                 # first deploy, from your machine
```

Easier: choose the token yourself and keep it in a password manager —
`fly secrets set ADMIN_TOKEN=<something long> -a xc-gpt-comments`.

Then make later deploys automatic (every change under `server/` on `main`):

```sh
fly tokens create deploy -a xc-gpt-comments
```

Paste the output into the repo secret **FLY_API_TOKEN**
(Settings → Secrets and variables → Actions → New repository secret).

The site finds the API through `commentsApi` in `data/curated/config.json`
(default `https://xc-gpt-comments.fly.dev`). If you named the app differently,
change it there and in `fly.toml`.

## Operating it

- Log: `https://xc-gpt-comments.fly.dev/admin` — paste the admin token once (kept in your browser).
- Backup: `fly ssh sftp get /data/comments.jsonl` (one JSON event per line).
- Change which sites may post: set `ALLOWED_ORIGINS` (comma list) in `fly.toml`.
- It runs one machine (the volume is tied to it) and sleeps when idle, so the
  first request after a quiet spell takes a second or two.
