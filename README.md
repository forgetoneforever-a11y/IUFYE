# IUFYE

IUFYE is a dark, mobile-first messenger interface. This first milestone establishes the React + TypeScript frontend, Express server, Socket.IO transport foundation, PostgreSQL connection check, and Render-ready deployment.

## Local development

```bash
npm install
npm run dev
```

The Vite app runs at http://localhost:5173. Start the API and Socket.IO server separately with `npm run server` on port 3000.

## Production

```bash
npm install
npm start
```

Render settings:
- Build command: `npm install && npm run build`
- Start command: `node server.js`
- Optional environment variable: `DATABASE_URL` (Render PostgreSQL internal URL when the web service and database are in the same region)

Health endpoint: `/api/health`

## Stage 1 — account and profile foundation

A PostgreSQL schema draft is available at `db/schema.sql`. It defines:
- `users`: verified email/phone identity fields and unique case-insensitive usernames
- `profiles`: display name, avatar URL, bio, and status text
- `auth_challenges`: expiring one-time verification challenges with attempt counters
- `sessions`: hashed session-token storage with expiry and revocation
- `contacts`: user contact relationships

Apply the schema to a PostgreSQL database before enabling account API routes. The schema alone does not activate registration, send verification codes, or create a production-ready authentication flow. Email/SMS delivery providers and their environment variables still need to be configured.

## Current milestone

- Responsive dark glass messenger layout
- Chat list, search, sample conversations and profile panels
- Local demo message composition
- Express health endpoint and Socket.IO connection foundation
- Optional PostgreSQL connectivity check

## Not implemented yet

Real user authentication, persistent messages, file uploads, calls, and end-to-end encryption are not implemented. The visible conversations are demo data; do not use this prototype for private or sensitive communication.
