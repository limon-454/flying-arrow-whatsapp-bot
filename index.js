import express from "express";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import P from "pino";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "4mb" }));

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
// SUPABASE_SERVICE_ROLE_KEY is recommended. SUPABASE_KEY is retained as a fallback
// for compatibility, but an anon key cannot bypass the tables' RLS policies.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || "";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN || "";
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID || "";

let qrImage = null;
let botStatus = "Starting...";
let isConnecting = false;
let reconnectTimer = null;
let adminSession = null;
let sessionExpiry = 0;
let waSocket = null;

const MAX_HISTORY = 14;
const MAX_CHATS = 300;
const chatMemory = new Map();
const chatQueues = new Map();

const SLOT_LABELS = {
  "3_pm": "3 PM",
  "8_pm": "8 PM",
  "9_pm_scam": "9 PM SCRIM",
  "9_pm_champion_rush": "9 PM CHAMPION RUSH",
  "10_pm": "10 PM",
  "11_pm": "11 PM",
  "12_pm": "12 PM"
};

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

const DEFAULT_TEAM_FORM = `TEAM NAME     ➤
IGL          NAME ➤
PLAYER NAME ➤
বিকাশ  ➤
নগত     ➤`;

const FALLBACK_PROMPT = `You are the friendly WhatsApp assistant of FLYING ARROW Free Fire Tournament. Owner: PRINCE LIMON. Understand Bangla, Banglish and English. Reply briefly, naturally and politely like a Bangladeshi admin. Casual chat must not trigger payment QR, team form or group links. Booking is handled by the bot's fixed booking flow; do not independently request payment, screenshots, team details, or send group links. Do not invent prices, availability, payment details or links. If the user asks a normal question, answer briefly. Booking policy: NO SLOT CANCEL & NO PAY-BACK.`;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
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

function supabaseReady() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

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

async function getSession(jid) {
  const rows = await sbRequest(`booking_sessions?jid=eq.${encodeURIComponent(jid)}&select=*`);
  return rows?.[0] || {
    jid,
    selected_slot_key: null,
    stage: "CHAT",
    payment_last4: null,
    team_name: null,
    igl_name: null,
    player_names: null,
    payment_method: null,
    payment_number: null,
    screenshot_received: false,
    admin_approved: false
  };
}

async function saveSession(session) {
  session.updated_at = new Date().toISOString();
  const rows = await sbRequest("booking_sessions?on_conflict=jid", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(session)
  });
  return rows?.[0] || session;
}

async function saveChat(jid, role, content) {
  try {
    await sbRequest("chat_messages", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ jid, role, content: String(content).slice(0, 5000) })
    });
  } catch (error) {
    console.error("Chat persistence error:", error.message);
  }
}

function getChatHistory(jid) {
  if (!chatMemory.has(jid)) chatMemory.set(jid, []);
  const history = chatMemory.get(jid);
  chatMemory.delete(jid);
  chatMemory.set(jid, history);
  while (chatMemory.size > MAX_CHATS) chatMemory.delete(chatMemory.keys().next().value);
  return history;
}

function remember(jid, role, content) {
  const history = getChatHistory(jid);
  history.push({ role, content });
  while (history.length > MAX_HISTORY) history.shift();
}

async function sendText(sock, jid, text) {
  await sock.sendMessage(jid, { text });
  remember(jid, "assistant", text);
  await saveChat(jid, "assistant", text);
}

async function sendPaymentQR(sock, jid, settings) {
  const url = settings.payment_qr_url || "";
  if (url) {
    try {
      await sock.sendMessage(jid, {
        image: { url },
        caption: "ভাই, এই QR কোডে পেমেন্ট করুন ❤️\nপেমেন্ট করার পর Screenshot পাঠাবেন।"
      });
      const caption = "ভাই, এই QR কোডে পেমেন্ট করুন ❤️\nপেমেন্ট করার পর Screenshot পাঠাবেন।";
      remember(jid, "assistant", caption);
      await saveChat(jid, "assistant", "[Payment QR sent] " + caption);
      return;
    } catch (error) {
      console.error("QR send error:", error.message);
    }
  }
  await sendText(sock, jid, "ভাই, QR এখন সেট করা নেই। চাইলে পেমেন্ট নম্বর নিতে বলুন ❤️");
}

