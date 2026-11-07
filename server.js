import "dotenv/config";
import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import pg from "pg";
import {
  createHash, createHmac, randomBytes, randomInt, timingSafeEqual
} from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const allowedOrigins = (process.env.APP_ORIGINS || "").split(",").map(v => v.trim()).filter(Boolean);
const corsOrigin = (origin, callback) => {
  if (!origin) return callback(null, true);
  if (allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Origin is not allowed"));
};
const io = new Server(server, { cors: { origin: corsOrigin, credentials: true } });
const PORT = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
  : null;

app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  next();
});

const authSecret = process.env.AUTH_SECRET || "";
const challengeMinutes = 10;
const sessionDays = 30;
const rateBuckets = new Map();

function apiError(res, status, message) {
  return res.status(status).json({ ok: false, error: message });
}
function requireDatabase(res) {
  if (!pool) {
    apiError(res, 503, "Аккаунты пока не настроены. Серверу нужна DATABASE_URL.");
    return false;
  }
  if (authSecret.length < 32) {
    apiError(res, 503, "Сервер авторизации ещё не настроен.");
    return false;
  }
  return true;
}
function normalizeIdentity(channel, value) {
  if (typeof value !== "string") return null;
  const normalized = channel === "email" ? value.trim().toLowerCase() : value.trim();
  if (channel === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && normalized.length <= 254 ? normalized : null;
  return /^\+[1-9]\d{7,14}$/.test(normalized) ? normalized : null;
}
function normalizeUsername(value) {
  if (typeof value !== "string") return null;
  const username = value.trim().replace(/^@/, "");
  return /^[A-Za-z0-9_]{4,32}$/.test(username) ? username : null;
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function codeDigest(code) {
  return createHmac("sha256", authSecret).update(code).digest("hex");
}
function safeEqualHex(a, b) {
  if (!/^[a-f0-9]{64}$/i.test(a || "") || !/^[a-f0-9]{64}$/i.test(b || "")) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const item = rateBuckets.get(key);
  if (!item || item.until <= now) {
    rateBuckets.set(key, { count: 1, until: now + windowMs });
    return true;
  }
  if (item.count >= max) return false;
  item.count += 1;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, item] of rateBuckets) if (item.until <= now) rateBuckets.delete(key);
}, 60000).unref();

async function sendEmailCode(to, code) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) throw new Error("Email delivery is not configured");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: [to],
      subject: "Код подтверждения IUFYE",
      text: `Код подтверждения IUFYE: ${code}. Он действует 10 минут. Никому не сообщайте этот код.`
    })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
}
async function sendSmsCode(to, code) {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
  if (!sid || !token || !from) throw new Error("SMS delivery is not configured");
  const body = new URLSearchParams({ To: to, From: from, Body: `IUFYE: ${code}. Код действует 10 минут. Никому его не сообщайте.` });
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!response.ok) throw new Error(`SMS provider returned ${response.status}`);
}

async function authenticate(req, res, next) {
  if (!pool || authSecret.length < 32) return apiError(res, 503, "Авторизация не настроена.");
  const header = req.get("authorization") || "";
  const cookieToken = (req.headers.cookie || "").split(";").map(part => part.trim()).find(part => part.startsWith("iufye_session="))?.slice("iufye_session=".length) || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : cookieToken;
  if (token.length < 32 || token.length > 256) return apiError(res, 401, "Нужно войти в аккаунт.");
  try {
    const result = await pool.query(
      `SELECT u.id, u.email, u.phone_e164, u.username, u.status,
              p.display_name, p.bio, p.avatar_url, p.status_text
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL
         AND s.expires_at > NOW() AND u.status = 'active' LIMIT 1`,
      [digest(token)]
    );
    if (!result.rowCount) return apiError(res, 401, "Сессия истекла. Войдите снова.");
    req.user = result.rows[0];
    req.sessionTokenHash = digest(token);
    next();
  } catch (error) {
    console.error("[IUFYE] Session lookup failed:", error.message);
    apiError(res, 500, "Не удалось проверить сессию.");
  }
}

