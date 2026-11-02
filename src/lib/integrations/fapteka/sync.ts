import { randomUUID } from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { fetchFaptekaReport, getFaptekaConfig, numberValue, dateValue, type FaptekaRow } from "./client";
import type { Filial } from "@/lib/filial";
import { categoryFromName, FAPTEKA_DEFAULT_CATEGORY } from "./category";
import { buildIncomingExpenseEntries, expenseGroupKey } from "./expense-helpers";
import {
  FAPTEKA_EXPENSE_MARK,
  FAPTEKA_EXPENSE_PREFIX_OLD,
  FAPTEKA_RECEIPT_PREFIX,
  FAPTEKA_REPORTS,
  FAPTEKA_SKU_PREFIX,
  faptekaExpenseTitle,
  faptekaReceipt,
  faptekaSku,
  type FaptekaReportKey,
} from "./mapping";
import { otdelUnitMap } from "./otdel";
import { isDebtSupplier } from "./debt-suppliers";

export type FaptekaSyncMode = "catalog" | "movements" | "sales" | "all";

export type FaptekaSyncSummary = {
  ok: boolean;
  mode: FaptekaSyncMode;
  dateFrom: string;
  dateTo: string;
  catalogRows: number;
  stockRows: number;
  productsUpserted: number;
  movementRows: number;
  movementsCreated: number;
  expenseRows: number;
  expensesCreated: number;
  saleRows: number;
  salesUpserted: number;
  /** Kirim qaysi dorixonalarga yozildi: "Yunusobod: 12, Umumiy: 3" */
  expenseUnits?: string;
  errors: string[];
};

export type FaptekaSitePushSummary = {
  ok: boolean;
  receivedRows: number;
  productsUpserted: number;
  skippedRows: number;
  /** Push'da yo'q (tugagan) dorilar — qoldig'i 0 ga tushirildi */
  stockZeroed: number;
  errors: string[];
};

type StockInfo = {
  stock: number;
  salePrice: number;
  expiryDate: Date | null;
};

type FaptekaSiteProductInput = {
  name: string;
  sku: string;
  unit: string;
  salePrice: number;
  stock: number;
  branchId: string;
};

function isoDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Sana noto'g'ri");
  return date.toISOString().slice(0, 10);
}

function endExclusive(value: string) {
  const date = new Date(value);
  date.setDate(date.getDate() + 1);
  return date;
}

function makeSummary(mode: FaptekaSyncMode, dateFrom: string, dateTo: string): FaptekaSyncSummary {
  return {
    ok: true,
    mode,
    dateFrom,
    dateTo,
    catalogRows: 0,
    stockRows: 0,
    productsUpserted: 0,
    movementRows: 0,
    movementsCreated: 0,
    expenseRows: 0,
    expensesCreated: 0,
    saleRows: 0,
    salesUpserted: 0,
    errors: [],
  };
}

function rowId(row: Record<string, string>, idKey: "I" | "G" = "G") {
  return row[idKey]?.trim();
}

function stockCount(value: unknown) {
  const quantity = numberValue(value);
  if (quantity > 0 && quantity < 1) return 1;
  return Math.max(0, Math.round(quantity));
}

function addError(summary: FaptekaSyncSummary, error: unknown) {
  summary.ok = false;
  summary.errors.push(error instanceof Error ? error.message : "Noma'lum xatolik");
}

function groupStockRows(rows: Record<string, string>[]) {
  const map = new Map<string, StockInfo>();
  for (const row of rows) {
    const id = rowId(row, "G");
    if (!id) continue;
    const existing = map.get(id) ?? { stock: 0, salePrice: 0, expiryDate: null };
    const expiryDate = dateValue(row.E);
    map.set(id, {
      stock: existing.stock + numberValue(row.Q),
      salePrice: Math.max(existing.salePrice, numberValue(row.P)),
      expiryDate:
        expiryDate && (!existing.expiryDate || expiryDate < existing.expiryDate)
          ? expiryDate
          : existing.expiryDate,
    });
  }
  return map;
}

async function syncCatalogAndStock(input: {
  branchId: string;
  dateFrom: string;
  dateTo: string;
  summary: FaptekaSyncSummary;
}) {
  const config = getFaptekaConfig();
  const [catalog, stock] = await Promise.all([
    fetchFaptekaReport({ report: "catalog", dateFrom: input.dateFrom, dateTo: input.dateTo, config }),
    fetchFaptekaReport({ report: "stock", dateFrom: input.dateFrom, dateTo: input.dateTo, config }),
  ]);

  input.summary.catalogRows += catalog.rows.length;
  input.summary.stockRows += stock.rows.length;

  const catalogById = new Map<string, Record<string, string>>();
  for (const row of catalog.rows) {
    const id = rowId(row, "I");
    if (id) catalogById.set(id, row);
  }

  const stockById = groupStockRows(stock.rows);
  const ids = new Set([...catalogById.keys(), ...stockById.keys()]);

  for (const id of ids) {
    const catalogRow = catalogById.get(id);
    const stockInfo = stockById.get(id);
    const sku = faptekaSku(id);
    const existing = await db.product.findUnique({
      where: { branchId_sku: { branchId: input.branchId, sku } },
    });

    const salePrice = stockInfo?.salePrice || Number(existing?.salePrice ?? 0);
    const stock = stockCount(stockInfo?.stock ?? existing?.stock ?? 0);
    const name = catalogRow?.N || existing?.name || `F-Apteka #${id}`;
    const unit = catalogRow?.E || existing?.unit || "dona";

    await db.product.upsert({
      where: { branchId_sku: { branchId: input.branchId, sku } },
      update: {
        name,
        unit,
        category: existing?.category || "F-Apteka",
        salePrice,
        stock,
        expiryDate: stockInfo?.expiryDate ?? existing?.expiryDate ?? null,
        isActive: true,
      },
      create: {
        name,
        sku,
        category: "F-Apteka",
        unit,
        costPrice: 0,
        salePrice,
        stock,
        minStock: 0,
        expiryDate: stockInfo?.expiryDate ?? null,
        branchId: input.branchId,
      },
    });
    input.summary.productsUpserted += 1;
  }
}

/**
 * Hisobot qatorlari qayerdan olinadi:
 * - pull: Vercel o'zi F-Apteka API'sidan so'raydi (API internetda bo'lsa)
 * - push: dorixona kompyuteridagi ko'prik skript API'dan olib, bizga yuboradi
 */
