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
  if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return callback(null, true);
  return callback(new Error("Origin is not allowed"));
};
const io = new Server(server, {
  cors: { origin: corsOrigin, credentials: true },
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    if (allowedOrigins.length) return callback(null, allowedOrigins.includes(origin));
    try { return callback(null, new URL(origin).host === req.headers.host); }
    catch { return callback(null, false); }
  }
});
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


function validUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function readCookie(header, name) {
  const prefix = `${name}=`;
  return (header || "").split(";").map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length) || "";
}
async function requireConversationMember(userId, conversationId) {
  if (!validUuid(conversationId)) return false;
  const result = await pool.query(
    "SELECT 1 FROM conversation_members WHERE user_id = $1 AND conversation_id = $2",
    [userId, conversationId]
  );
  return result.rowCount > 0;
}

const attachmentBucket = process.env.SUPABASE_STORAGE_BUCKET || "iufye-attachments";
const maxAttachmentBytes = 15 * 1024 * 1024;
const allowedAttachmentTypes = new Map([["image/jpeg","jpg"],["image/png","png"],["image/webp","webp"],["image/gif","gif"],["application/pdf","pdf"],["text/plain","txt"]]);
function storageConfig(){const base=(process.env.SUPABASE_URL||"").replace(/\/$/,"");const key=process.env.SUPABASE_SERVICE_ROLE_KEY||"";if(!base||!key)throw new Error("Supabase Storage is not configured");return {base,key};}
function storageObjectUrl(base,objectPath,signed=false){const encoded=objectPath.split("/").map(encodeURIComponent).join("/");return base+"/storage/v1/object/"+(signed?"sign/":"")+encodeURIComponent(attachmentBucket)+"/"+encoded;}
async function signedAttachmentUrl(objectPath){const {base,key}=storageConfig();const response=await fetch(storageObjectUrl(base,objectPath,true),{method:"POST",headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":"application/json"},body:JSON.stringify({expiresIn:3600})});if(!response.ok)throw new Error("Storage signed URL failed: "+response.status);const data=await response.json();return data.signedURL.startsWith("http")?data.signedURL:base+"/storage/v1"+data.signedURL;}
function validAttachmentBytes(buffer,mime){if(mime==="image/jpeg")return buffer.length>3&&buffer[0]===255&&buffer[1]===216&&buffer[2]===255;if(mime==="image/png")return buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));if(mime==="image/gif")return buffer.subarray(0,6).toString("ascii").startsWith("GIF8");if(mime==="image/webp")return buffer.length>12&&buffer.toString("ascii",0,4)==="RIFF"&&buffer.toString("ascii",8,12)==="WEBP";if(mime==="application/pdf")return buffer.subarray(0,5).toString("ascii")==="%PDF-";if(mime==="text/plain")return !buffer.includes(0);return false;}

app.get("/api/chats", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.id, c.type, c.title, c.updated_at,
              CASE WHEN lm.message_type IN ('image','file') THEN '📎 ' || lm.attachment_name ELSE lm.body END AS last_message, lm.created_at AS last_message_at,
              CASE WHEN c.type = 'direct' THEN COALESCE(peer.display_name, peer.username) ELSE c.title END AS display_title,
              CASE WHEN c.type = 'direct' THEN peer.username ELSE NULL END AS peer_username,
              (SELECT COUNT(*)::int FROM messages unread
               WHERE unread.conversation_id = c.id AND unread.sender_id <> $1
                 AND unread.created_at > mine.last_read_at AND unread.deleted_at IS NULL) AS unread_count
       FROM conversations c
       JOIN conversation_members mine ON mine.conversation_id = c.id AND mine.user_id = $1
       LEFT JOIN LATERAL (
         SELECT m.body, m.created_at, m.message_type, m.attachment_name FROM messages m
         WHERE m.conversation_id = c.id AND m.deleted_at IS NULL
         ORDER BY m.created_at DESC, m.id DESC LIMIT 1
       ) lm ON TRUE
       LEFT JOIN LATERAL (
         SELECT u.username, p.display_name FROM conversation_members other
         JOIN users u ON u.id = other.user_id
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE other.conversation_id = c.id AND other.user_id <> $1
         ORDER BY other.joined_at LIMIT 1
       ) peer ON c.type = 'direct'
       ORDER BY COALESCE(lm.created_at, c.updated_at) DESC LIMIT 100`,
      [req.user.id]
    );
    res.json({ ok: true, chats: result.rows });
  } catch (error) {
    console.error("[IUFYE] Chat list failed:", error.message);
    apiError(res, 500, "Не удалось загрузить список чатов.");
  }
});

app.post("/api/chats/direct", authenticate, async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  if (!username) return apiError(res, 400, "Укажите корректный username.");
  try {
    const targetResult = await pool.query(
      "SELECT id FROM users WHERE lower(username) = lower($1) AND status = 'active' LIMIT 1",
      [username]
    );
    if (!targetResult.rowCount) return apiError(res, 404, "Пользователь не найден.");
    const targetId = targetResult.rows[0].id;
    if (targetId === req.user.id) return apiError(res, 400, "Нельзя создать личный чат с самим собой.");
    const directKey = [req.user.id, targetId].sort().join(":");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const conversation = await client.query(
        `INSERT INTO conversations (type, direct_key, created_by)
         VALUES ('direct', $1, $2)
         ON CONFLICT (direct_key) WHERE direct_key IS NOT NULL
         DO UPDATE SET updated_at = conversations.updated_at
         RETURNING id`,
        [directKey, req.user.id]
      );
      const conversationId = conversation.rows[0].id;
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id)
         VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
        [conversationId, req.user.id, targetId]
      );
      await client.query("COMMIT");
      res.json({ ok: true, conversationId });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  } catch (error) {
    console.error("[IUFYE] Direct chat creation failed:", error.message);
    apiError(res, 500, "Не удалось создать чат.");
  }
});

app.post("/api/chats/group", authenticate, async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const names = Array.isArray(req.body?.usernames) ? req.body.usernames : [];
  if (title.length < 2 || title.length > 80 || names.length < 1 || names.length > 49) {
    return apiError(res, 400, "Укажите название группы и от 1 до 49 участников.");
  }
  const usernames = [...new Set(names.map(normalizeUsername).filter(Boolean))];
  if (usernames.length !== names.length) return apiError(res, 400, "Проверьте usernames участников.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const users = await client.query(
      "SELECT id FROM users WHERE lower(username) = ANY($1::text[]) AND status = 'active'",
      [usernames.map(v => v.toLowerCase())]
    );
    if (users.rowCount !== usernames.length) {
      await client.query("ROLLBACK");
      return apiError(res, 404, "Один или несколько участников не найдены.");
    }
    const conversation = await client.query(
      "INSERT INTO conversations (type, title, created_by) VALUES ('group', $1, $2) RETURNING id",
      [title, req.user.id]
    );
    const conversationId = conversation.rows[0].id;
    const members = [...new Set([req.user.id, ...users.rows.map(row => row.id)])];
    for (const userId of members) {
      await client.query(
        "INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, $3)",
        [conversationId, userId, userId === req.user.id ? "owner" : "member"]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ ok: true, conversationId });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[IUFYE] Group chat creation failed:", error.message);
    apiError(res, 500, "Не удалось создать группу.");
  } finally { client.release(); }
});

app.get("/api/chats/:conversationId/messages", authenticate, async (req, res) => {
  const { conversationId } = req.params;
  if (!validUuid(conversationId)) return apiError(res, 400, "Некорректный чат.");
  const before = typeof req.query.before === "string" ? req.query.before : null;
  if (before && Number.isNaN(Date.parse(before))) return apiError(res, 400, "Некорректная дата.");
  try {
    if (!(await requireConversationMember(req.user.id, conversationId))) return apiError(res, 404, "Чат не найден.");
    const result = await pool.query(
      `SELECT m.id, m.conversation_id, m.sender_id, m.body, m.message_type, m.attachment_path, m.attachment_name, m.attachment_mime, m.attachment_size, m.created_at,
              u.username AS sender_username, p.display_name AS sender_display_name
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id
       LEFT JOIN profiles p ON p.user_id = m.sender_id
       WHERE m.conversation_id = $1 AND m.deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR m.created_at < $2::timestamptz)
       ORDER BY m.created_at DESC, m.id DESC LIMIT 50`,
      [conversationId, before]
    );
    await pool.query(
      "UPDATE conversation_members SET last_read_at = NOW() WHERE conversation_id = $1 AND user_id = $2",
      [conversationId, req.user.id]
    );
    const messages = await Promise.all(result.rows.reverse().map(async row => ({...row, attachment_url: row.attachment_path ? await signedAttachmentUrl(row.attachment_path) : null})));
    res.json({ ok: true, messages });
  } catch (error) {
    console.error("[IUFYE] Message history failed:", error.message);
    apiError(res, 500, "Не удалось загрузить сообщения.");
  }
});

app.post("/api/chats/:conversationId/attachments", authenticate, express.raw({type:()=>true,limit:"15mb"}), async (req,res)=>{
  const conversationId=req.params.conversationId;
  if(!validUuid(conversationId))return apiError(res,400,"Некорректный чат.");
  const mime=(req.get("content-type")||"").split(";")[0].trim().toLowerCase();
  const extension=allowedAttachmentTypes.get(mime);
  const buffer=req.body;
  if(!extension)return apiError(res,415,"Поддерживаются JPG, PNG, WEBP, GIF, PDF и TXT.");
  if(!Buffer.isBuffer(buffer)||buffer.length<1||buffer.length>maxAttachmentBytes)return apiError(res,413,"Файл должен быть не больше 15 МБ.");
  if(!validAttachmentBytes(buffer,mime))return apiError(res,415,"Содержимое файла не соответствует его типу.");
  if(!rateLimit("attachment:"+req.user.id,12,10*60*1000))return apiError(res,429,"Слишком много файлов. Попробуйте позже.");
  const requested=typeof req.query.filename==="string"?req.query.filename:"file";
  const filename=requested.replaceAll("/","_").replaceAll("\\","_").replace(/[\x00-\x1f\x7f]/g,"_").trim().slice(0,120)||"file";
  const objectPath=req.user.id+"/"+conversationId+"/"+randomBytes(16).toString("hex")+"."+extension;
  let uploaded=false;
  try{
    if(!(await requireConversationMember(req.user.id,conversationId)))return apiError(res,404,"Чат не найден.");
    const {base,key}=storageConfig();
    const upload=await fetch(storageObjectUrl(base,objectPath),{method:"POST",headers:{apikey:key,Authorization:"Bearer "+key,"Content-Type":mime,"x-upsert":"false","cache-control":"3600"},body:buffer});
    if(!upload.ok){const detail=await upload.text().catch(()=>"");console.error("[IUFYE] Storage upload failed:",upload.status,detail.slice(0,300));return apiError(res,502,"Не удалось сохранить файл в хранилище.");}
    uploaded=true;
    const signedUrl=await signedAttachmentUrl(objectPath);
    const inserted=await pool.query(`INSERT INTO messages (conversation_id,sender_id,body,message_type,attachment_path,attachment_name,attachment_mime,attachment_size) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,conversation_id,sender_id,body,message_type,attachment_path,attachment_name,attachment_mime,attachment_size,created_at`,[conversationId,req.user.id,filename,mime.startsWith("image/")?"image":"file",objectPath,filename,mime,buffer.length]);
    const message={...inserted.rows[0],attachment_url:signedUrl,sender_username:req.user.username,sender_display_name:req.user.display_name};
    io.to("chat:"+conversationId).emit("chat:message",message);
    res.status(201).json({ok:true,message});
  }catch(error){if(uploaded){try{const {base,key}=storageConfig();await fetch(storageObjectUrl(base,objectPath),{method:"DELETE",headers:{apikey:key,Authorization:"Bearer "+key}});}catch{}}console.error("[IUFYE] Attachment upload failed:",error.message);apiError(res,503,"Хранилище файлов не настроено или временно недоступно.");}
});
app.post("/api/chats/:conversationId/messages", authenticate, async (req, res) => {
  const { conversationId } = req.params;
  const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";
  if (!validUuid(conversationId)) return apiError(res, 400, "Некорректный чат.");
  if (!body || body.length > 4000) return apiError(res, 400, "Сообщение должно содержать от 1 до 4000 символов.");
  if (!rateLimit(`message:${req.user.id}`, 30, 10 * 1000)) return apiError(res, 429, "Слишком часто. Подождите немного.");
  try {
    if (!(await requireConversationMember(req.user.id, conversationId))) return apiError(res, 404, "Чат не найден.");
    const result = await pool.query(
      `INSERT INTO messages (conversation_id, sender_id, body)
       VALUES ($1, $2, $3)
       RETURNING id, conversation_id, sender_id, body, created_at`,
      [conversationId, req.user.id, body]
    );
    const message = { ...result.rows[0], sender_username: req.user.username, sender_display_name: req.user.display_name };
    io.to(`chat:${conversationId}`).emit("chat:message", message);
    res.status(201).json({ ok: true, message });
  } catch (error) {
    console.error("[IUFYE] Message send failed:", error.message);
    apiError(res, 500, "Не удалось отправить сообщение.");
  }
});

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

io.use(async (socket, next) => {
  try {
    if (!pool || authSecret.length < 32) return next(new Error("Authentication is unavailable"));
    const token = readCookie(socket.handshake.headers.cookie, "iufye_session");
    if (token.length < 32 || token.length > 256) return next(new Error("Authentication required"));
    const result = await pool.query(
      `SELECT u.id, u.username, p.display_name
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL
         AND s.expires_at > NOW() AND u.status = 'active' LIMIT 1`,
      [digest(token)]
    );
    if (!result.rowCount) return next(new Error("Session expired"));
    socket.data.user = result.rows[0];
    next();
  } catch (error) {
    console.error("[IUFYE] Socket authentication failed:", error.message);
    next(new Error("Authentication failed"));
  }
});

io.on("connection", socket => {
  socket.emit("iufye:ready", { connected: true, userId: socket.data.user.id });

  socket.on("chat:join", async (payload, acknowledge) => {
    const conversationId = payload?.conversationId;
    try {
      if (!(await requireConversationMember(socket.data.user.id, conversationId))) {
        if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Чат не найден." });
        return;
      }
      socket.join(`chat:${conversationId}`);
      if (typeof acknowledge === "function") acknowledge({ ok: true });
    } catch {
      if (typeof acknowledge === "function") acknowledge({ ok: false, error: "Не удалось открыть чат." });
    }
  });

  socket.on("chat:leave", payload => {
    if (validUuid(payload?.conversationId)) socket.leave(`chat:${payload.conversationId}`);
  });

  socket.on("chat:typing", async payload => {
    const conversationId = payload?.conversationId;
    if (!validUuid(conversationId)) return;
    try {
      if (await requireConversationMember(socket.data.user.id, conversationId)) {
        socket.to(`chat:${conversationId}`).emit("chat:typing", {
          conversationId,
          userId: socket.data.user.id,
          username: socket.data.user.username
        });
      }
    } catch {}
  });
});

app.use(express.static(path.join(__dirname, "dist")));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
server.listen(PORT, "0.0.0.0", () => console.log(`[IUFYE] Server listening on ${PORT}`));

process.on("SIGTERM", async () => {
  if (pool) await pool.end().catch(() => {});
  server.close(() => process.exit(0));
});