function effectiveSettings(settings) {
  return {
    ...settings,
    main_prompt: settings.main_prompt?.trim() || FALLBACK_PROMPT,
    group_links: settings.group_links && Object.keys(settings.group_links).length ? settings.group_links : DEFAULT_GROUP_LINKS,
    admin_contacts: settings.admin_contacts && Object.keys(settings.admin_contacts).length ? settings.admin_contacts : DEFAULT_ADMIN_CONTACTS,
    team_form: settings.team_form || DEFAULT_TEAM_FORM,
    booking_rules: settings.booking_rules || "NO SLOT CANCEL & NO PAY-BACK!"
  };
}

function normalize(text) {
  return String(text || "").toLowerCase().replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d)).replace(/[.,!?।]/g, " ").replace(/\s+/g, " ").trim();
}

function isNumberRequest(text) {
  const t = normalize(text);
  return /(number|নাম্বার|নম্বর|নাম্বারটা|নাম্বার দেন|number den|payment number|qr kaj|qr কাজ|qr hocche na|কিউআর কাজ)/i.test(t);
}

function detectSlot(text) {
  const t = normalize(text);
  const has9 = /(^|\s)9\s*(pm|পিএম)?(\s|$)/.test(t) || /৯\s*(pm|পিএম)?/.test(String(text));
  if (has9) {
    if (/champion|চ্যাম্পিয়ন|চ্যাম্পিয়ন|rush|রাশ/.test(t)) return "9_pm_champion_rush";
    if (/scrim|স্ক্রিম|scam|স্ক্যাম/.test(t)) return "9_pm_scam";
    return "AMBIGUOUS_9";
  }
  const map = [
    ["3_pm", /(^|\s)3\s*(pm|পিএম)?(\s|$)|৩\s*(pm|পিএম)?/],
    ["8_pm", /(^|\s)8\s*(pm|পিএম)?(\s|$)|৮\s*(pm|পিএম)?/],
    ["10_pm", /(^|\s)10\s*(pm|পিএম)?(\s|$)|১০\s*(pm|পিএম)?/],
    ["11_pm", /(^|\s)11\s*(pm|পিএম)?(\s|$)|১১\s*(pm|পিএম)?/],
    ["12_pm", /(^|\s)12\s*(pm|পিএম)?(\s|$)|১২\s*(pm|পিএম)?/]
  ];
  for (const [key, re] of map) if (re.test(t)) return key;
  return null;
}

function looksLikeBookingIntent(text) {
  return /(slot|স্লট|ম্যাচ|খেলব|খেলতে|book|booking|নিব|লাগবে|আছে|available|pm|পিএম)/i.test(text);
}

function parseLast4(text) {
  const digits = String(text).replace(/\D/g, "");
  return digits.length === 4 ? digits : null;
}

function parseTeamInfo(text, current) {
  const lines = String(text).split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const result = { ...current };
  for (const line of lines) {
    const normalizedLine = normalize(line);
    const value = line.replace(/^[^:➤-]+[:➤-]\s*/, "").trim();
    if (!value) continue;
    if (/team name|teamname|টিম নাম|টিমের নাম/.test(normalizedLine)) result.team_name = value;
    else if (/igl|আইজিএল|ক্যাপ্টেন/.test(normalizedLine)) result.igl_name = value;
    else if (/player|প্লেয়ার|প্লেয়ার|সদস্য/.test(normalizedLine)) result.player_names = value;
    else if (/বিকাশ|bkash/.test(normalizedLine)) {
      result.payment_method = "bKash";
      result.payment_number = value;
    } else if (/নগদ|nagad/.test(normalizedLine)) {
      result.payment_method = "Nagad";
      result.payment_number = value;
    }
  }
  // Also accept simple five-line replies in the order shown on the form.
  if (lines.length >= 3 && !result.team_name) result.team_name = lines[0].replace(/^[^➤:]+[➤:]\s*/, "").trim();
  if (lines.length >= 3 && !result.igl_name) result.igl_name = lines[1].replace(/^[^➤:]+[➤:]\s*/, "").trim();
  if (lines.length >= 3 && !result.player_names) result.player_names = lines[2].replace(/^[^➤:]+[➤:]\s*/, "").trim();
  return result;
}

