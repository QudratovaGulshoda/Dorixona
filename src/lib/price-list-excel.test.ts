import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";

import { buildPriceListTemplate, parsePriceListWorkbook, PRICE_LIST_SHEET } from "./price-list-excel";

async function fill(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildPriceListTemplate()) as ArrayBuffer);
  const sheet = wb.getWorksheet(PRICE_LIST_SHEET)!;
  for (const row of rows) sheet.addRow(row);
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}

test("bo'sh namunada dori yo'q, namuna qatorlari o'qilmaydi", async () => {
  const result = await parsePriceListWorkbook((await buildPriceListTemplate()) as ArrayBuffer);
  assert.deepEqual(result, { entries: [], warnings: [] });
});

test("to'ldirilgan namunani o'qiydi", async () => {
  const result = await parsePriceListWorkbook(
    await fill([
      ["роаккутан  20", "", ""],
      ["ВИЗИН", { text: "havola", hyperlink: "https://arzonapteka.uz/ru/products/vizin-0-05-15-ml-kapli-glaz-8985" }, ""],
      ["КСАРЕЛТО", "", "7,5%"],
      [],
      ["РОАККУТАН 20", "", ""],
    ]),
  );
  assert.deepEqual(result.entries, [
    { name: "РОАККУТАН 20" },
    { name: "ВИЗИН", sourceUrl: "https://arzonapteka.uz/uz/products/vizin-0-05-15-ml-kapli-glaz-8985" },
    { name: "КСАРЕЛТО", percent: 7.5 },
  ]);
  assert.deepEqual(result.warnings, []);
});

test("noto'g'ri havola va foiz dorini tashlamaydi, ogohlantiradi", async () => {
  const result = await parsePriceListWorkbook(await fill([["ФОРТРАНС", "https://google.com", "abc"]]));
  assert.deepEqual(result.entries, [{ name: "ФОРТРАНС" }]);
  assert.equal(result.warnings.length, 2);
});

test("sarlavhasiz faylda A — nom, B — havola, C — foiz", async () => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Varaq1");
  sheet.addRow(["ДЕПО-МЕДРОЛ"]);
  sheet.addRow(["ФОРТРАНС", "", 3]);
  const result = await parsePriceListWorkbook((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  assert.deepEqual(result.entries, [{ name: "ДЕПО-МЕДРОЛ" }, { name: "ФОРТРАНС", percent: 3 }]);
});
