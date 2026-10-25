import ExcelJS from "exceljs";

/**
 * Narx nazorati ro'yxatini Excel'dan yuklash.
 *
 * Namuna fayl (buildPriceListTemplate) va o'qish (parsePriceListWorkbook)
 * bir joyda — ustunlar o'zgarsa ikkisi birga o'zgarsin.
 */

export const PRICE_LIST_SHEET = "Dorilar";
export const PRICE_LIST_COLUMNS = ["Dori nomi", "Arzonapteka havolasi", "Ustama %"] as const;
/** Bir yuklashda shuncha qatordan ortig'i o'qilmaydi */
export const PRICE_LIST_MAX_ROWS = 1000;

export type PriceListEntry = {
  name: string;
  sourceUrl?: string;
  percent?: number;
};

const ARZON_URL = /^https:\/\/arzonapteka\.uz\/(uz|ru)\/products\/[a-z0-9-]+/;

const RULES = [
  "1. Faqat «Dorilar» varag'i o'qiladi. 1-qator — sarlavha, uni o'chirmang va o'zgartirmang.",
  "2. Har bir dori — bitta qator, 2-qatordan boshlab. Bo'sh qatorlar o'tkazib yuboriladi.",
  "3. A ustun — Dori nomi (majburiy). F-Apteka'dagi nomi bilan boshlansin: РОАККУТАН, ВИЗИН, ДЕПО-МЕДРОЛ.",
  "   Nomga raqam yozsangiz (ПРЕДНИЗОЛОН 5), arzonaptekadan faqat shu raqamli mahsulot izlanadi.",
  "4. B ustun — Arzonapteka havolasi (ixtiyoriy). Bo'sh qolsa sayt o'zi izlab topadi.",
  "   To'ldirsangiz: https://arzonapteka.uz/uz/products/... ko'rinishida bo'lsin.",
  "5. C ustun — Ustama % (ixtiyoriy), faqat son: 5, 7, 10. Bo'sh qolsa dorixona sozlamasidagi foiz qo'llanadi.",
  "6. Ro'yxatda bor dori qayta yuklansa ikki marta qo'shilmaydi — havolasi va foizi yangilanadi.",
  "7. Excel'dan o'chirib bo'lmaydi: dorini saytdagi ro'yxatdan «×» tugmasi bilan o'chiring.",
  "8. Arzonaptekada topilmagan dorining tavsiya narxi «—» bo'ladi. Havolasini qo'lda biriktirsangiz narx keladi.",
];

const EXAMPLES: [string, string, number | null][] = [
  ["РОАККУТАН", "", null],
  ["ВИЗИН", "https://arzonapteka.uz/uz/products/vizin-0-05-15-ml-kapli-glaz-8985", null],
  ["КСАРЕЛТО", "", 7],
];

function styleHeader(row: ExcelJS.Row) {
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8F5F0" } };
    cell.border = { bottom: { style: "thin", color: { argb: "FF9CA3AF" } } };
  });
}

