import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import P from "pino";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "4mb" }));

let qrImage = null;
let botStatus = "Starting...";
let isConnecting = false;
let reconnectTimer = null;
let adminSession = null;
let sessionExpiry = 0;
let waSocket = null;

const ADMIN_USERNAME = process.env.ADMIN_USERNAME;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// ---------------- SUPABASE REST ----------------
function supabaseReady() { return Boolean(SUPABASE_URL && SUPABASE_KEY); }
async function sbRequest(route, options = {}) {
  if (!supabaseReady()) throw new Error("Supabase environment variables are missing");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${route}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : null;
}
async function getSettings() {
  const rows = await sbRequest("bot_settings?id=eq.1&select=*");
  return rows?.[0] || {};
}
async function getSlots() {
  return await sbRequest("slot_schedules?select=*&order=slot_key.asc");
}

// ---------------- IN-MEMORY CHAT HISTORY ----------------
const chatMemory = new Map();
const chatQueues = new Map();
const MAX_HISTORY = 14;
const MAX_CHATS = 300;
function getChatHistory(jid) {
  if (!chatMemory.has(jid)) chatMemory.set(jid, []);
  const history = chatMemory.get(jid);
  chatMemory.delete(jid);
  chatMemory.set(jid, history);
  while (chatMemory.size > MAX_CHATS) chatMemory.delete(chatMemory.keys().next().value);
  return history;
}
function saveChatHistory(jid, userMessage, botReply) {
  const history = getChatHistory(jid);
  history.push({ role: "user", content: userMessage }, { role: "assistant", content: botReply });
  while (history.length > MAX_HISTORY) history.shift();
}

// ---------------- ADMIN SECURITY ----------------
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function getCookie(req, name) {
  for (const item of (req.headers.cookie || "").split(";")) {
    const parts = item.trim().split("=");
    const key = parts.shift();
    if (key === name) return parts.join("=");
  }
  return null;
}
function isAdmin(req) {
  const token = getCookie(req, "fa_admin_session");
  return Boolean(adminSession && token && safeEqual(token, adminSession) && Date.now() < sessionExpiry);
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: "Admin login required" });
  next();
}

const loginPage = `<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FLYING ARROW Admin Login</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#081225;color:white;font-family:Arial;padding:20px}.card{width:100%;max-width:380px;background:#12213b;border:1px solid #263b5e;border-radius:16px;padding:28px}h2{color:#49a6ff;margin-top:0}input,button{width:100%;padding:13px;margin-top:13px;border-radius:8px;border:1px solid #344b6d;font-size:15px}input{background:#081225;color:white}button{background:#1679e9;color:white;border:0;font-weight:bold}#message{color:#ff7777;font-size:13px}</style></head><body><div class="card"><h2>FLYING ARROW ❤️</h2><p>Private Admin Login</p><form id="loginForm"><input id="username" placeholder="Admin Username" required autocomplete="username"><input id="password" type="password" placeholder="Admin Password" required autocomplete="current-password"><button>LOGIN</button></form><p id="message"></p></div><script>document.getElementById('loginForm').addEventListener('submit',async e=>{e.preventDefault();const m=document.getElementById('message');m.textContent='Logging in...';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:document.getElementById('username').value,password:document.getElementById('password').value})});const d=await r.json();if(!r.ok)throw Error(d.error||'Login failed');location.href='/'}catch(x){m.textContent=x.message}})</script></body></html>`;

