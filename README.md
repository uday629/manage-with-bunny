<p align="center"><img src="assets/logo.png" width="110" alt="Manage with Bunny"></p>
<h1 align="center">Manage with Bunny</h1>
<p align="center">Private team chat, voice messages, big file transfer, task pipelines, team chart, records and performance tracking that run entirely on your own Wi-Fi.<br>
Made by <b>Bunnys Framelab</b> · <a href="https://framelabmedia.odoo.com/">framelabmedia.odoo.com</a> · <a href="https://www.instagram.com/bunnysframelab/">Instagram @bunnysframelab</a></p>

> Full illustrated guide: open **[README.html](README.html)** · Tour of every screen: **[UI.html](UI.html)** (download the repo or view them through GitHub Pages).

## Download

Go to **[Releases](../../releases/latest)** and download **`Manage-with-Bunny-<version>-Complete.zip`** (one file with everything). Right-click it, **Extract All**, then open **README.html**. The ZIP contains:

- `Windows/` the Windows installer, `Mac (Apple Silicon)/` and `Mac (Intel)/` the Mac installers
- `README.html` complete guide: requirements, install, uninstall, first-time setup, how every feature works, network help, security, limitations, FAQ (works offline)
- `UI.html` a tour of every screen, `SECURITY_REPORT.md`, `SHA256SUMS.txt`

The installers are also attached to the release separately.

| Platform | File | First run |
|---|---|---|
| Windows 10/11 (64-bit) | `Manage-with-Bunny-Setup-<version>.exe` | Double-click, press **Yes** on the admin prompt. If "Windows protected your PC" appears: **More info, Run anyway** (see Security). |
| macOS 12+ Apple Silicon | `Manage-with-Bunny-<version>-arm64.dmg` | Drag to Applications. First time: **right-click, Open**. Allow Local Network (and Microphone for voice messages). |
| macOS 12+ Intel | `Manage-with-Bunny-<version>-x64.dmg` | Same as above. |

Verify downloads with `SHA256SUMS.txt` on the release page.

## How it works

