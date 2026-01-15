require("dotenv").config();
const { Groq } = require("groq-sdk");
const PDFDocument = require("pdfkit");
const fs = require("fs");
const path = require("path");

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
  const today = now.toLocaleString("sv-SE", { timeZone: "Asia/Jakarta" });

  return {
    today: today.split(" ")[0],
    todayFormatted: new Date().toLocaleDateString("id-ID", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Jakarta",
    }),
  };
}

async function parseFinanceInput(message) {
  const { today, todayFormatted } = getContextDates();

  const systemPrompt = `
    Context:
    - Today: ${todayFormatted}
    - Today Date: ${today}
    
    Role: Strict Finance Parser.
    Task: Extract finance data from user input.
    
    RULES:
    1. If user is asking for balance/summary (e.g. "berapa sisa saldo", "pengeluaran hari ini"), return {"action": "query", "queryType": "..."} where queryType can be: "balance", "today_expenses", "today_income", "summary"
    2. If user is recording a transaction (e.g. "beli cilok 2k", "dapat gaji 5jt"), extract: amount (in rupiah), type (pengeluaran/pemasukan), category, description
    3. JSON Format for recording: {"action": "record", "amount": number, "type": "pengeluaran|pemasukan", "category": "string", "description": "string"}
    4. JSON Format for query: {"action": "query", "queryType": "balance|today_expenses|today_income|summary"}
    5. IMPORTANT: Amount should be numeric only (remove "k", "jt", "rb" and convert to rupiah)
    
    EXAMPLES:
    - "beli cilok 2k" → {"action": "record", "amount": 2000, "type": "pengeluaran", "category": "makanan", "description": "beli cilok"}
    - "dapat gaji 5jt" → {"action": "record", "amount": 5000000, "type": "pemasukan", "category": "gaji", "description": "dapat gaji"}
    - "berapa sisa saldo" → {"action": "query", "queryType": "balance"}
    - "pengeluaran hari ini" → {"action": "query", "queryType": "today_expenses"}
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
      return parsed;
    } catch {
      return null;
    }
  } catch (error) {
    console.error("Error parsing finance:", error.message);
    return null;
  }
}

async function handleFinanceRecord(db, sock, userId, remoteJid, financeData) {
  const { addFinance } = require("./database");

  try {
    const id = await addFinance(
      db,
      userId,
      financeData.amount,
      financeData.type,
      financeData.category,
      financeData.description
    );

    let symbol = financeData.type === "pengeluaran" ? "💸" : "💰";
    let typeText =
      financeData.type === "pengeluaran" ? "Pengeluaran" : "Pemasukan";

    const response = `${symbol} *${typeText} Tercatat!*\n\n📝: ${
      financeData.description
    }\n💵: Rp ${financeData.amount.toLocaleString("id-ID")}\n🏷️: ${
      financeData.category
    }`;

    await sock.sendMessage(remoteJid, { text: response });
    console.log(
      `[FINANCE SUCCESS] Recorded! Type: ${financeData.type} | Amount: ${financeData.amount} | User: ${userId}`
    );
    return true;
  } catch (error) {
    console.error("Error recording finance:", error.message);
    await sock.sendMessage(remoteJid, {
      text: "❌ Gagal mencatat transaksi, coba lagi ya!",
    });
    return false;
  }
}

async function handleFinanceQuery(db, sock, userId, remoteJid, queryType) {
  const { getFinancesSummary, getTodayFinances } = require("./database");

  try {
    if (queryType === "balance") {
      const summary = await getFinancesSummary(db, userId);

      let pemasukan = 0;
      let pengeluaran = 0;

      summary.forEach((row) => {
        if (row.type === "pemasukan") pemasukan = parseFloat(row.total);
        else if (row.type === "pengeluaran")
          pengeluaran = parseFloat(row.total);
      });

      const saldo = pemasukan - pengeluaran;

      let response = `💰 *RINGKASAN SALDO*\n\n`;
      response += `💵 Pemasukan Total: Rp ${pemasukan.toLocaleString(
        "id-ID"
      )}\n`;
      response += `💸 Pengeluaran Total: Rp ${pengeluaran.toLocaleString(
        "id-ID"
      )}\n`;
      response += `━━━━━━━━━━━━━━━━━\n`;
      response += `📊 Saldo Akhir: Rp ${saldo.toLocaleString("id-ID")}`;

      await sock.sendMessage(remoteJid, { text: response });
    } else if (queryType === "today_expenses") {
      const todayFinances = await getTodayFinances(db, userId);
      const expenses = todayFinances.filter((f) => f.type === "pengeluaran");

      if (expenses.length === 0) {
        await sock.sendMessage(remoteJid, {
          text: "✅ Tidak ada pengeluaran hari ini!",
        });
        return true;
      }

      let totalExpense = 0;
      let response = `💸 *PENGELUARAN HARI INI*\n\n`;

      expenses.forEach((expense, index) => {
        totalExpense += parseFloat(expense.amount);
        const time = new Date(expense.transaction_time).toLocaleTimeString(
          "id-ID",
          {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Asia/Jakarta",
          }
        );
        response += `${index + 1}. ${expense.description} (${
          expense.category
        })\n   💵 Rp ${parseFloat(expense.amount).toLocaleString(
          "id-ID"
        )} - ${time}\n\n`;
      });

      response += `━━━━━━━━━━━━━━━━━\n`;
      response += `📊 Total Pengeluaran: Rp ${totalExpense.toLocaleString(
        "id-ID"
      )}`;

      await sock.sendMessage(remoteJid, { text: response });
    } else if (queryType === "today_income") {
      const todayFinances = await getTodayFinances(db, userId);
      const income = todayFinances.filter((f) => f.type === "pemasukan");

      if (income.length === 0) {
        await sock.sendMessage(remoteJid, {
          text: "ℹ️ Tidak ada pemasukan hari ini!",
        });
        return true;
      }

      let totalIncome = 0;
      let response = `💰 *PEMASUKAN HARI INI*\n\n`;

      income.forEach((item, index) => {
        totalIncome += parseFloat(item.amount);
        const time = new Date(item.transaction_time).toLocaleTimeString(
          "id-ID",
          {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Asia/Jakarta",
          }
        );
        response += `${index + 1}. ${item.description} (${
          item.category
        })\n   💵 Rp ${parseFloat(item.amount).toLocaleString(
          "id-ID"
        )} - ${time}\n\n`;
      });

      response += `━━━━━━━━━━━━━━━━━\n`;
      response += `📊 Total Pemasukan: Rp ${totalIncome.toLocaleString(
        "id-ID"
      )}`;

      await sock.sendMessage(remoteJid, { text: response });
    } else if (queryType === "summary") {
      const summary = await getFinancesSummary(db, userId);
      const todayFinances = await getTodayFinances(db, userId);

      let pemasukan = 0;
      let pengeluaran = 0;
      let todayExpense = 0;
      let todayIncome = 0;

      summary.forEach((row) => {
        if (row.type === "pemasukan") pemasukan = parseFloat(row.total);
        else if (row.type === "pengeluaran")
          pengeluaran = parseFloat(row.total);
      });

      todayFinances.forEach((item) => {
        if (item.type === "pemasukan") todayIncome += parseFloat(item.amount);
        else todayExpense += parseFloat(item.amount);
      });

      const saldo = pemasukan - pengeluaran;

      let response = `📊 *RINGKASAN KEUANGAN*\n\n`;
      response += `*TOTAL:*\n`;
      response += `💰 Pemasukan: Rp ${pemasukan.toLocaleString("id-ID")}\n`;
      response += `💸 Pengeluaran: Rp ${pengeluaran.toLocaleString("id-ID")}\n`;
      response += `📊 Saldo: Rp ${saldo.toLocaleString("id-ID")}\n\n`;
      response += `*HARI INI:*\n`;
      response += `💰 Pemasukan: Rp ${todayIncome.toLocaleString("id-ID")}\n`;
      response += `💸 Pengeluaran: Rp ${todayExpense.toLocaleString(
        "id-ID"
      )}\n`;
      response += `📊 Neto: Rp ${(todayIncome - todayExpense).toLocaleString(
        "id-ID"
      )}`;

      await sock.sendMessage(remoteJid, { text: response });
    }

    return true;
  } catch (error) {
    console.error("Error querying finance:", error.message);
    await sock.sendMessage(remoteJid, {
      text: "❌ Gagal mengambil data, coba lagi ya!",
    });
    return false;
  }
}
async function generateAISuggestion(
  monthlyIncome,
  monthlyExpense,
  monthlyNet,
  expensesByCategory
) {
  try {
    const topExpenses = expensesByCategory
      .slice(0, 3)
      .map(
        (cat) =>
          `${cat.category}: Rp ${parseFloat(cat.total).toLocaleString("id-ID")}`
      )
      .join(", ");

    const savingPercentage =
      monthlyIncome > 0 ? ((monthlyNet / monthlyIncome) * 100).toFixed(1) : 0;

    const prompt = `
Analyze the monthly financial data below and provide detailed financial insights with specific data references:

- Monthly Income: Rp ${monthlyIncome.toLocaleString("id-ID")}
- Monthly Expense: Rp ${monthlyExpense.toLocaleString("id-ID")}
- Net (Remaining): Rp ${monthlyNet.toLocaleString("id-ID")}
- Saving Rate: ${savingPercentage}%
- Top Expenses: ${topExpenses}

Provide 2-3 analytical financial observations in Indonesian with max 400 characters or 50 words. Include specific numbers, percentages, and categories in your analysis. Focus on data-driven insights about spending patterns and financial health and suggest ways to improve. Be direct and informative, not casual. DONT GIVE "*" SYMBOLS AT ANY COST. user paragraph, don't use bullet or numbering points.`;

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      model: "openai/gpt-oss-120b",
      temperature: 0.5,
    });

    const suggestion = completion.choices[0]?.message?.content || "";
    return suggestion.trim();
  } catch (error) {
    console.error("Error generating AI suggestion:", error.message);
    return "";
  }
}

