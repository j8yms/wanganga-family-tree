# Wang'ang'a Family Tree

An interactive, crowdsourced family tree for the Gīkũyũ Wang'ang'a family.

- **Frontend:** Single-page app with D3.js tree visualization (`index.html`, `styles.css`, `app.js`)
- **Backend:** Google Apps Script API (`Code.gs`) over a Google Sheets database
- **Photos:** App-uploaded portraits stored in a public Google Drive folder
- **Hosting:** Free GitHub Pages static hosting + Apps Script web app for the API

## Features

- Interactive D3 tree with zoom/pan, spouse clusters, and expand/collapse branches
- Radial action menu: add parents, spouses, children, siblings; link/unlink; edit; delete
- Onboarding (`?onboard=1`) lets relatives search their name and claim or create a profile
- Circular photo crop tool with drag + zoom
- Ownership-based editing: records are only editable by their creator unless admin unlocks

## Quick Start

See [SETUP.md](SETUP.md) for full deployment steps. The short version:

1. **Backend:** Create a Google Sheet → Extensions > Apps Script → paste `Code.gs` →
   redact the spreadsheet ID & set `SUPERADMIN_TOKEN` via Script Properties →
   Deploy as Web App (Anyone access).
2. **Frontend:** Put your deployed `https://script.google.com/.../exec` URL in
   `app.js` (line 4) and `scripts/config.js`, then push the repo to GitHub and
   enable Pages.

## Project Structure

```
├── index.html          Frontend HTML (structure only)
├── styles.css          Frontend CSS
├── app.js              Frontend JavaScript
├── Code.gs             Google Apps Script backend API
├── SETUP.md            Deployment + admin guide
├── scripts/
│   ├── config.js       API URL (single source of truth)
│   ├── api.js          Shared fetch helpers for seed scripts
│   ├── seed_persons.js / seed_persons.ps1
│   ├── seed_relationships.js
│   ├── seed_spouses.js
│   └── dedupe.js
└── person_ids.json     Generated seed output (git-ignored)
```