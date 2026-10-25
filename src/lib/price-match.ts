/**
 * Dori nomini arzonapteka.uz mahsulot sahifasiga moslash.
 *
 * Saytning qidiruvi yopiq API orqali ishlaydi (robots.txt da /api/
 * taqiqlangan), shuning uchun ochiq sitemap'dagi havolalardan topamiz.
 * Havola dori nomidan lotinchaga o'girib yasalgan:
 *   ВИЗИН 0,05% 15 мл → vizin-0-05-15-ml-kapli-glaz-8985
 * Oxiridagi raqam — saytdagi mahsulot ID'si.
 *
 * Bu fayl toza funksiyalar — test qilish oson bo'lsin.
 */

/** Sayt havolasidagi o'girish: х → h, щ → sch, ц → ts */
const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
  и: "i", і: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p",
  р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh",
  щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  ў: "o", қ: "q", ғ: "g", ҳ: "h",
};

/** "МИКАРДИС ПЛЮС 80МГ №28" → ["mikardis", "plyus", "80", "mg", "28"] */
export function latinTokens(text: string) {
  const latin = Array.from(text.toLowerCase().replace(/\+/g, " plyus "), (ch) => CYRILLIC[ch] ?? ch).join("");
  return latin.match(/[a-z]+|\d+/g) ?? [];
}

export type CatalogEntry = {
  slug: string;
  /** Havoladagi so'zlar, ID'siz */
  tokens: string[];
  tokenSet: Set<string>;
  /** So'zlar chiziqchasiz qo'shib yozilgan: "mikardisplyus1258..." */
  compact: string;
};

/** Sitemap XML'dan mahsulot havolalarini oladi */
export function parseCatalog(xml: string): CatalogEntry[] {
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/\/products\/([a-z0-9-]+)<\/loc>/g)) {
    const slug = match[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    // Oxirgi bo'lak — ID, nomga kirmaydi
    const tokens = slug.split("-").slice(0, -1).filter(Boolean);
    if (!tokens.length) continue;
    entries.push({ slug, tokens, tokenSet: new Set(tokens), compact: tokens.join("") });
  }
  return entries;
}

const isNumber = (token: string) => /^\d/.test(token);

/**
 * Eng mos mahsulotni tanlaydi.
 *
 * @param name    ro'yxatdagi nom (ПРЕДНИЗОЛОН, ДЕВИТ-30000) — havola shu
 *                so'zlar bilan boshlanishi va nomdagi har bir raqam havolada
 *                bo'lishi shart
 * @param detail  ombordagi to'liq nom (ПРЕДНИЗОЛОН 5МГ ТАБ №100) — bir dori
 *                bir necha shaklda bo'lsa, qaysi biri ekanini shu hal qiladi
 * @returns       havola (slug) yoki topilmasa null
 */
export function matchCatalog(name: string, detail: string | null, catalog: CatalogEntry[]) {
  const nameTokens = latinTokens(name);
  const words = nameTokens.filter((token) => !isNumber(token));
  const numbers = nameTokens.filter(isNumber);
  if (!words.length) return null;

  const head = words.join("");
  const wanted = latinTokens(detail ?? "");

  let best: CatalogEntry | null = null;
  let bestScore = -Infinity;

  for (const entry of catalog) {
    if (!entry.compact.startsWith(head)) continue;
    if (numbers.some((number) => !entry.tokenSet.has(number))) continue;

    let score = 0;
    // Nom so'z chegarasida tugasa ("vizin-0-05"), boshqa dori emas ("vizinalergi")
    let joined = "";
    for (const token of entry.tokens) {
      joined += token;
      if (joined.length >= head.length) {
        if (joined === head) score += 3;
        break;
      }
    }
    for (const token of wanted) {
      if (entry.tokenSet.has(token)) score += isNumber(token) ? 2 : 1;
    }
    // Teng bo'lsa qisqarog'i — ortiqcha qo'shimchasiz asosiy shakl
    score -= entry.tokens.length * 0.01;

    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  return best?.slug ?? null;
}
