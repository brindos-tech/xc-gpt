# Operations: one-time setups outside the repo

Things the site depends on that live in someone's account rather than in code. Each section says what it is for, how to set it up, how to check it works, and what happens if it stops.

## TFR timer

**Why.** `refresh-tfr.yml` is scheduled every 10 minutes, but GitHub runs schedules on a best-effort basis and was seen running it only every 4 to 11 hours, so TFRs went 5 hours stale. An outside timer starts the workflow every 15 minutes through GitHub's API. The workflow ends in seconds when the published file is under 10 minutes old, so extra starts cost nothing.

**If it stops.** GitHub's own schedule is still there as a fallback, the TFR sheet shows how old its list is, and the site shows a banner once the list is 4 hours old.

### 1. Make a token that can only start workflows in this repository

GitHub → your picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**.

- Token name: `XC Scanner TFR timer`
- Expiration: 1 year. Put a calendar reminder to renew it.
- Resource owner: `brindos-tech`
- Repository access: **Only select repositories** → `xc-gpt`
- Repository permissions: **Actions → Read and write**. Leave every other permission at "No access". Metadata becomes read-only by itself; that is required and harmless.

Copy the token (starts `github_pat_`). With only this permission it can start, re-run or cancel workflow runs in `xc-gpt`. It cannot read or change code, secrets, settings or the site.

### 2. Create the timer

At [cron-job.org](https://cron-job.org) (free), make an account, then **Create cronjob**:

- Title: `XC Scanner TFRs`
- URL: `https://api.github.com/repos/brindos-tech/xc-gpt/actions/workflows/refresh-tfr.yml/dispatches`
- Execution schedule: every 15 minutes
- **Advanced** tab:
  - Request method: `POST`
  - Headers:
    - `Authorization`: `Bearer <the token>`
    - `Accept`: `application/vnd.github+json`
    - `X-GitHub-Api-Version`: `2022-11-28`
    - `Content-Type`: `application/json`
  - Request body: `{"ref":"main"}`
- Notifications: turn on "notify me when execution fails".

### 3. Check it

Use **Test run** on the job: GitHub answers **204 No Content** when it worked. Then a "Refresh TFRs" run appears in the repository's Actions tab within a minute or so. A 401 means the token is wrong or expired; a 403 or 404 usually means the token lacks the Actions permission or the repository was not selected.

## Comments server (Fly.io)

**Why.** The comments panel on field and airspace sheets talks to a small server, `server/`, on Fly.io. The site already points at `https://xc-gpt-comments.fly.dev` (`commentsApi` in `data/curated/config.json`); until that app exists the panel says comments are offline.

**Cost.** One shared-cpu-1x machine with 256 MB that sleeps when idle, plus a 1 GB volume. That is within or close to Fly's smallest charges (a few dollars a month at most). Fly asks for a card when you sign up.

### Setup

From a GitHub Codespace on the repository (green **Code** button → **Codespaces**) or any computer with a terminal:

```sh
curl -L https://fly.io/install.sh | sh          # installs the fly command
export PATH="$HOME/.fly/bin:$PATH"
fly auth login                                  # prints a link; open it and sign in (or sign up)
cd server
fly apps create xc-gpt-comments
fly volumes create comments_data --region dfw --size 1 -a xc-gpt-comments
fly secrets set ADMIN_TOKEN="<a password of 16+ characters you keep in a password manager>" -a xc-gpt-comments   # the server refuses to start with a shorter one
fly deploy -a xc-gpt-comments
```

`fly volumes create` asks whether you are sure you want a single volume (no replication); answer yes. If `xc-gpt-comments` is taken, pick another name and tell Claude, so `server/fly.toml` and `config.json` are changed to match.

Then let GitHub redeploy it on every change under `server/`:

```sh
fly tokens create deploy -a xc-gpt-comments
```

Copy the whole output (starts `FlyV1`) into the repository secret **FLY_API_TOKEN**: repository **Settings** → **Secrets and variables** → **Actions** → **New repository secret**.

### Check it

- `https://xc-gpt-comments.fly.dev/health` answers `{"ok":true,...}`.
- Open a field on xcscanner.com: the comments panel shows the form instead of "offline".
- `https://xc-gpt-comments.fly.dev/admin`: paste the ADMIN_TOKEN once to see the log and delete posts or read problem reports.

More detail on how the server works and is backed up: `server/README.md`.

## Moderating comments

Everything anyone posts, including private "Report a problem" notes, is in the log at **https://xc-gpt-comments.fly.dev/admin**. Paste the ADMIN_TOKEN once; the browser remembers it.

- **What you see:** newest first, up to the last 1,000. Each entry shows the field or airspace it is about, the rating, date, name given, every answer and the notes, and a short "poster" code (a salted hash of the poster's network address, not the address itself).
- **Find things:** the Filter box matches any text (a field code, a name, a word). "Reports only" shows the private problem reports, marked REPORT; those never appear on the site.
- **Remove one comment:** Delete, then confirm. It disappears from the site at once (the site and the Reviews tab refresh within about a minute).
- **Remove everything from one person:** "Delete all from this poster" removes every comment with that poster code. Use it for spam or a troll; the same person on a different network gets a different code.
- **Built-in limits:** 5 posts per 10 minutes and 30 per day per poster, 300 per hour site-wide, no links allowed, a hidden spam trap and a minimum time to fill the form. Ten wrong admin tokens in a minute locks that network out for the minute.
- **Backup or export:** from a Codespace with the fly command, `fly ssh sftp get /data/comments.jsonl -a xc-gpt-comments` (one JSON line per post or deletion).
- **If you suspect the token leaked:** `fly secrets set ADMIN_TOKEN=<new 16+ characters> -a xc-gpt-comments` (the server restarts with the new one), then paste the new token in the admin page.

There is no automatic alert for new comments yet: check the log every few days, or ask Claude for a daily e-mail digest (a small GitHub workflow that reads the log and opens or updates an issue when there is something new; GitHub e-mails you about issues).
