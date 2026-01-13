const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("baileys");
const QRCode = require("qrcode");
const {
  parseSchedule,
  generateAIResponse,
  parseDeleteRequest,
  parseEditRequest,
} = require("./ai");
const {
  initDB,
  getUpcomingSchedules,
  markAsReminded,
  deleteSchedule,
  updateSchedule,
  getScheduleById,
} = require("./database");

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

      const remoteJid = msg.key.remoteJid;
      const textMessage =
        msg.message.conversation || msg.message.extendedTextMessage?.text;

      console.log(msg);
      if (!textMessage) return;

      const scheduleData = await parseSchedule(textMessage);

      if (scheduleData) {
        const scheduleCount = scheduleData.length;

        for (const schedule of scheduleData) {
          await db.query(
            `INSERT INTO schedules (task, time, user_id) VALUES (?, ?, ?)`,
            [schedule.task, schedule.time, remoteJid]
          );
          console.log(
            `[DATABASE SUCCESS] New Schedule Saved! Task: "${schedule.task}" | Time: ${schedule.time}`
          );
        }

        let responseText;
        if (scheduleCount === 1) {
          responseText = `Oke noted, udah aku catet ya!\n\n📝: ${scheduleData[0].task}\n⏰: ${scheduleData[0].time}`;
        } else {
          responseText = `Oke noted, udah aku catet ${scheduleCount} jadwal ya!\n\n`;
          scheduleData.forEach((schedule, index) => {
            responseText += `${index + 1}. 📝 ${schedule.task}\n   ⏰ ${
              schedule.time
            }\n\n`;
          });
        }

        await sock.sendMessage(remoteJid, { text: responseText });
      } else {
        const userSchedules = await getUpcomingSchedules(db, remoteJid);

        const deleteData = await parseDeleteRequest(textMessage, userSchedules);
        if (deleteData) {
          if (deleteData.needsConfirmation) {
            const confirmMessage = `❓ Permintaan Hapus Tidak Jelas\n\n${deleteData.details}\n\nTolong kasih info yang lebih jelas ya, kak!`;
            await sock.sendMessage(remoteJid, { text: confirmMessage });
            return;
          }

          const scheduleToDelete = await getScheduleById(db, deleteData.id);
          if (scheduleToDelete) {
            await deleteSchedule(db, deleteData.id);
            const deleteMessage = `✅ Jadwal berhasil dihapus!\n\n📝: ${scheduleToDelete.task}\n⏰: ${scheduleToDelete.time}`;
            await sock.sendMessage(remoteJid, { text: deleteMessage });
            console.log(
              `[DATABASE SUCCESS] Schedule Deleted! Task: "${scheduleToDelete.task}"`
            );
          } else {
            await sock.sendMessage(remoteJid, {
              text: "❌ Jadwal tidak ditemukan!",
            });
          }
          return;
        }

        const editData = await parseEditRequest(textMessage, userSchedules);
        if (editData) {
          if (editData.needsConfirmation) {
            const confirmMessage = `❓ Permintaan Edit Tidak Jelas\n\n${editData.details}\n\nTolong kasih info yang lebih jelas ya, kak!`;
            await sock.sendMessage(remoteJid, { text: confirmMessage });
            return;
          }

          const scheduleToEdit = await getScheduleById(db, editData.id);
          if (scheduleToEdit) {
            const oldTask = scheduleToEdit.task;
            const oldTime = scheduleToEdit.time;

            const newTask = editData.newTask || oldTask;
            const newTime = editData.newTime || oldTime;

            await updateSchedule(db, editData.id, newTask, newTime);

            let editMessage = `✏️ Jadwal berhasil diubah!\n\n`;
            editMessage += `📋 *SEBELUM:*\n📝: ${oldTask}\n⏰: ${oldTime}\n\n`;
            editMessage += `📋 *SESUDAH:*\n📝: ${newTask}\n⏰: ${newTime}`;
            await sock.sendMessage(remoteJid, { text: editMessage });
            console.log(
              `[DATABASE SUCCESS] Schedule Updated! Old: "${oldTask}" → New: "${newTask}"`
            );
          } else {
            await sock.sendMessage(remoteJid, {
              text: "❌ Jadwal tidak ditemukan!",
            });
          }
          return;
        }

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
        [currentMinute]
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

  return sock;
}

connectToWhatsApp();
