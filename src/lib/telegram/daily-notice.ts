import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { AppPermission } from "@/lib/permissions";
import { recipientsFor, sendTelegram } from "./notify";

/**
 * Kunlik Telegram eslatmalari uchun umumiy qism.
 *
 * Har bir eslatma o'z sahifasida faqat matnini yasaydi, qolgan hammasi —
 * ruxsat, oluvchilar, kuniga bir marta yuborish, jurnalga yozish — shu
 * yerda. Uch joyda bir xil kod takrorlanmasin.
 *
 * Nega "soatdan keyin": eslatmani relay chaqiradi, u esa har 15 daqiqada
 * ishlaydi. Shuning uchun endpoint o'zi qaraydi — Toshkent vaqti bilan
 * kerakli soat bo'ldimi va bugun yuborilganmi.
 */

const TZ = "Asia/Tashkent";

/** Toshkent vaqti bilan hozirgi soat (0–23) */
export function tashkentHour(now = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(now),
  );
}

/** Toshkent kunining boshi (UTC lahza sifatida) */
export function tashkentDayStart(now = new Date()) {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(now)
    .split("-")
    .map(Number);
  // Toshkent UTC+5, yozgi vaqt yo'q
  return new Date(Date.UTC(year, month - 1, day) - 5 * 3600 * 1000);
}

function allowed(request: NextRequest) {
  if (request.headers.get("x-vercel-cron")) return true;
  const expected = process.env.CRON_SECRET?.trim() || process.env.FAPTEKA_SITE_TOKEN?.trim();
  if (!expected) return false;
  const auth = request.headers.get("authorization")?.trim();
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return bearer === expected || request.nextUrl.searchParams.get("token")?.trim() === expected;
}

async function sentToday(source: string) {
  try {
    return await db.integrationLog.findFirst({
      where: { source, ok: true, createdAt: { gte: tashkentDayStart() } },
      select: { createdAt: true },
    });
  } catch {
    return null;
  }
}

export type NoticeOptions = {
  /** Jurnaldagi nom, masalan "kunlik-xulosa" */
  source: string;
  /** Toshkent vaqti bilan shu soatdan keyin yuboriladi */
  minHour: number;
  /** Kim oladi */
  permission: AppPermission;
  buttonText: string;
  section: string;
  /** Sahifadagi kalitcha bilan o'chirilgan bo'lsa false — xabar ketmaydi */
  enabled?: () => Promise<boolean>;
  /** Xabar matni; ogohlantiradigan narsa bo'lmasa null */
  build: () => Promise<{ text: string | null; holat: Record<string, unknown> }>;
};

export async function runDailyNotice(request: NextRequest, options: NoticeOptions) {
  if (!allowed(request)) {
    return NextResponse.json({ ok: false, error: "Token noto'g'ri" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const dryRun = params.get("tekshir") === "1";
  const force = params.get("majburan") === "1";

  const hour = tashkentHour();
  const [{ text, holat }, recipients, enabled] = await Promise.all([
    options.build(),
    recipientsFor(options.permission),
    options.enabled ? options.enabled() : true,
  ]);

  const javob = {
    ok: true,
    soat: hour,
    kerakliSoat: options.minHour,
    xabarBor: Boolean(text),
    oluvchilar: recipients.map((r) => ({ chatId: r.chatId, kim: r.name, manba: r.source })),
    eslatmaYoqilgan: enabled,
    ...holat,
  };

  if (dryRun) return NextResponse.json({ ...javob, rejim: "tekshiruv", xabar: text });
  if (!enabled) return NextResponse.json({ ...javob, yuborildi: 0, sabab: "eslatma o'chirilgan" });
  if (!text) return NextResponse.json({ ...javob, yuborildi: 0, sabab: "aytadigan narsa yo'q" });
  if (!force && hour < options.minHour) {
    return NextResponse.json({ ...javob, yuborildi: 0, sabab: `hali erta (${options.minHour}:00 dan keyin)` });
  }
  if (!recipients.length) {
    return NextResponse.json({ ...javob, yuborildi: 0, sabab: "oluvchi yo'q" });
  }
  if (!force) {
    const sent = await sentToday(options.source);
    if (sent) {
      return NextResponse.json({
        ...javob,
        yuborildi: 0,
        sabab: `bugun yuborilgan (${sent.createdAt.toISOString()})`,
      });
    }
  }

  const results = await sendTelegram(
    recipients.map((r) => r.chatId),
    text,
    { buttonText: options.buttonText, section: options.section },
  );
  const delivered = results.filter((r) => r.ok).length;
  const failures = results.filter((r) => !r.ok);

  try {
    await db.integrationLog.create({
      data: {
        source: options.source,
        rowCount: delivered,
        note:
          `yuborildi: ${delivered}/${results.length}` +
          (failures.length ? ` | xato: ${failures.map((f) => `${f.chatId} ${f.error}`).join("; ")}` : ""),
        ok: delivered > 0,
      },
    });
  } catch {
    // Jurnal yozilmasa ham xabar ketgan
  }

  return NextResponse.json({ ...javob, yuborildi: delivered, natijalar: results });
}