type ReportSource = (report: FaptekaReportKey) => Promise<FaptekaRow[]>;

/** Push paytida qaysi filial (otdel) ma'lumoti kelgani */
type PushScope = { filialId: string; unit: Filial | null };

type StepInput = {
  branchId: string;
  dateFrom: string;
  dateTo: string;
  summary: FaptekaSyncSummary;
  source: ReportSource;
  scope?: PushScope;
};

function pullSource(dateFrom: string, dateTo: string): ReportSource {
  return async (report) => (await fetchFaptekaReport({ report, dateFrom, dateTo })).rows;
}

/**
 * Qatorlardagi F-Apteka tovarlarini bitta so'rovda topadi, yo'qlarini
 * yaratadi. Har qator uchun alohida so'rov yuborilsa, bir kunlik savdo
 * Vercel'ning 60 soniyasiga sig'masdi.
 */
async function loadFaptekaProducts(branchId: string, rows: FaptekaRow[]) {
  const prices = new Map<string, number>();
  for (const row of rows) {
    const id = rowId(row, "G");
    if (id && !prices.has(id)) prices.set(id, numberValue(row.P));
  }
  const skus = [...prices.keys()].map(faptekaSku);
  if (!skus.length) return new Map<string, { id: string; salePrice: Prisma.Decimal; costPrice: Prisma.Decimal }>();

  const find = () =>
    db.product.findMany({
      where: { branchId, sku: { in: skus } },
      select: { id: true, sku: true, salePrice: true, costPrice: true },
    });

  let products = await find();
  const have = new Set(products.map((product) => product.sku));
  const missing = [...prices.entries()].filter(([id]) => !have.has(faptekaSku(id)));
  if (missing.length) {
    await db.product.createMany({
      data: missing.map(([id, price]) => ({
        name: `F-Apteka #${id}`,
        sku: faptekaSku(id),
        category: FAPTEKA_DEFAULT_CATEGORY,
        unit: "dona",
        costPrice: 0,
        salePrice: price,
        stock: 0,
        minStock: 0,
        branchId,
      })),
      skipDuplicates: true,
    });
    products = await find();
  }

  return new Map(products.map(({ sku, ...product }) => [sku, product]));
}

async function syncMovementReport(
  input: StepInput & { report: FaptekaReportKey; movementType: "IN" | "OUT" | "ADJUST" },
) {
  const report = FAPTEKA_REPORTS[input.report];
  const rows = await input.source(input.report);
  input.summary.movementRows += rows.length;

  // Filial bo'yicha push'da har filial faqat o'z yozuvlarini almashtiradi
  const notePrefix = input.scope
    ? `FA:${report.id}:F${input.scope.filialId}:`
    : `FA:${report.id}:`;
  const products = await loadFaptekaProducts(input.branchId, rows);

  const data: Prisma.StockMovementCreateManyInput[] = [];
  const costUpdates = new Map<string, number>();
  const vatRates = new Map<string, number>();
  for (const row of rows) {
    const faptekaId = rowId(row, "G");
    const quantity = stockCount(row.Q);
    const product = faptekaId ? products.get(faptekaSku(faptekaId)) : undefined;
    if (!faptekaId || !product || quantity <= 0) continue;

    const cost = costPerUnit(row);
    if (input.movementType === "IN" && cost > 0) costUpdates.set(product.id, cost);
    const vat = input.movementType === "IN" ? purchaseVatRate(row) : null;
    if (vat !== null) vatRates.set(product.id, vat);

    const docId = row.ID || row.N || `${row.D ?? input.dateFrom}-${faptekaId}`;
    data.push({
      productId: product.id,
      type: input.movementType,
      quantity,
      note: `${notePrefix}${docId}; series=${row.S ?? "-"}; product=${faptekaId}`,
      createdAt: dateValue(row.D) ?? new Date(input.dateFrom),
    });
  }

  await db.$transaction([
    db.stockMovement.deleteMany({
      where: {
        note: { startsWith: notePrefix },
        createdAt: { gte: new Date(input.dateFrom), lt: endExclusive(input.dateTo) },
      },
    }),
    db.stockMovement.createMany({ data }),
  ]);
  input.summary.movementsCreated += data.length;

  const updates = [...costUpdates.entries()];
  for (let index = 0; index < updates.length; index += 25) {
    await Promise.all(
      updates
        .slice(index, index + 25)
        .map(([id, costPrice]) => db.product.update({ where: { id }, data: { costPrice } })),
    );
  }
  await savePurchaseVatRates(vatRates);
}

/**
 * Kirim qatorlaridagi "I" (1-hisobotda INN, 11-hisobotda kontragent ID)
 * bo'yicha tashkilot nomlarini topadi. Ro'yxat 189-hisobotdan to'ladi.
 */
async function supplierNames(rows: FaptekaRow[]) {
  const keys = [...new Set(rows.map((row) => (row.I ?? "").trim()).filter(Boolean))];
  if (!keys.length) return new Map<string, string>();

  const orgs = await db.faptekaOrg.findMany({
    where: { OR: [{ id: { in: keys } }, { inn: { in: keys } }] },
    select: { id: true, inn: true, name: true },
  });

  const map = new Map<string, string>();
  for (const org of orgs) {
    map.set(org.id, org.name);
    if (org.inn) map.set(org.inn, org.name);
  }
  return map;
}

/** Ombordagi nomlar: FA:<G> -> tovar nomi */
async function productNames(branchId: string, rows: FaptekaRow[]) {
  const skus = [...new Set(rows.map((row) => rowId(row, "G")).filter(Boolean))].map((id) =>
    faptekaSku(id as string),
  );
  if (!skus.length) return new Map<string, string>();

  const products = await db.product.findMany({
    where: { branchId, sku: { in: skus } },
    select: { sku: true, name: true },
  });
  return new Map(products.map((product) => [product.sku, product.name]));
}