/** Yuklash uchun namuna: bo'sh «Dorilar» varag'i va «Qoidalar» */
export async function buildPriceListTemplate() {
  const wb = new ExcelJS.Workbook();

  const sheet = wb.addWorksheet(PRICE_LIST_SHEET, { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.columns = [{ width: 34 }, { width: 62 }, { width: 12 }];
  styleHeader(sheet.addRow([...PRICE_LIST_COLUMNS]));

  const rules = wb.addWorksheet("Qoidalar");
  rules.columns = [{ width: 34 }, { width: 62 }, { width: 12 }];
  rules.addRow(["Narx nazorati ro'yxatiga dori qo'shish"]).font = { bold: true, size: 13 };
  rules.addRow([]);
  for (const rule of RULES) rules.addRow([rule]);
  rules.addRow([]);
  rules.addRow(["Namuna — «Dorilar» varag'i shunday to'ldiriladi:"]).font = { bold: true };
  styleHeader(rules.addRow([...PRICE_LIST_COLUMNS]));
  for (const [name, url, percent] of EXAMPLES) rules.addRow([name, url, percent]);

  return wb.xlsx.writeBuffer();
}

function cellText(cell: ExcelJS.Cell) {
  // Havola bo'lsa ko'rinadigan matni emas, manzilining o'zi kerak
  const value = cell.value;
  if (value && typeof value === "object" && "hyperlink" in value && value.hyperlink) {
    return String(value.hyperlink).trim();
  }
  return (cell.text ?? "").trim();
}

/** Ustun sarlavhasidan qaysi ma'lumot ekanini aniqlaydi */
function columnKind(header: string): keyof PriceListEntry | null {
  const text = header.toLowerCase();
  if (/havola|ssilka|ссылк|url|link|sayt/.test(text)) return "sourceUrl";
  if (/ustama|foiz|%|наценк/.test(text)) return "percent";
  if (/nom|наимен|назван|dori|препарат/.test(text)) return "name";
  return null;
}

/**
 * Yuklangan fayldan dorilarni o'qiydi.
 *
 * Sarlavha birinchi 5 qatordan qidiriladi; topilmasa A — nom, B — havola,
 * C — foiz deb olinadi. Noto'g'ri havola yoki foiz qator tashlab
 * yuborilmaydi — faqat o'sha katak e'tiborga olinmaydi va ogohlantiriladi.
 */
export async function parsePriceListWorkbook(buffer: ArrayBuffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.getWorksheet(PRICE_LIST_SHEET) ?? wb.worksheets[0];
  if (!sheet) return { entries: [], warnings: ["Faylda varaq yo'q"] };

  const columns: Partial<Record<keyof PriceListEntry, number>> = {};
  let firstRow = 1;
  for (let rowNumber = 1; rowNumber <= Math.min(5, sheet.rowCount); rowNumber += 1) {
    const found: typeof columns = {};
    sheet.getRow(rowNumber).eachCell((cell, col) => {
      const kind = columnKind(cellText(cell));
      if (kind && !found[kind]) found[kind] = col;
    });
    if (found.name) {
      Object.assign(columns, found);
      firstRow = rowNumber + 1;
      break;
    }
  }
  if (!columns.name) Object.assign(columns, { name: 1, sourceUrl: 2, percent: 3 });

  const entries: PriceListEntry[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const lastRow = Math.min(sheet.rowCount, firstRow + PRICE_LIST_MAX_ROWS - 1);
  if (sheet.rowCount > lastRow) {
    warnings.push(`Faqat birinchi ${PRICE_LIST_MAX_ROWS} qator o'qildi`);
  }

  for (let rowNumber = firstRow; rowNumber <= lastRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const name = cellText(row.getCell(columns.name as number)).replace(/\s+/g, " ").toUpperCase();
    if (!name) continue;
    if (name.length > 120) {
      warnings.push(`${rowNumber}-qator: nom juda uzun`);
      continue;
    }
    if (seen.has(name)) continue;
    seen.add(name);

    const entry: PriceListEntry = { name };
    const url = columns.sourceUrl ? cellText(row.getCell(columns.sourceUrl)) : "";
    if (url) {
      if (ARZON_URL.test(url)) entry.sourceUrl = url.replace("/ru/products/", "/uz/products/");
      else warnings.push(`${rowNumber}-qator (${name}): havola arzonapteka.uz dan emas — sayt o'zi izlaydi`);
    }
    const percentText = columns.percent ? cellText(row.getCell(columns.percent)).replace("%", "").replace(",", ".") : "";
    if (percentText) {
      const percent = Number(percentText);
      if (Number.isFinite(percent) && percent >= 0 && percent <= 1000) entry.percent = percent;
      else warnings.push(`${rowNumber}-qator (${name}): ustama son emas — dorixona foizi qo'llanadi`);
    }
    entries.push(entry);
  }

  return { entries, warnings };
}
