import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { DEBT_DUE_SOON_DAYS, DEBT_URGENT_DAYS } from "@/lib/queries";
import { debtAlertMessage, debtSummary } from "@/lib/telegram/digest";
import { recipientsFor, sendTelegram } from "@/lib/telegram/notify";
import { isDebtAlertOn } from "@/lib/app-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Qarz muddati eslatmasi — Telegram'ga yuboriladi.
 *
 * Kim oladi: TELEGRAM_ADMIN_IDS ichidagi adminlar va "qarzlar" ruxsati bo'lgan,
 * Telegram'i bog'langan xodimlar.
 *
 * Qachon: muddat o'tgan yoki ${DEBT_URGENT_DAYS} kundan kam qolgan (qizil),
 * ${DEBT_DUE_SOON_DAYS} kundan kam qolgan (sariq) qarz bo'lsa.
 *
 * Kim chaqiradi: Vercel Cron (vercel.json) va dorixona kompyuteridagi relay
 * skript. Ikkisi ham chaqirsa ham kuniga bir marta ketadi — quyidagi
 * "bugun yuborilganmi" tekshiruvi shuni ta'minlaydi.
 *
 * Tekshirish uchun (xabar yubormaydi, faqat holatni aytadi):
 *   /api/notifications/debts?token=<FAPTEKA_SITE_TOKEN>&tekshir=1
 * Majburan qayta yuborish:
 *   /api/notifications/debts?token=<...>&majburan=1
 */

const LOG_SOURCE = "qarz-eslatma";

function allowed(request: NextRequest) {
  // Vercel Cron o'z sarlavhasini qo'yadi; qo'lda chaqirilsa token so'raladi
  if (request.headers.get("x-vercel-cron")) return true;

  const expected = process.env.CRON_SECRET?.trim() || process.env.FAPTEKA_SITE_TOKEN?.trim();
  if (!expected) return false;

  const auth = request.headers.get("authorization")?.trim();
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return bearer === expected || request.nextUrl.searchParams.get("token")?.trim() === expected;
}

/** Bugun muvaffaqiyatli yuborilganmi — takror xabar bo'lmasin */
async function alreadySentToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  try {
    const sent = await db.integrationLog.findFirst({
      where: { source: LOG_SOURCE, ok: true, createdAt: { gte: today } },
      select: { id: true, createdAt: true },
    });
    return sent;
  } catch {
    return null;
  }
}

async function log(note: string, ok: boolean, rowCount: number) {
  try {
    await db.integrationLog.create({ data: { source: LOG_SOURCE, note, ok, rowCount } });
  } catch {
    // Jurnal yozilmasa ham asosiy ish buzilmasin
  }
}

async function handle(request: NextRequest) {
  if (!allowed(request)) {
    return NextResponse.json({ ok: false, error: "Token noto'g'ri" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const dryRun = params.get("tekshir") === "1" || params.get("debug") === "1";
  const force = params.get("majburan") === "1" || params.get("force") === "1";

  const [summary, recipients, alertOn] = await Promise.all([
    debtSummary(),
    recipientsFor("qarzlar"),
    isDebtAlertOn(),
  ]);

  const red = summary.overdue.length + summary.urgent.length;
  const text = debtAlertMessage(summary);

  // Nima bo'layotganini bir qarashda ko'rish uchun
  const holat = {
    ok: true,
    jadval: summary.needsMigration ? "yaratilmagan" : "bor",
    ochiqQarz: summary.openCount,
    muddatiBor: summary.withDueDate,
    muddatiYoq: summary.noDueDate.length,
    muddatiOtgan: summary.overdue.length,
    shoshilinch: summary.urgent.length,
    muddatiYaqin: summary.soon.length,
    chegaralar: { qizil: DEBT_URGENT_DAYS, sariq: DEBT_DUE_SOON_DAYS },
    oluvchilar: recipients.map((r) => ({ chatId: r.chatId, kim: r.name, manba: r.source })),
    botToken: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim()),
    xabarBor: Boolean(text),
    eslatmaYoqilgan: alertOn,
  };

  if (dryRun) {
    return NextResponse.json({ ...holat, rejim: "tekshiruv", xabar: text });
  }

  // Dorixona egasi Qarzlar bo'limidan o'chirib qo'ygan bo'lsa yubormaymiz
  if (!alertOn) {
    return NextResponse.json({ ...holat, yuborildi: 0, sabab: "eslatma o'chirilgan" });
  }

  if (!text) {
    // Ogohlantirish yo'q — bekorga xabar yubormaymiz
    return NextResponse.json({ ...holat, yuborildi: 0, sabab: "ogohlantiradigan qarz yo'q" });
  }

  if (!recipients.length) {
    await log("oluvchi yo'q: TELEGRAM_ADMIN_IDS sozlanmagan", false, red);
    return NextResponse.json({ ...holat, yuborildi: 0, sabab: "oluvchi yo'q" });
  }

  if (!force) {
    const sent = await alreadySentToday();
    if (sent) {
      return NextResponse.json({
        ...holat,
        yuborildi: 0,
        sabab: `bugun allaqachon yuborilgan (${sent.createdAt.toISOString()})`,
      });
    }
  }

  const results = await sendTelegram(
    recipients.map((r) => r.chatId),
    text,
    { buttonText: "Qarzlarni ochish", section: "debts" },
  );

  const delivered = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);
  await log(
    `qizil: ${red}, sariq: ${summary.soon.length}, yuborildi: ${delivered}/${results.length}` +
      (failures.length ? ` | xato: ${failures.map((f) => `${f.chatId} ${f.error}`).join("; ")}` : ""),
    delivered > 0,
    red + summary.soon.length,
  );

  return NextResponse.json({ ...holat, yuborildi: delivered, natijalar: results });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