1. **Host**: one computer that stays on (the owner's PC or an office PC) chooses *Host a workspace*, picks a storage drive and creates the owner account. It runs the server in the background, starts with the computer and stays in the tray / menu bar.
2. **Invite**: on the host, *Copy invite* copies the 20-character join code **and** the host address.
3. **Join**: teammates install the app, choose *Join a team* and paste the invite. The app finds the host on the Wi-Fi and verifies its identity first.
4. **Approve**: the owner approves each request and sets the role and manager; that builds the team chart.
5. Everyone stays connected: after Wi-Fi drops, sleep, a host restart or an IP change, apps reconnect by themselves. Messages written offline are sent later; uploads resume.

## Features

- **Chat**: end-to-end encrypted direct messages, group chats, **voice messages**, replies, edits, **search** (Bengali and English, jump to result), **seen / not seen** ticks and "Seen by ...", typing indicator, offline outbox, drag-and-drop and paste.
- **Files**: resumable uploads at full Wi-Fi speed, any size (limit configurable), inline video / image / audio, versions, automatic de-duplication, cleanup of duplicates and old versions.
- **Tasks**: assign down the chain, delegate subtasks, start, submit with files, request changes, approve, cancel, reopen; full history; month filter.
- **Remote teammates**: profiles for people who cannot be on the office Wi-Fi. A caretaker moves their tasks forward on their behalf and keeps a daily work log; "Activate login" later turns it into a real account with the same history.
- **Work report**: one sheet of every task and daily update for Today / 2 / 3 / 7 / 30 / 90 days / 6 months / 1 year / custom: person, work, who gave it, client, hours, on time or late, quality stars, Drive links and files on the host. Excel / PDF export.
- **Profile photos** with crop and position (caretakers can add photos for remote teammates).
- **Team chart**, **Records** (private shareable sheets), **Performance** (monthly score, on-time rate, overdue, logged hours, reviews, 12-month history).
- **Export to Excel and PDF**: tasks, records, performance, work logs, security log.
- **Admin**: join requests, members, custom roles with 12 permissions, join-code rotation, storage report and cleanup, daily backups, move storage to another drive, security log.
- **Network check**: explains why someone cannot connect (firewall, different network, router isolation) and repairs the Windows firewall rule in one click.

## Uninstall

- **Windows:** quit the app from the tray icon, then Settings, Apps, Installed apps, Manage with Bunny, Uninstall. This removes the app, shortcuts, firewall rule and auto-start entry.
- **Mac:** quit from the menu-bar icon, drag the app from Applications to the Trash, remove it from System Settings, General, Login Items.
- Your workspace data (the host's storage folder) is never deleted automatically. App settings stay in `%APPDATA%\Manage with Bunny` (Windows) or `~/Library/Application Support/Manage with Bunny` (Mac) until you delete them.

## Limitations

Same local network only (no internet access; remote people use remote profiles); the host must be on; one host per workspace; guest Wi-Fi / AP isolation blocks it; no calls or screen sharing; Windows and Mac only (no mobile or Linux); no automatic updates; group data and DM attachments are not encrypted on the host's disk (use BitLocker / FileVault); a password reset makes old private messages unreadable; installers are not code-signed; tested with 15 simultaneous users and a year of data; the Mac build has not yet been tried on a real Mac. Full list in README.html.

## Network notes

- The Windows installer allows the app through the firewall **only for devices on the same local network**, on Private and Public Wi-Fi.
- Discovery uses broadcast, multicast, a local network scan and remembered addresses, so it works on most routers. If the router has **AP / client isolation** (common on guest Wi-Fi), devices cannot reach each other at all; use the main network or turn that option off. The app's Network check tells you when this is the likely cause.
- Tip: reserve the host's IP address in the router (DHCP reservation).

## Security

- Traffic is TLS 1.3 with the host certificate pinned by fingerprint; joining needs the code **and** admin approval.
- Passwords never leave the device (Argon2id). Direct messages are end-to-end encrypted (X25519 + AES-256-GCM); the host only stores ciphertext.
- Every request is authorised on the host: roles, reporting chain, resource ownership. See [SECURITY_REPORT.md](SECURITY_REPORT.md).

> **Turn on BitLocker (Windows) or FileVault (Mac) on the host computer.** Group chats, tasks, records and files are protected by the app but stored unencrypted on the host's disk. Anyone who can log in to that computer or take its drive could read them. Windows: *Settings, Privacy & security, Device encryption* (or *Control Panel, BitLocker Drive Encryption*) for the drive that holds the storage folder.

> **The installers are not code-signed yet.** Windows SmartScreen ("Windows protected your PC") and macOS Gatekeeper ("unidentified developer") warn on first run. Removing the warnings needs a paid code-signing certificate (Windows) and an Apple Developer ID with notarization (Mac). Until then: Windows *More info, Run anyway*; Mac *right-click, Open*. Only download from this repository's Releases page.

## Tested

| Test | Result |
|---|---|
| API and security tests against a real host | 147 / 147 passed |
| Internal penetration test (auth bypass, IDOR, traversal, smuggling, prototype pollution, TLS downgrade, WebSocket abuse, races, revoked-link replay, brute force) | 56 / 56 attacks blocked |
| UI end-to-end with a real host app and member app (setup, join, chat, voice, search, seen, files, tasks, remote profiles, profile photo, work report, Excel/PDF export, network check, restarts and auto-reconnect) | 52 / 52 passed |
| 15 people at once for 60 s + five 40 MB uploads | 1,989 requests, 0 errors; 9,296 / 9,296 live deliveries, median 1 ms; host memory 72-81 MB |
| 12 months of data (41 people, 300,000 messages, 25,000 tasks, 20,000 files) | every screen under 200 ms; host starts in 84 ms |
| Real 2.9 GiB (3.11 GB) LLM model file through the apps | upload 122 MB/s, download 306 MB/s, byte-identical (1 GB in about 8 s; on Wi-Fi the network is the limit) |
| Semgrep SAST, secret scan, npm audit | no open issues in shipped code (details in the security report) |

All tests run on one Windows PC with two app instances; real multi-computer Wi-Fi and the Mac build are covered by the CI workflow and need a real-world pilot. No external company has audited the app.

## Build from source

```bash
npm install
npm start                 # development run
npm run typecheck
npm run test:server       # API + security tests
npm run test:pentest      # internal penetration test
npm run test:load         # 15-user + 12-month data tests
node build.mjs --dev && node tests/e2e.mjs   # UI end-to-end (Windows)
npm run dist:win          # Windows installer -> release/
npm run dist:mac          # Mac DMGs (on macOS)
```

Pushing a tag like `v1.2.0` runs `.github/workflows/build.yml`, which builds Windows and Mac on clean machines and publishes a Release.

Stack: Electron 45 (Node 24, Chromium 156), React 19, TypeScript, esbuild, SQLite built into Node (`node:sqlite`, no native modules), `ws`, `hash-wasm`.

---
Manage with Bunny · Copyright © 2026 Bunnys Framelab. All rights reserved.
