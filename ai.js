require("dotenv").config();
const { Groq } = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Helper sakti buat format YYYY-MM-DD sesuai zona waktu Jakarta
// Jadi jam 1 malem tetep diitung hari ini, bukan kemarin!
function getJakartaDateStr(dateObj) {
  return dateObj.toLocaleDateString("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function getContextDates() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const options = {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Jakarta",
  };
  const timeOptions = {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
    hour12: false,
  };

  return {
    todayStr: now.toLocaleDateString("id-ID", options),
    tomorrowStr: tomorrow.toLocaleDateString("id-ID", options),
    // INI PERBAIKANNYA: Jangan pake toISOString(), pake helper Jakarta
    todayShort: getJakartaDateStr(now), // "2026-01-13" (Bener!)
    tomorrowShort: getJakartaDateStr(tomorrow), // "2026-01-14"
    timeStr: now.toLocaleTimeString("id-ID", timeOptions),
  };
}

async function parseSchedule(message) {
  const { todayStr, tomorrowStr, timeStr } = getContextDates();

  const systemPrompt = `
    Context:
    - Today: ${todayStr}
    - Tomorrow: ${tomorrowStr}
    - Current Time: ${timeStr}
    
    Role: Strict Schedule Extractor.
    Task: Convert user commands into JSON.
    
    RULES:
    1. IF user asks questions (e.g. "Besok ada apa?", "Cek jadwal"), RETURN NULL.
    2. ONLY return JSON if user EXPLICITLY wants to create a task (e.g. "Ingetin...", "Jadwalin...").
    3. JSON Format: {"task": "string", "time": "YYYY-MM-DD HH:mm:ss"}
    
    MIDNIGHT RULE:
    If Current Time is between 00:00 and 04:00, and user says "Besok", assume they mean the actual next calendar day (Date + 1).
  `;

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.1,
    });

    const content = completion.choices[0]?.message?.content || "null";
    const cleanContent = content
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    if (cleanContent.toLowerCase().includes("null")) return null;

    try {
      return JSON.parse(cleanContent);
    } catch {
      return null;
    }
  } catch (error) {
    return null;
  }
}

async function generateAIResponse(message, schedules = []) {
  const { todayStr, tomorrowStr, timeStr, todayShort, tomorrowShort } =
    getContextDates();

  const scheduleList =
    schedules.length > 0
      ? schedules
          .map((s) => {
            // --- BAGIAN PERBAIKAN TIMEZONE ---
            // Kita asumsikan s.time formatnya "YYYY-MM-DD HH:mm:ss"
            // Kita ubah jadi "YYYY-MM-DDTHH:mm:ss+07:00" biar JS tau ini WIB!

            let timeString = s.time;

            // Kalau s.time bentuknya object Date (kadang driver sql otomatis ubah), balikin ke string dulu
            if (s.time instanceof Date) {
              // Hati-hati di sini, mending kita ambil raw stringnya kalau bisa
              // Tapi kalau udah terlanjur object, kita format manual
              const y = s.time.getFullYear();
              const m = String(s.time.getMonth() + 1).padStart(2, "0");
              const d = String(s.time.getDate()).padStart(2, "0");
              const h = String(s.time.getHours()).padStart(2, "0");
              const min = String(s.time.getMinutes()).padStart(2, "0");
              const sec = String(s.time.getSeconds()).padStart(2, "0");
              timeString = `${y}-${m}-${d} ${h}:${min}:${sec}`;
            }

            // KUNCI PERBAIKAN: Tambahin +07:00 secara paksa!
            const safeDateStr = timeString.replace(" ", "T") + "+07:00";
            const d = new Date(safeDateStr);

            // Format ulang buat label (tetep pake timezone Jakarta)
            const dateOnly = getJakartaDateStr(d);
            const timeOnly = d.toLocaleTimeString("id-ID", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
              timeZone: "Asia/Jakarta",
            });

            let dayLabel = d.toLocaleDateString("id-ID", {
              weekday: "long",
              day: "numeric",
              month: "short",
              timeZone: "Asia/Jakarta",
            });

            if (dateOnly === todayShort) dayLabel = "🔴 HARI INI";
            else if (dateOnly === tomorrowShort) dayLabel = "🔵 BESOK";

            return `- [${dayLabel} pukul ${timeOnly}] ${s.task}`;
          })
          .join("\n")
      : "Tidak ada jadwal tersimpan.";

  const systemPrompt = `
    You are XeylaBot.
    
    CONTEXT:
    - Sekarang: ${todayStr} Jam ${timeStr}
    
    DATA JADWAL USER (DATABASE):
    ${scheduleList}
    
    INSTRUCTION:
    1. Answer based on the "DATA JADWAL USER" above.
    2. If user asks "Hari ini ada apa?", look for items marked with "🔴 HARI INI".
    3. If user asks "Besok ada apa?", look for items marked with "🔵 BESOK".
    4. If user asks "Semua jadwal", list EVERYTHING.
    5. Reply in Indonesian slang.
  `;

  try {
    const completion = await groq.chat.completions.create({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.5,
    });
    return completion.choices[0]?.message?.content || "Loading...";
  } catch (error) {
    return "Error AI";
  }
}
module.exports = { parseSchedule, generateAIResponse };