async function getAIReply(messageText, previousMessages = []) {
  if (!CF_TOKEN || !CF_ACCOUNT) throw new Error("Cloudflare AI environment variables are missing");
  const settings = effectiveSettings(await getSettings());
  const prompt = `${settings.main_prompt}\n\nIMPORTANT BOOKING BOUNDARY: You handle casual conversation only. The application handles all booking, QR, payment-number, screenshot, team-form, approval and group-link steps. Never initiate those steps yourself. Keep replies short.`;
  const url = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/openai/gpt-oss-20b`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${CF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "system", content: prompt }, ...previousMessages, { role: "user", content: messageText }],
      max_tokens: 180,
      temperature: 0.45
    }),
    signal: AbortSignal.timeout(60000)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error("Cloudflare returned invalid JSON"); }
  if (!response.ok || data.success === false) throw new Error(`Cloudflare HTTP ${response.status}: ${JSON.stringify(data.errors || data).slice(0, 400)}`);
  let reply = data.result?.response || data.result?.output_text || data.result?.choices?.[0]?.message?.content || "";
  if (Array.isArray(reply)) reply = reply.filter(x => x.type === "text").map(x => x.text || "").join("");
  if (typeof reply !== "string" || !reply.trim()) throw new Error("Cloudflare returned an empty reply");
  return reply.trim().slice(0, 1200);
}

async function handleCustomerText(sock, jid, text) {
  const msg = normalize(text);
  const session = await getSession(jid);
  const settings = effectiveSettings(await getSettings());

  await saveChat(jid, "user", text);
  remember(jid, "user", text);

  if (session.stage === "WAIT_LAST4") {
    const last4 = parseLast4(text);
    if (!last4) {
      await sendText(sock, jid, "ভাই, পেমেন্ট নম্বরের শেষ ৪ ডিজিট লিখে দিন ❤️");
      return;
    }
    session.payment_last4 = last4;
    session.stage = "WAIT_TEAM_FORM";
    await saveSession(session);
    await sendText(sock, jid, settings.team_form);
    return;
  }

  if (session.stage === "WAIT_TEAM_FORM") {
    const parsed = parseTeamInfo(text, session);
    Object.assign(session, parsed);
    const missing = [];
    if (!session.team_name) missing.push("TEAM NAME");
    if (!session.igl_name) missing.push("IGL NAME");
    if (!session.player_names) missing.push("PLAYER NAME");
    if (!session.payment_number) missing.push("বিকাশ অথবা নগদ নম্বর");
    await saveSession(session);
    if (missing.length) {
      await sendText(sock, jid, `ভাই, ফর্মের এই তথ্যগুলো বাকি আছে: ${missing.join(", ")} ❤️`);
      return;
    }
    session.stage = "PENDING_ADMIN";
    session.admin_approved = false;
    await saveSession(session);
    await sendText(sock, jid, "কিছু সেকেন্ড ওয়েট করুন........\nএডমিন এসে চেক করে আপনাকে গ্রুপে এপ্রুভ করছে ❤️");
    return;
  }

  if (session.stage === "PENDING_ADMIN") {
    await sendText(sock, jid, "ভাই, আপনার তথ্য এডমিনের কাছে পাঠানো হয়েছে। একটু অপেক্ষা করুন ❤️");
    return;
  }

  if (isNumberRequest(text) && session.selected_slot_key) {
    await sendText(sock, jid, settings.payment_details || "পেমেন্ট নম্বর এখন সেট করা নেই। এডমিনের সঙ্গে যোগাযোগ করুন ❤️");
    session.stage = "WAIT_SCREENSHOT";
    await saveSession(session);
    return;
  }

  const selected = detectSlot(text);
  if (selected === "AMBIGUOUS_9") {
    await sendText(sock, jid, "ভাই, ৯ PM-এ দুইটা ম্যাচ আছে ❤️\nSCRIM – ২০ টাকা\nCHAMPION RUSH – ২৫ টাকা\nকোনটা খেলবেন?");
    return;
  }

  if (selected) {
    const slots = await getSlots();
    const slot = slots.find(s => s.slot_key === selected);
    if (!slot) {
      await sendText(sock, jid, "ভাই, এই ম্যাচের তথ্য এখন পাওয়া যাচ্ছে না। একটু পরে চেষ্টা করুন ❤️");
      return;
    }
    const remaining = Math.max(0, Number(slot.total_slots) - Number(slot.booked_slots));
    if (slot.status !== "AVAILABLE" || remaining <= 0) {
      await sendText(sock, jid, "দুঃখিত ভাই, এই ম্যাচের স্লট এখন FULL/OFF ❤️ অন্য সময় নিতে পারেন।");
      return;
    }
    session.selected_slot_key = selected;
    session.stage = "WAIT_SCREENSHOT";
    session.payment_last4 = null;
    session.team_name = null;
    session.igl_name = null;
    session.player_names = null;
    session.payment_method = null;
    session.payment_number = null;
    session.screenshot_received = false;
    session.admin_approved = false;
    await saveSession(session);
    await sendPaymentQR(sock, jid, settings);
    return;
  }

  if (looksLikeBookingIntent(text) && !session.selected_slot_key) {
    await sendText(sock, jid, "ভাই, কোন PM স্লট লাগবে? ❤️\n3 PM / 8 PM / 9 PM / 10 PM / 11 PM / 12 PM");
    return;
  }

  try {
    const reply = await getAIReply(text, getChatHistory(jid).slice(0, -1));
    await sendText(sock, jid, reply);
  } catch (error) {
    console.error("AI reply error:", error.message);
    const t = normalize(text);
    const simple = /^(hi|hello|হাই|হ্যালো)$/.test(t) ? "হ্যালো ভাই ❤️" :
      /^(ভাই|bro|ভাইয়া|ভাইয়া)$/.test(t) ? "জি ভাই, বলেন ❤️" :
      /^(ধন্যবাদ|thanks|thank you)$/.test(t) ? "স্বাগতম ভাই ❤️" :
      /^(আচ্ছা|ঠিক আছে|ok|okay)$/.test(t) ? "ঠিক আছে ভাই ❤️" :
      "দুঃখিত ভাই, একটু সমস্যা হচ্ছে। আবার মেসেজ করবেন ❤️";
    await sendText(sock, jid, simple);
  }
}

async function queueCustomerMessage(sock, jid, task) {
  const previousTask = chatQueues.get(jid) || Promise.resolve();
  const currentTask = previousTask.catch(() => {}).then(task).catch(async error => {
    console.error("Customer message processing error:", error.message);
    try { await sendText(sock, jid, "দুঃখিত ভাই, একটু সমস্যা হচ্ছে। আবার মেসেজ করবেন ❤️"); } catch {}
  });
  chatQueues.set(jid, currentTask);
  try { await currentTask; } finally {
    if (chatQueues.get(jid) === currentTask) chatQueues.delete(jid);
  }
}

async function handleIncomingImage(sock, jid, message) {
  const session = await getSession(jid);
  if (!session.selected_slot_key || !["WAIT_SCREENSHOT", "WAIT_LAST4"].includes(session.stage)) {
    await saveChat(jid, "user", "[Image received]");
    return;
  }
  session.screenshot_received = true;
  session.stage = "WAIT_LAST4";
  await saveSession(session);
  await saveChat(jid, "user", "[Payment screenshot received]");
  await sendText(sock, jid, "ভাই, Screenshot পেয়েছি। পেমেন্ট যে নম্বর থেকে করেছেন, সেই নম্বরের শেষ ৪ ডিজিট লিখে দিন ❤️");
}

async function approveBooking(jid) {
  if (!waSocket || botStatus !== "WhatsApp Connected") throw new Error("WhatsApp is not connected");
  const session = await getSession(jid);
  if (session.stage !== "PENDING_ADMIN") throw new Error("এই Booking এখন Approval-এর জন্য প্রস্তুত নয়");
  const settings = effectiveSettings(await getSettings());
  const link = settings.group_links?.[session.selected_slot_key];
  if (!link || !/^https:\/\/chat\.whatsapp\.com\//i.test(link)) throw new Error("এই ম্যাচের Group Link সেট করা নেই বা ভুল");
  session.admin_approved = true;
  session.stage = "APPROVED";
  await saveSession(session);
  const message = `আপনার CG/GROUP LINK ❤️\n${link}`;
  await waSocket.sendMessage(jid, { text: message });
  remember(jid, "assistant", message);
  await saveChat(jid, "assistant", message);
  return session;
}

// ---------------- LOGIN PAGE ----------------
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
  adminSession = null;
  sessionExpiry = 0;
  res.setHeader("Set-Cookie", "fa_admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  res.json({ success: true });
});
app.get("/", (req, res) => !isAdmin(req) ? res.redirect("/login") : res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/admin.html", (req, res) => !isAdmin(req) ? res.redirect("/login") : res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/health", (req, res) => res.json({ server: "online" }));

app.get("/api/status", requireAdmin, async (req, res) => {
  let db = "offline";
  try { await getSettings(); db = "online"; } catch {}
  res.json({
    status: botStatus,
    whatsappConnected: botStatus === "WhatsApp Connected",
    qrReady: Boolean(qrImage),
    server: "online",
    aiProvider: "Cloudflare Workers AI",
    database: db,
    conversationMemory: "Supabase + in-memory"
  });
});
app.get("/api/qr", requireAdmin, (req, res) => res.json({ qr: qrImage }));
app.get("/status", requireAdmin, (req, res) => res.json({ status: botStatus }));

// ---------------- DASHBOARD SETTINGS + SCHEDULE ----------------
app.get("/api/settings", requireAdmin, async (req, res) => {
  try { res.json({ settings: effectiveSettings(await getSettings()), supabaseConnected: true }); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

app.put("/api/settings", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const allowed = ["main_prompt", "payment_details", "payment_qr_url", "group_links", "admin_contacts", "team_form", "booking_rules"];
    const update = {};
    for (const key of allowed) {
      if (body[key] === undefined) continue;
      if (["group_links", "admin_contacts"].includes(key) && (!body[key] || typeof body[key] !== "object" || Array.isArray(body[key]))) {
        return res.status(400).json({ error: `${key} must be a JSON object` });
      }
      if (typeof body[key] === "string" && body[key].length > 20000) return res.status(400).json({ error: `${key} is too long` });
      update[key] = body[key];
    }
    if (!Object.keys(update).length) return res.status(400).json({ error: "No valid settings supplied" });
    update.updated_at = new Date().toISOString();
    const rows = await sbRequest("bot_settings?id=eq.1", {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(update)
    });
    if (!rows?.length) return res.status(404).json({ error: "bot_settings row id=1 not found" });
    res.json({ success: true, settings: rows[0] });
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
    if (price_tk !== undefined) {
      if (!Number.isInteger(price_tk) || price_tk < 1) return res.status(400).json({ error: "Invalid price_tk" });
      update.price_tk = price_tk;
    }
    if (booked_slots !== undefined) {
      if (!Number.isInteger(booked_slots) || booked_slots < 0 || booked_slots > 12) return res.status(400).json({ error: "booked_slots must be 0-12" });
      update.booked_slots = booked_slots;
    }
    if (status !== undefined) {
      if (!["AVAILABLE", "FULL", "OFF"].includes(status)) return res.status(400).json({ error: "Invalid status" });
      update.status = status;
    }
    if (match_name !== undefined) {
      if (typeof match_name !== "string" || !match_name.trim()) return res.status(400).json({ error: "Invalid match_name" });
      update.match_name = match_name.trim().slice(0, 80);
    }
    const rows = await sbRequest(`slot_schedules?slot_key=eq.${encodeURIComponent(req.params.key)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(update)
    });
    if (!rows?.length) return res.status(404).json({ error: "Slot not found" });
    res.json({ success: true, slot: rows[0] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ---------------- PAYMENT QR STORAGE ----------------
app.post("/api/settings/payment-qr", requireAdmin, async (req, res) => {
  try {
    if (!supabaseReady()) throw new Error("Supabase environment variables are missing");
    const { imageData, mimeType } = req.body || {};
    if (!imageData || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)) return res.status(400).json({ error: "PNG, JPG অথবা WEBP ছবি দিন" });
    const match = imageData.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match || match[1] !== mimeType) return res.status(400).json({ error: "Invalid image data" });
    const buffer = Buffer.from(match[2], "base64");
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) return res.status(400).json({ error: "ছবির সাইজ সর্বোচ্চ 2MB হতে পারবে" });
    const ext = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1];
    const fileName = `payment-qr-${Date.now()}.${ext}`;
    const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/fa-payment-assets/${fileName}`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": mimeType, "x-upsert": "true" },
      body: buffer,
      signal: AbortSignal.timeout(30000)
    });
    const uploadText = await upload.text();
    if (!upload.ok) throw new Error(`Storage upload ${upload.status}: ${uploadText.slice(0, 400)}`);
    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/fa-payment-assets/${fileName}`;
    await sbRequest("bot_settings?id=eq.1", {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ payment_qr_url: publicUrl, updated_at: new Date().toISOString() })
    });
    res.json({ success: true, payment_qr_url: publicUrl });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ---------------- CHAT + BOOKINGS ADMIN APIs ----------------
