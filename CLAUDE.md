# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## About This Repository

Full-stack dashboard application for Nuvo (nuvo.co.il). Combines a Node.js web server, HTML dashboards, a Word-document generation pipeline ("docpack"), and Python data-import scripts that pull product/pricing data from vendors (Hikvision, Avigilon).

## Tech Stack

- **Runtime**: Node.js 20.x (see [package.json](package.json))
- **Server**: Express with helmet, rate limiting, JWT auth, bcrypt — entry point [server.js](server.js)
- **Database**: SQLite via [db.js](db.js)
- **Word export**: docxtemplater pipeline in [docpack.js](docpack.js); templates under `templates/`
- **Data import**: Python scripts at repo root (Hikvision/Avigilon scrapers, price fixers, batch downloaders)
- **Deployment**: [render.yaml](render.yaml) (Render.com)

## Major Components

- **HTML dashboards**: `dashboard.html`, `admin.html`, `landing.html`, `login.html` — served as static files by `server.js`
- **Auth & API**: `server.js` handles login, JWT issuance, datasheet routes, doc-pack generation endpoints
- **Doc-pack export**: `docpack.js` + `templates/*.docx` — generates Word datasheets with RTL support for Hebrew/Google Docs
- **Data layer**: `ds/` holds vendor PDF datasheets (git-committed fallback); `data/` (gitignored) holds runtime DB and uploads
- **Python import scripts**: at repo root — `build_avigilon.py`, `download_hik_batch*.py`, `fix_hik_prices.py`, etc.

## Dev Server

```
npm run dev      # node server.js, default port 3000
$env:PORT=3001; npm run dev   # override port (useful for parallel worktrees)
```

Required env vars in production: `JWT_SECRET`, `SMTP_USER`, `SMTP_PASS`. Optional: `PORT`, `DS_PATH`, `STATIC_DIR`, `APP_URL`.

## Conventions

- Open an issue before submitting a pull request to discuss proposed changes.
- Branch names follow the pattern `<type>/<short-description>` (e.g., `fix/readme-typo`, `feat/sheets-import`).
- For parallel feature work, prefer `git worktree add` over branch-switching in the main folder — see `C:\Users\robi_\.claude\plans\misty-herding-puddle.md` for the workflow.
