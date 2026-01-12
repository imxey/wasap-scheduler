require("dotenv").config();
const { Groq } = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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
    todayShort: now.toISOString().split("T")[0],
    tomorrowShort: tomorrow.toISOString().split("T")[0],
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
    
    CRITICAL RULES:
    1. IF user asks questions (e.g. "Besok ada apa?", "Cek jadwal"), RETURN NULL.
    2. ONLY return JSON if user EXPLICITLY wants to create a task (e.g. "Ingetin...", "Jadwalin...", "Ke rumah temen jam 10").
    3. JSON Format: {"task": "string", "time": "YYYY-MM-DD HH:mm:ss"}
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
            const d = new Date(s.time);
            const dateOnly = s.time.split(" ")[0];
            const timeOnly = s.time.split(" ")[1].substring(0, 5);

            let dayLabel = d.toLocaleDateString("id-ID", {
              weekday: "long",
              day: "numeric",
              month: "short",
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
    4. If user asks "Semua jadwal", list EVERYTHING you see in the data above. DO NOT FILTER OR HIDE ANYTHING.
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
