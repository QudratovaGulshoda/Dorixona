import "server-only";
import { db } from "@/lib/db";
import { otdelUnitMap } from "@/lib/integrations/fapteka/otdel";
import { matchCatalog, parseCatalog, type CatalogEntry } from "@/lib/price-match";

/**
 * Narx nazorati: raqobatchidagi (arzonapteka.uz) eng arzon narxni kuzatadi.
 *
 * Narx mahsulot sahifasining ochiq ma'lumotidan olinadi — o'sha yerda
 * "narxi 264 800 soʻmdan" deb yozilgan, ya'ni Toshkentdagi eng arzon taklif.
 * Saytning yopiq API'siga tegilmaydi (robots.txt da /api/ taqiqlangan).
 *
 * Sahifalar birma-bir, orasida kutib olinadi — raqobatchi serveriga
 * ortiqcha yuk tushmasin.
 */

const REQUEST_DELAY_MS = 800;
const USER_AGENT = "EvomedApteka-PriceWatch/1.0 (+https://dorixonaa.vercel.app)";
/** Shuncha soatdan eski bo'lsa yangilanadi */
export const PRICE_STALE_HOURS = 3;

/** Narxi bor mahsulotlar ro'yxati (~43 ming havola, ~10 MB) */
const CATALOG_URL = "https://arzonapteka.uz/sitemaps/sitemap-products-priced.xml";
/** Ro'yxat bir necha soat xotirada turadi — har qo'shishda qayta yuklanmasin */
const CATALOG_TTL_MS = 6 * 3600 * 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let listedReady = false;

/**
 * PriceWatch."listed" ustuni bo'lmasa qo'shadi.
 *
 * Supabase'da qo'lda SQL ishga tushirish shart bo'lmasin — birinchi
 * chaqiruvda o'zi yaratiladi. Shu paytgacha bo'lgan qatorlardan ro'yxatga
 * havolasi borlari va foizsizlari kiradi; faqat foiz qo'yilgan qatorlar
 * (havolasiz) ro'yxatga kirmaydi — ular ombordagi dorining ustamasi.
 */
export async function ensurePriceWatchListed() {
  if (listedReady) return;
  const rows = await db.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
    WHERE table_name = 'PriceWatch' AND column_name = 'listed'
  `;
  if (!rows[0]?.n) {
    await db.$executeRaw`ALTER TABLE "PriceWatch" ADD COLUMN IF NOT EXISTS "listed" BOOLEAN NOT NULL DEFAULT false`;
    await db.$executeRaw`UPDATE "PriceWatch" SET "listed" = true WHERE "sourceUrl" IS NOT NULL OR "percent" IS NULL`;
  }
  listedReady = true;
}

/** Sahifadan eng arzon narxni va to'liq nomni oladi */
export async function fetchCompetitorPrice(url: string) {
  // O'zbekcha sahifada narx "narxi 264 800 soʻmdan" ko'rinishida yoziladi
  const target = url.replace("/ru/products/", "/uz/products/");
  const response = await fetch(target, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "uz" },
    cache: "no-store",
  });
  if (!response.ok) return { ok: false as const, error: `HTTP ${response.status}` };

  const html = await response.text();
  const description = html.match(/<meta name="description" content="([^"]{0,500})"/)?.[1] ?? "";
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";

  // 2026-10 dan sayt matni "dorixonalarida 255 000 soʻmdan" bo'ldi ("narxi"
  // so'zi yo'q) — shuning uchun avval schema.org lowPrice, matn — zaxira
  const lowPrice = html.match(/itemProp="lowPrice" content="([0-9.]+)"/i)?.[1];
  const matched =
    lowPrice ??
    description.match(/narxi\s*([0-9][0-9\s ]*)/)?.[1] ??
    description.match(/([0-9][0-9\s ]*)\s*soʻmdan/)?.[1];
  if (!matched) return { ok: false as const, error: "Narx topilmadi" };

  const price = Math.round(Number(lowPrice ?? matched.replace(/\D/g, "")));
  if (!Number.isFinite(price) || price <= 0) return { ok: false as const, error: "Narx o'qilmadi" };

  return {
    ok: true as const,
    price,
    title: title.split("—")[0].trim().slice(0, 160),
  };
}

let catalogCache: { at: number; entries: CatalogEntry[] } | null = null;

/** arzonapteka.uz dagi narxi bor mahsulotlar — ochiq sitemap'dan */
async function loadCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.entries;
  // 10 MB — Next keshiga sig'maydi, shuning uchun no-store
  const response = await fetch(CATALOG_URL, { headers: { "User-Agent": USER_AGENT }, cache: "no-store" });
  if (!response.ok) throw new Error(`arzonapteka ro'yxati: HTTP ${response.status}`);
  const entries = parseCatalog(await response.text());
  if (!entries.length) throw new Error("arzonapteka ro'yxati bo'sh keldi");
  catalogCache = { at: Date.now(), entries };
  return entries;
}