app.get("/api/health", async (_req, res) => {
  let database = "not_configured";
  if (pool) {
    try { await pool.query("SELECT 1"); database = "connected"; }
    catch { database = "error"; }
  }
  res.json({ ok: true, app: "IUFYE", database, authConfigured: Boolean(authSecret.length >= 32), timestamp: new Date().toISOString() });
});

app.post("/api/auth/request-code", async (req, res) => {
  if (!requireDatabase(res)) return;
  const channel = req.body?.channel;
  if (channel !== "email" && channel !== "phone") return apiError(res, 400, "Выберите почту или телефон.");
  const destination = normalizeIdentity(channel, req.body?.destination);
  if (!destination) return apiError(res, 400, channel === "email" ? "Проверьте адрес почты." : "Укажите телефон в международном формате, например +31612345678.");
  const ip = req.ip || "unknown";
  if (!rateLimit(`ip:${ip}`, 8, 15 * 60 * 1000) || !rateLimit(`dest:${destination}`, 4, 60 * 60 * 1000)) {
    return apiError(res, 429, "Слишком много запросов. Попробуйте позже.");
  }
  try {
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    if (channel === "email") await sendEmailCode(destination, code);
    else await sendSmsCode(destination, code);
    await pool.query(
      `UPDATE auth_challenges SET consumed_at = NOW()
       WHERE destination = $1 AND consumed_at IS NULL`,
      [destination]
    );
    await pool.query(
      `INSERT INTO auth_challenges (channel, destination, code_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '${challengeMinutes} minutes')`,
      [channel, destination, codeDigest(code)]
    );
    return res.json({ ok: true, message: "Если адрес или номер можно использовать, код отправлен.", expiresInSeconds: challengeMinutes * 60 });
  } catch (error) {
    console.error("[IUFYE] Verification delivery failed:", error.message);
    return apiError(res, 503, "Не удалось отправить код. Проверьте настройки доставки.");
  }
});