async function generateMonthlyReport(db, sock, userId, remoteJid, year, month) {
  try {
    console.log(`[REPORT] Generating report for ${userId}, ${year}-${month}`);

    const {
      getMonthlyFinances,
      getMonthlyExpensesByCategory,
      getFinancesSummary,
    } = require("./database");

    const monthlyData = await getMonthlyFinances(db, userId, year, month);
    const expensesByCategory = await getMonthlyExpensesByCategory(
      db,
      userId,
      year,
      month
    );
    const totalSummary = await getFinancesSummary(db, userId);

    if (monthlyData.length === 0 && totalSummary.length === 0) {
      await sock.sendMessage(remoteJid, {
        text: "ℹ️ Belum ada data keuangan untuk bulan ini. Mulai catat transaksi dulu ya!",
      });
      return false;
    }

    // --- CALCULATION SECTION ---
    let monthlyIncome = 0;
    let monthlyExpense = 0;

    monthlyData.forEach((item) => {
      if (item.type === "pemasukan") {
        monthlyIncome += parseFloat(item.amount);
      } else {
        monthlyExpense += parseFloat(item.amount);
      }
    });

    const monthlyNet = monthlyIncome - monthlyExpense;

    const reportDir = path.join(__dirname, "reports");
    if (!fs.existsSync(reportDir)) {
      fs.mkdirSync(reportDir);
    }

    const monthName = new Date(year, month - 1).toLocaleDateString("id-ID", {
      month: "long",
      year: "numeric",
    });

    const fileName = `Financial_Report_${year}-${String(month).padStart(
      2,
      "0"
    )}_${userId.replace(/@.*/, "")}.pdf`;
    const filePath = path.join(reportDir, fileName);

    const doc = new PDFDocument({
      size: "A4",
      margin: 50,
      autoFirstPage: true,
    });

    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);

    const colors = {
      primary: "#2c3e50",
      accent: "#3498db",
      success: "#27ae60",
      danger: "#c0392b",
      tableHeader: "#ecf0f1",
      tableStripe: "#f9f9f9",
      text: "#333333",
    };

    doc.rect(0, 0, 595.28, 100).fill(colors.primary);

    doc
      .fontSize(24)
      .fillColor("white")
      .font("Helvetica-Bold")
      .text("LAPORAN KEUANGAN", 50, 35);

    doc.fontSize(12).font("Helvetica").text(`Periode: ${monthName}`, 50, 65);

    doc
      .fontSize(10)
      .text(`Generated for: ${userId.split("@")[0]}`, 400, 35, {
        align: "right",
        width: 150,
      })
      .text(`Date: ${new Date().toLocaleDateString("id-ID")}`, 400, 50, {
        align: "right",
        width: 150,
      });

    // Reset color
    doc.fillColor(colors.text);
    doc.moveDown(5);

    const startY = 130;
    const boxWidth = 150;
    const boxHeight = 60;

    const drawSummaryBox = (x, title, value, color) => {
      doc.roundedRect(x, startY, boxWidth, boxHeight, 5).stroke(color);

      doc
        .fontSize(10)
        .fillColor(colors.text)
        .font("Helvetica")
        .text(title, x + 10, startY + 10);

      doc
        .fontSize(14)
        .fillColor(color)
        .font("Helvetica-Bold")
        .text(`Rp ${value.toLocaleString("id-ID")}`, x + 10, startY + 30);
    };

    drawSummaryBox(50, "Total Pemasukan", monthlyIncome, colors.success);
    drawSummaryBox(220, "Total Pengeluaran", monthlyExpense, colors.danger);
    drawSummaryBox(
      390,
      "Sisa Saldo (Net)",
      monthlyNet,
      monthlyNet >= 0 ? colors.accent : colors.danger
    );

    doc.moveDown(6);
    doc.y = 220;

    if (expensesByCategory.length > 0) {
      doc
        .fontSize(12)
        .fillColor(colors.primary)
        .font("Helvetica-Bold")
        .text("Rincian Pengeluaran per Kategori");
      doc.moveDown(0.5);

      let catY = doc.y;
      expensesByCategory.slice(0, 5).forEach((cat) => {
        const catTotal = parseFloat(cat.total);
        const percent = (catTotal / monthlyExpense) * 100;

        doc
          .fontSize(10)
          .fillColor(colors.text)
          .font("Helvetica")
          .text(cat.category, 50, catY);
        doc.text(`Rp ${catTotal.toLocaleString("id-ID")}`, 150, catY);
        doc.text(`${percent.toFixed(1)}%`, 250, catY);

        const barWidth = Math.min(percent * 2, 200);
        doc.rect(300, catY + 2, barWidth, 6).fill(colors.danger);
        doc.fillColor(colors.text);

        catY += 15;
      });
      doc.y = catY + 20;
    }

    doc
      .fontSize(12)
      .fillColor(colors.primary)
      .font("Helvetica-Bold")
      .text("Mutasi Transaksi", 50, doc.y);
    doc.moveDown(0.5);

    const tableTop = doc.y;
    const itemHeight = 20;

    const colX = { date: 50, desc: 130, cat: 300, type: 400, amt: 480 };
    const colW = { date: 70, desc: 160, cat: 90, type: 70, amt: 70 };
    doc.rect(50, tableTop, 500, 20).fill(colors.primary);
    doc.fillColor("white").fontSize(9).font("Helvetica-Bold");
    doc.text("TANGGAL", colX.date + 5, tableTop + 5);
    doc.text("DESKRIPSI", colX.desc + 5, tableTop + 5);
    doc.text("KATEGORI", colX.cat + 5, tableTop + 5);
    doc.text("TIPE", colX.type + 5, tableTop + 5);
    doc.text("JUMLAH", colX.amt, tableTop + 5, {
      align: "right",
      width: colW.amt,
    });

    let currentY = tableTop + 20;
    doc.fillColor(colors.text).font("Helvetica");

    monthlyData.forEach((trans, i) => {
      if (currentY > 750) {
        doc.addPage();
        currentY = 50;
        doc.rect(50, currentY, 500, 20).fill(colors.primary);
        doc.fillColor("white").fontSize(9).font("Helvetica-Bold");
        doc.text("TANGGAL", colX.date + 5, currentY + 5);
        doc.text("DESKRIPSI", colX.desc + 5, currentY + 5);
        doc.text("KATEGORI", colX.cat + 5, currentY + 5);
        doc.text("TIPE", colX.type + 5, currentY + 5);
        doc.text("JUMLAH", colX.amt, currentY + 5, {
          align: "right",
          width: colW.amt,
        });
        doc.fillColor(colors.text).font("Helvetica");
        currentY += 20;
      }

      if (i % 2 === 0) {
        doc.rect(50, currentY, 500, itemHeight).fill(colors.tableStripe);
      }
      doc.fillColor(colors.text);

      const dateStr = new Date(trans.transaction_time).toLocaleDateString(
        "id-ID",
        { day: "2-digit", month: "short" }
      );
      const amountStr = parseFloat(trans.amount).toLocaleString("id-ID");
      const typeStr = trans.type === "pemasukan" ? "Pemasukan" : "Pengeluaran";
      const typeColor =
        trans.type === "pemasukan" ? colors.success : colors.danger;

      doc.fontSize(8);

      doc.text(dateStr, colX.date + 5, currentY + 6);
      doc.text(trans.description.substring(0, 35), colX.desc + 5, currentY + 6);
      doc.text(trans.category, colX.cat + 5, currentY + 6);

      doc.fillColor(typeColor).text(typeStr, colX.type + 5, currentY + 6);
      doc.fillColor(colors.text).text(amountStr, colX.amt, currentY + 6, {
        align: "right",
        width: colW.amt,
      });

      currentY += itemHeight;
    });

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.fontSize(8).fillColor("#aaaaaa");
      doc.text(
        `Page ${i + 1} of ${range.count} - Generated by Xeyla Finance Bot`,
        50,
        doc.page.height - 30,
        { align: "center", width: 500 }
      );
    }

    doc.end();

    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    console.log(`[REPORT] PDF created: ${filePath}`);

    const aiSuggestion = await generateAISuggestion(
      monthlyIncome,
      monthlyExpense,
      monthlyNet,
      expensesByCategory
    );

    const caption = `📊 *LAPORAN KEUANGAN ${monthName.toUpperCase()}*\n\n💰 Income: Rp ${monthlyIncome.toLocaleString(
      "id-ID"
    )}\n💸 Expense: Rp ${monthlyExpense.toLocaleString(
      "id-ID"
    )}\n⚖️ Net: Rp ${monthlyNet.toLocaleString(
      "id-ID"
    )}\n\n💡 *Suggestion dari AI:*\n${aiSuggestion}`;

    const pdfBuffer = fs.readFileSync(filePath);
    await sock.sendMessage(remoteJid, {
      document: pdfBuffer,
      mimetype: "application/pdf",
      fileName: fileName,
      caption: caption,
    });

    return true;
  } catch (error) {
    console.error("Error generating report:", error);
    await sock.sendMessage(remoteJid, {
      text: `❌ Yah, gagal bikin report nih: ${error.message}`,
    });
    return false;
  }
}
module.exports = {
  parseFinanceInput,
  handleFinanceRecord,
  handleFinanceQuery,
  generateMonthlyReport,
  generateAISuggestion,
};
