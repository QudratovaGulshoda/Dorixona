import "server-only";
import { db } from "@/lib/db";

/**
 * Kichik yoqilgan/o'chirilgan sozlamalar.
 *
 * Jadval birinchi yozishda o'zi yaratiladi (UserPermission kabi), shuning
 * uchun Supabase'da qo'lda SQL ishga tushirish kerak emas. O'qishda jadval
 * hali bo'lmasa xato bermaydi — standart qiymat qaytadi.
 */

export async function ensureSettingTable() {
  await db.$executeRaw`
    CREATE TABLE IF NOT EXISTS "AppSetting" (
      "key"       TEXT PRIMARY KEY,
      "value"     TEXT NOT NULL,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

export async function readFlag(key: string, fallback: boolean) {
  try {
    const rows = await db.$queryRaw<{ value: string }[]>`
      SELECT "value" FROM "AppSetting" WHERE "key" = ${key}
    `;
    if (!rows.length) return fallback;
    return rows[0].value === "1";
  } catch {
    // Jadval hali yo'q — standart qiymat
    return fallback;
  }
}

export async function writeFlag(key: string, value: boolean) {
  await ensureSettingTable();
  await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value") VALUES (${key}, ${value ? "1" : "0"})
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = CURRENT_TIMESTAMP
  `;
}

/**
 * Qarz eslatmasi Telegram'ga yuborilsinmi.
 *
 * Standart holat — O'CHIQ. Dorixona egasi eslatmani qachon kerakligini
 * o'zi hal qiladi: Qarzlar bo'limidagi kalitcha bilan yoqadi.
 */
export const DEBT_ALERT_KEY = "qarz-eslatma";

export async function isDebtAlertOn() {
  return readFlag(DEBT_ALERT_KEY, false);
}