async function syncIncomingExpenses(input: StepInput & { report: FaptekaReportKey }) {
  const rows = await input.source(input.report);
  input.summary.expenseRows += rows.length;

  const docIdOf = (row: FaptekaRow) =>
    row.ID || row.N || `${row.D ?? input.dateFrom}-${rowId(row, "G") || ""}`;

  const [suppliers, names] = await Promise.all([
    supplierNames(rows),
    productNames(input.branchId, rows),
  ]);

  // Qaysi dorixonaga kelgani.
  //
  // TEKSHIRILDI (27.09.2026): 1-hisobot qatorlarida filial ustuni YO'Q —
  // kelgan maydonlar D, N, I, G, S, E, Q, P, SP, SN, V, SR, IK. Shuning
  // uchun filial so'rovning o'zidan olinadi (pFilial_id). Hozir kirim
  // faqat ombor (filial 1) nomidan so'raladi, shuning uchun "Umumiy"
  // bo'lib qoladi; relay filial 2 va 3 dan ham so'raydigan bo'lsa,
  // harajat o'sha dorixonaga yoziladi.
  //
  // DIQQAT: 20-hisobotdagi O — yetkazib beruvchi tashkilot, filial emas.
  // Ikkisini adashtirmaslik kerak.
  const otdels = otdelUnitMap();
  const unitOf = (row: FaptekaRow) =>
    otdels.get((row.O ?? "").trim()) ?? input.scope?.unit ?? null;

  // Hujjat ichida nima kelgani: nom -> summa. Harajat nomida eng kattalari
  // ko'rsatiladi, shunda ro'yxatga qaraboq nima olinganini bilish mumkin.
  const itemsByDoc = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const faptekaId = rowId(row, "G");
    const name = faptekaId ? names.get(faptekaSku(faptekaId)) : undefined;
    if (!name) continue;
    const key = expenseGroupKey(docIdOf(row), unitOf(row));
    const items = itemsByDoc.get(key) ?? new Map<string, number>();
    items.set(name, (items.get(name) ?? 0) + stockCount(row.Q || 1) * costPerUnit(row));
    itemsByDoc.set(key, items);
  }

  const entries = buildIncomingExpenseEntries(
    rows.map((row) => ({
      docId: docIdOf(row),
      quantity: stockCount(row.Q || 1),
      price: costPerUnit(row),
      spentAt: dateValue(row.D) ?? new Date(input.dateFrom),
      supplier: suppliers.get((row.I ?? "").trim()),
      unit: unitOf(row),
    })),
  );

  // Eski ko'rinishdagi yozuvlar ham tozalansin, aks holda nom o'zgargach
  // bir xil kirim ikki marta turib qolardi.
  const titleFilters = [
    { title: { contains: FAPTEKA_EXPENSE_MARK } },
    { title: { startsWith: FAPTEKA_EXPENSE_PREFIX_OLD } },
  ];
  await db.$transaction([
    db.expense.deleteMany({
      where: {
        OR: titleFilters,
        spentAt: { gte: new Date(input.dateFrom), lt: endExclusive(input.dateTo) },
      },
    }),
    db.expense.createMany({
      data: entries.map((entry) => ({
        title: faptekaExpenseTitle({
          docId: entry.docId,
          supplier: entry.supplier,
          items: itemsByDoc.get(expenseGroupKey(entry.docId, entry.unit)),
        }),
        category: "GOODS" as const,
        amount: entry.amount,
        spentAt: entry.spentAt,
        isRecurring: false,
        unit: entry.unit,
        branchId: input.branchId,
      })),
    }),
  ]);
  input.summary.expensesCreated += entries.length;

  // Jurnalda ko'rinsin: kirim qaysi dorixonalarga yozildi. "Umumiy" chiqsa,
  // demak F-Apteka qatorlarida otdel (O) yo'q.
  const perUnit = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.unit ?? "Umumiy";
    perUnit.set(key, (perUnit.get(key) ?? 0) + 1);
  }
  if (perUnit.size > 0) {
    input.summary.expenseUnits = Array.from(perUnit.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([unit, count]) => `${unit}: ${count}`)
      .join(", ");
  }
}

async function syncMovements(input: StepInput) {
  await syncIncomingExpenses({ ...input, report: "incomingV2" });
  await syncMovementReport({ ...input, report: "incomingV2", movementType: "IN" });
  await syncMovementReport({ ...input, report: "supplierReturnV2", movementType: "OUT" });
  await syncMovementReport({ ...input, report: "writeOff", movementType: "ADJUST" });
}

/**
 * Bir dona tovarning tan narxi, QQS bilan: (SP + SN) / Q.
 * Savdo summasi ham QQS bilan keladi, shuning uchun taqqoslash bir xil
 * bo'lishi kerak. SP/SN bo'lmasa, P (QQSsiz narx) ishlatiladi.
 */
function costPerUnit(row: FaptekaRow) {
  const quantity = numberValue(row.Q);
  const withVat = numberValue(row.SP) + numberValue(row.SN);
  if (quantity > 0 && withVat > 0) return withVat / quantity;
  return numberValue(row.P);
}

/**
 * Kirimdagi QQS stavkasi: SN / SP (0,12 yoki 0 — QQSsiz yetkazib beruvchi).
 * Foyda F-Apteka'dagi kabi QQSsiz hisoblanishi uchun kerak (monthly-finance).
 */
function purchaseVatRate(row: FaptekaRow) {
  const withoutVat = numberValue(row.SP);
  if (withoutVat <= 0) return null;
  const rate = numberValue(row.SN) / withoutVat;
  return Number.isFinite(rate) && rate >= 0 && rate < 0.3 ? Math.round(rate * 10_000) / 10_000 : null;
}

/**
 * Tovarlarning xarid QQS stavkasini yozadi. Ustun Prisma sxemasida yo'q —
 * SQL (prisma/manual/xarid-qqs.sql) ishga tushirilmagan bo'lsa, tovar
 * so'rovlari yiqilmasin. Ustun yo'q bo'lsa jimgina o'tkazib yuboriladi.
 */
async function savePurchaseVatRates(rates: Map<string, number>) {
  const entries = [...rates.entries()];
  try {
    for (let index = 0; index < entries.length; index += 500) {
      const chunk = entries.slice(index, index + 500);
      await db.$executeRaw`
        UPDATE "Product" p SET "purchaseVatRate" = v.rate
        FROM (VALUES ${Prisma.join(chunk.map(([id, rate]) => Prisma.sql`(${id}, ${rate}::numeric)`))}) AS v(id, rate)
        WHERE p.id = v.id`;
    }
  } catch {
    // Ustun hali yaratilmagan
  }
}

