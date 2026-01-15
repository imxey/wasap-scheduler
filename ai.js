require("dotenv").config();
const { Groq } = require("groq-sdk");

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

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

    todayShort: getJakartaDateStr(now),
    tomorrowShort: getJakartaDateStr(tomorrow),
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
    2. ONLY return JSON if user EXPLICITLY wants to create task(s) (e.g. "Ingetin...", "Jadwalin...") or tell the event like "Besok ada meeting jam 2".
    3. JSON Format for MULTIPLE schedules: [{"task": "string", "time": "YYYY-MM-DD HH:mm:ss"}, ...]
    4. JSON Format for SINGLE schedule: {"task": "string", "time": "YYYY-MM-DD HH:mm:ss"}
    5. IMPORTANT: If user creates MULTIPLE tasks in one message, return an ARRAY of objects.
    
    MIDNIGHT RULE:
    If Current Time is between 00:00 and 04:00, and user says "Besok", assume they mean the actual next calendar day (Date + 1).
    
    EXAMPLES:
    - "Ingetin meeting jam 2 sama olahraga jam 5" → [{"task": "meeting", "time": "..."}, {"task": "olahraga", "time": "..."}]
    - "Jadwalin besok makan siang jam 12, lalu beli buku jam 3" → [{"task": "makan siang", "time": "..."}, {"task": "beli buku", "time": "..."}]
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
      const parsed = JSON.parse(cleanContent);

      if (Array.isArray(parsed)) {
        return parsed.length > 0 ? parsed : null;
      } else if (parsed && parsed.task && parsed.time) {
        return [parsed];
      }
      return null;
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
            let timeString = s.time;

            if (s.time instanceof Date) {
              const y = s.time.getFullYear();
              const m = String(s.time.getMonth() + 1).padStart(2, "0");
              const d = String(s.time.getDate()).padStart(2, "0");
              const h = String(s.time.getHours()).padStart(2, "0");
              const min = String(s.time.getMinutes()).padStart(2, "0");
              const sec = String(s.time.getSeconds()).padStart(2, "0");
              timeString = `${y}-${m}-${d} ${h}:${min}:${sec}`;
            }

            const safeDateStr = timeString.replace(" ", "T") + "+07:00";
            const d = new Date(safeDateStr);

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
    You are task scheduler bot.
    
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
    6. Pay attention to * symbols, the * must be 1 before and after the word(s) to be emphasized., e.g. *penting*. don't double the * like **penting**
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
async function parseDeleteRequest(message, userSchedules) {
  const { todayStr, tomorrowStr, timeStr, todayShort, tomorrowShort } =
    getContextDates();

  const scheduleList = userSchedules
    .map((s) => {
      let timeString = s.time;
      if (s.time instanceof Date) {
        const y = s.time.getFullYear();
        const m = String(s.time.getMonth() + 1).padStart(2, "0");
        const d = String(s.time.getDate()).padStart(2, "0");
        const h = String(s.time.getHours()).padStart(2, "0");
        const min = String(s.time.getMinutes()).padStart(2, "0");
        const sec = String(s.time.getSeconds()).padStart(2, "0");
        timeString = `${y}-${m}-${d} ${h}:${min}:${sec}`;
      }
      const safeDateStr = timeString.replace(" ", "T") + "+07:00";
      const d = new Date(safeDateStr);
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
      return `ID: ${s.id} | [${dayLabel} pukul ${timeOnly}] ${s.task}`;
    })
    .join("\n");

  const systemPrompt = `
    Role: Extract delete intent dari pesan user.
    
    Context:
    - Waktu sekarang: ${timeStr}
    
    Jadwal user:
    ${scheduleList}
    
    Task: Cek apakah user ingin MENGHAPUS sebuah jadwal.
    
    RULES:
    1. Jika user jelas ingin HAPUS jadwal (e.g. "Hapus...", "Jangan ingetin...", "Apus..."), extract schedule ID-nya.
    2. Return JSON: {"action": "delete", "id": <schedule_id>} jika JELAS DAN TIDAK AMBIGU
    3. Jika user sebutkan nama task ATAU waktu, cocokkan dengan list di atas dan return matching ID
    4. Jika TIDAK JELAS atau AMBIGU, return: {"action": "delete", "needsConfirmation": true, "details": "penjelasan dalam bahasa Indonesia yang singkat"}
    5. Jika BUKAN delete request, return NULL
    
    PENTING: Ketat tentang kejelasan. Jika user tidak kasih nama task dan tanggal dengan jelas, minta konfirmasi.
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

async function determineMessageType(message) {
  const systemPrompt = `
    Role: Message Classifier for Bot Gateway
    Task: Determine if user message is about SCHEDULING or FINANCE
    
    RULES:
    1. SCHEDULING: Messages about creating tasks, reminders, events, checking schedule (e.g. "ingetin", "jadwalin", "besok ada apa", "cek jadwal")
    2. FINANCE: Messages about money transactions, expenses, income, balance queries (e.g. "beli", "dapat", "berapa saldo", "pengeluaran")
    3. Return JSON: {"type": "schedule"|"finance"} only
    4. If message could be either, classify based on primary intent
    
    EXAMPLES:
    - "Ingetin meeting jam 2" → {"type": "schedule"}
    - "Beli cilok 2k" → {"type": "finance"}
    - "Besok ada apa" → {"type": "schedule"}
    - "Berapa saldo" → {"type": "finance"}
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

    try {
      const parsed = JSON.parse(cleanContent);
      return parsed.type || "schedule";
    } catch {
      return "schedule";
    }
  } catch (error) {
    return "schedule";
  }
}