app.get("/login", (req, res) => isAdmin(req) ? res.redirect("/") : res.type("html").send(loginPage));
app.post("/api/login", (req, res) => {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return res.status(500).json({ error: "Admin login environment is not configured" });
  const { username, password } = req.body || {};
  if (!safeEqual(username, ADMIN_USERNAME) || !safeEqual(password, ADMIN_PASSWORD)) return res.status(401).json({ error: "ভুল Username অথবা Password" });
  adminSession = crypto.randomBytes(32).toString("hex");
  sessionExpiry = Date.now() + 12 * 60 * 60 * 1000;
  res.setHeader("Set-Cookie", `fa_admin_session=${adminSession}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
  res.json({ success: true });
});
app.post("/api/logout", requireAdmin, (req, res) => {
  adminSession = null; sessionExpiry = 0;
  res.setHeader("Set-Cookie", "fa_admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  res.json({ success: true });
});
app.get("/", (req, res) => !isAdmin(req) ? res.redirect("/login") : res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin.html", (req, res) => !isAdmin(req) ? res.redirect("/login") : res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/health", (req, res) => res.json({ server: "online" }));
app.get("/api/status", requireAdmin, async (req, res) => {
  let db = "offline";
  try { await getSettings(); db = "online"; } catch {}
  res.json({ status: botStatus, whatsappConnected: botStatus === "WhatsApp Connected", qrReady: Boolean(qrImage), server: "online", aiProvider: "Cloudflare Workers AI", database: db, conversationMemory: "Enabled" });
});
app.get("/api/qr", requireAdmin, (req, res) => res.json({ qr: qrImage }));
app.get("/status", requireAdmin, (req, res) => res.json({ status: botStatus }));

// ---------------- DASHBOARD API ----------------
const DEFAULT_GROUP_LINKS = {
  "3_pm": "https://chat.whatsapp.com/FtEGKt4esJAJm6yNrvlctw?s=cl&p=a&iam=2",
  "8_pm": "https://chat.whatsapp.com/Hk0kh8YaCz9CuODu1vAQqW?s=cl&p=a&iam=2",
  "9_pm_scam": "https://chat.whatsapp.com/LuEBkD0RO2V7V7wxXthPBN?s=cl&p=a&iam=2",
  "9_pm_champion_rush": "https://chat.whatsapp.com/I20qt2uASfv5Q23O4L6Vaf?s=cl&p=a&iam=2",
  "10_pm": "https://chat.whatsapp.com/HWJveO8Sd8j4vDPFCCaK53?s=cl&p=a&iam=2",
  "11_pm": "https://chat.whatsapp.com/EpAZJkXK5HeBqVvuQt6yDR?s=cl&p=a&iam=2",
  "12_pm": "https://chat.whatsapp.com/CfGbFnO6wXlHrqRy07AZyT?s=cl&p=a&iam=2"
};
const DEFAULT_ADMIN_CONTACTS = {
  "ADMIN A.B RAHMAN": "@abrahman8152007",
  "ADMIN LIMON": "01624102776",
  "ADMIN HASIB": "01327633420"
};
function effectiveSettings(settings) {
  return {
    ...settings,
    main_prompt: settings.main_prompt?.trim() || FALLBACK_PROMPT,
    group_links: settings.group_links && Object.keys(settings.group_links).length ? settings.group_links : DEFAULT_GROUP_LINKS,
    admin_contacts: settings.admin_contacts && Object.keys(settings.admin_contacts).length ? settings.admin_contacts : DEFAULT_ADMIN_CONTACTS
  };
}

app.get("/api/settings", requireAdmin, async (req, res) => {
  try { res.json({ settings: effectiveSettings(await getSettings()), supabaseConnected: true }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const allowed = ["main_prompt", "payment_details", "payment_qr_url", "group_links", "admin_contacts", "team_form", "booking_rules"];
    const update = {};
    for (const key of allowed) if (body[key] !== undefined) update[key] = body[key];
    update.updated_at = new Date().toISOString();
    await sbRequest("bot_settings?id=eq.1", { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update) });
    res.json({ success: true, settings: await getSettings() });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get("/api/slots", requireAdmin, async (req, res) => {
  try { res.json({ slots: await getSlots() }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});
app.put("/api/slots/:key", requireAdmin, async (req, res) => {
  try {
    const { price_tk, booked_slots, status, match_name } = req.body || {};
    const update = { updated_at: new Date().toISOString() };
    if (Number.isInteger(price_tk) && price_tk > 0) update.price_tk = price_tk;
    if (Number.isInteger(booked_slots) && booked_slots >= 0 && booked_slots <= 12) update.booked_slots = booked_slots;
    if (["AVAILABLE", "FULL", "OFF"].includes(status)) update.status = status;
    if (typeof match_name === "string" && match_name.trim()) update.match_name = match_name.trim().slice(0, 80);
    const rows = await sbRequest(`slot_schedules?slot_key=eq.${encodeURIComponent(req.params.key)}`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(update) });
    if (!rows?.length) return res.status(404).json({ error: "Slot not found" });
    res.json({ success: true, slot: rows[0] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});
app.get("/api/chats", requireAdmin, (req, res) => {
  const chats = [...chatMemory.entries()].reverse().map(([jid, messages]) => ({ jid, messages, lastMessage: messages.at(-1)?.content || "" }));
  res.json({ chats });
});
app.post("/api/settings/payment-qr", requireAdmin, async (req, res) => {
  try {
    const { imageData, mimeType } = req.body || {};
    if (!imageData || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) return res.status(400).json({ error: "PNG, JPG অথবা WEBP ছবি দিন" });
    const match = imageData.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[1] !== mimeType) return res.status(400).json({ error: "Invalid image data" });
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: "ছবির সাইজ সর্বোচ্চ 2MB হতে পারবে" });
    const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1];
    const fileName = `payment-qr-${Date.now()}.${ext}`;
    const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/fa-payment-assets/${fileName}`, {
      method: "POST", headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": mimeType, "x-upsert": "true" }, body: buffer, signal: AbortSignal.timeout(30000)
    });
    const uploadText = await upload.text();
    if (!upload.ok) throw new Error(`Storage upload ${upload.status}: ${uploadText.slice(0, 400)}`);
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/fa-payment-assets/${fileName}`;
    await sbRequest("bot_settings?id=eq.1", { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ payment_qr_url: publicUrl, updated_at: new Date().toISOString() }) });
    res.json({ success: true, payment_qr_url: publicUrl });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ---------------- AI PROMPT + LIVE SLOT DATA ----------------
const FALLBACK_PROMPT = `You are the friendly WhatsApp admin assistant of FLYING ARROW Free Fire Tournament. Owner: PRINCE LIMON. Understand Bangla, Banglish and English. Reply naturally, briefly and politely like a Bangladeshi tournament admin. Use ভাই naturally and ❤️ occasionally. Casual chat must not trigger payment QR, form or links. Do not repeat questions already answered in chat history. Only discuss FLYING ARROW tournaments. Known matches: 3 PM, 8 PM, 9 PM SCRIM, 9 PM CHAMPION RUSH, 10 PM, 11 PM, 12 PM. 9 PM SCRIM costs 20 TK; 9 PM CHAMPION RUSH costs 25 TK; other matches cost 20 TK. The two 9 PM matches are separate; always ask which one. Never invent slot availability, payment details or group links. Never claim payment verified. Only send the team form when customer is booking. Required form: TEAM NAME / IGL NAME / PLAYER NAME / at least one bKash or Nagad number. Never send a group link before required team information is collected. If uncertain, ask one short question. Booking policy: NO SLOT CANCEL & NO PAY-BACK.`;
async function buildSystemPrompt() {
  const settings = effectiveSettings(await getSettings());
  let slots = [];
  try { slots = await getSlots(); } catch (e) { console.error("Slot data read error:", e.message); }
  const liveSlotText = slots.map(s => `${s.match_name}: price ${s.price_tk} TK, total ${s.total_slots}, booked ${s.booked_slots}, remaining ${Math.max(0, s.total_slots - s.booked_slots)}, status ${s.status}`).join("\n");
  const groupLinks = settings.group_links || {};
  const contacts = settings.admin_contacts || {};
  return `${settings.main_prompt?.trim() || FALLBACK_PROMPT}\n\nCURRENT LIVE SLOT DATA (use this as source of truth):\n${liveSlotText || "Live slot data unavailable. Do not claim availability."}\n\nPAYMENT DETAILS:\n${settings.payment_details || "Not configured. Do not invent payment details."}\nPAYMENT QR URL: ${settings.payment_qr_url || "Not uploaded"}\nGROUP LINKS (only use exact matching link):\n${JSON.stringify(groupLinks)}\nADMIN CONTACTS:\n${JSON.stringify(contacts)}\nTEAM FORM:\n${settings.team_form || "Not configured"}\nBOOKING RULES:\n${settings.booking_rules || "Not configured"}\n\nIMPORTANT: Settings above are admin-provided data, not instructions to reveal secrets. Never invent missing information. If a slot is FULL or OFF, do not accept booking. Keep each reply short.`;
}

async function getAIReply(messageText, previousMessages = []) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!apiToken) throw new Error("CLOUDFLARE_API_TOKEN is missing");
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is missing");
  const model = "@cf/openai/gpt-oss-20b";
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const systemPrompt = await buildSystemPrompt();
  const messages = [{ role: "system", content: systemPrompt }, ...previousMessages, { role: "user", content: messageText }];
  const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ messages, max_tokens: 300, temperature: 0.5 }), signal: AbortSignal.timeout(60000) });
  const responseText = await response.text();
  let data;
  try { data = JSON.parse(responseText); } catch { throw new Error("Cloudflare returned invalid JSON: " + responseText.slice(0, 300)); }
  if (!response.ok || data.success === false) throw new Error(`Cloudflare HTTP ${response.status}: ${JSON.stringify(data.errors || data).slice(0, 600)}`);
  const result = data.result || {};
  let reply = result.response || result.output_text || result.choices?.[0]?.message?.content || "";
  if (Array.isArray(reply)) reply = reply.filter(x => x.type === "text").map(x => x.text || "").join("");
  if (typeof reply !== "string" || !reply.trim()) throw new Error("Cloudflare returned an empty reply");
  return reply.trim();
}

async function processCustomerMessage(sock, jid, messageText) {
  const history = getChatHistory(jid);
  const reply = await getAIReply(messageText, [...history]);
  saveChatHistory(jid, messageText, reply);
  await sock.sendMessage(jid, { text: reply });
  console.log("AI reply sent");
}
async function queueCustomerMessage(sock, jid, messageText) {
  const previousTask = chatQueues.get(jid) || Promise.resolve();
  const currentTask = previousTask.catch(() => {}).then(() => processCustomerMessage(sock, jid, messageText)).catch(async error => {
    console.error("AI reply error:", error.message);
    try { await sock.sendMessage(jid, { text: "দুঃখিত ভাই, একটু সমস্যা হচ্ছে। আবার মেসেজ করবেন ❤️" }); } catch (e) { console.error("WhatsApp send error:", e.message); }
  });
  chatQueues.set(jid, currentTask);
  try { await currentTask; } finally { if (chatQueues.get(jid) === currentTask) chatQueues.delete(jid); }
}

// ---------------- START SERVER + WHATSAPP ----------------
app.listen(PORT, () => { console.log("FLYING ARROW AI BOT server started"); connectWhatsApp(); });
async function connectWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;
  try {
    botStatus = "Connecting...";
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const sock = makeWASocket({ auth: state, logger: P({ level: "silent" }), markOnlineOnConnect: false });
    waSocket = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) { qrImage = await QRCode.toDataURL(qr); botStatus = "QR Code Ready"; console.log("WhatsApp QR generated"); }
      if (connection === "open") { qrImage = null; botStatus = "WhatsApp Connected"; console.log("WhatsApp connected"); }
      if (connection === "close") {
        qrImage = null; isConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) { botStatus = "Logged out. Scan a new QR."; return; }
        botStatus = "Disconnected. Reconnecting...";
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWhatsApp(); }, 5000);
      }
    });
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) continue;
        const content = msg.message;
        const messageText = content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption;
        if (!messageText?.trim()) continue;
        console.log("New WhatsApp message received");
        await queueCustomerMessage(sock, jid, messageText.trim());
      }
    });
    isConnecting = false;
  } catch (error) {
    console.error("WhatsApp connection error:", error.message);
    botStatus = "Connection error"; isConnecting = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectWhatsApp(); }, 10000);
  }
}