/** Nomi bo'yicha bizning tovarni topadi (F-Apteka tovarlari orasidan) */
async function findOurProduct(name: string) {
  const product = await db.product.findFirst({
    where: { isActive: true, sku: { startsWith: "FA:" }, name: { startsWith: name, mode: "insensitive" } },
    orderBy: { stock: "desc" },
    select: { sku: true },
  });
  return product?.sku ?? null;
}

/**
 * Kuzatilayotgan dorilarni ombor bilan bog'laydi.
 *
 * Avval bog'lash faqat raqobatchi narxi olingandan keyin bo'lardi. Ro'yxat
 * uch soatda 12 tadan aylanadi, shuning uchun ko'p dori uzoq vaqt "omborda
 * topilmadi" bo'lib turardi — savdosi ko'rinmagani uchun topiviy/kam
 * sotilayotganga ham ajralmasdi. Endi bog'lash narxdan mustaqil: bir
 * so'rovda hamma tovar olinadi va nomi bo'yicha xotirada solishtiriladi.
 */
export async function linkPriceWatchProducts() {
  const unlinked = await db.priceWatch.findMany({
    where: { sku: null },
    select: { id: true, name: true },
  });
  if (!unlinked.length) return { checked: 0, linked: 0 };

  const products = await db.product.findMany({
    where: { isActive: true, sku: { startsWith: "FA:" } },
    select: { sku: true, name: true, stock: true },
  });

  // Nomi eng ko'p qoldiqlisi tanlanadi — bir dori bir necha qadoqda bo'lishi mumkin
  const best = new Map<string, { sku: string; stock: number }>();
  for (const product of products) {
    const key = product.name.trim().toUpperCase();
    const current = best.get(key);
    if (!current || product.stock > current.stock) {
      best.set(key, { sku: product.sku as string, stock: product.stock });
    }
  }
  const keys = Array.from(best.keys());

  let linked = 0;
  for (const row of unlinked) {
    const name = row.name.trim().toUpperCase();
    // Avval to'liq mos kelgani, bo'lmasa shu nom bilan boshlanadigani
    const exact = best.get(name);
    let match = exact;
    if (!match) {
      let bestStock = -1;
      for (const key of keys) {
        if (!key.startsWith(name)) continue;
        const candidate = best.get(key);
        if (candidate && candidate.stock > bestStock) {
          bestStock = candidate.stock;
          match = candidate;
        }
      }
    }
    if (!match) continue;
    await db.priceWatch.update({ where: { id: row.id }, data: { sku: match.sku } });
    linked += 1;
  }

  return { checked: unlinked.length, linked };
}

/** Bitta dorining narxini saytdan olib yozadi; xato bo'lsa sababini qaytaradi */
async function updateCompetitorPrice(item: { id: string; name: string; sku: string | null; sourceUrl: string }) {
  const result = await fetchCompetitorPrice(item.sourceUrl);
  if (!result.ok) {
    // Xato bo'lsa ham vaqtini belgilaymiz, aks holda navbat tiqilib qoladi
    await db.priceWatch.update({ where: { id: item.id }, data: { checkedAt: new Date() } });
    return result.error;
  }
  const sku = item.sku ?? (await findOurProduct(item.name));
  await db.priceWatch.update({
    where: { id: item.id },
    data: {
      competitorPrice: result.price,
      sourceTitle: result.title,
      checkedAt: new Date(),
      sku,
    },
  });
  return null;
}

/**
 * Ro'yxatga yangi qo'shilgan dorilarni arzonapteka.uz dan izlaydi.
 *
 * Topilsa havolasi yoziladi va narxi navbatga tushadi (checkedAt bo'sh —
 * refreshPriceWatch birinchi bo'lib oladi). Topilmasa checkedAt qo'yiladi:
 * qayta-qayta izlanmaydi, sahifada "topilmadi" va tavsiya "—" bo'ladi.
 *
 * @param ids         shu dorilarni izlash (qayta izlash ham); bo'lmasa —
 *                    hali hech izlanmagan ro'yxatdagi dorilar
 * @param priceLimit  topilganlardan nechtasining narxi darrov olinsin
 *                    (qolgani navbat bilan, har 15 daqiqada)
 */
