"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { PRICE_ALERT_KEY, writeFlag } from "@/lib/app-settings";
import { parsePriceListWorkbook, type PriceListEntry } from "@/lib/price-list-excel";
import { checkWatchedPrices, ensurePriceWatchListed, refreshPriceWatch, searchCompetitorLinks } from "@/lib/price-watch";
import { priceAlertMessage } from "@/lib/telegram/digest";
import { recipientsFor, sendTelegram } from "@/lib/telegram/notify";
import { fail, requireUser, type ActionResult } from "./_shared";

/** Har bir dorixona uchun ustama: yoqilgan/o'chirilgan va foizi */
const settingSchema = z.object({
  unit: z.string().min(2),
  enabled: z.boolean(),
  /** Arzonaptekada kuzatiladigan doriga ustama */
  percent: z.number().min(0).max(100),
  /** Qolgan dorilarga: tan narx ustiga qo'shiladigan foiz */
  costPercent: z.number().min(0).max(1000).default(0),
});

function revalidateAll() {
  revalidatePath("/narxlar");
  revalidatePath("/ombor");
}

export async function savePriceSetting(input: z.input<typeof settingSchema>): Promise<ActionResult> {
  try {
    await requireUser();
    const data = settingSchema.parse(input);
    await db.priceSetting.upsert({
      where: { unit: data.unit },
      update: { enabled: data.enabled, percent: data.percent, costPercent: data.costPercent },
      create: {
        unit: data.unit,
        enabled: data.enabled,
        percent: data.percent,
        costPercent: data.costPercent,
      },
    });
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Doriga arzonapteka.uz havolasini biriktirish.
 *
 * Havola bor doriga tavsiya narx raqobatchining eng arzon narxidan,
 * havolasiz doriga esa tan narxdan hisoblanadi.
 */
export async function setPriceWatchUrl(input: {
  watchId?: string | null;
  sku?: string | null;
  name: string;
  sourceUrl: string;
}): Promise<ActionResult> {
  try {
    await requireUser();
    const url = input.sourceUrl.trim();
    if (url && !/^https:\/\/arzonapteka\.uz\//.test(url)) {
      return { ok: false, error: "arzonapteka.uz havolasi bo'lishi kerak" };
    }

    await ensurePriceWatchListed();

    if (input.watchId) {
      // Havola o'zgardi — eski narx endi yaramaydi, qayta tekshiriladi.
      // Qo'lda o'chirilgan havolani avtomatik qidiruv qaytarib qo'ymasin:
      // checkedAt qo'yiladi — "izlangan, topilmadi" holati.
      await db.priceWatch.update({
        where: { id: input.watchId },
        data: {
          sourceUrl: url || null,
          sourceTitle: null,
          competitorPrice: null,
          checkedAt: url ? null : new Date(),
          ...(url ? { listed: true } : {}),
        },
      });
    } else {
      if (!url) return { ok: true };
      const name = input.name.trim().toUpperCase();
      await db.priceWatch.upsert({
        where: { name },
        update: { sourceUrl: url, sku: input.sku ?? undefined, active: true, listed: true, checkedAt: null },
        create: { name, sku: input.sku ?? null, sourceUrl: url, listed: true },
      });
    }

    revalidateAll();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Bitta doriga ustama foizi.
 *
 * Narx sozlamasi `PriceWatch` da saqlanadi. arzonapteka.uz da kuzatilmagan
 * doriga sozlama qatori hali bo'lmaydi — birinchi marta foiz qo'yilganda
 * o'sha dori uchun qator yaratiladi (havolasiz, faqat foiz uchun).
 */
export async function setDrugPercent(input: {
  watchId?: string | null;
  sku?: string | null;
  name: string;
  percent: number | null;
}): Promise<ActionResult> {
  try {
    await requireUser();
    const { percent } = input;
    if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 1000)) {
      return { ok: false, error: "Foiz 0 va 1000 orasida bo'lishi kerak" };
    }

    await ensurePriceWatchListed();

    if (input.watchId) {
      const row = await db.priceWatch.findUnique({ where: { id: input.watchId } });
      if (!row) return { ok: true };
      // Faqat foiz uchun yaratilgan qator foizsiz hech narsa saqlamaydi — o'chiramiz
      if (percent === null && !row.listed && !row.sourceUrl) {
        await db.priceWatch.delete({ where: { id: row.id } });
      } else {
        await db.priceWatch.update({ where: { id: row.id }, data: { percent } });
      }
    } else {
      if (percent === null) return { ok: true }; // o'chiradigan narsa yo'q
      const name = input.name.trim().toUpperCase();
      await db.priceWatch.upsert({
        where: { name },
        update: { percent, sku: input.sku ?? undefined, active: true },
        create: { name, sku: input.sku ?? null, percent },
      });
    }

    revalidateAll();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Qo'lda yangilash — bir chaqiruvda 12 ta dori */
export async function refreshPricesNow(): Promise<ActionResult> {
  try {
    await requireUser();
    const result = await refreshPriceWatch(12);
    revalidateAll();
    if (!result.ok && result.updated === 0 && result.linked === 0) {
      return { ok: false, error: result.errors[0] ?? "Narx olinmadi" };
    }
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Qo'shilgandan keyin shuncha dorining narxi darrov olinadi, qolgani navbat bilan */
const PRICE_NOW_LIMIT = 6;

export type PriceListResult =
  | {
      ok: true;
      added: number;
      updated: number;
      found: number;
      priced: number;
      notFound: string[];
      warnings: string[];
    }
  | { ok: false; error: string };

/**
 * Narx nazorati ro'yxatiga dori qo'shish (qo'lda yoki Excel'dan).
 *
 * Havolasi berilmagan yangi dorilar arzonapteka.uz dan darrov izlanadi:
 * topilsa birinchi bir nechtasining narxi shu zahoti olinadi, qolgani
 * navbat bilan (har 15 daqiqada). Topilmasa tavsiya "—" bo'lib turadi.
 *
 * Ro'yxatda bor dori qayta kelsa ikki marta qo'shilmaydi — berilgan
 * havola va foizi yangilanadi.
 */
async function addToPriceList(entries: PriceListEntry[], warnings: string[] = []): Promise<PriceListResult> {
  await ensurePriceWatchListed();

  const byName = new Map<string, PriceListEntry>();
  for (const entry of entries) {
    const name = entry.name.trim().replace(/\s+/g, " ").toUpperCase();
    if (name) byName.set(name, { ...entry, name });
  }
  if (!byName.size) return { ok: false, error: "Dori nomi yozilmagan" };

  const names = Array.from(byName.keys());
  const existing = await db.priceWatch.findMany({ where: { name: { in: names } } });
  const existingByName = new Map(existing.map((row) => [row.name, row]));

  const fresh = names.filter((name) => !existingByName.has(name));
  if (fresh.length) {
    await db.priceWatch.createMany({
      data: fresh.map((name) => {
        const entry = byName.get(name) as PriceListEntry;
        return { name, listed: true, sourceUrl: entry.sourceUrl ?? null, percent: entry.percent ?? null };
      }),
      skipDuplicates: true,
    });
  }

  let updated = 0;
  for (const row of existing) {
    const entry = byName.get(row.name) as PriceListEntry;
    const urlChanged = entry.sourceUrl !== undefined && entry.sourceUrl !== row.sourceUrl;
    const percentChanged = entry.percent !== undefined && entry.percent !== Number(row.percent ?? NaN);
    if (row.listed && !urlChanged && !percentChanged) continue;
    await db.priceWatch.update({
      where: { id: row.id },
      data: {
        listed: true,
        active: true,
        ...(urlChanged ? { sourceUrl: entry.sourceUrl, sourceTitle: null, competitorPrice: null, checkedAt: null } : {}),
        ...(percentChanged ? { percent: entry.percent } : {}),
      },
    });
    updated += 1;
  }

  // Havolasiz va hali izlanmagan dorilar — yangilari va ustamasi bor edi-yu
  // ro'yxatda yo'q bo'lganlari
  const toSearch = await db.priceWatch.findMany({
    where: {
      name: { in: names },
      sourceUrl: null,
      OR: [{ name: { in: fresh } }, { checkedAt: null }],
    },
    select: { id: true },
  });
  const search = toSearch.length
    ? await searchCompetitorLinks({ ids: toSearch.map((row) => row.id), priceLimit: PRICE_NOW_LIMIT })
    : null;

  revalidateAll();
  return {
    ok: true,
    added: fresh.length,
    updated,
    found: search?.found ?? 0,
    priced: search?.priced ?? 0,
    notFound: search?.notFound ?? [],
    warnings,
  };
}

/** Ro'yxatga qo'lda qo'shish: har qatorda yoki vergul bilan bitta nom */
export async function addPriceWatchNames(text: string): Promise<PriceListResult> {
  try {
    await requireUser();
    const entries = text
      .split(/[\n,;]+/)
      .map((name) => ({ name: name.trim() }))
      .filter((entry) => entry.name && entry.name.length <= 120);
    return await addToPriceList(entries);
  } catch (e) {
    return fail(e);
  }
}

/** Ro'yxatni Excel'dan yuklash — ustunlar namuna faylidagidek */
export async function importPriceWatchExcel(formData: FormData): Promise<PriceListResult> {
  try {
    await requireUser();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Fayl tanlanmagan" };
    if (!/\.xlsx$/i.test(file.name)) {
      return { ok: false, error: "Faqat .xlsx fayl (Excel). Eski .xls bo'lsa Excel'da .xlsx qilib saqlang" };
    }
    const { entries, warnings } = await parsePriceListWorkbook(await file.arrayBuffer());
    if (!entries.length) {
      return { ok: false, error: warnings[0] ?? "Faylda dori topilmadi — namunadagidek A ustunga yozing" };
    }
    return await addToPriceList(entries, warnings);
  } catch (e) {
    return fail(e);
  }
}

/**
 * Dorini ro'yxatdan o'chirish. Doriga alohida ustama qo'yilgan bo'lsa
 * qator qoladi (foizi kerak), faqat arzonapteka kuzatuvi to'xtaydi.
 */
export async function removePriceWatch(id: string): Promise<ActionResult> {
  try {
    await requireUser();
    await ensurePriceWatchListed();
    const row = await db.priceWatch.findUnique({ where: { id } });
    if (!row) return { ok: true };
    if (row.percent !== null) {
      await db.priceWatch.update({
        where: { id },
        data: { listed: false, sourceUrl: null, sourceTitle: null, competitorPrice: null, checkedAt: null },
      });
    } else {
      await db.priceWatch.delete({ where: { id } });
    }
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Arzonaptekadan qaytadan izlash — avvalgi havola noto'g'ri bo'lsa yoki topilmagan bo'lsa */
export async function searchPriceWatchAgain(id: string): Promise<PriceListResult> {
  try {
    await requireUser();
    const search = await searchCompetitorLinks({ ids: [id], priceLimit: 1 });
    revalidateAll();
    return {
      ok: true,
      added: 0,
      updated: 0,
      found: search.found,
      priced: search.priced,
      notFound: search.notFound,
      warnings: search.errors,
    };
  } catch (e) {
    return fail(e);
  }
}

/** Narx eslatmasi Telegram'ga yuborilsinmi — Narx nazorati bo'limidagi kalitcha */
export async function setPriceAlert(enabled: boolean): Promise<ActionResult> {
  try {
    await requireUser();
    await writeFlag(PRICE_ALERT_KEY, enabled);
    revalidatePath("/narxlar");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Narx eslatmasini oldindan ko'rish — tokenli havolasiz, saytning o'zida.
 * Matn eslatmadagidek (Telegram HTML: faqat <b>, <i>).
 */
export async function previewPriceAlert(): Promise<{ ok: true; text: string | null } | { ok: false; error: string }> {
  try {
    await requireUser();
    return { ok: true, text: priceAlertMessage(await checkWatchedPrices()) };
  } catch (e) {
    return fail(e);
  }
}

/**
 * Eslatmani hozir yuborish — tekshirib ko'rish uchun. Kunlik eslatma
 * jurnaliga yozilmaydi, shuning uchun ertalabki o'z vaqtida yana keladi.
 */
export async function sendPriceAlertNow(): Promise<{ ok: true; sent: number; total: number } | { ok: false; error: string }> {
  try {
    await requireUser();
    const text = priceAlertMessage(await checkWatchedPrices());
    if (!text) return { ok: false, error: "Yuboradigan narsa yo'q — hammasi tavsiyaga mos" };
    const recipients = await recipientsFor("narxlar");
    if (!recipients.length) return { ok: false, error: "Oluvchi yo'q: Telegram bog'langan admin yoki xodim topilmadi" };
    const results = await sendTelegram(
      recipients.map((r) => r.chatId),
      text,
      { buttonText: "Narxlarni ochish", section: "prices" },
    );
    const sent = results.filter((r) => r.ok).length;
    if (!sent) return { ok: false, error: results[0]?.error ?? "Yuborilmadi" };
    return { ok: true, sent, total: results.length };
  } catch (e) {
    return fail(e);
  }
}