app.get("/api/chats", requireAdmin, async (req, res) => {
  try {
    const rows = await sbRequest("chat_messages?select=jid,role,content,created_at&order=created_at.desc&limit=300");
    const grouped = new Map();
    for (const row of rows || []) {
      if (!grouped.has(row.jid)) grouped.set(row.jid, []);
      const list = grouped.get(row.jid);
      if (list.length < 30) list.push({ role: row.role, content: row.content, created_at: row.created_at });
    }
    const chats = [...grouped.entries()].map(([jid, messages]) => ({
      jid,
      messages: messages.reverse(),
      lastMessage: messages[0]?.content || ""
    }));
    res.json({ chats });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/chats/:jid", requireAdmin, async (req, res) => {
  try {
    const rows = await sbRequest(`chat_messages?jid=eq.${encodeURIComponent(req.params.jid)}&select=*&order=created_at.asc&limit=200`);
    res.json({ messages: rows || [] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get("/api/bookings", requireAdmin, async (req, res) => {
  try {
    const rows = await sbRequest("booking_sessions?select=*&order=updated_at.desc&limit=200");
    res.json({ bookings: rows || [] });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post("/api/bookings/:jid/approve", requireAdmin, async (req, res) => {
  try {
    const session = await approveBooking(req.params.jid);
    res.json({ success: true, booking: session });
  } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post("/api/bookings/:jid/reject", requireAdmin, async (req, res) => {
  try {
    const session = await getSession(req.params.jid);
    session.stage = "REJECTED";
    session.admin_approved = false;
    await saveSession(session);
    if (waSocket && botStatus === "WhatsApp Connected") {
      await sendText(waSocket, req.params.jid, "ভাই, আপনার Booking এডমিন গ্রহণ করতে পারেনি। বিস্তারিত জানতে এডমিনের সঙ্গে যোগাযোগ করুন ❤️");
    }
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// ---------------- WHATSAPP CONNECTION ----------------
app.listen(PORT, () => {
  console.log("FLYING ARROW AI BOT server started on port", PORT);
  connectWhatsApp();
});

async function connectWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;
  try {
    botStatus = "Connecting...";
    const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
    const sock = makeWASocket({
      auth: state,
      logger: P({ level: "silent" }),
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    waSocket = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", async update => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrImage = await QRCode.toDataURL(qr);
        botStatus = "QR Code Ready";
        console.log("WhatsApp QR generated");
      }
      if (connection === "open") {
        qrImage = null;
        botStatus = "WhatsApp Connected";
        isConnecting = false;
        console.log("WhatsApp connected");
      }
      if (connection === "close") {
        qrImage = null;
        waSocket = null;
        isConnecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          botStatus = "Logged out. Scan a new QR.";
          return;
        }
        botStatus = "Disconnected. Reconnecting...";
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectWhatsApp();
        }, 5000);
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === "status@broadcast" || jid.endsWith("@g.us")) continue;
        const content = msg.message;
        const imageMessage = content.imageMessage || content.documentMessage?.mimetype?.startsWith("image/");
        const messageText = content.conversation ||
          content.extendedTextMessage?.text ||
          content.imageMessage?.caption ||
          content.videoMessage?.caption ||
          content.documentMessage?.caption || "";

        await queueCustomerMessage(sock, jid, async () => {
          if (imageMessage) {
            await handleIncomingImage(sock, jid, msg);
            if (messageText?.trim()) await handleCustomerText(sock, jid, messageText.trim());
            return;
          }
          if (messageText?.trim()) await handleCustomerText(sock, jid, messageText.trim());
        });
      }
    });
    isConnecting = false;
  } catch (error) {
    console.error("WhatsApp connection error:", error.message);
    botStatus = "Connection error";
    isConnecting = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectWhatsApp();
    }, 10000);
  }
}
