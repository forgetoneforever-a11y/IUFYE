# IUFYE

IUFYE is a dark, mobile-first messenger interface. The project currently contains a React + TypeScript frontend, Express server, Socket.IO transport foundation, and PostgreSQL-backed account API foundation.

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
- Required for account API: `DATABASE_URL`, `AUTH_SECRET`
- Email delivery: `RESEND_API_KEY`, `EMAIL_FROM`
- SMS delivery: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`
- Optional Socket.IO cross-origin allowlist: `APP_ORIGINS` (comma-separated exact origins)

Copy `.env.example` as a reference. Never commit real secrets or send database credentials in chat. Use a verified sender domain for Resend and a properly configured Twilio sender for SMS. If a delivery provider is not configured, that channel returns a setup error; no verification code is exposed to the browser or written to logs.

Health endpoint: `/api/health`

## Stage 1 — accounts and profiles

Before enabling account endpoints, apply `db/schema.sql` once to the Render PostgreSQL database. The schema creates:
- `users`: email/phone identity, verified status, and unique case-insensitive usernames
- `profiles`: display name, avatar URL, bio, and status text
- `auth_challenges`: expiring one-time codes with attempt counters
- `sessions`: hashed session-token storage with expiry and revocation
- `contacts`: contact relationships

Account API:
- `POST /api/auth/request-code` — request an email or SMS code; JSON: `{ "channel": "email" | "phone", "destination": "..." }`
- `POST /api/auth/verify-code` — verify code and create a session; JSON: `{ "channel", "destination", "code", "username?" }`. A new user must provide a username.
- `GET /api/me` — current account; requires the HttpOnly session cookie
- `PATCH /api/profile` — update `displayName`, `bio`, and `statusText`; requires an active session
- `GET /api/users/search?username=...` — search public usernames; requires an active session
- `POST /api/auth/logout` — revoke the current session and clear the cookie; requires an active session

Security notes:
- Codes are six digits, expire after 10 minutes, are single-use, and are limited to five verification attempts.
- Request limits are applied per IP and destination in each server process.
- Only hashes of session tokens and keyed hashes of verification codes are stored. The browser session is held in an HttpOnly, SameSite=Lax cookie (Secure in production).
- Authentication is unavailable until PostgreSQL, `AUTH_SECRET`, and the selected delivery provider are configured.
- Use HTTPS in production. Configure `APP_ORIGINS` for any separate frontend origin.

## Stage 2 — persistent chats and live messages

After applying `db/schema.sql`, apply `db/chat-schema.sql` to the same PostgreSQL database.

Added API:
- `GET /api/chats` — list conversations for the signed-in user
- `POST /api/chats/direct` — create or open a direct conversation; JSON: `{ "username": "someone" }`
- `POST /api/chats/group` — create a group; JSON: `{ "title": "Project", "usernames": ["person_one", "person_two"] }`
- `GET /api/chats/:conversationId/messages` — latest 50 messages (optional ISO `before` query)
- `POST /api/chats/:conversationId/messages` — persist and broadcast a text message; JSON: `{ "body": "Hello" }`

Socket.IO:
- The handshake is authenticated using the HttpOnly session cookie.
- `chat:join` checks that the signed-in user belongs to the conversation before joining its room.
- `chat:leave` leaves a room; `chat:typing` is broadcast only to authorized conversation members.
- New messages are inserted through the authenticated REST endpoint and then broadcast to authorized room members.

The Black Glass UI now loads real conversation history, creates direct chats from username search, sends persisted text messages, and receives live updates. File uploads, group creation controls, message editing/deletion, delivery/read receipts, calls, and end-to-end encryption are still future work.

## Deployment order for the staged PRs

1. Merge Stage 1 account foundation first.
2. Merge Stage 2 persistent chat second.
3. Apply `db/schema.sql`, then `db/chat-schema.sql` to PostgreSQL.
4. Configure the environment variables described above and deploy the app.

## Current milestone

- Responsive dark glass messenger layout
- Demo chat list, local search, sample conversations and profile panels
- PostgreSQL account schema and OTP/session/profile/search API foundation
- Express health endpoint

## Not implemented yet

The current React chat UI is still demo-only and is not connected to the new account API. Messages are not persisted or synchronized. Real-time chat membership checks, file uploads, calls, and end-to-end encryption are not implemented. Do not use this prototype for private or sensitive communication.
