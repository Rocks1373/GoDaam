# GoDam Warehouse System

Full-stack warehouse operations: web admin, APIs, and mobile field app.

## Modules

- **Admin panel** — users, roles, carriers, vendors, maintenance  
- **Main Stock** — source of truth, inbound/outbound tabs, comparison report  
- **Stock By Rack (FIFO)** — rack inventory and picking flows  
- **Outbound upload** — orders and allocation  
- **Delivery Note** — DN workflow, transport, deliver-to  
- **Mobile app** — React Native (Expo) under `godam-mobile/` (warehouse companion)

## Tech stack

- **Backend:** Node.js + Express + SQLite  
- **Frontend:** React + Vite + Tailwind  
- **Mobile:** React Native (Expo)

## Prerequisites

- Node.js 18+  
- npm  

Do **not** commit `.env` files or production databases. Copy `.env.example` where provided and set secrets locally.

## Run from repo root (web + API)

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3001  
- Frontend UI: http://localhost:5173  

## Run backend only

```bash
cd backend
npm install
npm run dev
```

## Run frontend only

```bash
cd frontend
npm install
npm run dev
```

## Mobile app (Expo)

### Setup Android Emulator

1. **Open Android Studio**.
2. Go to **Tools -> Device Manager**.
3. Click **Create Device**, select a device (e.g., Pixel 8), and download/select a system image (e.g., API 34).
4. Once created, click the **Play** button to start the emulator.

### Run the app

```bash
cd godam-mobile
npm install
npx expo start
```

Press **a** to open on the Android emulator.

Configure API base URL via the mobile app’s env / config (see `godam-mobile/.env.example`).

## Project layout

```
├── backend/        # Express API + SQLite (DB file created locally; gitignored)
├── frontend/       # Vite + React admin UI
├── godam-mobile/   # Expo React Native app
├── dev.sh          # Optional: kill ports + npm run dev
└── package.json    # Root workspaces (backend + frontend)
```

## Security

- Never push `.env` or secrets.  
- Keep `JWT_SECRET`, DB paths, and credentials in environment variables.  
- `*.db` / `*.sqlite` are ignored by Git by default.

## Publish to GitHub

1. Create an empty repo named **`godam-warehouse-system`** (no README/license on GitHub).  
2. Replace `YOUR_USERNAME` with your GitHub username or org:

```bash
git remote add origin https://github.com/YOUR_USERNAME/godam-warehouse-system.git
git branch -M main
git push -u origin main
```

If HTTPS asks for a password, use a **Personal Access Token** (GitHub → Settings → Developer settings → PAT), not your account password.

Alternatively, with GitHub CLI after `gh auth login`:

```bash
gh repo create godam-warehouse-system --private --source=. --remote=origin --push
```
