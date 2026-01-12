const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
const path = require("path");
const fs = require("fs");

async function initDB() {
  // Ensure the directory exists
  const dbDir = path.dirname("./schedules.db");
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = await open({
    filename: path.resolve("./schedules.db"),
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT,
      time DATETIME,
      user_id TEXT,
      is_reminded BOOLEAN DEFAULT 0
    )
  `);

  return db;
}

async function getUpcomingSchedules(db, userId) {
  return await db.all(
    `SELECT * FROM schedules WHERE user_id = ? ORDER BY time ASC`,
    userId
  );
}
module.exports = { initDB, getUpcomingSchedules };
