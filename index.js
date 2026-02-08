require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("baileys");
const QRCode = require("qrcode");
const { determineMessageType } = require("./ai");
const { initDB, getUpcomingSchedules, markAsReminded } = require("./database");
const {
  handleScheduleCreate,
  handleScheduleDelete,
  handleScheduleEdit,
  handleScheduleQuery,
} = require("./schedule");
const {
  parseFinanceInput,
  handleFinanceRecord,
  handleFinanceQuery,
  generateMonthlyReport,
} = require("./finance");

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
      console.log("Bot Scheduler Ready!");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type === "notify") {
      const msg = messages[0];
      if (!msg.message) return;

      const isGroup = msg.key.remoteJid.endsWith("@g.us");
      const userId = isGroup
        ? msg.key.participantAlt || msg.key.participant
        : msg.key.remoteJid;

      const remoteJid = msg.key.remoteJid;
      const remoteJidAlt = msg.key.remoteJidAlt;

      const textMessage =
        msg.message.conversation || msg.message.extendedTextMessage?.text;

      console.log(msg);
      if (!textMessage) return;

      const trustedNumbers = (process.env.TRUSTED_NUMBERS || "")
        .split(",")
        .map((n) => n.trim());
      const isTrustedPC =
        !isGroup && trustedNumbers.some((num) => remoteJidAlt.startsWith(num));
      const requiresPrefix = isGroup || !isTrustedPC;

      if (requiresPrefix && !textMessage.startsWith("p,")) return;

      const cleanMessage = requiresPrefix
        ? textMessage.substring(2).trim()
        : textMessage;

      console.log(`[MESSAGE] Clean message: "${cleanMessage}"`);

      if (cleanMessage.toLowerCase() === "report") {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        await generateMonthlyReport(db, sock, userId, remoteJid, year, month);
        return;
      }

      const messageType = await determineMessageType(cleanMessage);

      if (messageType === "finance") {
        const financeData = await parseFinanceInput(cleanMessage);

        if (financeData && financeData.action === "record") {
          await handleFinanceRecord(db, sock, userId, remoteJid, financeData);
        } else if (financeData && financeData.action === "query") {
          await handleFinanceQuery(
            db,
            sock,
            userId,
            remoteJid,
            financeData.queryType,
          );
        } else {
          await sock.sendMessage(remoteJid, {
            text: "❌ Mohon format input dengan jelas ya! (contoh: beli cilok 2k, berapa saldo)",
          });
        }
      } else {
        const userSchedules = await getUpcomingSchedules(db, userId);

        const created = await handleScheduleCreate(
          db,
          sock,
          userId,
          remoteJid,
          cleanMessage,
        );
        if (created) return;

        const deleted = await handleScheduleDelete(
          db,
          sock,
          userId,
          remoteJid,
          cleanMessage,
          userSchedules,
        );
        if (deleted) return;

        const edited = await handleScheduleEdit(
          db,
          sock,
          userId,
          remoteJid,
          cleanMessage,
          userSchedules,
        );
        if (edited) return;

        await handleScheduleQuery(
          db,
          sock,
          userId,
          remoteJid,
          cleanMessage,
          userSchedules,
        );
      }
    }
  });

  setInterval(async () => {
    const nowInJakarta = new Date().toLocaleString("sv-SE", {
      timeZone: "Asia/Jakarta",
    });

    const currentMinute = nowInJakarta.replace("T", " ").substring(0, 16);

    console.log(`🕵️‍♀️ Cek Reminder (WIB): ${currentMinute}`);

    try {
      const [tasks] = await db.query(
        `SELECT * FROM schedules 
             WHERE DATE_FORMAT(time, '%Y-%m-%d %H:%i') = ? 
             AND is_reminded = 0`,
        [currentMinute],
      );

      if (tasks.length > 0) {
        console.log(`🔔 WAKTU TIBA! Mengirim ${tasks.length} pengingat...`);

        for (const task of tasks) {
          await sock.sendMessage(task.user_id, {
            text: `🔔 *PENGINGAT!*\n\nHalo kak! Jangan lupa: *${task.task}* sekarang ya!\n(Waktu: ${task.time})`,
          });

          await markAsReminded(db, task.id);
          console.log(`✅ Sukses ingetin tugas: ${task.task}`);
        }
      }
    } catch (error) {
      console.error("❌ Error Scheduler:", error.message);
    }
  }, 60000);

  // Auto-send monthly report at end of month
  setInterval(async () => {
    const now = new Date();
    const jakartaNow = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Jakarta" }),
    );

    const hour = jakartaNow.getHours();
    const minute = jakartaNow.getMinutes();
    const date = jakartaNow.getDate();

    // Check if it's end of month (28th-31st at 23:59)
    const isEndOfMonth = [28, 29, 30, 31].includes(date);
    const isLateEvening = hour === 23 && minute === 59;

    if (isEndOfMonth && isLateEvening) {
      console.log("📊 Mengirim laporan keuangan bulanan...");

      try {
        // Get all users who have finance data
        const [users] = await db.query(`SELECT DISTINCT user_id FROM finances`);

        for (const user of users) {
          const userId = user.user_id;
          const year = jakartaNow.getFullYear();
          const month = jakartaNow.getMonth() + 1;

          // Send report
          await generateMonthlyReport(db, sock, userId, userId, year, month);

          // Small delay to avoid rate limiting
          await new Promise((r) => setTimeout(r, 1000));
        }

        console.log(
          `✅ Selesai mengirim ${users.length} laporan keuangan bulanan`,
        );
      } catch (error) {
        console.error("❌ Error sending monthly reports:", error.message);
      }
    }
  }, 60000); // Check every minute

  return sock;
}

connectToWhatsApp();
