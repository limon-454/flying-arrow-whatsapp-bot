
import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import P from "pino";

const app = express();
const PORT = process.env.PORT || 3000;

let qrImage = null;
let botStatus = "Starting...";
let isConnecting = false;

app.get("/", (req, res) => {
  res.send(`
    <h2>FLYING ARROW AI BOT ❤️</h2>
    <p>Status: ${botStatus}</p>
    <a href="/qr">Open WhatsApp QR Code</a>
  `);
});

app.get("/qr", (req, res) => {
  if (!qrImage) {
    return res.send(`
      <h2>FLYING ARROW AI BOT</h2>
      <p>${botStatus}</p>
      <p>QR code is not available yet. Refresh this page.</p>
    `);
  }

  res.send(`
    <h2>Scan WhatsApp QR Code</h2>
    <img src="${qrImage}" width="300" />
    <p>WhatsApp → Linked Devices → Link a Device</p>
  `);
});

app.get("/status", (req, res) => {
  res.json({ status: botStatus });
});

app.listen(PORT, () => {
  console.log(`FLYING ARROW BOT running on port ${PORT}`);
  connectWhatsApp();
});

async function connectWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    botStatus = "Connecting to WhatsApp...";

    const { state, saveCreds } =
      await useMultiFileAuthState("auth_info_baileys");

    const sock = makeWASocket({
      auth: state,
      logger: P({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrImage = await QRCode.toDataURL(qr);
        botStatus = "QR Code Ready";
        console.log("WhatsApp QR Code generated");
      }

      if (connection === "open") {
        qrImage = null;
        botStatus = "WhatsApp Connected ❤️";
        console.log("WhatsApp connected successfully");
      }

      if (connection === "close") {
        qrImage = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        if (statusCode === DisconnectReason.loggedOut) {
          botStatus = "Logged out. Scan a new QR code.";
          isConnecting = false;
          console.log("WhatsApp logged out");
          return;
        }

        botStatus = "Disconnected. Reconnecting...";
        isConnecting = false;

        setTimeout(() => {
          connectWhatsApp();
        }, 5000);
      }
    });

    sock.ev.on("messages.upsert", ({ messages }) => {
      for (const message of messages) {
        if (!message.key.fromMe && message.message) {
          console.log(
            "New WhatsApp message received:",
            message.key.remoteJid
          );
        }
      }
    });

    isConnecting = false;

  } catch (error) {
    console.error("WhatsApp connection error:", error);
    botStatus = "Connection error";
    isConnecting = false;

    setTimeout(() => {
      connectWhatsApp();
    }, 10000);
  }
}