function saleLineTotal(row: Record<string, string>, quantity: number, fallbackPrice: number) {
  const withoutVat = numberValue(row.SP);
  const vat = numberValue(row.SN);
  if (withoutVat || vat) return withoutVat + vat;
  const rowPrice = numberValue(row.P, fallbackPrice);
  return rowPrice * quantity;
}

async function syncSalesReport(input: StepInput & { report: FaptekaReportKey; receiptPrefix: string }) {
  const rows = await input.source(input.report);
  input.summary.saleRows += rows.length;

  const groups = new Map<string, FaptekaRow[]>();
  for (const row of rows) {
    const faptekaId = rowId(row, "G");
    if (!faptekaId) continue;
    const docId = row.ID || `${row.D ?? input.dateFrom}-${faptekaId}-${row.S ?? ""}`;
    const group = groups.get(docId) ?? [];
    group.push(row);
    groups.set(docId, group);
  }
  if (!groups.size) return;

  // Filial bo'yicha push'da chek raqamiga filial qo'shiladi: FA-2-123
  const receiptPrefix = input.scope
    ? `${input.receiptPrefix}${input.scope.filialId}-`
    : input.receiptPrefix;
  const products = await loadFaptekaProducts(input.branchId, rows);

  const sales: Prisma.SaleCreateManyInput[] = [];
  const items: Prisma.SaleItemCreateManyInput[] = [];
  for (const [docId, groupRows] of groups) {
    const saleId = randomUUID();
    const lines: Prisma.SaleItemCreateManyInput[] = [];
    for (const row of groupRows) {
      const product = products.get(faptekaSku(rowId(row, "G")));
      if (!product) continue;
      const quantity = Math.max(1, stockCount(row.Q || 1));
      const lineTotal = saleLineTotal(row, quantity, Number(product.salePrice ?? numberValue(row.P)));
      lines.push({
        saleId,
        productId: product.id,
        quantity,
        unitPrice: lineTotal / quantity,
        costPrice: Number(product.costPrice ?? 0),
        lineTotal,
      });
    }
    if (!lines.length) continue;

    sales.push({
      id: saleId,
      receiptNo: faptekaReceipt(docId, receiptPrefix),
      total: lines.reduce((sum, line) => sum + Number(line.lineTotal), 0),
      discount: 0,
      pointsEarned: 0,
      pointsRedeemed: 0,
      paymentMethod: "CASH",
      unit: input.scope?.unit ?? null,
      branchId: input.branchId,
      createdAt: dateValue(groupRows[0]?.D) ?? new Date(input.dateFrom),
    });
    items.push(...lines);
  }

  // Har push bugun va kechani qayta yuboradi — cheklarni o'chirib qayta
  // yozamiz (bandlari cascade bilan o'chadi). Takror chek paydo bo'lmaydi.
  await db.$transaction([
    db.sale.deleteMany({ where: { receiptNo: { in: sales.map((sale) => sale.receiptNo) } } }),
    db.sale.createMany({ data: sales }),
    db.saleItem.createMany({ data: items }),
  ]);
  input.summary.salesUpserted += sales.length;
}

async function syncSales(input: StepInput) {
  await syncSalesReport({ ...input, report: "retailSaleV2", receiptPrefix: "FA-" });
  await syncSalesReport({ ...input, report: "insuranceSaleV2", receiptPrefix: "FA-INS-" });
}

export async function syncFapteka(input: {
  mode: FaptekaSyncMode;
  dateFrom: string;
  dateTo: string;
}): Promise<FaptekaSyncSummary> {
  const dateFrom = isoDate(input.dateFrom);
  const dateTo = isoDate(input.dateTo);
  const summary = makeSummary(input.mode, dateFrom, dateTo);

  const branch = await db.branch.findFirst({ where: { isActive: true } });
  if (!branch) throw new Error("Aktiv filial topilmadi");
  const source = pullSource(dateFrom, dateTo);

  try {
    if (input.mode === "catalog" || input.mode === "all") {
      await syncCatalogAndStock({ branchId: branch.id, dateFrom, dateTo, summary });
    }
  } catch (error) {
    addError(summary, error);
  }

  try {
    if (input.mode === "movements" || input.mode === "all") {
      await syncMovements({ branchId: branch.id, dateFrom, dateTo, summary, source });
    }
  } catch (error) {
    addError(summary, error);
  }

  try {
    if (input.mode === "sales" || input.mode === "all") {
      await syncSales({ branchId: branch.id, dateFrom, dateTo, summary, source });
    }
  } catch (error) {
    addError(summary, error);
  }

  return summary;
}

