const { parseSchedule } = require("./ai");
const {
  getUpcomingSchedules,
  deleteSchedule,
  updateSchedule,
  getScheduleById,
} = require("./database");

async function handleScheduleCreate(db, sock, userId, remoteJid, message) {
  const scheduleData = await parseSchedule(message);

  if (!scheduleData) return false;

  const scheduleCount = scheduleData.length;

  for (const schedule of scheduleData) {
    await db.query(
      `INSERT INTO schedules (task, time, user_id) VALUES (?, ?, ?)`,
      [schedule.task, schedule.time, userId]
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
  return true;
}

async function handleScheduleDelete(
  db,
  sock,
  userId,
  remoteJid,
  message,
  userSchedules
) {
  const { parseDeleteRequest } = require("./ai");
  const deleteData = await parseDeleteRequest(message, userSchedules);

  if (!deleteData) return false;

  if (deleteData.needsConfirmation) {
    const confirmMessage = `❓ Permintaan Hapus Tidak Jelas\n\n${deleteData.details}\n\nTolong kasih info yang lebih jelas ya, kak!`;
    await sock.sendMessage(remoteJid, { text: confirmMessage });
    return true;
  }

  const scheduleToDelete = await getScheduleById(db, deleteData.id);
  if (scheduleToDelete) {
    await deleteSchedule(db, deleteData.id);
    const deleteMessage = `✅ Jadwal berhasil dihapus!\n\n📝: ${scheduleToDelete.task}\n⏰: ${scheduleToDelete.time}`;
    await sock.sendMessage(remoteJid, { text: deleteMessage });
  } else {
    await sock.sendMessage(remoteJid, {
      text: "❌ Jadwal tidak ditemukan!",
    });
  }
  return true;
}

async function handleScheduleEdit(
  db,
  sock,
  userId,
  remoteJid,
  message,
  userSchedules
) {
  const { parseEditRequest } = require("./ai");
  const editData = await parseEditRequest(message, userSchedules);

  if (!editData) return false;

  if (editData.needsConfirmation) {
    const confirmMessage = `❓ Permintaan Edit Tidak Jelas\n\n${editData.details}\n\nTolong kasih info yang lebih jelas ya, kak!`;
    await sock.sendMessage(remoteJid, { text: confirmMessage });
    return true;
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
  } else {
    await sock.sendMessage(remoteJid, {
      text: "❌ Jadwal tidak ditemukan!",
    });
  }
  return true;
}

async function handleScheduleQuery(
  db,
  sock,
  userId,
  remoteJid,
  message,
  userSchedules
) {
  const { generateAIResponse } = require("./ai");
  const reply = await generateAIResponse(message, userSchedules);
  await sock.sendMessage(remoteJid, { text: reply });
  return true;
}

module.exports = {
  handleScheduleCreate,
  handleScheduleDelete,
  handleScheduleEdit,
  handleScheduleQuery,
};
