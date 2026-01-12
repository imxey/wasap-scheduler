const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("baileys");
const QRCode = require("qrcode");
const { parseSchedule, generateAIResponse } = require("./ai");
const { initDB, getUpcomingSchedules } = require("./database");

let db;

async function connectToWhatsApp() {
  db = await initDB();
  const { state, saveCreds } = await useMultiFileAuthState("auth");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log(await QRCode.toString(qr, { type: "terminal" }));
    }

    if (connection === "close") {
      if (
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      ) {
        connectToWhatsApp();
      }
    }
    if (connection === "open") {
      console.log("Xeyla Scheduler Super Smart Ready!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type === "notify") {
      const msg = messages[0];
      if (!msg.message) return;

      const remoteJid = msg.key.remoteJid;
      const textMessage =
        msg.message.conversation || msg.message.extendedTextMessage?.text;

      console.log(msg);
      if (!textMessage) return;

      const scheduleData = await parseSchedule(textMessage);

      if (scheduleData) {
        await db.run(
          `INSERT INTO schedules (task, time, user_id) VALUES (?, ?, ?)`,
          scheduleData.task,
          scheduleData.time,
          remoteJid
        );

        console.log(
          `[DATABASE SUCCESS] New Schedule Saved! Task: "${scheduleData.task}" | Time: ${scheduleData.time}`
        );

        await sock.sendMessage(remoteJid, {
          text: `Oke noted, udah aku catet ya!\n\n📝: ${scheduleData.task}\n⏰: ${scheduleData.time}`,
        });
      } else {
        const userSchedules = await getUpcomingSchedules(db, remoteJid);

        console.log("=== DEBUG SCHEDULES ===");
        console.log("User ID:", remoteJid);
        console.log("Jadwal Ditemukan:", userSchedules);
        console.log("=======================");

        const reply = await generateAIResponse(textMessage, userSchedules);
        await sock.sendMessage(remoteJid, { text: reply });
      }
    }
  });

  setInterval(async () => {
    const now = new Date();

    const nowStr = now
      .toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" })
      .replace(" ", " ")
      .substring(0, 16);

    const tasks = await db.all(
      `SELECT * FROM schedules WHERE strftime('%Y-%m-%d %H:%M', time) = ? AND is_reminded = 0`,
      nowStr
    );

    for (const task of tasks) {
      await sock.sendMessage(task.user_id, {
        text: `🔔 PENGINGAT!\n\nHalo, waktunya: ${task.task} sekarang!`,
      });

      await db.run(
        `UPDATE schedules SET is_reminded = 1 WHERE id = ?`,
        task.id
      );
    }
  }, 60000);

  return sock;
}

connectToWhatsApp();