export async function syncFaptekaSiteRows(rows: FaptekaRow[]): Promise<FaptekaSitePushSummary> {
  const summary: FaptekaSitePushSummary = {
    ok: true,
    receivedRows: rows.length,
    productsUpserted: 0,
    skippedRows: 0,
    stockZeroed: 0,
    errors: [],
  };

  const branch = await db.branch.findFirst({ where: { isActive: true } });
  if (!branch) throw new Error("Aktiv filial topilmadi");

  const productsBySku = new Map<string, FaptekaSiteProductInput & { rawStock: number }>();
  for (const row of rows) {
    const id = rowId(row, "I") || rowId(row, "G");
    if (!id) {
      summary.skippedRows += 1;
      continue;
    }

    const sku = faptekaSku(id);
    const existing = productsBySku.get(sku);
    const rawStock = numberValue(row.K ?? row.Q);
    productsBySku.set(sku, {
      name: row.N || existing?.name || `F-Apteka #${id}`,
      sku,
      unit: row.UN || row.E || existing?.unit || "dona",
      salePrice: Math.max(existing?.salePrice ?? 0, numberValue(row.P)),
      stock: 0,
      rawStock: (existing?.rawStock ?? 0) + rawStock,
      branchId: branch.id,
    });
  }

  const products = [...productsBySku.values()].map(({ rawStock, ...product }) => ({
    ...product,
    stock: stockCount(rawStock),
  }));

  for (let index = 0; index < products.length; index += 500) {
    const chunk = products.slice(index, index + 500);
    try {
      await db.$executeRaw(Prisma.sql`
        INSERT INTO "Product" (
          "id", "name", "sku", "category", "unit", "costPrice", "salePrice", "stock",
          "minStock", "isActive", "branchId", "createdAt", "updatedAt"
        )
        VALUES ${Prisma.join(
          chunk.map((product) => Prisma.sql`(
            ${randomUUID()}, ${product.name}, ${product.sku}, ${categoryFromName(product.name)}, ${product.unit},
            ${0}, ${product.salePrice}, ${product.stock}, ${0}, ${true}, ${product.branchId}, NOW(), NOW()
          )`),
        )}
        ON CONFLICT ("branchId", "sku") DO UPDATE SET
          "name" = EXCLUDED."name",
          -- Toifani faqat kod qo'ygan bo'lsa yangilaymiz: odam o'zgartirgan
          -- toifaga tegmaymiz
          "category" = CASE
            WHEN "Product"."category" IS NULL OR "Product"."category" = '' OR "Product"."category" = 'F-Apteka'
              THEN EXCLUDED."category"
            ELSE "Product"."category"
          END,
          "unit" = EXCLUDED."unit",
          "salePrice" = EXCLUDED."salePrice",
          "stock" = EXCLUDED."stock",
          "isActive" = true,
          "updatedAt" = NOW()
      `);
      summary.productsUpserted += chunk.length;
    } catch (error) {
      summary.ok = false;
      summary.errors.push(error instanceof Error ? error.message : "F-Apteka mahsulotlari batch saqlanmadi");
    }
  }

  // SITE.exe faqat qoldig'i bor dorini yuboradi: dori tugasa push'dan
  // chiqib ketadi va Product.stock oxirgi sonda qotib qolardi (ombor,
  // "Umumiy" qiymati va ogohlantirishlar shu eski son bilan ishlardi).
  // Push'da yo'q F-Apteka dorilari qoldig'ini 0 qilamiz — lekin faqat
  // push to'liq bo'lsa: hamma dorixona keldi va batch'lar xatosiz yozildi.
  // Aks holda bir dorixona kelmay qolsa, uning dorilari nolga tushib ketardi.
  const pushedOtdels = new Set(rows.map((row) => (row.O ?? "").trim()).filter(Boolean));
  const fullSnapshot = [...otdelUnitMap().keys()].every((otdel) => pushedOtdels.has(otdel));
  if (summary.ok && fullSnapshot && productsBySku.size > 0) {
    try {
      summary.stockZeroed = await db.$executeRaw`
        UPDATE "Product" SET "stock" = 0, "updatedAt" = NOW()
        WHERE "branchId" = ${branch.id}
          AND "sku" LIKE ${`${FAPTEKA_SKU_PREFIX}%`}
          AND "stock" > 0
          AND NOT ("sku" = ANY(${[...productsBySku.keys()]}::text[]))`;
    } catch (error) {
      summary.ok = false;
      summary.errors.push(error instanceof Error ? error.message : "Tugagan dorilar qoldig'i nolga tushirilmadi");
    }
  }

  return summary;
}

/**
 * 22-hisobot (tuzatilgan savdo): kun kesimida sotuv va **tan narx** summasi.
 *
 * 4-hisobotda tan narx yo'q, shuning uchun foyda kirim narxidan taxminiy
 * hisoblanardi. Bu yerda F-Apteka o'zi hisoblagan tan narx keladi — o'sha
 * kunning bandlariga ulush bo'yicha tarqatamiz. Shunda kunlik foyda aniq
 * bo'ladi, tovar kesimi esa 4-hisobotdan saqlanib qoladi.
 */
export async function syncFaptekaSalesTotals(input: {
  rows: FaptekaRow[];
  filialId: string;
  dateFrom: string;
  dateTo: string;
}) {
  const dateFrom = isoDate(input.dateFrom);
  const dateTo = isoDate(input.dateTo);
  const unit = otdelUnitMap().get(input.filialId) ?? null;

  // 22-hisobot DOCTYPE (2,3,4,8,7) ni oladi, 4-hisobot esa faqat (2,4) ni.
  // Tan narx o'sha savdolarga tarqatilishi uchun bir xil doiradan olamiz,
  // aks holda sug'urta va qaytarishlar aralashib, foyda buzilardi.
  const SALE_DOC_TYPES = new Set(["2", "4"]);
  const rows = input.rows.filter(
    (row) =>
      (!row.F || row.F.trim() === input.filialId) &&
      (!row.DT || SALE_DOC_TYPES.has(row.DT.trim())),
  );
  const reported = rows.reduce((sum, row) => sum + numberValue(row.SS || row.SP), 0);
  const reportedCost = rows.reduce((sum, row) => sum + numberValue(row.SI), 0);

  const from = new Date(dateFrom);
  const to = endExclusive(dateTo);
  const [current] = await db.$queryRaw<{ turnover: number }[]>`
    SELECT COALESCE(SUM(si."lineTotal"), 0)::float8 AS turnover
    FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
    WHERE s."createdAt" >= ${from} AND s."createdAt" < ${to}
      AND s."receiptNo" LIKE ${`${FAPTEKA_RECEIPT_PREFIX}%`}
      AND (${unit}::text IS NULL OR s."unit" = ${unit})`;

  // Hujjat turi kesimida kunlik savdo — naqd va terminal shundan ajratiladi
  const byDocType = new Map<string, { amount: number; cost: number }>();
  for (const row of input.rows) {
    if (row.F && row.F.trim() !== input.filialId) continue;
    const docType = (row.DT ?? "").trim() || "?";
    const current = byDocType.get(docType) ?? { amount: 0, cost: 0 };
    byDocType.set(docType, {
      amount: current.amount + numberValue(row.SS || row.SP),
      cost: current.cost + numberValue(row.SI),
    });
  }

  const dayStart = new Date(dateFrom);
  for (const [docType, sums] of byDocType) {
    try {
      await db.dailySales.upsert({
        where: { day_unit_docType: { day: dayStart, unit: unit ?? "Umumiy", docType } },
        update: { amount: sums.amount, cost: sums.cost },
        create: { day: dayStart, unit: unit ?? "Umumiy", docType, amount: sums.amount, cost: sums.cost },
      });
    } catch {
      // Jadval hali yaratilmagan bo'lsa asosiy ish to'xtamasin
    }
  }

  const erpTurnover = numberValue(current?.turnover);
  if (reportedCost <= 0 || erpTurnover <= 0) {
    return { ok: true, reported, reportedCost, erpTurnover, updated: 0, applied: false, docTypes: "" };
  }

  // Tan narxni tushum ulushiga qarab tarqatamiz
  const factor = reportedCost / erpTurnover;
  const updated = await db.$executeRaw`
    UPDATE "SaleItem" si
    SET "costPrice" = ROUND((si."lineTotal" * ${factor}::numeric) / GREATEST(si.quantity, 1), 2)
    FROM "Sale" s
    WHERE s.id = si."saleId"
      AND s."createdAt" >= ${from} AND s."createdAt" < ${to}
      AND s."receiptNo" LIKE ${`${FAPTEKA_RECEIPT_PREFIX}%`}
      AND (${unit}::text IS NULL OR s."unit" = ${unit})`;

  const docTypes = [...byDocType.entries()]
    .map(([docType, sums]) => `DT${docType}=${Math.round(sums.amount)}`)
    .join(", ");
  return { ok: true, reported, reportedCost, erpTurnover, updated, applied: true, docTypes };
}

