const mysql = require("mysql2/promise");

let pool;

async function initDB() {
  pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "wasap",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,

    dateStrings: true,
  });

  const connection = await pool.getConnection();

  await connection.query(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      task TEXT,
      time DATETIME,
      user_id VARCHAR(255),
      is_reminded BOOLEAN DEFAULT 0,
      INDEX idx_user_time (user_id, time),
      INDEX idx_reminded (is_reminded, time)
    )
  `);

  connection.release();
  return pool;
}

async function getUpcomingSchedules(db, userId) {
  const [rows] = await db.query(
    `SELECT * FROM schedules WHERE user_id = ? ORDER BY time ASC`,
    [userId]
  );
  return rows;
}

async function markAsReminded(db, id) {
  await db.query(`UPDATE schedules SET is_reminded = 1 WHERE id = ?`, [id]);
}

async function deleteSchedule(db, id) {
  const [result] = await db.query(`DELETE FROM schedules WHERE id = ?`, [id]);
  return result.affectedRows > 0;
}

async function updateSchedule(db, id, newTask, newTime) {
  const [result] = await db.query(
    `UPDATE schedules SET task = ?, time = ? WHERE id = ?`,
    [newTask, newTime, id]
  );
  return result.affectedRows > 0;
}

async function getScheduleById(db, id) {
  const [rows] = await db.query(`SELECT * FROM schedules WHERE id = ?`, [id]);
  return rows.length > 0 ? rows[0] : null;
}

module.exports = {
  initDB,
  getUpcomingSchedules,
  markAsReminded,
  deleteSchedule,
  updateSchedule,
  getScheduleById,
};