module.exports = {
  parseSchedule,
  generateAIResponse,
  parseDeleteRequest,
  parseEditRequest,
  determineMessageType,
};
async function parseEditRequest(message, userSchedules) {
  const { todayStr, tomorrowStr, timeStr, todayShort, tomorrowShort } =
    getContextDates();

  const scheduleList = userSchedules
    .map((s) => {
      let timeString = s.time;
      if (s.time instanceof Date) {
        const y = s.time.getFullYear();
        const m = String(s.time.getMonth() + 1).padStart(2, "0");
        const d = String(s.time.getDate()).padStart(2, "0");
        const h = String(s.time.getHours()).padStart(2, "0");
        const min = String(s.time.getMinutes()).padStart(2, "0");
        const sec = String(s.time.getSeconds()).padStart(2, "0");
        timeString = `${y}-${m}-${d} ${h}:${min}:${sec}`;
      }
      const safeDateStr = timeString.replace(" ", "T") + "+07:00";
      const d = new Date(safeDateStr);
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
      return `ID: ${s.id} | [${dayLabel} pukul ${timeOnly}] ${s.task}`;
    })
    .join("\n");

  const systemPrompt = `
    Role: Extract edit intent dari pesan user.
    
    Context:
    - Waktu sekarang: ${timeStr}
    - Hari ini: ${todayStr}
    - Besok: ${tomorrowStr}
    
    Jadwal user:
    ${scheduleList}
    
    Task: Cek apakah user ingin MENGEDIT sebuah jadwal (ubah nama task dan/atau waktu).
    
    RULES:
    1. Jika user jelas ingin UBAH jadwal (e.g. "Ubah...", "Ganti...", "Edit..."), extract perubahannya.
    2. Return JSON: {"action": "edit", "id": <schedule_id>, "newTask": "string", "newTime": "YYYY-MM-DD HH:mm:ss"}
    3. Jika hanya task ATAU waktu yang berubah, tetap return keduanya.
    4. Jika TIDAK JELAS atau AMBIGU, return: {"action": "edit", "needsConfirmation": true, "details": "penjelasan dalam bahasa Indonesia yang singkat"}
    5. Jika BUKAN edit request, return NULL
    
    PENTING: Ketat tentang kejelasan. Jika tidak jelas jadwal mana yang diedit atau value barunya apa, minta konfirmasi.
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