/**
 * 20-hisobot (tuzatilgan kirim): hujjat raqami va yetkazib beruvchi ID'si.
 *
 * 1-hisobotda yetkazib beruvchi maydoni bo'sh kelgan. Bu yerda u bor, hujjat
 * raqami esa ikkalasida bir xil — shu orqali harajat nomiga nom qo'shamiz.
 */
export async function syncFaptekaIncomingSuppliers(input: {
  rows: FaptekaRow[];
  dateFrom: string;
  dateTo: string;
}) {
  const orgIds = [...new Set(input.rows.map((row) => (row.O ?? "").trim()).filter(Boolean))];
  if (!orgIds.length) return { ok: true, updated: 0, unknownOrgs: 0 };

  const orgs = await db.faptekaOrg.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, name: true },
  });
  const names = new Map(orgs.map((org) => [org.id, org.name]));

  const from = new Date(isoDate(input.dateFrom));
  const to = endExclusive(isoDate(input.dateTo));
  const expenses = await db.expense.findMany({
    where: { title: { contains: FAPTEKA_EXPENSE_MARK }, spentAt: { gte: from, lt: to } },
    select: { id: true, title: true },
  });

  let updated = 0;
  let unknownOrgs = 0;
  for (const row of input.rows) {
    const docId = (row.N ?? "").trim();
    const supplier = names.get((row.O ?? "").trim());
    if (!docId) continue;
    if (!supplier) {
      unknownOrgs += 1;
      continue;
    }

    const mark = `${FAPTEKA_EXPENSE_MARK}${docId})`;
    for (const expense of expenses) {
      // Nomi shu hujjatga tegishli va yetkazib beruvchi hali yozilmagan bo'lsa
      if (!expense.title.endsWith(mark) || expense.title.includes(" — ")) continue;
      await db.expense.update({
        where: { id: expense.id },
        data: { title: expense.title.replace(mark, `— ${supplier} ${mark}`) },
      });
      updated += 1;
    }
  }

  return { ok: true, updated, unknownOrgs };
}

/**
 * 30-hisobot (PAYIN): kassaga tushgan pul, kassa apparati kesimida.
 *
 * Savdo hisobotlarida to'lov turi yo'q, bu yerda esa har kassa alohida:
 * naqd, terminal va boshqalar. Kassa raqamlari DailySales ga "PAY:1",
 * "PAY:2" ko'rinishida yoziladi — nomlari sozlamada beriladi.
 */
export async function syncFaptekaPayments(input: {
  rows: FaptekaRow[];
  filialId: string;
  dateFrom: string;
}) {
  const dateFrom = isoDate(input.dateFrom);
  const unit = otdelUnitMap().get(input.filialId) ?? "Umumiy";
  const day = new Date(dateFrom);

  const byCashbox = new Map<string, number>();
  for (const row of input.rows) {
    if (row.F && row.F.trim() !== input.filialId) continue;
    const cashbox = (row.C ?? "").trim() || "?";
    byCashbox.set(cashbox, (byCashbox.get(cashbox) ?? 0) + numberValue(row.S));
  }

  let saved = 0;
  for (const [cashbox, amount] of byCashbox) {
    const docType = `PAY:${cashbox}`;
    try {
      await db.dailySales.upsert({
        where: { day_unit_docType: { day, unit, docType } },
        update: { amount, cost: 0 },
        create: { day, unit, docType, amount, cost: 0 },
      });
      saved += 1;
    } catch {
      // Jadval hali yaratilmagan bo'lsa asosiy ish to'xtamasin
    }
  }

  const summary = [...byCashbox.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cashbox, amount]) => `K${cashbox}=${Math.round(amount)}`)
    .join(", ");
  return { ok: true, receivedRows: input.rows.length, saved, summary };
}

/** Kirim hujjatiga qarz muddati: sana + shuncha kun */
const SUPPLIER_TERM_DAYS = Number(process.env.FAPTEKA_SUPPLIER_TERM_DAYS ?? 30) || 30;

/** Qarz summalarini tarixdan qayta hisoblaydi */
async function recalcDebt(debtId: string) {
  const entries = await db.debtEntry.findMany({
    where: { debtId },
    select: { type: true, amount: true },
  });
  let total = 0;
  let paid = 0;
  for (const entry of entries) {
    if (entry.type === "CHARGE") total += Number(entry.amount);
    else paid += Number(entry.amount);
  }
  const remaining = total - paid;
  await db.debt.update({
    where: { id: debtId },
    data: { totalAmount: total, paidAmount: paid, closedAt: remaining <= 0.009 ? new Date() : null },
  });
}

/**
 * Firmadan olingan tovar — qarz sifatida yoziladi (20-hisobot).
 *
 * F-Apteka to'lovlarni bermaydi, faqat nima olinganini beradi. Shuning
 * uchun qarz avtomatik oshadi, to'lovlar esa ERP da qo'lda kiritiladi:
 * "shuncha berildi, shuncha qoldi" shundan chiqadi.
 *
 * Har hujjat bir marta yoziladi — DebtEntry.ref bo'yicha tekshiriladi.
 *
 * Faqat qarzga tovar beradigan firmalar (debt-suppliers.ts) yoziladi.
 * Qolganlaridan tovar to'liq to'lab olinadi — ular qarz emas.
 */
