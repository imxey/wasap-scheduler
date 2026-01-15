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

  await connection.query(`
    CREATE TABLE IF NOT EXISTS finances (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id VARCHAR(255),
      amount DECIMAL(12, 2),
      type ENUM('pengeluaran', 'pemasukan'),
      category VARCHAR(100),
      description TEXT,
      transaction_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_time (user_id, transaction_time)
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

async function addFinance(db, userId, amount, type, category, description) {
  const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" });
  const [result] = await db.query(
    `INSERT INTO finances (user_id, amount, type, category, description, transaction_time) 
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, amount, type, category, description, now]
  );
  return result.insertId;
}

async function getFinancesByUser(db, userId) {
  const [rows] = await db.query(
    `SELECT * FROM finances WHERE user_id = ? ORDER BY transaction_time DESC`,
    [userId]
  );
  return rows;
}

async function getFinancesByDate(db, userId, date) {
  const [rows] = await db.query(
    `SELECT * FROM finances WHERE user_id = ? AND DATE(transaction_time) = ? ORDER BY transaction_time DESC`,
    [userId, date]
  );
  return rows;
}

async function getFinancesSummary(db, userId) {
  const [rows] = await db.query(
    `SELECT 
      type,
      SUM(amount) as total
      FROM finances 
      WHERE user_id = ? 
      GROUP BY type`,
    [userId]
  );
  return rows;
}

async function getTodayFinances(db, userId) {
  const now = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" });
  const today = now.split(" ")[0];
  return getFinancesByDate(db, userId, today);
}

async function getMonthlyFinances(db, userId, year, month) {
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const [rows] = await db.query(
    `SELECT * FROM finances 
     WHERE user_id = ? 
     AND transaction_time >= ? 
     AND transaction_time < ?
     ORDER BY transaction_time DESC`,
    [userId, startDate, endDate]
  );
  return rows;
}

async function getMonthlyExpensesByCategory(db, userId, year, month) {
  const startDate = `${year}-${String(month).padStart(2, "0")}-01`;
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  const endDate = `${nextYear}-${String(nextMonth).padStart(2, "0")}-01`;

  const [rows] = await db.query(
    `SELECT category, SUM(amount) as total, COUNT(*) as count
     FROM finances
     WHERE user_id = ? 
     AND type = 'pengeluaran'
     AND transaction_time >= ? 
     AND transaction_time < ?
     GROUP BY category
     ORDER BY total DESC`,
    [userId, startDate, endDate]
  );
  return rows;
}

module.exports = {
  initDB,
  getUpcomingSchedules,
  markAsReminded,
  deleteSchedule,
  updateSchedule,
  getScheduleById,
  // Finance functions
  addFinance,
  getFinancesByUser,
  getFinancesByDate,
  getFinancesSummary,
  getTodayFinances,
  getMonthlyFinances,
  getMonthlyExpensesByCategory,
};