app.post("/api/auth/verify-code", async (req, res) => {
  if (!requireDatabase(res)) return;
  const channel = req.body?.channel;
  const destination = normalizeIdentity(channel, req.body?.destination);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  const requestedUsername = req.body?.username ? normalizeUsername(req.body.username) : null;
  if (!destination || !/^\d{6}$/.test(code)) return apiError(res, 400, "Проверьте данные и шестизначный код.");
  if (req.body?.username && !requestedUsername) return apiError(res, 400, "Username: 4–32 символа, латинские буквы, цифры или _.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const challengeResult = await client.query(
      `SELECT id, code_hash, attempts FROM auth_challenges
       WHERE channel = $1 AND destination = $2 AND consumed_at IS NULL
         AND expires_at > NOW() AND attempts < 5
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [channel, destination]
    );
    if (!challengeResult.rowCount) {
      await client.query("ROLLBACK");
      return apiError(res, 400, "Код не найден или срок его действия истёк. Запросите новый.");
    }
    const challenge = challengeResult.rows[0];
    if (!safeEqualHex(challenge.code_hash, codeDigest(code))) {
      await client.query("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = $1", [challenge.id]);
      await client.query("COMMIT");
      return apiError(res, 400, "Неверный код.");
    }
    await client.query("UPDATE auth_challenges SET consumed_at = NOW() WHERE id = $1", [challenge.id]);
    const identityColumn = channel === "email" ? "email" : "phone_e164";
    const verifiedColumn = channel === "email" ? "email_verified_at" : "phone_verified_at";
    let userResult = await client.query(`SELECT * FROM users WHERE ${identityColumn} = $1 LIMIT 1`, [destination]);
    let user;
    if (userResult.rowCount) {
      user = userResult.rows[0];
      await client.query(`UPDATE users SET ${verifiedColumn} = COALESCE(${verifiedColumn}, NOW()) WHERE id = $1`, [user.id]);
    } else {
      if (!requestedUsername) {
        await client.query("ROLLBACK");
        return apiError(res, 409, "Код подтверждён. Для завершения регистрации выберите username и отправьте код ещё раз.");
      }
      const insert = await client.query(
        `INSERT INTO users (${identityColumn}, username, ${verifiedColumn})
         VALUES ($1, $2, NOW()) RETURNING *`,
        [destination, requestedUsername]
      );
      user = insert.rows[0];
      await client.query("INSERT INTO profiles (user_id, display_name) VALUES ($1, $2)", [user.id, requestedUsername]);
    }
    const token = randomBytes(32).toString("base64url");
    await client.query(
      "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '30 days')",
      [user.id, digest(token)]
    );
    const profileResult = await client.query("SELECT display_name, bio, avatar_url, status_text FROM profiles WHERE user_id = $1", [user.id]);
    await client.query("COMMIT");
    const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `iufye_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secureCookie}`);
    return res.json({
      ok: true,
      user: {
        id: user.id,
        email: user.email,
        phone: user.phone_e164,
        username: user.username,
        ...profileResult.rows[0]
      }
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") return apiError(res, 409, "Этот username или способ входа уже занят. Выберите другой username.");
    console.error("[IUFYE] Code verification failed:", error.message);
    return apiError(res, 500, "Не удалось завершить вход.");
  } finally {
    client.release();
  }
});

app.get("/api/me", authenticate, (req, res) => res.json({ ok: true, user: req.user }));

app.patch("/api/profile", authenticate, async (req, res) => {
  const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
  const bio = typeof req.body?.bio === "string" ? req.body.bio.trim() : "";
  const statusText = typeof req.body?.statusText === "string" ? req.body.statusText.trim() : "";
  if (displayName.length > 64 || bio.length > 160 || statusText.length > 80) return apiError(res, 400, "Слишком длинный текст профиля.");
  try {
    await pool.query(
      `INSERT INTO profiles (user_id, display_name, bio, status_text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name,
         bio = EXCLUDED.bio, status_text = EXCLUDED.status_text`,
      [req.user.id, displayName, bio, statusText]
    );
    const result = await pool.query("SELECT display_name, bio, avatar_url, status_text FROM profiles WHERE user_id = $1", [req.user.id]);
    res.json({ ok: true, profile: result.rows[0] });
  } catch (error) {
    console.error("[IUFYE] Profile update failed:", error.message);
    apiError(res, 500, "Не удалось сохранить профиль.");
  }
});

app.get("/api/users/search", authenticate, async (req, res) => {
  const raw = typeof req.query.username === "string" ? req.query.username.trim().replace(/^@/, "") : "";
  if (!/^[A-Za-z0-9_]{2,32}$/.test(raw)) return apiError(res, 400, "Введите username для поиска.");
  try {
    const result = await pool.query(
      `SELECT u.id, u.username, p.display_name, p.avatar_url, p.status_text
       FROM users u LEFT JOIN profiles p ON p.user_id = u.id
       WHERE u.status = 'active' AND u.id <> $1 AND lower(u.username) LIKE lower($2)
       ORDER BY lower(u.username) LIMIT 20`,
      [req.user.id, `${raw}%`]
    );
    res.json({ ok: true, users: result.rows });
  } catch (error) {
    console.error("[IUFYE] User search failed:", error.message);
    apiError(res, 500, "Поиск временно недоступен.");
  }
});

app.post("/api/auth/logout", authenticate, async (req, res) => {
  try {
    await pool.query("UPDATE sessions SET revoked_at = NOW() WHERE token_hash = $1", [req.sessionTokenHash]);
    const secureCookie = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `iufye_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureCookie}`);
    res.json({ ok: true });
  } catch (error) {
    console.error("[IUFYE] Logout failed:", error.message);
    apiError(res, 500, "Не удалось завершить сессию.");
  }
});

// The current chat UI is still a local demo. Real-time chat rooms are deliberately
// not exposed until authenticated membership checks and persistent messages ship.
io.on("connection", socket => socket.emit("iufye:ready", { connected: true }));

app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
server.listen(PORT, "0.0.0.0", () => console.log(`[IUFYE] Server listening on ${PORT}`));

process.on("SIGTERM", async () => {
  if (pool) await pool.end().catch(() => {});
  server.close(() => process.exit(0));
});
