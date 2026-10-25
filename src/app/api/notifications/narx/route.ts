import { NextRequest } from "next/server";
import { isPriceAlertOn } from "@/lib/app-settings";
import { checkWatchedPrices } from "@/lib/price-watch";
import { priceAlertMessage } from "@/lib/telegram/digest";
import { runDailyNotice } from "@/lib/telegram/daily-notice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Narx eslatmasi — kuniga bir marta.
 *
 * Arzonaptekada kuzatilayotgan dorilardan narxi tavsiyaga (eng arzon narx
 * + ustama) mos kelmaganlari, har dorixona uchun alohida: qaysi dorini
 * F-Apteka'da qanchaga o'zgartirish kerak. Hammasi joyida bo'lsa xabar
 * yuborilmaydi.
 *
 * Kim oladi: "narxlar" ruxsati bo'lganlar.
 * Yoqish/o'chirish: Narx nazorati bo'limidagi kalitcha.
 *
 * Tekshirish (yubormaydi): /api/notifications/narx?token=<...>&tekshir=1
 */
const SEND_AFTER_HOUR = 10;

async function handle(request: NextRequest) {
  return runDailyNotice(request, {
    source: "narx-eslatma",
    minHour: SEND_AFTER_HOUR,
    permission: "narxlar",
    buttonText: "Narxlarni ochish",
    section: "prices",
    enabled: isPriceAlertOn,
    build: async () => {
      const check = await checkWatchedPrices();
      return {
        text: priceAlertMessage(check),
        holat: {
          dorixonalar: check.units.map((unit) => ({
            dorixona: unit.unit,
            yoqilgan: unit.enabled,
            tekshirildi: unit.checked,
            tushirish: unit.lower.length,
            kotarish: unit.raise.length,
          })),
        },
      };
    },
  });
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