export async function searchCompetitorLinks(options: { ids?: string[]; priceLimit?: number } = {}) {
  await ensurePriceWatchListed();

  const where = options.ids
    ? { id: { in: options.ids } }
    : { listed: true, sourceUrl: null, checkedAt: null };
  if (!(await db.priceWatch.count({ where }))) {
    return { searched: 0, found: 0, priced: 0, notFound: [] as string[], errors: [] as string[] };
  }

  // Ombordagi to'liq nom kerak — qaysi shakl ekanini shu hal qiladi
  await linkPriceWatchProducts().catch(() => null);
  const rows = await db.priceWatch.findMany({
    where,
    select: { id: true, name: true, sku: true },
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const catalog = await loadCatalog();

  const skus = rows.map((row) => row.sku).filter((sku): sku is string => Boolean(sku));
  const products = skus.length
    ? await db.product.findMany({ where: { sku: { in: skus } }, select: { sku: true, name: true } })
    : [];
  const fullName = new Map(products.map((product) => [product.sku, product.name]));

  const found: { id: string; name: string; sku: string | null; sourceUrl: string }[] = [];
  const notFound: string[] = [];

  for (const row of rows) {
    const slug = matchCatalog(row.name, row.sku ? fullName.get(row.sku) ?? null : null, catalog);
    if (!slug) {
      notFound.push(row.name);
      await db.priceWatch.update({
        where: { id: row.id },
        data: { sourceUrl: null, sourceTitle: null, competitorPrice: null, checkedAt: new Date() },
      });
      continue;
    }
    const sourceUrl = `https://arzonapteka.uz/uz/products/${slug}`;
    await db.priceWatch.update({
      where: { id: row.id },
      data: { sourceUrl, sourceTitle: null, competitorPrice: null, checkedAt: null },
    });
    found.push({ ...row, sourceUrl });
  }

  let priced = 0;
  const errors: string[] = [];
  for (const item of found.slice(0, options.priceLimit ?? 0)) {
    try {
      const error = await updateCompetitorPrice(item);
      if (error) errors.push(`${item.name}: ${error}`);
      else priced += 1;
    } catch (error) {
      errors.push(`${item.name}: ${error instanceof Error ? error.message : "xato"}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  return { searched: rows.length, found: found.length, priced, notFound, errors };
}

/**
 * Eskirgan yozuvlarni yangilaydi. Bir chaqiruvda ozdan olamiz —
 * Vercel'ning 60 soniyasiga sig'sin va sayt ham bosim ko'rmasin.
 */
export async function refreshPriceWatch(limit = 12) {
  await ensurePriceWatchListed();

  // Bog'lash narx olinishini kutmaydi — savdo bo'yicha ajratish darrov ishlasin
  const linkResult = await linkPriceWatchProducts().catch(() => ({ checked: 0, linked: 0 }));

  const errors: string[] = [];

  // Ro'yxatga qo'shilib, hali izlanmagan dorilar — havolasi topilsa narxi
  // shu chaqiruvning o'zida navbatga tushadi
  const search = await searchCompetitorLinks().catch((error) => {
    errors.push(`qidiruv: ${error instanceof Error ? error.message : "xato"}`);
    return null;
  });

  const staleEdge = new Date(Date.now() - PRICE_STALE_HOURS * 3600 * 1000);

  const items = await db.priceWatch.findMany({
    where: {
      active: true,
      sourceUrl: { not: null },
      OR: [{ checkedAt: null }, { checkedAt: { lt: staleEdge } }],
    },
    orderBy: [{ checkedAt: { sort: "asc", nulls: "first" } }, { name: "asc" }],
    take: limit,
  });

  let updated = 0;

  for (const item of items) {
    try {
      const error = await updateCompetitorPrice({ ...item, sourceUrl: item.sourceUrl as string });
      if (error) errors.push(`${item.name}: ${error}`);
      else updated += 1;
    } catch (error) {
      errors.push(`${item.name}: ${error instanceof Error ? error.message : "xato"}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  return {
    ok: errors.length === 0,
    checked: items.length,
    updated,
    linked: linkResult.linked,
    searched: search?.searched ?? 0,
    found: search?.found ?? 0,
    errors,
  };
}

/**
 * Tavsiyadan shuncha farq qilsa eslatiladi. Kichik farq — narxni yaxlitlab
 * qo'yilgani (278 040 o'rniga 278 000), uni har kuni eslatish shart emas.
 */
export const PRICE_TOLERANCE_PERCENT = 0.5;
export const PRICE_TOLERANCE_SOM = 100;

export type PriceMismatch = {
  name: string;
  /** F-Apteka'dagi hozirgi chakana narx (shu dorixonada) */
  our: number;
  competitor: number;
  suggested: number;
  /** Doriga alohida foiz qo'yilgan bo'lsa */
  ownPercent: number | null;
  diff: number;
};

export type UnitPriceCheck = {
  unit: string;
  enabled: boolean;
  percent: number;
  /** Arzonaptekada bor va shu dorixonada qoldig'i bor dorilar */
  checked: number;
  /** Bizda qimmat — tushirish kerak */
  lower: PriceMismatch[];
  /** Bizda arzon — ko'tarish mumkin */
  raise: PriceMismatch[];
};

/**
 * Arzonaptekada kuzatilayotgan dorilar: har bir dorixonadagi narx
 * tavsiyaga (eng arzon narx + ustama) mosmi.
 *
 * Bizdagi narx SITE.exe yuborgan F-Apteka narxidan (FaptekaPrice) — har
 * dorixonaniki alohida, chunki narx F-Apteka'da dorixona bo'yicha qo'yiladi.
 */
export async function checkWatchedPrices() {
  await ensurePriceWatchListed();
  const units = otdelUnitMap();

  const [settings, rows, latest] = await Promise.all([
    db.priceSetting.findMany(),
    db.$queryRaw<
      { otdel: string; price: unknown; competitorPrice: unknown; percent: unknown; name: string }[]
    >`
      SELECT DISTINCT ON (fp.otdel, fp.fid)
             fp.otdel, fp.price, w."competitorPrice", w.percent,
             COALESCE(p.name, w.name) AS name
      FROM "PriceWatch" w
      JOIN "FaptekaPrice" fp ON w.sku = 'FA:' || fp.fid
      LEFT JOIN LATERAL (SELECT name FROM "Product" WHERE sku = w.sku LIMIT 1) p ON true
      WHERE w.active = true AND w.listed = true
        AND w."competitorPrice" IS NOT NULL AND fp.qty > 0 AND fp.price > 0
      ORDER BY fp.otdel, fp.fid, w."createdAt" ASC
    `,
    db.priceWatch.findFirst({
      where: { competitorPrice: { not: null }, checkedAt: { not: null } },
      orderBy: { checkedAt: "desc" },
      select: { checkedAt: true },
    }),
  ]);

  const result = new Map<string, UnitPriceCheck>();
  for (const unit of new Set(units.values())) {
    const setting = settings.find((s) => s.unit === unit);
    result.set(unit, {
      unit,
      enabled: setting?.enabled ?? true,
      percent: setting ? Number(setting.percent) : 5,
      checked: 0,
      lower: [],
      raise: [],
    });
  }

  for (const row of rows) {
    const unit = units.get(row.otdel);
    const check = unit ? result.get(unit) : undefined;
    if (!check || !check.enabled) continue;

    const competitor = Number(row.competitorPrice);
    const our = Number(row.price);
    const ownPercent = row.percent === null ? null : Number(row.percent);
    const suggested = Math.round(competitor * (1 + (ownPercent ?? check.percent) / 100));
    const diff = our - suggested;
    check.checked += 1;

    const tolerance = Math.max((suggested * PRICE_TOLERANCE_PERCENT) / 100, PRICE_TOLERANCE_SOM);
    if (Math.abs(diff) <= tolerance) continue;
    const item = { name: row.name, our, competitor, suggested, ownPercent, diff };
    (diff > 0 ? check.lower : check.raise).push(item);
  }

  // Farqi (foizda) kattasi tepada
  const byGap = (a: PriceMismatch, b: PriceMismatch) =>
    Math.abs(b.diff) / b.suggested - Math.abs(a.diff) / a.suggested;
  for (const check of result.values()) {
    check.lower.sort(byGap);
    check.raise.sort(byGap);
  }

  return { units: Array.from(result.values()), checkedAt: latest?.checkedAt ?? null };
}
