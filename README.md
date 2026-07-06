# 🏡 Hearth

![build](https://github.com/Jacobsonradical/HEARTH/actions/workflows/build.yml/badge.svg)

A tiny, cozy chat app just for two people, self-hosted on your own machine. It
runs as a single Docker container on your home server and you open it from any
browser on your home wifi — no accounts to sign up for, nothing installed on the
other person's computer, and none of your words ever leave the house.

Real-time chat, a shared little garden that grows the more you talk, custom
avatars, nicknames, notification sounds, and backgrounds. Made for love, not for
work. 💛

---

## What's inside

- **Real-time 1-on-1 chat** over WebSocket between exactly two accounts.
- **Everything persisted** to one folder (`data/`) via SQLite + stored files —
  survives restarts, rebuilds, and reboots.
- **A shared garden** 🌱 that grows from real interaction: daily watering, saying
  good morning, and keeping a chat streak grow a tree and bloom flowers, with
  seasonal touches.
- **Make it yours**: custom username display name, a private nickname for your
  partner (only you see it), profile photos, a notification sound (yes, a bark 🐶
  works), and a chat background.
- **LAN-only by design.** Never meant to touch the internet.
- **One-folder backup/restore** with a cron-friendly script.

No database server to install. No Node or Go needed on the host. Just Docker.

---

## Requirements

One always-on computer at home (the "host") with **Docker**:

| Host OS | What to install |
|---|---|
| **Linux** | [Docker Engine](https://docs.docker.com/engine/install/) + compose plugin |
| **macOS** (Apple Silicon *and* Intel) | [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) |
| **Windows** | [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/) with the **WSL2** backend |

That's it. **You do NOT need to install SQLite, PostgreSQL, Go, or Node** —
everything is built and run inside the container. The image builds natively on
your machine's own architecture (arm64 or x86-64), so Apple Silicon needs no
special steps.

---

## Install (one line)

**Linux and macOS** — open a terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/Jacobsonradical/HEARTH/master/install.sh | sh
```

**Windows** — open your **WSL terminal** (e.g. Ubuntu; Docker Desktop requires
WSL2 anyway) and run the same line. Running inside WSL is deliberate: the
database lives on WSL's Linux filesystem, where SQLite is fully safe —
Windows-mounted folders are not reliable for it.

The installer checks Docker, downloads the app into `~/hearth`, detects your
LAN IP and timezone, builds, and starts it. At the end it prints your address:

```
hearth | HEARTH is up!  Open:   http://192.168.1.50:3000
```

Open that from any device on your wifi — the app greets you with a **one-time
setup screen** where you create the two accounts, yours and your love's. Done.

Re-running the installer later **updates** an existing `~/hearth` install.
Options: `HEARTH_DIR=/elsewhere`, `HEARTH_BIND_IP=...`, `HEARTH_PORT=...` before
the command.

## Setup by hand (alternative)

If you'd rather not pipe scripts into your shell — sensible! — do the same
steps yourself:

```bash
git clone https://github.com/Jacobsonradical/HEARTH.git ~/hearth
cd ~/hearth

# 1. Auto-configure machine-specific settings (LAN IP, timezone, user) into .env
./setup.sh

# 2. Build and start
docker compose up -d --build

# 3. Open the printed address and create the two accounts in the app.
```

The first build takes a couple of minutes. After that it starts instantly.

### What `setup.sh` fills in

`setup.sh` detects and writes these into `.env` so you don't have to look them up:

- `HEARTH_BIND_IP` — **your machine's LAN IP**, so phones/PCs on the wifi can
  reach it. If auto-detect guesses wrong (e.g. you have a VPN or several
  interfaces), pass the right one explicitly: `./setup.sh 192.168.1.50`.
  To find it yourself: `hostname -I`.
- `TZ` — your system timezone, so daily streaks and seasons match your real
  day. If it can't be detected here, the app detects it itself from your
  internet connection at startup.
- `HEARTH_UID` / `HEARTH_GID` — your user, so files in `./data` stay owned by you.
- On **WSL** it asks Windows for the real LAN IP automatically (PowerShell
  interop); on **macOS** it queries the network services directly.

Accounts are **not** set in `.env` — the app asks you on first open. (The
`HEARTH_USER*/PASS*` variables exist only as an override, e.g. to reset a
forgotten password: set all of them, restart the container once, then clear
them again.)

> Prefer to do it all by hand? Skip `setup.sh`, run `cp .env.example .env`, and
> edit every value yourself.

---

## Logging in from another device

1. Make sure the phone/PC is on the **same wifi**.
2. Open a browser and go to:

   ```
   http://<YOUR-LAN-IP>:3000
   ```

   e.g. `http://192.168.1.50:3000`
3. Log in with one of the two accounts from your `.env`.

Your login is remembered for a long time, so you won't have to sign in every
time — even after closing the browser.

> Tip: bookmark it on the home screen. On phones, "Add to Home Screen" makes it
> feel like a real little app.

---

## Using it

- **Chat** 💬 — type and press Enter (Shift+Enter for a new line). Tap 📷 to send
  a photo. A dot shows when your partner is here.
- **Garden** 🌱 — water it once a day, say good morning, and keep chatting. The
  tree grows through stages, flowers bloom, and the scene changes with the
  seasons. When you both say good morning on the same day, you get a bonus.
- **Me** ⚙️ — set your display name, a private nickname for your partner, your
  photo, your notification sound, and your chat background.

---

## Updating

When new features land in this repository, update your install with either:

```bash
# the same one-liner — it detects the existing install and updates it in place
curl -fsSL https://raw.githubusercontent.com/Jacobsonradical/HEARTH/master/install.sh | sh
```

or by hand:

```bash
cd ~/hearth
git pull
docker compose up -d --build
```

**Your data is never touched by an update** — messages, photos, garden, and
logins all live in `./data`, which git and Docker builds leave alone. You stay
logged in, the app is only briefly restarted. (Old image layers pile up after
many rebuilds; reclaim disk now and then with `docker image prune -f`.)

---

## Backup & restore

**Everything lives in `./data`.** That one folder is the whole app state.
(On Windows that's inside WSL, e.g. `~/hearth/data` in your Ubuntu distro.)

**Backup** — copy the folder, or use the included script:

```bash
./scripts/backup.sh                      # writes a tarball into ./backups
KEEP=30 BACKUP_DIR=/mnt/usb ./scripts/backup.sh
```

Automatic nightly backup at 02:30 — run `crontab -e` and add (adjust the path
to your install; `echo $HOME` tells you what ~ is):

```cron
30 2 * * * $HOME/hearth/scripts/backup.sh >> $HOME/hearth/backup.log 2>&1
```

**Restore** — put the folder back and start the container:

```bash
docker compose down
rm -rf data && tar -xzf backups/hearth-YYYYMMDD-HHMMSS.tar.gz   # extracts ./data
docker compose up -d
```

To move to a new machine, copy `data/` (and your `.env`) over and
`docker compose up -d --build`. Done.

---

## Security model (please read)

This app is built to live **only on your home network**. It has simple login
with two fixed accounts and hashed passwords, but it is **not hardened for the
public internet** and must never be exposed there.

- **Do NOT set up port forwarding** on your router for this app. Ever.
- The container publishes its port **bound to your LAN IP only**
  (`HEARTH_BIND_IP` in `.env`), so it isn't listening on a public interface.
- Sessions survive browser restarts; passwords are bcrypt-hashed; uploaded
  files and chat history are only served to a logged-in session.

### Firewall (ufw) — defense in depth

Restrict the port to your local subnet:

```bash
# Allow only devices on your home subnet (adjust to match your network):
sudo ufw allow from 192.168.1.0/24 to any port 3000 proto tcp
sudo ufw deny 3000
```

> **Important Docker + ufw note:** Docker manages its own iptables rules and can
> bypass ufw for *published* ports. That's exactly why we publish the port bound
> to your private LAN IP (`192.168.x.x`) instead of `0.0.0.0` — a private address
> is not routable from the internet, so even with Docker's rules the app stays
> LAN-only as long as your router isn't forwarding to it. If you want ufw to also
> govern Docker traffic directly, add rules in the `DOCKER-USER` chain rather
> than relying on the default ufw chains.

### HTTPS

Not required for v1 on home wifi (plain HTTP). Nothing here blocks adding it
later — you'd put a reverse proxy (e.g. Caddy) in front and flip the cookie's
`Secure` flag in `server/auth/auth.go`.

---

## How it's built

| Piece      | Choice                          | Why                                            |
|------------|---------------------------------|------------------------------------------------|
| Backend    | Go (`net/http`, gorilla/ws)     | One static binary, easy to run and reason about |
| Storage    | SQLite (pure-Go driver)         | A single file, no DB server to install/manage  |
| Files      | Plain files under `data/uploads`| Transparent; backup is just copying a folder   |
| Frontend   | React + Vite                    | Cozy, responsive UI                            |
| Delivery   | One Docker image via compose    | `docker compose up -d` and you're live         |

Layout:

```
HEARTH/
├── docker-compose.yml     # one service
├── Dockerfile             # 3-stage build (web → server → runtime)
├── .env.example           # copy to .env and fill in
├── scripts/backup.sh      # cron-friendly backup
├── server/                # Go backend (store, auth, hub, garden, api)
├── web/                   # React + Vite frontend
└── data/                  # runtime state — the one folder to back up
```

Data folders and rules:
- `data/hearth.db` — messages, users, sessions, garden state (SQLite).
- `data/uploads/` — avatars, sounds, backgrounds, sent images.

---

## Developing locally (optional)

You only need this if you want to change the code without rebuilding the image.

```bash
# Terminal 1 — backend on :3000
cd server
HEARTH_USER1=me HEARTH_PASS1=pw HEARTH_USER2=you HEARTH_PASS2=pw \
  HEARTH_DATA_DIR=../data go run .

# Terminal 2 — frontend dev server on :5173 (proxies /api and /ws to :3000)
cd web
npm install
npm run dev
```

Open `http://localhost:5173`.

---

Made with 💛 for a working-from-home couple in two different bedrooms.