export async function syncFaptekaSupplierDebts(rows: FaptekaRow[]) {
  const branch = await db.branch.findFirst({ where: { isActive: true } });
  if (!branch) throw new Error("Aktiv filial topilmadi");

  const orgIds = [...new Set(rows.map((row) => (row.O ?? "").trim()).filter(Boolean))];
  if (!orgIds.length) {
    return { ok: true, created: 0, updated: 0, skipped: rows.length, paidInFull: 0, removed: 0 };
  }

  const orgs = await db.faptekaOrg.findMany({
    where: { id: { in: orgIds } },
    select: { id: true, name: true },
  });
  const names = new Map(orgs.map((org) => [org.id, org.name]));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let paidInFull = 0;

  for (const row of rows) {
    const docId = (row.N ?? "").trim();
    const supplier = names.get((row.O ?? "").trim());
    const amount = numberValue(row.SS) || numberValue(row.SP) + numberValue(row.SN);
    if (!docId || !supplier || amount <= 0) {
      skipped += 1;
      continue;
    }
    if (!isDebtSupplier(supplier)) {
      paidInFull += 1;
      continue;
    }

    const happenedAt = dateValue(row.D) ?? new Date();
    const ref = `FA:INC:${docId}`;

    // Shu yetkazib beruvchining ochiq qarzi bo'lsa — o'shanga qo'shamiz
    let debt = await db.debt.findFirst({
      where: { branchId: branch.id, kind: "FIRM", counterparty: supplier, closedAt: null },
    });
    if (!debt) {
      debt = await db.debt.create({
        data: {
          counterparty: supplier,
          kind: "FIRM",
          currency: "UZS",
          direction: "PAYABLE",
          totalAmount: 0,
          paidAmount: 0,
          dueDate: new Date(happenedAt.getTime() + SUPPLIER_TERM_DAYS * 864e5),
          note: "F-Apteka kirimlaridan avtomatik",
          branchId: branch.id,
        },
      });
    }

    const existing = await db.debtEntry.findUnique({ where: { ref } });
    if (existing) {
      await db.debtEntry.update({
        where: { ref },
        data: { amount, happenedAt, debtId: debt.id },
      });
      updated += 1;
    } else {
      await db.debtEntry.create({
        data: {
          ref,
          debtId: debt.id,
          type: "CHARGE",
          amount,
          happenedAt,
          note: `Kirim #${docId}`,
        },
      });
      created += 1;
    }

    // Muddat qo'yilmagan bo'lsa, kirim sanasiga qarab qo'yiladi
    if (!debt.dueDate) {
      await db.debt.update({
        where: { id: debt.id },
        data: { dueDate: new Date(happenedAt.getTime() + SUPPLIER_TERM_DAYS * 864e5) },
      });
    }
    await recalcDebt(debt.id);
  }

  const removed = await removeNonDebtSupplierDebts();
  return { ok: true, created, updated, skipped, paidInFull, removed };
}

/**
 * Ro'yxatda yo'q firmalarga avval avtomatik yozilgan qarzlarni tozalaydi.
 *
 * Faqat F-Apteka kirimidan kelgan yozuvlar (ref "FA:INC:...") o'chiriladi.
 * Qarzda qo'lda kiritilgan to'lov yoki yozuv qolsa, qarzning o'zi qoladi
 * va summasi qayta hisoblanadi; bo'sh qolsa — o'chiriladi.
 */
async function removeNonDebtSupplierDebts() {
  const debts = await db.debt.findMany({
    where: { kind: "FIRM", entries: { some: { ref: { startsWith: "FA:INC:" } } } },
    select: { id: true, counterparty: true },
  });
  let removed = 0;
  for (const debt of debts) {
    if (isDebtSupplier(debt.counterparty)) continue;
    await db.debtEntry.deleteMany({ where: { debtId: debt.id, ref: { startsWith: "FA:INC:" } } });
    const left = await db.debtEntry.count({ where: { debtId: debt.id } });
    if (left === 0) await db.debt.delete({ where: { id: debt.id } });
    else await recalcDebt(debt.id);
    removed += 1;
  }
  return removed;
}

/**
 * 188-hisobot (spravochnik): barcha tovarlar nomi va o'lchov birligi.
 *
 * SITE.exe faqat qoldig'i bor tovarlarni yuboradi, shuning uchun sotilgan-u
 * qoldig'i qolmagan dori ERP da "F-Apteka #326340" bo'lib qolardi. Bu
 * hisobot hammasini beradi: nom va toifa shu yerdan to'ldiriladi.
 * Narx va qoldiqqa tegilmaydi — ular SITE.exe dan keladi.
 */
export async function syncFaptekaCatalog(rows: FaptekaRow[]) {
  const branch = await db.branch.findFirst({ where: { isActive: true } });
  if (!branch) throw new Error("Aktiv filial topilmadi");

  const items = new Map<string, { sku: string; name: string; unit: string; category: string }>();
  for (const row of rows) {
    const id = rowId(row, "I");
    const name = (row.N ?? "").trim();
    if (!id || !name) continue;
    items.set(faptekaSku(id), {
      sku: faptekaSku(id),
      name,
      unit: (row.E ?? "").trim(),
      category: categoryFromName(name),
    });
  }

  const list = [...items.values()];
  let updated = 0;
  for (let index = 0; index < list.length; index += 1000) {
    const chunk = list.slice(index, index + 1000);
    const count = await db.$executeRaw(Prisma.sql`
      UPDATE "Product" p SET
        "name" = v.name,
        "unit" = CASE WHEN v.unit = '' THEN p."unit" ELSE v.unit END,
        -- Odam qo'lda qo'ygan toifaga tegilmaydi
        "category" = CASE
          WHEN p."category" IS NULL OR p."category" IN ('', 'F-Apteka', ${FAPTEKA_DEFAULT_CATEGORY})
            THEN v.category
          ELSE p."category"
        END,
        "updatedAt" = NOW()
      FROM (VALUES ${Prisma.join(
        chunk.map((item) => Prisma.sql`(${item.sku}, ${item.name}, ${item.unit}, ${item.category})`),
      )}) AS v(sku, name, unit, category)
      WHERE p."sku" = v.sku AND p."branchId" = ${branch.id}
    `);
    updated += Number(count);
  }

  return { ok: true, receivedRows: rows.length, updated };
}

/**
 * F-Apteka tashkilotlari (189-hisobot): yetkazib beruvchi, filial,
 * sug'urta kompaniyasi. Kirim harajatida nomni yozish uchun kerak.
 */
