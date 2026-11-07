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
- Private file storage: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`\n- Private file storage: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`

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

The Black Glass UI loads real conversation history, creates direct chats from username search, sends persisted text messages, receives live updates, includes group creation and filters, and supports image/document attachments. Attachments use a private Supabase Storage bucket and short-lived signed download URLs. Message editing/deletion, delivery/read receipts, calls, and end-to-end encryption remain future work.

## Stage 4 — images and file attachments

Create a **private** bucket in Supabase Storage (default name `iufye-attachments`), then configure `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET` in the server environment. Never expose the service-role key to the browser or commit it. Apply `db/attachments-schema.sql` after the account and chat migrations.

The authenticated `POST /api/chats/:conversationId/attachments` endpoint accepts JPG, PNG, WEBP, GIF, PDF, and TXT files up to 15 MB. It checks conversation membership, validates supported file signatures, uploads to private storage, records attachment metadata in PostgreSQL, and returns a signed URL valid for one hour. History requests create fresh signed URLs.

## Deployment order for the staged PRs

1. Merge Stage 1 account foundation.
2. Merge Stage 2 persistent chats.
3. Merge Stage 3 group creation UI.
4. Merge Stage 4 attachments.
5. Apply `db/schema.sql`, then `db/chat-schema.sql`, then `db/attachments-schema.sql` to PostgreSQL.
6. Configure OTP and private Supabase Storage environment variables, then deploy and test with at least two accounts.

## Current milestone

- PostgreSQL-backed accounts, profiles, direct/group conversations, and persistent messages (after migrations)
- Username search, live Socket.IO chat updates, group creation, and conversation filters
- Private image/document attachment upload and signed downloads (after storage setup)

## Not implemented yet

The code is not production-ready until all required database migrations are applied, OTP delivery and private storage are configured, and the app is deployed and tested with multiple accounts. Calls, message editing/deletion, delivery/read receipts, and end-to-end encryption are not implemented. Do not use this prototype for private or sensitive communication.
