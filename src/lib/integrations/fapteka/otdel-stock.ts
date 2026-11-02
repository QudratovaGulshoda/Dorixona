import "server-only";
import { db } from "@/lib/db";
import type { Filial } from "@/lib/filial";
import { otdelUnitMap } from "./otdel";

type Row = Record<string, string>;

const numberValue = (value: unknown) => {
  const n = Number(String(value ?? "").replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

export type OtdelStockResult = {
  /** Mapping sozlanmagan bo'lsa null — faqat ko'rsatiladi, yozilmaydi */
  unit: Filial | null;
  otdelId: string;
  rows: number;
  stockValue: number;
  saved: boolean;
};

/**
 * SITE.exe push'idagi qoldiqni otdel bo'yicha ajratib, joriy oyning
 * `MonthlyFinance.stockValue` (astatka) maydoniga yozadi.
 *
 * Nega shu yo'l: `Product` jadvalida bitta SKU uchun bitta qator bor
 * (`@@unique([branchId, sku])`), shuning uchun ikki dorixona qoldig'i
 * u yerda qo'shilib ketadi. Bu funksiya esa Product'ga tegmasdan,
 * push paytida otdel kesimida hisoblab qo'yadi.
 *
 * Hisob: SUM(K × P) — miqdor × chakana narx. P chakana narx bo'lgani
 * uchun natija tan narxdagi astatkadan katta chiqadi.
 *
 * FAPTEKA_OTDEL_UNITS sozlanmagan bo'lsa hech narsa qilmaydi.
 */
export async function syncOtdelStockValue(rows: Row[]): Promise<OtdelStockResult[]> {
  const map = otdelUnitMap();

  // Qoldiq HAR DOIM otdel bo'yicha hisoblanadi — mapping sozlanmagan
  // bo'lsa ham. Shunda jurnalda "O=2: 1290 mln, O=3: 1215 mln" ko'rinadi
  // va qaysi otdel qaysi dorixona ekanini taxmin qilmasdan aniqlash mumkin.
  const totals = new Map<string, { unit: Filial | null; rows: number; value: number }>();
  for (const row of rows) {
    const otdelId = (row.O ?? "").trim();
    if (!otdelId) continue;

    const quantity = numberValue(row.K ?? row.Q);
    const price = numberValue(row.P);
    if (quantity <= 0) continue;

    const current = totals.get(otdelId) ?? { unit: map.get(otdelId) ?? null, rows: 0, value: 0 };
    current.rows += 1;
    current.value += quantity * price;
    totals.set(otdelId, current);
  }

  const branch = map.size > 0 ? await db.branch.findFirst({ where: { isActive: true } }) : null;

  // Oy Toshkent vaqti (UTC+5) bo'yicha: Vercel UTC'da ishlaydi va oyning
  // 1-kuni 00:00–05:00 orasidagi push'lar o'tgan oyning astatkasini
  // ustidan yozib ketardi
  const tashkent = new Date(Date.now() + 5 * 3600_000);
  const periodMonth = new Date(Date.UTC(tashkent.getUTCFullYear(), tashkent.getUTCMonth(), 1));

  const results: OtdelStockResult[] = [];
  for (const [otdelId, entry] of totals) {
    let saved = false;
    if (entry.unit && branch) {
      await db.monthlyFinance.upsert({
        where: { unit_periodMonth: { unit: entry.unit, periodMonth } },
        create: {
          unit: entry.unit,
          periodMonth,
          branchId: branch.id,
          stockValue: entry.value,
        },
        // Faqat astatka yangilanadi — savdo, foyda va pereotsenkaga tegilmaydi
        update: { stockValue: entry.value },
      });
      saved = true;
    }
    results.push({ unit: entry.unit, otdelId, rows: entry.rows, stockValue: entry.value, saved });
  }

  return results.sort((a, b) => b.stockValue - a.stockValue);
}