export async function syncFaptekaOrganizations(rows: FaptekaRow[]) {
  // Ro'yxatda 300 dan ortiq tashkilot bor: bittalab yozilsa Vercel'ning
  // 60 soniyasiga sig'maydi (504 bergan edi), shuning uchun to'p-to'p yoziladi.
  const orgs = new Map<string, { id: string; name: string; inn: string | null; isSupplier: boolean }>();
  for (const row of rows) {
    const id = (row.I ?? "").trim();
    const name = (row.N ?? "").trim();
    if (!id || !name) continue;
    orgs.set(id, {
      id,
      name,
      inn: (row.INN ?? "").trim() || null,
      isSupplier: (row.INC ?? "") === "1",
    });
  }

  const list = [...orgs.values()];
  let saved = 0;
  const errors: string[] = [];

  for (let index = 0; index < list.length; index += 500) {
    const chunk = list.slice(index, index + 500);
    try {
      await db.$executeRaw(Prisma.sql`
        INSERT INTO "FaptekaOrg" ("id", "name", "inn", "isSupplier", "updatedAt")
        VALUES ${Prisma.join(
          chunk.map(
            (org) => Prisma.sql`(${org.id}, ${org.name}, ${org.inn}, ${org.isSupplier}, NOW())`,
          ),
        )}
        ON CONFLICT ("id") DO UPDATE SET
          "name" = EXCLUDED."name",
          "inn" = EXCLUDED."inn",
          "isSupplier" = EXCLUDED."isSupplier",
          "updatedAt" = NOW()
      `);
      saved += chunk.length;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Tashkilotlar saqlanmadi");
    }
  }

  return { ok: errors.length === 0, receivedRows: rows.length, saved, errors };
}

/**
 * Kirim hisobotidan faqat tan narxni oladi: harajat ham, ombor harakati ham
 * yozilmaydi. Eski kirimlarni ortga qarab tortib, foyda hisobini to'g'rilash
 * uchun - aks holda o'tgan oylarga qayta harajat yozilib ketardi.
 */
export async function syncFaptekaCostPrices(rows: FaptekaRow[]) {
  const branch = await db.branch.findFirst({ where: { isActive: true } });
  if (!branch) throw new Error("Aktiv filial topilmadi");

  const products = await loadFaptekaProducts(branch.id, rows);
  const costs = new Map<string, number>();
  const vatRates = new Map<string, number>();
  for (const row of rows) {
    const faptekaId = rowId(row, "G");
    const product = faptekaId ? products.get(faptekaSku(faptekaId)) : undefined;
    const cost = costPerUnit(row);
    // Bir tovar bir necha marta kelgan bo'lsa, oxirgi narx qoladi
    if (product && cost > 0) costs.set(product.id, cost);
    const vat = purchaseVatRate(row);
    if (product && vat !== null) vatRates.set(product.id, vat);
  }
  await savePurchaseVatRates(vatRates);

  const updates = [...costs.entries()];
  for (let index = 0; index < updates.length; index += 25) {
    await Promise.all(
      updates
        .slice(index, index + 25)
        .map(([id, costPrice]) => db.product.update({ where: { id }, data: { costPrice } })),
    );
  }
  return { ok: true, receivedRows: rows.length, productsUpdated: updates.length };
}

/**
 * Ko'prik skript yuboradigan hisobotlar (savdo va tovar harakati).
 *
 * Dorixonadagi API'da Ver.2 hisobotlari (14, 15, 11, 12) bo'sh qaytaradi —
 * faqat eski raqamlar (4, 5, 1, 2, 3) ma'lumot beradi. Ikkalasi ham qabul
 * qilinadi: API yangilansa, skriptdagi ro'yxatni almashtirish kifoya.
 * Bitta xil ma'lumotni ikkala raqamda yubormang — savdo ikki marta yozilmasin.
 */
export const FAPTEKA_PUSH_REPORTS = [
  "retailSale",
  "retailSaleV2",
  "insuranceSale",
  "insuranceSaleV2",
  "incoming",
  "incomingV2",
  "supplierReturn",
  "supplierReturnV2",
  "writeOff",
  "organizations",
  "salesTotals",
  "incomingTotals",
  "catalog",
  "payments",
] as const;
export type FaptekaPushReport = (typeof FAPTEKA_PUSH_REPORTS)[number];

export function isFaptekaPushReport(value: unknown): value is FaptekaPushReport {
  return (FAPTEKA_PUSH_REPORTS as readonly unknown[]).includes(value);
}

/**
 * Dorixona kompyuteridagi ko'prik skript yuborgan bitta hisobotni yozadi.
 * Bitta so'rov = bitta hisobot × bitta filial × sana oralig'i.
 */
export async function syncFaptekaPushedReport(input: {
  report: FaptekaPushReport;
  rows: FaptekaRow[];
  filialId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<FaptekaSyncSummary> {
  const dateFrom = isoDate(input.dateFrom);
  const dateTo = isoDate(input.dateTo);
  const isSale = input.report.startsWith("retailSale") || input.report.startsWith("insuranceSale");
  const summary = makeSummary(isSale ? "sales" : "movements", dateFrom, dateTo);

  const branch = await db.branch.findFirst({ where: { isActive: true } });
  if (!branch) throw new Error("Aktiv filial topilmadi");

  const step: StepInput = {
    branchId: branch.id,
    dateFrom,
    dateTo,
    summary,
    source: async () => input.rows,
    scope: { filialId: input.filialId, unit: otdelUnitMap().get(input.filialId) ?? null },
  };

  try {
    switch (input.report) {
      case "retailSale":
      case "retailSaleV2":
        await syncSalesReport({ ...step, report: input.report, receiptPrefix: "FA-" });
        break;
      case "insuranceSale":
      case "insuranceSaleV2":
        await syncSalesReport({ ...step, report: input.report, receiptPrefix: "FA-INS-" });
        break;
      case "incoming":
      case "incomingV2":
        await syncIncomingExpenses({ ...step, report: input.report });
        await syncMovementReport({ ...step, report: input.report, movementType: "IN" });
        break;
      case "supplierReturn":
      case "supplierReturnV2":
        await syncMovementReport({ ...step, report: input.report, movementType: "OUT" });
        break;
      case "writeOff":
        await syncMovementReport({ ...step, report: input.report, movementType: "ADJUST" });
        break;
      case "organizations":
      case "salesTotals":
      case "incomingTotals":
      case "catalog":
      case "payments":
        // Bularni route alohida bajaradi
        break;
    }
  } catch (error) {
    addError(summary, error);
  }

  return summary;
}
