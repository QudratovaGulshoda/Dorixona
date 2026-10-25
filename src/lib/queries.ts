import { auth } from "@/auth";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { activeBranch } from "@/lib/actions/_shared";
import { monthName } from "@/lib/format";
import { isFaptekaExpenseTitle, isFaptekaSku } from "@/lib/integrations/fapteka/mapping";
import { unitWhere } from "@/lib/filial";
import { currentFilial } from "@/lib/filial-server";
import { overlayRetail, retailByLocalDate, retailDaily, retailTotals, utcDay } from "@/lib/monthly-finance";
import { ensurePriceWatchListed } from "@/lib/price-watch";

/**
 * F-Apteka hujjat turi (DOCTYPE) nimani bildiradi.
 *
 * 22-hisobotdagi ma'lumotdan aniqlandi: DT=2 oddiy sotuv, DT=4 esa
 * summasi manfiy bo'lib keladi — ya'ni mijoz qaytargan tovar.
 * To'lov turi (naqd yoki terminal) bu hisobotda umuman yo'q.
 *
 * Kerak bo'lsa env orqali o'zgartiriladi:
 *   FAPTEKA_SALE_DOCTYPES="2"   FAPTEKA_REFUND_DOCTYPES="4"
 */
function docTypeGroups() {
  const parse = (raw: string | undefined, fallback: string[]) => {
    const list = (raw ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    return new Set(list.length ? list : fallback);
  };
  return {
    sale: parse(process.env.FAPTEKA_SALE_DOCTYPES, ["2"]),
    refund: parse(process.env.FAPTEKA_REFUND_DOCTYPES, ["4"]),
  };
}

/**
 * Kassa nomlari. F-Apteka PAYIN jadvalida faqat raqam beradi; qaysi raqam
 * nima ekani "Розничная продажа" hisobotidagi ustunlar bilan solishtirib
 * aniqlandi (24.09.2026, Yunusobod):
 *   Наличные 20 282 654 = C1 · HUMO 4 067 900 = C2 · UzCard 8 077 002 = C6
 * Yangi kassa qo'shilsa, env orqali nomlanadi:
 *   FAPTEKA_CASHBOX_LABELS="1:Naqd,2:HUMO,6:UzCard"
 */
function cashboxLabels() {
  const map = new Map<string, string>([
    ["1", "Naqd"],
    ["2", "HUMO"],
    ["6", "UzCard"],
  ]);
  const raw = process.env.FAPTEKA_CASHBOX_LABELS?.trim();
  if (raw) {
    map.clear();
    for (const pair of raw.split(",")) {
      const [id, label] = pair.split(":").map((part) => part.trim());
      if (id && label) map.set(id, label);
    }
  }
  return map;
}

/** Naqd va kartani ajratish uchun: qaysi kassa naqd hisoblanadi */
const CASH_BOXES = new Set((process.env.FAPTEKA_CASH_BOXES ?? "1").split(",").map((v) => v.trim()));

/** To'lov turlari bo'yicha tushum (30-hisobot, PAYIN) */
export async function paymentBreakdown(from: Date, to: Date, unit: string | null) {
  let rows: { docType: string; amount: unknown }[] = [];
  try {
    rows = await db.dailySales
      .groupBy({
        by: ["docType"],
        _sum: { amount: true },
        where: {
          day: { gte: from, lt: to },
          docType: { startsWith: "PAY:" },
          ...(unit ? { unit } : {}),
        },
      })
      .then((list) => list.map((row) => ({ docType: row.docType, amount: row._sum.amount })));
  } catch {
    return { items: [], total: 0, cash: 0, card: 0, known: false };
  }

  const labels = cashboxLabels();
  const items = rows
    .map((row) => {
      const cashbox = row.docType.slice(4);
      return { cashbox, label: labels.get(cashbox) ?? `Kassa ${cashbox}`, amount: num(row.amount) };
    })
    .filter((item) => item.amount !== 0)
    .sort((a, b) => b.amount - a.amount);

  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const cash = items.filter((item) => CASH_BOXES.has(item.cashbox)).reduce((sum, i) => sum + i.amount, 0);
  return { items, total, cash, card: total - cash, known: items.length > 0 };
}

/** Oy ichidagi sotuv va qaytarish — DailySales jadvalidan */
export async function salesSplit(from: Date, to: Date, unit: string | null) {
  let rows: { docType: string; amount: unknown }[] = [];
  try {
    rows = await db.dailySales.groupBy({
      by: ["docType"],
      _sum: { amount: true },
      where: {
        day: { gte: from, lt: to },
        NOT: { docType: { startsWith: "PAY:" } },
        ...(unit ? { unit } : {}),
      },
    }).then((list) => list.map((row) => ({ docType: row.docType, amount: row._sum.amount })));
  } catch {
    // Jadval hali yaratilmagan
    return { sales: 0, refunds: 0, net: 0, known: false };
  }

  const groups = docTypeGroups();
  let sales = 0;
  let refunds = 0;
  for (const row of rows) {
    const amount = num(row.amount);
    if (groups.refund.has(row.docType)) refunds += Math.abs(amount);
    else if (groups.sale.has(row.docType)) sales += amount;
  }
  return { sales, refunds, net: sales - refunds, known: rows.length > 0 };
}

async function getBranchId() {
  const session = await auth();
  if (session?.user?.branchId) return session.user.branchId;
  return (await activeBranch()).id;
}

// ─── Sana yordamchilari ───
function startOfDay(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function startOfMonth(offset = 0, base = new Date()) {
  return new Date(base.getFullYear(), base.getMonth() + offset, 1);
}
const num = (v: unknown) => Number(v ?? 0);
/** MonthlyFinance.periodMonth uchun: oy boshi UTC yarim tunda */
export function utcMonthStart(d: Date) {
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1));
}
const M = (v: unknown) => num(v) / 1_000_000; // mln so'm

// ─────────────────────────────────────────────────────────────
//  MOLIYA
// ─────────────────────────────────────────────────────────────
export async function getFinanceData(period?: Date) {
  const branchId = await getBranchId();
  const today = startOfDay();
  const tomorrow = new Date(today.getTime() + 864e5);
  const yesterday = new Date(today.getTime() - 864e5);
  // Oy tanlansa oylik agregatlar o'sha oyga tayanadi; bugun/hafta jonli qoladi.
  const base = period ?? new Date();
  const monthStart = new Date(base.getFullYear(), base.getMonth(), 1);
  const nextMonth = new Date(base.getFullYear(), base.getMonth() + 1, 1);
  const lastMonthStart = new Date(base.getFullYear(), base.getMonth() - 1, 1);
  const weekAgo = new Date(today.getTime() - 6 * 864e5);
  const sixMonthsAgo = startOfMonth(-5);

  const [
    todayAgg,
    yesterdayAgg,
    monthMargin,
    lastMonthMargin,
    payAgg,
    invValue,
    weekRows,
    catRows,
    seriesRows,
  ] = await Promise.all([
    db.sale.aggregate({ _sum: { total: true }, where: { branchId, createdAt: { gte: today, lt: tomorrow } } }),
    db.sale.aggregate({ _sum: { total: true }, where: { branchId, createdAt: { gte: yesterday, lt: today } } }),
    db.$queryRaw<{ margin: number }[]>`
      SELECT COALESCE(SUM(si."lineTotal" - si."costPrice" * si.quantity), 0)::float8 AS margin
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${monthStart} AND s."createdAt" < ${nextMonth}`,
    db.$queryRaw<{ margin: number }[]>`
      SELECT COALESCE(SUM(si."lineTotal" - si."costPrice" * si.quantity), 0)::float8 AS margin
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${lastMonthStart} AND s."createdAt" < ${monthStart}`,
    db.$queryRaw<{ method: string; sum: number }[]>`
      SELECT s."paymentMethod"::text AS method, COALESCE(SUM(s.total),0)::float8 AS sum
      FROM "Sale" s WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${monthStart} AND s."createdAt" < ${nextMonth}
      GROUP BY 1`,
    db.$queryRaw<{ value: number }[]>`
      SELECT COALESCE(SUM(stock * "costPrice"),0)::float8 AS value FROM "Product" WHERE "isActive" = true AND "branchId" = ${branchId}`,
    db.$queryRaw<{ d: Date; total: number }[]>`
      SELECT date_trunc('day', s."createdAt") AS d, COALESCE(SUM(s.total),0)::float8 AS total
      FROM "Sale" s WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${weekAgo}
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<{ category: string; revenue: number }[]>`
      SELECT p.category, COALESCE(SUM(si."lineTotal"),0)::float8 AS revenue
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId" JOIN "Product" p ON p.id = si."productId"
      WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${monthStart} GROUP BY p.category ORDER BY revenue DESC`,
    db.$queryRaw<{ m: Date; rev: number }[]>`
      SELECT date_trunc('month', s."createdAt") AS m, COALESCE(SUM(s.total),0)::float8 AS rev
      FROM "Sale" s WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${sixMonthsAgo}
      GROUP BY 1 ORDER BY 1`,
  ]);

  const [expenseSeries, monthDailyRows] = await Promise.all([
    db.$queryRaw<{ m: Date; exp: number }[]>`
      SELECT date_trunc('month', e."spentAt") AS m, COALESCE(SUM(e.amount),0)::float8 AS exp
      FROM "Expense" e WHERE e."branchId" = ${branchId} AND e."spentAt" >= ${sixMonthsAgo}
        AND e."category" <> 'GOODS' 
      GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<{ d: Date; total: number }[]>`
      SELECT date_trunc('day', s."createdAt") AS d, COALESCE(SUM(s.total),0)::float8 AS total
      FROM "Sale" s WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${monthStart} AND s."createdAt" < ${nextMonth}
      GROUP BY 1 ORDER BY 1`,
  ]);

  // Kunlik jamlanma (22-hisobot) bor kunlar/oylar — F-Apteka bilan bir xil
  // savdo; jamlanmasi yo'q eski kunlar cheklardan qoladi
  const chartFilial = await currentFilial();
  const chartUnit = chartFilial === "Umumiy" ? null : chartFilial;
  const retailRows = await retailDaily(utcDay(sixMonthsAgo), utcDay(tomorrow), chartUnit);
  const retailDays = retailByLocalDate(retailRows);
  const retailMonths = retailByLocalDate(retailRows, true);
  for (const [key, value] of retailDays) {
    const d = new Date(key);
    if (d >= weekAgo) {
      const row = weekRows.find((r) => startOfDay(new Date(r.d)).getTime() === key);
      if (row) row.total = value.turnover;
      else weekRows.push({ d, total: value.turnover });
    }
    if (d >= monthStart && d < nextMonth) {
      const row = monthDailyRows.find((r) => startOfDay(new Date(r.d)).getTime() === key);
      if (row) row.total = value.turnover;
      else monthDailyRows.push({ d, total: value.turnover });
    }
  }
  for (const [key, value] of retailMonths) {
    const row = seriesRows.find((r) => new Date(r.m).getTime() === key);
    if (row) row.rev = value.turnover;
    else seriesRows.push({ m: new Date(key), rev: value.turnover });
  }

  // Joriy oy — kunlik savdo (bugungacha)
  const monthDayMap = new Map(
    monthDailyRows.map((r) => [startOfDay(new Date(r.d)).getTime(), M(r.total)]),
  );
  const daysInMonthSoFar = today.getDate();
  const monthDaily = Array.from({ length: daysInMonthSoFar }, (_, i) => {
    const day = new Date(today.getFullYear(), today.getMonth(), i + 1);
    return { label: String(i + 1), value: +(monthDayMap.get(day.getTime()) ?? 0).toFixed(2) };
  });

  // Haftalik (7 kun, bo'sh kunlarni 0 bilan to'ldirish)
  const UZ = ["Yak", "Dush", "Sesh", "Chor", "Pay", "Jum", "Sha"];
  const weekMap = new Map(weekRows.map((r) => [startOfDay(new Date(r.d)).getTime(), M(r.total)]));
  const weekSales = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(today.getTime() - (6 - i) * 864e5);
    return { label: UZ[day.getDay()], value: +(weekMap.get(day.getTime()) ?? 0).toFixed(2) };
  });

  // Toifalar (top 4 + boshqa)
  const totalCat = catRows.reduce((s, r) => s + r.revenue, 0) || 1;
  const top = catRows.slice(0, 3);
  const restSum = catRows.slice(3).reduce((s, r) => s + r.revenue, 0);
  const categories = [
    ...top.map((r) => ({ name: r.category, value: Math.round((r.revenue / totalCat) * 100) })),
    ...(restSum > 0 ? [{ name: "Boshqa", value: Math.round((restSum / totalCat) * 100) }] : []),
  ];

  // 6 oylik seriya
  const expMap = new Map(expenseSeries.map((r) => [new Date(r.m).getTime(), M(r.exp)]));
  const profitSeries = Array.from({ length: 6 }, (_, i) => {
    const d = startOfMonth(-5 + i);
    const rev = seriesRows.find((r) => new Date(r.m).getTime() === d.getTime());
    return {
      label: monthName(d.getMonth() + 1).slice(0, 3),
      savdo: +(rev ? M(rev.rev) : 0).toFixed(1),
      xarajat: +(expMap.get(d.getTime()) ?? 0).toFixed(1),
    };
  });

  // ERP ichidagi POS savdolari (kam) — to'lov turi o'zida yozilgan
  const posCash = payAgg.find((p) => p.method === "CASH")?.sum ?? 0;
  const posCard = payAgg.find((p) => p.method === "CARD")?.sum ?? 0;
  const mixed = payAgg.find((p) => p.method === "MIXED")?.sum ?? 0;

  // F-Apteka savdosi: sotuv va qaytarish. To'lov turini (naqd/terminal)
  // F-Apteka bermaydi, shuning uchun ajratilmaydi.
  const filial = await currentFilial();
  const [split, payments] = await Promise.all([
    salesSplit(monthStart, nextMonth, filial === "Umumiy" ? null : filial),
    paymentBreakdown(monthStart, nextMonth, filial === "Umumiy" ? null : filial),
  ]);
  const cash = posCash;
  const card = posCard;

  // Kunlik jamlanma (22-hisobot) bor bo'lsa — F-Apteka bilan bir xil raqam:
  // savdo qaytarish ayirilgan, foyda QQSsiz. Aks holda cheklardan.
  const retailUnit = filial === "Umumiy" ? null : filial;
  const [rToday, rYesterday, rMonth, rLastMonth] = await Promise.all([
    retailTotals(utcDay(today), utcDay(tomorrow), retailUnit),
    retailTotals(utcDay(yesterday), utcDay(today), retailUnit),
    retailTotals(utcDay(monthStart), utcDay(nextMonth), retailUnit),
    retailTotals(utcDay(lastMonthStart), utcDay(monthStart), retailUnit),
  ]);
  const todaySales = rToday.known ? rToday.turnover : num(todayAgg._sum.total);
  const yesterdaySales = (rYesterday.known ? rYesterday.turnover : num(yesterdayAgg._sum.total)) || 1;
  const margin = rMonth.known ? rMonth.profit : num(monthMargin[0]?.margin);
  const lastMargin = (rLastMonth.known ? rLastMonth.profit : num(lastMonthMargin[0]?.margin)) || 1;

  return {
    todaySales,
    todayTrend: ((todaySales - yesterdaySales) / yesterdaySales) * 100,
    monthlyProfit: margin,
    profitTrend: ((margin - lastMargin) / lastMargin) * 100,
    cashTotal: split.known ? split.net : cash + card + mixed,
    cash,
    card,
    // F-Apteka savdosi: sotuv, qaytarish va sof tushum
    faptekaSales: split.sales,
    faptekaRefunds: split.refunds,
    hasFaptekaSplit: split.known,
    payments: payments.items,
    paymentsTotal: payments.total,
    paymentsCash: payments.cash,
    paymentsCard: payments.card,
    hasPayments: payments.known,
    inventoryValue: num(invValue[0]?.value),
    weekSales,
    monthDaily,
    sixMonthSales: profitSeries.map((p) => ({ label: p.label, value: p.savdo })),
    categories,
    profitSeries,
  };
}

// ─────────────────────────────────────────────────────────────
//  OMBOR
// ─────────────────────────────────────────────────────────────
export type StockStatus = { label: string; color: "green" | "amber" | "red" };
export function stockStatus(stock: number, min: number): StockStatus {
  if (min > 0 && stock < min * 0.4) return { label: "Zudlik buyurtma", color: "red" };
  if (stock < min) return { label: "Kam qoldiq", color: "red" };
  if (stock < min * 1.2) return { label: "Chegarada", color: "amber" };
  return { label: "Yetarli", color: "green" };
}

export async function getInventoryData() {
  const branchId = await getBranchId();
  const in30 = new Date(Date.now() + 30 * 864e5);
  const [products, totalCount, valueRow] = await Promise.all([
    db.product.findMany({
      where: { isActive: true, branchId },
      orderBy: { name: "asc" },
    }),
    db.product.count({ where: { isActive: true, branchId } }),
    db.$queryRaw<{ value: number }[]>`
      SELECT COALESCE(SUM(stock * "costPrice"),0)::float8 AS value FROM "Product" WHERE "isActive" = true AND "branchId" = ${branchId}`,
  ]);

  const faptekaProducts = products.filter((p) => isFaptekaSku(p.sku));
  const lowStock = products.filter((p) => p.stock < p.minStock).length;
  const expiring = products.filter((p) => p.expiryDate && p.expiryDate <= in30).length;
  const faptekaLastUpdated = faptekaProducts.reduce<Date | null>((latest, product) => {
    if (!latest || product.updatedAt > latest) return product.updatedAt;
    return latest;
  }, null);

  return {
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku,
      category: p.category,
      stock: p.stock,
      minStock: p.minStock,
      salePrice: num(p.salePrice),
      costPrice: num(p.costPrice),
      expiryDate: p.expiryDate ? p.expiryDate.toISOString().slice(0, 10) : null,
      fromFapteka: isFaptekaSku(p.sku),
      status: stockStatus(p.stock, p.minStock),
    })),
    totalCount,
    lowStock,
    expiring,
    faptekaCount: faptekaProducts.length,
    faptekaStock: faptekaProducts.reduce((sum, product) => sum + product.stock, 0),
    faptekaLastUpdated,
    inventoryValue: num(valueRow[0]?.value),
  };
}

// ─────────────────────────────────────────────────────────────
//  HARAJATLAR
// ─────────────────────────────────────────────────────────────
export async function getExpensesData(period?: Date) {
  const branchId = await getBranchId();

  // Oy berilmasa: joriy oyda yozuv bo'lmasa, ma'lumot bor eng oxirgi oyni ko'rsatamiz
  let monthStart: Date;
  if (period) {
    monthStart = new Date(period.getFullYear(), period.getMonth(), 1);
  } else {
    const current = startOfMonth(0);
    const [currentCount, currentFin] = await Promise.all([
      db.expense.count({ where: { branchId, spentAt: { gte: current, lt: startOfMonth(1) } } }),
      db.monthlyFinance.count({ where: { branchId, periodMonth: utcMonthStart(current) } }),
    ]);
    if (currentCount > 0 || currentFin > 0) {
      monthStart = current;
    } else {
      // Harajat ham, moliyaviy xulosa ham hisobga olinadi — aks holda
      // faqat moliya kiritilgan oy (masalan avgust) ochilmay qolardi
      const [lastExpense, lastFin] = await Promise.all([
        db.expense.findFirst({
          where: { branchId },
          orderBy: { spentAt: "desc" },
          select: { spentAt: true },
        }),
        db.monthlyFinance.findFirst({
          where: { branchId },
          orderBy: { periodMonth: "desc" },
          select: { periodMonth: true },
        }),
      ]);
      const candidates = [
        lastExpense && new Date(lastExpense.spentAt.getFullYear(), lastExpense.spentAt.getMonth(), 1),
        lastFin &&
          new Date(lastFin.periodMonth.getUTCFullYear(), lastFin.periodMonth.getUTCMonth(), 1),
      ].filter((d): d is Date => d !== null && d !== undefined);
      monthStart = candidates.length
        ? new Date(Math.max(...candidates.map((d) => d.getTime())))
        : current;
    }
  }
  const nextMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 1);
  const filial = await currentFilial();
  const unitFilter = unitWhere(filial);
  const where = { branchId, spentAt: { gte: monthStart, lt: nextMonth }, ...unitFilter };
  // Tovar xaridi harajat emas: u omborga qo'shiladi, sotilgach tan narxi
  // "Foyda" ichida allaqachon ayirilgan. Uni ham ayirsak ikki marta
  // hisoblanardi (sentabrda sof foyda -1,25 mlrd chiqqan edi).
  const opWhere = { ...where, category: { not: "GOODS" as const } };

  const [list, totalAgg, byCat, byUnitRows, finRows, debtRows, allDates, finMonths] =
    await Promise.all([
      db.expense.findMany({ where, orderBy: { spentAt: "desc" } }),
      db.expense.aggregate({ _sum: { amount: true }, where: opWhere }),
      db.expense.groupBy({ by: ["category"], _sum: { amount: true }, where }),
      db.expense.groupBy({ by: ["unit"], _sum: { amount: true }, _count: true, where: opWhere }),
      db.monthlyFinance.findMany({
        // periodMonth UTC yarim tunda saqlanadi — mahalliy vaqt bilan
        // taqqoslasak UTC+5 da oy siljib ketadi
        where: { branchId, periodMonth: utcMonthStart(monthStart), ...unitFilter },
        orderBy: { unit: "asc" },
      }),
      db.debt.findMany({ where: { branchId }, orderBy: { createdAt: "asc" } }),
      db.expense.findMany({
        where: { branchId },
        select: { spentAt: true },
        orderBy: { spentAt: "desc" },
      }),
      // Moliyaviy xulosa bor, lekin harajat yozuvi yo'q oylar ham
      // ro'yxatda ko'rinishi kerak
      db.monthlyFinance.findMany({
        where: { branchId },
        select: { periodMonth: true },
        distinct: ["periodMonth"],
      }),
    ]);

  await overlayRetail(finRows);
  const catSum = (c: string) => num(byCat.find((b) => b.category === c)?._sum.amount);

  // Tovar puli ikki manbadan kelishi mumkin: F-Apteka kirimi (avtomatik) va
  // qo'lda kiritilgani. Ikkalasi bir oyda bo'lsa - ikki marta hisoblangan.
  const goodsAuto = list
    .filter((e) => e.category === "GOODS" && isFaptekaExpenseTitle(e.title))
    .reduce((sum, e) => sum + num(e.amount), 0);

  const byUnit = byUnitRows
    .map((r) => ({ unit: r.unit ?? "Umumiy", amount: num(r._sum.amount), count: r._count }))
    .sort((a, b) => b.amount - a.amount);
  const unitSpent = new Map(byUnit.map((u) => [u.unit, u.amount]));

  // Harajat sanalari + moliyaviy xulosa oylari birlashtiriladi, yangisi birinchi
  const monthKeys = new Set<string>([
    ...allDates.map((d) => `${d.spentAt.getFullYear()}-${d.spentAt.getMonth()}`),
    ...finMonths.map(
      (f) => `${f.periodMonth.getUTCFullYear()}-${f.periodMonth.getUTCMonth()}`,
    ),
  ]);
  const availableMonths = Array.from(monthKeys)
    .map((key) => {
      const [y, m] = key.split("-").map(Number);
      return new Date(y, m, 1);
    })
    .sort((a, b) => b.getTime() - a.getTime());

  // Doimiy xarajatlar: o'tgan oylarda bor, lekin shu oyda hali yo'q
  const recurringSources = await db.expense.findMany({
    where: { branchId, isRecurring: true, spentAt: { lt: monthStart } },
    orderBy: { spentAt: "desc" },
    take: 60,
  });
  const currentTitles = new Set(list.map((expense) => expense.title.trim().toLowerCase()));
  const missingRecurring: { id: string; title: string; category: string; amount: number; unit: string | null }[] = [];
  const seen = new Set<string>();
  for (const expense of recurringSources) {
    const key = expense.title.trim().toLowerCase();
    if (seen.has(key) || currentTitles.has(key)) continue;
    seen.add(key);
    missingRecurring.push({
      id: expense.id,
      title: expense.title,
      category: expense.category as string,
      amount: num(expense.amount),
      unit: expense.unit,
    });
  }

  return {
    period: monthStart,
    availableMonths,
    missingRecurring,
    list: list.map((e) => ({
      id: e.id,
      title: e.title,
      category: e.category,
      amount: num(e.amount),
      spentAt: e.spentAt,
      isRecurring: e.isRecurring,
      unit: e.unit,
    })),
    total: num(totalAgg._sum.amount),
    rent: catSum("RENT") + catSum("UTILITIES"),
    salary: catSum("SALARY"),
    goods: catSum("GOODS"),
    goodsAuto,
    // Kasr qoldig'i "0 so'm" bo'lib ko'rinib ogohlantirish chiqarmasin
    goodsManual: Math.max(0, Math.round(catSum("GOODS") - goodsAuto)),
    byCategory: byCat
      .map((c) => ({ category: c.category as string, amount: num(c._sum.amount) }))
      .sort((a, b) => b.amount - a.amount),
    byUnit,
    monthlyUnits: finRows.map((f) => {
      const spent = unitSpent.get(f.unit) ?? 0;
      const profit = num(f.profit);
      return {
        unit: f.unit,
        turnover: num(f.turnover),
        profit,
        expenses: spent,
        netProfit: profit - spent,
        stockValue: num(f.stockValue),
        revaluation: num(f.revaluation),
        bankBalance: f.bankBalance == null ? null : num(f.bankBalance),
        note: f.note,
      };
    }),
    debts: debtRows.map((q) => ({
      id: q.id,
      counterparty: q.counterparty,
      direction: q.direction as string,
      total: num(q.totalAmount),
      paid: num(q.paidAmount),
      remaining: num(q.totalAmount) - num(q.paidAmount),
      note: q.note,
    })),
  };
}

// ─────────────────────────────────────────────────────────────
//  XODIMLAR
// ─────────────────────────────────────────────────────────────
export async function getEmployeesData() {
  const now = new Date();
  const filial = await currentFilial();
  const employees = await db.employee.findMany({
    where: { ...unitWhere(filial) },
    orderBy: { createdAt: "asc" },
    include: {
      branch: true,
      kpiRecords: { where: { year: now.getFullYear(), month: now.getMonth() + 1 } },
    },
  });
  return employees.map((e) => ({
    id: e.id,
    fullName: e.fullName,
    position: e.position,
    // Telegram bot xodimni shu raqamdan taniydi
    phone: e.phone,
    branch: e.branch.name,
    unit: e.unit,
    baseSalary: num(e.baseSalary),
    status: e.status,
    kpi: e.kpiRecords[0]?.totalScore ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────
//  KPI
// ─────────────────────────────────────────────────────────────
export async function getKpiData() {
  const now = new Date();
  const filial = await currentFilial();

  // Joriy oyda yozuv bo'lmasa — ma'lumot bor eng oxirgi oyni ko'rsatamiz
  const latest = await db.kpiRecord.findFirst({
    orderBy: [{ year: "desc" }, { month: "desc" }],
    select: { year: true, month: true },
  });
  const year = latest?.year ?? now.getFullYear();
  const month = latest?.month ?? now.getMonth() + 1;

  // Barcha faol xodimlar ro'yxatga kiradi — KPI hali kiritilmagan bo'lsa ham,
  // aks holda birinchi KPI ni kiritishning iloji bo'lmaydi.
  const [employees, records] = await Promise.all([
    db.employee.findMany({
      where: { status: "ACTIVE", ...unitWhere(filial) },
      orderBy: { fullName: "asc" },
    }),
    db.kpiRecord.findMany({ where: { year, month } }),
  ]);

  const byEmployee = new Map(records.map((r) => [r.employeeId, r]));

  const ranking = employees
    .map((e) => {
      const r = byEmployee.get(e.id);
      return {
        id: r?.id ?? `pending-${e.id}`,
        employeeId: e.id,
        name: e.fullName,
        position: e.position,
        unit: e.unit,
        baseSalary: num(e.baseSalary),
        hasRecord: Boolean(r),
        total: r?.totalScore ?? 0,
        bonusPercent: r?.bonusPercent ?? 0,
        bonusAmount: num(r?.bonusAmount),
        components: {
          sales: r?.salesScore ?? 0,
          margin: r?.marginScore ?? 0,
          attendance: r?.attendanceScore ?? 0,
          discipline: r?.disciplineScore ?? 0,
          customer: r?.customerScore ?? 0,
        },
      };
    })
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  const scored = ranking.filter((r) => r.hasRecord);
  const avg = scored.length
    ? Math.round((scored.reduce((s, r) => s + r.total, 0) / scored.length) * 10) / 10
    : 0;

  return {
    ranking,
    scoredCount: scored.length,
    avg,
    bonusFund: ranking.reduce((s, r) => s + r.bonusAmount, 0),
    over90: scored.filter((r) => r.total >= 90).length,
    under60: scored.filter((r) => r.total < 60).length,
    top: scored[0] ?? null,
    month,
    year,
  };
}

// ─────────────────────────────────────────────────────────────
//  DAVOMAT
// ─────────────────────────────────────────────────────────────
/** day — ko'riladigan kun (mahalliy yarim tun); berilmasa bugun */
export async function getAttendanceData(day?: Date) {
  const today = day ? startOfDay(day) : startOfDay();
  const tomorrow = new Date(today.getTime() + 864e5);
  const monthStart = startOfMonth(0, today);

  const [employees, todayRecords, monthRecords] = await Promise.all([
    db.employee.findMany({ where: { status: { not: "INACTIVE" } }, orderBy: { createdAt: "asc" } }),
    db.attendance.findMany({ where: { date: { gte: today, lt: tomorrow } } }),
    db.attendance.findMany({ where: { date: { gte: monthStart } } }),
  ]);

  const byEmp = new Map(todayRecords.map((r) => [r.employeeId, r]));
  const records = employees.map((e) => {
    const r = byEmp.get(e.id);
    return {
      employeeId: e.id,
      name: e.fullName,
      checkIn: r?.checkIn ?? null,
      lateMinutes: r?.lateMinutes ?? 0,
      penalty: r?.penalty ?? 0,
      status: (r?.status as string | undefined) ?? null, // null = belgilanmagan
    };
  });

  const present = records.filter((r) => r.status === "PRESENT" || r.status === "LATE").length;
  const lateThisMonth = monthRecords.filter((r) => r.lateMinutes > 5).length;
  const checkIns = todayRecords.filter((r) => r.checkIn).map((r) => r.checkIn!);
  const avgCheckIn = checkIns.length
    ? new Date(checkIns.reduce((s, d) => s + d.getTime(), 0) / checkIns.length)
    : null;
  const perfect = monthRecords.filter((r) => r.status === "PRESENT" && r.lateMinutes === 0).length;
  const totalPenalty = monthRecords.reduce((s, r) => s + r.penalty, 0);

  return {
    records,
    presentCount: present,
    totalEmployees: employees.length,
    lateThisMonth,
    totalPenalty,
    avgCheckIn,
    perfect,
  };
}

// ─────────────────────────────────────────────────────────────
//  MIJOZLAR (sodiqlik)
// ─────────────────────────────────────────────────────────────
export async function getCustomersData() {
  const customers = await db.customer.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      loyaltyTransactions: { orderBy: { createdAt: "desc" }, take: 10 },
    },
  });

  const list = customers.map((c) => ({
    id: c.id,
    fullName: c.fullName,
    phone: c.phone,
    cardCode: c.cardCode,
    points: c.points,
    tier: c.tier,
    totalSpent: num(c.totalSpent),
    viaTelegram: c.telegramId !== null,
    history: c.loyaltyTransactions.map((t) => ({
      id: t.id,
      type: t.type as string,
      points: t.points,
      note: t.note,
      createdAt: t.createdAt.toISOString(),
    })),
  }));

  return {
    list,
    total: list.length,
    viaTelegram: list.filter((c) => c.viaTelegram).length,
    totalPoints: list.reduce((s, c) => s + c.points, 0),
    gold: list.filter((c) => c.tier === "GOLD").length,
  };
}

// ─────────────────────────────────────────────────────────────
//  HISOBOTLAR — xodim/foyda korrelyatsiyasi
// ─────────────────────────────────────────────────────────────
export async function getReportsData() {
  const now = new Date();
  const monthStart = startOfMonth(0);

  const [marginRows, kpis, lowProducts] = await Promise.all([
    db.$queryRaw<{ id: string; name: string; margin: number }[]>`
      SELECT e.id, e."fullName" AS name,
        COALESCE(SUM(si."lineTotal" - si."costPrice" * si.quantity),0)::float8 AS margin
      FROM "Sale" s JOIN "Employee" e ON e.id = s."employeeId"
      JOIN "SaleItem" si ON si."saleId" = s.id
      WHERE s."createdAt" >= ${monthStart}
      GROUP BY e.id, e."fullName"`,
    db.kpiRecord.findMany({
      where: { year: now.getFullYear(), month: now.getMonth() + 1 },
      include: { employee: true },
    }),
    db.product.findMany({ where: { isActive: true } }),
  ]);

  const kpiMap = new Map(kpis.map((k) => [k.employeeId, k.totalScore]));
  const correlation = marginRows
    .map((r) => ({
      label: `${r.name.split(" ")[0]} (${kpiMap.get(r.id) ?? "-"})`,
      value: +M(r.margin).toFixed(1),
      kpi: kpiMap.get(r.id) ?? 0,
    }))
    .sort((a, b) => b.kpi - a.kpi);

  const critical = lowProducts.find((p) => p.stock < p.minStock * 0.4);

  return { correlation, critical: critical?.name ?? null };
}

// ─────────────────────────────────────────────────────────────
//  ANALITIKA — F-Apteka uslubidagi grafiklar
//  Manba: MonthlyFinance (savdo/foyda/astatka), Product (ombor),
//  Expense (harajat). Hammasi bor ma'lumotdan hisoblanadi.
// ─────────────────────────────────────────────────────────────
export async function getAnalyticsData(year?: number) {
  const branchId = await getBranchId();
  const y = year ?? new Date().getFullYear();
  const yearStart = new Date(Date.UTC(y, 0, 1));
  const yearEnd = new Date(Date.UTC(y + 1, 0, 1));

  // Savdo endi F-Apteka'dan keladi, shuning uchun yil kesimida tovar
  // tahlillarini ham hisoblaymiz (TOP savdo, sekin sotiladigan, vedomost).
  const salesFrom = yearStart;
  const salesTo = yearEnd;

  const [finRows, catRows, expRows, assortRows, topRows, stockRows, vedomostRows, dailyRows] = await Promise.all([
    // Oylik moliya — filial kesimida (Umumiy'ni chiqarib tashlaymiz, u taqsimlanmagan)
    db.monthlyFinance.findMany({
      where: { branchId, periodMonth: { gte: yearStart, lt: yearEnd } },
      orderBy: { periodMonth: "asc" },
    }),
    // Ombor qiymati — toifa bo'yicha (chakana narxda, jonli)
    db.$queryRaw<{ category: string; value: number; qty: number }[]>`
      SELECT p.category,
        COALESCE(SUM(p.stock * p."salePrice"), 0)::float8 AS value,
        COALESCE(SUM(p.stock), 0)::float8 AS qty
      FROM "Product" p
      WHERE p."isActive" = true AND p."branchId" = ${branchId} AND p.stock > 0
      GROUP BY p.category ORDER BY value DESC`,
    // Harajat — oy bo'yicha
    db.$queryRaw<{ m: Date; exp: number }[]>`
      SELECT date_trunc('month', e."spentAt") AS m, COALESCE(SUM(e.amount), 0)::float8 AS exp
      FROM "Expense" e WHERE e."branchId" = ${branchId}
        AND e."spentAt" >= ${yearStart} AND e."spentAt" < ${yearEnd}
        AND e."category" <> 'GOODS' 
      GROUP BY 1 ORDER BY 1`,
    // Assortiment — hozirgi qoldiq (eng qimmat 50 ta pozitsiya)
    db.$queryRaw<{ name: string; category: string; stock: number; price: number; value: number }[]>`
      SELECT p.name, p.category, p.stock::float8 AS stock, p."salePrice"::float8 AS price,
        (p.stock * p."salePrice")::float8 AS value
      FROM "Product" p
      WHERE p."isActive" = true AND p."branchId" = ${branchId} AND p.stock > 0
      ORDER BY value DESC LIMIT 50`,
    // TOP savdo — tushum bo'yicha
    db.$queryRaw<{ name: string; qty: number; turnover: number; profit: number }[]>`
      SELECT p.name,
        SUM(si.quantity)::float8 AS qty,
        SUM(si."lineTotal")::float8 AS turnover,
        SUM(si."lineTotal" - si."costPrice" * si.quantity)::float8 AS profit
      FROM "SaleItem" si
      JOIN "Sale" s ON s.id = si."saleId"
      JOIN "Product" p ON p.id = si."productId"
      WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${salesFrom} AND s."createdAt" < ${salesTo}
      GROUP BY p.name ORDER BY turnover DESC LIMIT 50`,
    // Qoldig'i bor tovarlar: yil ichida qancha sotilgan (sekin sotiladigan va aylanuvchanlik uchun)
    db.$queryRaw<{ name: string; stock: number; value: number; qty: number }[]>`
      SELECT p.name, p.stock::float8 AS stock,
        (p.stock * p."salePrice")::float8 AS value,
        COALESCE((
          SELECT SUM(si.quantity) FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
          WHERE si."productId" = p.id AND s."createdAt" >= ${salesFrom} AND s."createdAt" < ${salesTo}
        ), 0)::float8 AS qty
      FROM "Product" p
      WHERE p."isActive" = true AND p."branchId" = ${branchId} AND p.stock > 0
      ORDER BY value DESC LIMIT 400`,
    // Aylanma vedomost: kirim, sotuv, hozirgi qoldiq
    db.$queryRaw<{ name: string; incoming: number; sold: number; stock: number }[]>`
      SELECT p.name, p.stock::float8 AS stock,
        COALESCE((
          SELECT SUM(si.quantity) FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
          WHERE si."productId" = p.id AND s."createdAt" >= ${salesFrom} AND s."createdAt" < ${salesTo}
        ), 0)::float8 AS sold,
        COALESCE((
          SELECT SUM(m.quantity) FROM "StockMovement" m
          WHERE m."productId" = p.id AND m.type = 'IN'
            AND m."createdAt" >= ${salesFrom} AND m."createdAt" < ${salesTo}
        ), 0)::float8 AS incoming
      FROM "Product" p
      WHERE p."isActive" = true AND p."branchId" = ${branchId}
      ORDER BY sold DESC LIMIT 50`,
    // Kunlik savdo — oxirgi 60 kun
    db.$queryRaw<{ day: Date; savdo: number; foyda: number }[]>`
      SELECT date_trunc('day', s."createdAt") AS day,
        SUM(si."lineTotal")::float8 AS savdo,
        SUM(si."lineTotal" - si."costPrice" * si.quantity)::float8 AS foyda
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${new Date(Date.now() - 60 * 864e5)}
      GROUP BY 1 ORDER BY 1`,
  ]);

  // Kunlik jamlanma bor kunlarda savdo va QQSsiz foyda F-Apteka bo'yicha
  const sixtyDaysAgo = new Date(Date.now() - 60 * 864e5);
  const retailDays = retailByLocalDate(
    await retailDaily(utcDay(sixtyDaysAgo), utcDay(new Date(Date.now() + 864e5)), null),
  );
  for (const [key, value] of retailDays) {
    const row = dailyRows.find((r) => startOfDay(new Date(r.day)).getTime() === key);
    if (row) {
      row.savdo = value.turnover;
      row.foyda = value.profit;
    } else {
      dailyRows.push({ day: new Date(key), savdo: value.turnover, foyda: value.profit });
    }
  }
  dailyRows.sort((a, b) => new Date(a.day).getTime() - new Date(b.day).getTime());

  // Oy raqami -> harajat
  const expMap = new Map(expRows.map((r) => [new Date(r.m).getUTCMonth() + 1, M(r.exp)]));

  // Har oy uchun barcha filiallar yig'indisi (Umumiy'dan tashqari)
  const monthAgg = new Map<number, { savdo: number; foyda: number; astatka: number }>();
  await overlayRetail(finRows);
  for (const row of finRows) {
    if (row.unit === "Umumiy") continue;
    const m = new Date(row.periodMonth).getUTCMonth() + 1;
    const cur = monthAgg.get(m) ?? { savdo: 0, foyda: 0, astatka: 0 };
    cur.savdo += num(row.turnover) / 1_000_000;
    cur.foyda += num(row.profit) / 1_000_000;
    cur.astatka += num(row.stockValue) / 1_000_000;
    monthAgg.set(m, cur);
  }

  // 12 oylik dinamika — ma'lumot bor oylargacha
  const monthly = Array.from({ length: 12 }, (_, i) => {
    const m = i + 1;
    const a = monthAgg.get(m);
    return {
      month: m,
      label: monthName(m).slice(0, 3),
      savdo: +(a?.savdo ?? 0).toFixed(1),
      foyda: +(a?.foyda ?? 0).toFixed(1),
      astatka: +(a?.astatka ?? 0).toFixed(1),
      xarajat: +(expMap.get(m) ?? 0).toFixed(1),
    };
  }).filter((r) => r.savdo > 0 || r.foyda > 0 || r.astatka > 0 || r.xarajat > 0);

  // Eng oxirgi ma'lumot bor oy — filiallar taqqoslashi uchun
  const lastMonth = finRows
    .filter((r) => r.unit !== "Umumiy")
    .reduce((max, r) => {
      const m = new Date(r.periodMonth).getUTCMonth() + 1;
      return m > max ? m : max;
    }, 0);

  const byUnit = finRows
    .filter((r) => r.unit !== "Umumiy" && new Date(r.periodMonth).getUTCMonth() + 1 === lastMonth)
    .map((r) => ({
      unit: r.unit,
      savdo: +(num(r.turnover) / 1_000_000).toFixed(1),
      foyda: +(num(r.profit) / 1_000_000).toFixed(1),
      astatka: +(num(r.stockValue) / 1_000_000).toFixed(1),
    }))
    .sort((a, b) => b.savdo - a.savdo);

  // Ombor qiymati toifa bo'yicha (top 6 + boshqa), mln so'm
  const totalCat = catRows.reduce((s, r) => s + r.value, 0);
  const topCats = catRows.slice(0, 6).map((r) => ({
    name: r.category,
    value: +M(r.value).toFixed(1),
  }));
  const restCat = catRows.slice(6).reduce((s, r) => s + r.value, 0);
  const inventoryByCategory =
    restCat > 0 ? [...topCats, { name: "Boshqa", value: +M(restCat).toFixed(1) }] : topCats;

  return {
    year: y,
    monthly, // { label, savdo, foyda, astatka, xarajat }[]
    byUnit, // oxirgi oy filiallar kesimi
    lastMonthName: lastMonth ? monthName(lastMonth) : null,
    inventoryByCategory, // ombor qiymati toifa bo'yicha (mln)
    inventoryTotal: +M(totalCat).toFixed(1),
    hasFinance: monthly.length > 0,
    hasInventory: inventoryByCategory.length > 0,
    // Assortiment (sana holatiga) — hozirgi qoldiq
    assortment: assortRows.map((r) => ({
      name: r.name,
      category: r.category,
      stock: Math.round(r.stock),
      price: Math.round(r.price),
      value: +M(r.value).toFixed(2),
    })),
    // TOP savdo — yil bo'yicha eng ko'p tushum keltirgan tovarlar
    topProducts: topRows.map((r) => ({
      name: r.name,
      qty: Math.round(r.qty),
      turnover: +M(r.turnover).toFixed(2),
      profit: +M(r.profit).toFixed(2),
    })),
    // Sekin sotiladigan: qoldig'i bor, lekin yil davomida kam sotilgan
    slowMovers: [...stockRows]
      .sort((a, b) => a.qty - b.qty || b.value - a.value)
      .slice(0, 50)
      .map((r) => ({
        name: r.name,
        stock: Math.round(r.stock),
        qty: Math.round(r.qty),
        value: +M(r.value).toFixed(2),
      })),
    // Aylanuvchanlik: yil savdosi qoldiqqa nisbatan necha marta aylangan
    turnoverRatio: stockRows
      .filter((r) => r.qty > 0 && r.stock > 0)
      .map((r) => ({
        name: r.name,
        stock: Math.round(r.stock),
        qty: Math.round(r.qty),
        ratio: +(r.qty / r.stock).toFixed(2),
      }))
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 50),
    // Aylanma vedomost: kirim, sotuv, hozirgi qoldiq
    vedomost: vedomostRows.map((r) => ({
      name: r.name,
      incoming: Math.round(r.incoming),
      sold: Math.round(r.sold),
      stock: Math.round(r.stock),
    })),
    // Kunlik savdo — oxirgi 60 kun (mln so'm)
    dailySales: dailyRows.map((r) => {
      const day = new Date(r.day);
      return {
        label: `${String(day.getDate()).padStart(2, "0")}.${String(day.getMonth() + 1).padStart(2, "0")}`,
        savdo: +M(r.savdo).toFixed(2),
        foyda: +M(r.foyda).toFixed(2),
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────
//  SAVDO — F-Apteka'dan kelgan sotuvlar
// ─────────────────────────────────────────────────────────────

/**
 * Sana oralig'idagi savdo: kunlik jadval, dorixona kesimi va eng ko'p
 * sotilgan tovarlar.
 *
 * F-Apteka 4-hisoboti chekma-chek emas, kunlik jamlanma beradi — shuning
 * uchun "chek soni" ko'rsatilmaydi, faqat tushum, foyda va marja.
 */
export async function getSalesData(input: { from: Date; to: Date }) {
  const branchId = await getBranchId();
  const filial = await currentFilial();
  const unit = filial === "Umumiy" ? null : filial;
  // `to` — tanlangan kunning o'zi ham kirsin
  const toExclusive = new Date(input.to.getFullYear(), input.to.getMonth(), input.to.getDate() + 1);

  const [dailyRows, unitRows, productRows] = await Promise.all([
    db.$queryRaw<{ day: Date; turnover: number; profit: number }[]>`
      SELECT date_trunc('day', s."createdAt") AS day,
             SUM(si."lineTotal")::float8 AS turnover,
             SUM(si."lineTotal" - si."costPrice" * si.quantity)::float8 AS profit
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."branchId" = ${branchId}
        AND s."createdAt" >= ${input.from} AND s."createdAt" < ${toExclusive}
        AND (${unit}::text IS NULL OR s."unit" = ${unit})
      GROUP BY 1 ORDER BY 1 DESC`,
    db.$queryRaw<{ unit: string | null; turnover: number; profit: number }[]>`
      SELECT s."unit" AS unit,
             SUM(si."lineTotal")::float8 AS turnover,
             SUM(si."lineTotal" - si."costPrice" * si.quantity)::float8 AS profit
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."branchId" = ${branchId}
        AND s."createdAt" >= ${input.from} AND s."createdAt" < ${toExclusive}
        AND (${unit}::text IS NULL OR s."unit" = ${unit})
      GROUP BY 1 ORDER BY 2 DESC`,
    db.$queryRaw<{ name: string; quantity: number; turnover: number; profit: number }[]>`
      SELECT p.name AS name,
             SUM(si.quantity)::float8 AS quantity,
             SUM(si."lineTotal")::float8 AS turnover,
             SUM(si."lineTotal" - si."costPrice" * si.quantity)::float8 AS profit
      FROM "SaleItem" si
      JOIN "Sale" s ON s.id = si."saleId"
      JOIN "Product" p ON p.id = si."productId"
      WHERE s."branchId" = ${branchId}
        AND s."createdAt" >= ${input.from} AND s."createdAt" < ${toExclusive}
        AND (${unit}::text IS NULL OR s."unit" = ${unit})
      GROUP BY 1 ORDER BY 3 DESC LIMIT 25`,
  ]);

  // Kunlik sotuv va qaytarish — F-Apteka hujjat turidan (DailySales)
  const groups = docTypeGroups();
  let paymentRows: { day: Date; docType: string; amount: unknown }[] = [];
  try {
    paymentRows = await db.dailySales.findMany({
      where: {
        day: { gte: input.from, lt: toExclusive },
        NOT: { docType: { startsWith: "PAY:" } },
        ...(unit ? { unit } : {}),
      },
      select: { day: true, docType: true, amount: true },
    });
  } catch {
    // Jadval hali yaratilmagan bo'lsa ustunlar bo'sh qoladi
  }

  const payments = new Map<string, { refund: number }>();
  for (const row of paymentRows) {
    const key = new Date(row.day).toISOString().slice(0, 10);
    const current = payments.get(key) ?? { refund: 0 };
    if (groups.refund.has(row.docType)) current.refund += Math.abs(num(row.amount));
    payments.set(key, current);
  }

  // Kunlik naqd va karta — 30-hisobotdan (PAY: qatorlari)
  let payRows: { day: Date; docType: string; amount: unknown }[] = [];
  try {
    payRows = await db.dailySales.findMany({
      where: {
        day: { gte: input.from, lt: toExclusive },
        docType: { startsWith: "PAY:" },
        ...(unit ? { unit } : {}),
      },
      select: { day: true, docType: true, amount: true },
    });
  } catch {
    // Jadval hali yaratilmagan
  }

  const cashBoxes = new Set((process.env.FAPTEKA_CASH_BOXES ?? "1").split(",").map((v) => v.trim()));
  const byDay = new Map<string, { cash: number; card: number }>();
  for (const row of payRows) {
    const key = new Date(row.day).toISOString().slice(0, 10);
    const current = byDay.get(key) ?? { cash: 0, card: 0 };
    const amount = num(row.amount);
    if (cashBoxes.has(row.docType.slice(4))) current.cash += amount;
    else current.card += amount;
    byDay.set(key, current);
  }

  // Kunlik jamlanma (22-hisobot) bor bo'lsa savdo va foyda shundan —
  // F-Apteka "Продажи за период" bilan bir xil. Cheklar (4-hisobot)
  // summani ~3% oshirib ko'rsatadi, ular faqat tovarlar reytingi uchun.
  const retail = await retailDaily(utcDay(input.from), utcDay(toExclusive), unit);
  if (retail.length) {
    const byDate = new Map<string, { day: Date; turnover: number; profit: number }>();
    const units = new Map<string, { turnover: number; profit: number }>();
    for (const row of retail) {
      const key = new Date(row.day).toISOString().slice(0, 10);
      const day = byDate.get(key) ?? { day: new Date(row.day), turnover: 0, profit: 0 };
      day.turnover += row.turnover;
      day.profit += row.profit;
      byDate.set(key, day);
      const name = row.unit === "Umumiy" ? "Ajratilmagan" : row.unit;
      const entry = units.get(name) ?? { turnover: 0, profit: 0 };
      entry.turnover += row.turnover;
      entry.profit += row.profit;
      units.set(name, entry);
    }
    dailyRows.splice(
      0,
      dailyRows.length,
      ...[...byDate.values()].sort((a, b) => b.day.getTime() - a.day.getTime()),
    );
    unitRows.splice(
      0,
      unitRows.length,
      ...[...units].map(([name, v]) => ({ unit: name, ...v })).sort((a, b) => b.turnover - a.turnover),
    );
  }

  const daily = dailyRows.map((row) => {
    const day = new Date(row.day);
    const payment = payments.get(day.toISOString().slice(0, 10));
    const pay = byDay.get(day.toISOString().slice(0, 10));
    return {
      day,
      turnover: num(row.turnover),
      profit: num(row.profit),
      refund: payment?.refund ?? 0,
      cash: pay?.cash ?? 0,
      card: pay?.card ?? 0,
    };
  });
  const turnover = daily.reduce((sum, row) => sum + row.turnover, 0);
  const profit = daily.reduce((sum, row) => sum + row.profit, 0);

  return {
    filial,
    daily,
    turnover,
    profit,
    refundTotal: daily.reduce((sum, row) => sum + row.refund, 0),
    hasRefunds: paymentRows.length > 0,
    cashTotal: daily.reduce((sum, row) => sum + row.cash, 0),
    cardTotal: daily.reduce((sum, row) => sum + row.card, 0),
    hasPayments: payRows.length > 0,
    // Tan narx hali kelmagan bo'lsa foyda tushumga teng bo'lib qoladi —
    // sahifa shunda ogohlantirish ko'rsatadi.
    costMissing: turnover > 0 && profit >= turnover - 0.5,
    byUnit: unitRows.map((row) => ({
      unit: row.unit ?? "Ajratilmagan",
      turnover: num(row.turnover),
      profit: num(row.profit),
    })),
    products: productRows.map((row) => ({
      name: row.name,
      quantity: num(row.quantity),
      turnover: num(row.turnover),
      profit: num(row.profit),
    })),
  };
}

// ─────────────────────────────────────────────────────────────
//  QARZLAR
// ─────────────────────────────────────────────────────────────

/** 10 kundan kam qolsa qizil, 20 kundan kam qolsa sariq */
export const DEBT_URGENT_DAYS = 10;
export const DEBT_DUE_SOON_DAYS = 20;

/**
 * Qarzlar: firma (tovar) va ko'cha (naqd) kesimida, tarixi bilan.
 * Qoldiq tarixdan hisoblanadi, shuning uchun "shuncha berildi, shuncha
 * qoldi" har doim to'g'ri chiqadi.
 */
export async function getDebtsData() {
  const branchId = await getBranchId();

  // Jadval hali yaratilmagan bo'lsa (qarzlar.sql ishga tushirilmagan),
  // sahifa xato bermasin — bo'sh ro'yxat va ogohlantirish qaytaramiz.
  type DebtWithEntries = Prisma.DebtGetPayload<{ include: { entries: true } }>;
  let rows: DebtWithEntries[] = [];
  let needsMigration = false;
  try {
    rows = await db.debt.findMany({
      where: { branchId },
      orderBy: [{ closedAt: "asc" }, { dueDate: "asc" }, { createdAt: "desc" }],
      include: { entries: { orderBy: { happenedAt: "desc" } } },
    });
  } catch {
    needsMigration = true;
  }

  const today = startOfDay();
  const urgentEdge = new Date(today.getTime() + DEBT_URGENT_DAYS * 864e5);
  const soonEdge = new Date(today.getTime() + DEBT_DUE_SOON_DAYS * 864e5);

  const debts = rows.map((debt) => {
    const total = num(debt.totalAmount);
    const paid = num(debt.paidAmount);
    const remaining = total - paid;
    const due = debt.dueDate ? new Date(debt.dueDate) : null;
    const closed = Boolean(debt.closedAt) || remaining <= 0.009;

    return {
      id: debt.id,
      counterparty: debt.counterparty,
      kind: debt.kind as "FIRM" | "STREET",
      currency: debt.currency as "UZS" | "USD",
      direction: debt.direction as "PAYABLE" | "RECEIVABLE",
      total,
      paid,
      remaining,
      dueDate: due,
      closed,
      // Rang uchun: qizil (o'tgan yoki 10 kundan kam), sariq (20 kundan kam)
      overdue: !closed && due !== null && due <= urgentEdge,
      dueSoon: !closed && due !== null && due > urgentEdge && due <= soonEdge,
      unit: debt.unit,
      note: debt.note,
      entries: debt.entries.map((entry) => ({
        id: entry.id,
        ref: entry.ref,
        type: entry.type as "CHARGE" | "PAYMENT",
        amount: num(entry.amount),
        happenedAt: entry.happenedAt,
        note: entry.note,
      })),
    };
  });

  const open = debts.filter((debt) => !debt.closed);
  const sumBy = (kind: "FIRM" | "STREET", currency: "UZS" | "USD") =>
    open
      .filter((debt) => debt.kind === kind && debt.currency === currency)
      .reduce((sum, debt) => sum + debt.remaining, 0);

  return {
    needsMigration,
    debts,
    totals: {
      firmUzs: sumBy("FIRM", "UZS"),
      firmUsd: sumBy("FIRM", "USD"),
      streetUzs: sumBy("STREET", "UZS"),
      streetUsd: sumBy("STREET", "USD"),
    },
    overdue: open.filter((debt) => debt.overdue),
    dueSoon: open.filter((debt) => debt.dueSoon),
    openCount: open.length,
  };
}

// ─────────────────────────────────────────────────────────────
//  BOSH SAHIFA (dashboard)
// ─────────────────────────────────────────────────────────────

/** Saytga kirganda ko'rinadigan umumiy holat — hamma bo'limdan qisqacha */
export async function getDashboardData() {
  const branchId = await getBranchId();
  const filial = await currentFilial();
  const unit = filial === "Umumiy" ? null : filial;

  const today = startOfDay();
  const tomorrow = new Date(today.getTime() + 864e5);
  const yesterday = new Date(today.getTime() - 864e5);
  const monthStart = startOfMonth(0);
  const nextMonth = startOfMonth(1);
  const in30 = new Date(today.getTime() + 30 * 864e5);

  const [
    todayRows,
    yesterdayRows,
    monthRows,
    stock,
    lowStock,
    expiring,
    lastSync,
    todayPay,
    ownExpense,
  ] = await Promise.all([
    db.$queryRaw<{ turnover: number }[]>`
      SELECT COALESCE(SUM(si."lineTotal"), 0)::float8 AS turnover
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${today} AND s."createdAt" < ${tomorrow}
        AND (${unit}::text IS NULL OR s."unit" = ${unit})`
      .then(async (rows) => {
        const retail = await retailTotals(utcDay(today), utcDay(tomorrow), unit);
        return retail.known ? [{ turnover: retail.turnover }] : rows;
      }),
    db.$queryRaw<{ turnover: number }[]>`
      SELECT COALESCE(SUM(si."lineTotal"), 0)::float8 AS turnover
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${yesterday} AND s."createdAt" < ${today}
        AND (${unit}::text IS NULL OR s."unit" = ${unit})`
      .then(async (rows) => {
        const retail = await retailTotals(utcDay(yesterday), utcDay(today), unit);
        return retail.known ? [{ turnover: retail.turnover }] : rows;
      }),
    db.$queryRaw<{ turnover: number; profit: number }[]>`
      SELECT COALESCE(SUM(si."lineTotal"), 0)::float8 AS turnover,
             COALESCE(SUM(si."lineTotal" - si."costPrice" * si.quantity), 0)::float8 AS profit
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${monthStart} AND s."createdAt" < ${nextMonth}
        AND (${unit}::text IS NULL OR s."unit" = ${unit})`
      // Kunlik jamlanma bo'lsa — F-Apteka bilan bir xil hisob (QQSsiz foyda)
      .then(async (rows) => {
        const retail = await retailTotals(utcDay(monthStart), utcDay(nextMonth), unit);
        return retail.known ? [{ turnover: retail.turnover, profit: retail.profit }] : rows;
      }),
    db.$queryRaw<{ value: number; positions: number }[]>`
      -- Tan narxida — Moliya va Ombor sahifalaridagi bilan bir xil raqam
      SELECT COALESCE(SUM(p.stock * p."costPrice"), 0)::float8 AS value,
             (COUNT(*) FILTER (WHERE p.stock > 0))::float8 AS positions
      FROM "Product" p
      WHERE p."isActive" = true AND p."branchId" = ${branchId}`,
    db.product.findMany({
      // Tugab qolganlar emas, tugayotganlar kerak: qoldig'i bor, lekin ozaygan
      where: { isActive: true, branchId, stock: { gt: 0, lte: 3 } },
      orderBy: { stock: "asc" },
      take: 6,
      select: { id: true, name: true, stock: true },
    }),
    db.product.findMany({
      where: { isActive: true, branchId, stock: { gt: 0 }, expiryDate: { not: null, lte: in30 } },
      orderBy: { expiryDate: "asc" },
      take: 6,
      select: { id: true, name: true, stock: true, expiryDate: true },
    }),
    db.integrationLog
      .findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true, source: true, note: true } })
      .catch(() => null),
    // Bugungi naqd va karta — 30-hisobotdan
    paymentBreakdown(today, tomorrow, unit),
    // Shu filialning o'z xarajati
    db.expense
      .aggregate({
        _sum: { amount: true },
        where: { spentAt: { gte: monthStart, lt: nextMonth }, category: { not: "GOODS" }, ...(unit ? { unit } : {}) },
      })
      .catch(() => ({ _sum: { amount: 0 } })),
  ]);

  const todaySales = num(todayRows[0]?.turnover);
  const yesterdaySales = num(yesterdayRows[0]?.turnover);

  // Oylik xarajat (tovar xaridisiz). Filial tanlanganda faqat o'z harajati:
  // hech qaysi dorixonaga biriktirilmagan harajat (svet, soliq...) faqat
  // Umumiy ko'rinishda ayiriladi — Harajatlar sahifasi bilan bir xil.
  const monthExpense = num(ownExpense._sum.amount);

  return {
    filial,
    todaySales,
    yesterdaySales,
    todayTrend: yesterdaySales > 0 ? ((todaySales - yesterdaySales) / yesterdaySales) * 100 : 0,
    monthTurnover: num(monthRows[0]?.turnover),
    monthProfit: num(monthRows[0]?.profit),
    stockValue: num(stock[0]?.value),
    stockPositions: Math.round(num(stock[0]?.positions)),
    lowStock: lowStock.map((p) => ({ id: p.id, name: p.name, stock: p.stock })),
    expiring: expiring.map((p) => ({
      id: p.id,
      name: p.name,
      stock: p.stock,
      expiryDate: p.expiryDate as Date,
    })),
    lastSync: lastSync ? { at: lastSync.createdAt, source: lastSync.source, note: lastSync.note } : null,
    // Bugungi tushum to'lov turlari bo'yicha
    cash: todayPay.cash,
    card: todayPay.card,
    payKnown: todayPay.known,
    monthExpense,
  };
}

// ─────────────────────────────────────────────────────────────
//  NARX NAZORATI
// ─────────────────────────────────────────────────────────────

/**
 * Narx nazorati — OMBORDAGI HAMMA DORI bo'yicha.
 *
 * Dori savdosiga qarab ikkiga bo'linadi: oxirgi PRICE_SALES_DAYS kunda
 * oyiga TOP_SELLER_PER_MONTH donadan ko'p sotilgani "topiviy", qolgani
 * "kam sotilayotgan".
 *
 * Tavsiya narx ikki xil hisoblanadi:
 *   • arzonapteka.uz da kuzatilayotgan dori bo'lsa — raqobatchining eng
 *     arzon narxi + ustama (dorixona foizi, odatda 5%);
 *   • qolgan hamma doriga — TAN NARX + ustama, foizi esa 0 dan boshlanadi.
 *     Foizni dorixona o'zi qo'yadi, har doriga alohida.
 *
 * Narx F-Apteka'da qo'lda o'zgartiriladi — bizda yozish imkoni yo'q,
 * shuning uchun ERP faqat ko'rsatadi.
 */
export type PriceGroup = "top" | "slow";
/** Tavsiya nimadan hisoblangani */
export type PriceBasis = "competitor" | "cost";

export const PRICE_SALES_DAYS = 90;
/** Oyiga shuncha dona va undan ko'p sotilsa — topiviy */
export const TOP_SELLER_PER_MONTH = 10;
/** Bir sahifada nechta dori */
export const PRICE_PAGE_SIZE = 50;

export type PriceQuery = {
  group?: PriceGroup | "all";
  search?: string;
  page?: number;
};

type PriceRow = {
  id: string;
  sku: string | null;
  name: string;
  stock: number;
  salePrice: unknown;
  costPrice: unknown;
  qty: number;
  watchId: string | null;
  competitorPrice: unknown;
  sourceUrl: string | null;
  ownPercent: unknown;
  checkedAt: Date | null;
};

export async function getPriceWatchData(query: PriceQuery = {}) {
  const branchId = await getBranchId();
  const filial = await currentFilial();

  let settings: Awaited<ReturnType<typeof db.priceSetting.findMany>> = [];
  let needsMigration = false;
  try {
    settings = await db.priceSetting.findMany({ orderBy: { unit: "asc" } });
  } catch {
    needsMigration = true;
  }

  const active = filial === "Umumiy" ? settings[0] : settings.find((s) => s.unit === filial);
  const percent = active ? num(active.percent) : 5;
  // Tan narxli dorilarga umumiy ustama; jadval eski bo'lsa 0
  const costPercent = active ? num((active as { costPercent?: unknown }).costPercent ?? 0) : 0;
  const enabled = active ? active.enabled : true;

  const group = query.group ?? "slow";
  const search = query.search?.trim() ?? "";
  const page = Math.max(1, query.page ?? 1);
  const months = PRICE_SALES_DAYS / 30;
  // Oyiga TOP_SELLER_PER_MONTH dona = oraliqda shuncha dona
  const topThreshold = TOP_SELLER_PER_MONTH * months;
  const salesFrom = new Date(Date.now() - PRICE_SALES_DAYS * 864e5);

  const searchFilter = search
    ? Prisma.sql`AND p.name ILIKE ${`%${search}%`}`
    : Prisma.empty;
  const groupFilter =
    group === "top"
      ? Prisma.sql`AND COALESCE(sold.qty, 0) >= ${topThreshold}`
      : group === "slow"
        ? Prisma.sql`AND COALESCE(sold.qty, 0) < ${topThreshold}`
        : Prisma.empty;
  // Topiviy jadvalda ko'p sotilgani, qolganida puli ko'p turib qolgani tepada
  const order =
    group === "slow"
      ? Prisma.sql`ORDER BY (p.stock * p."costPrice") DESC, p.name ASC`
      : Prisma.sql`ORDER BY COALESCE(sold.qty, 0) DESC, p.name ASC`;

  const soldCte = Prisma.sql`
    WITH sold AS (
      SELECT si."productId" AS pid, SUM(si.quantity)::float8 AS qty
      FROM "SaleItem" si JOIN "Sale" s ON s.id = si."saleId"
      WHERE s."branchId" = ${branchId} AND s."createdAt" >= ${salesFrom}
      GROUP BY 1
    )`;

  // PriceWatch jadvali hali yaratilmagan bo'lsa ham sahifa ishlashi kerak
  const watchJoin = needsMigration
    ? Prisma.sql`LEFT JOIN LATERAL (SELECT NULL::text AS id, NULL::numeric AS "competitorPrice",
                                          NULL::text AS "sourceUrl", NULL::numeric AS percent,
                                          NULL::timestamp AS "checkedAt") w ON true`
    : Prisma.sql`LEFT JOIN LATERAL (
        SELECT w.id, w."competitorPrice", w."sourceUrl", w.percent, w."checkedAt"
        FROM "PriceWatch" w
        WHERE w.sku = p.sku AND w.active = true
        ORDER BY (w."competitorPrice" IS NOT NULL) DESC, w."createdAt" ASC
        LIMIT 1
      ) w ON true`;

  const base = Prisma.sql`
    FROM "Product" p
    LEFT JOIN sold ON sold.pid = p.id
    ${watchJoin}
    WHERE p."isActive" = true AND p."branchId" = ${branchId} AND p.stock > 0
      ${groupFilter}
      ${searchFilter}`;

  const [rows, totals] = await Promise.all([
    db.$queryRaw<PriceRow[]>`
      ${soldCte}
      SELECT p.id, p.sku, p.name, p.stock, p."salePrice", p."costPrice",
             COALESCE(sold.qty, 0)::float8 AS qty,
             w.id AS "watchId", w."competitorPrice", w."sourceUrl",
             w.percent AS "ownPercent", w."checkedAt"
      ${base}
      ${order}
      LIMIT ${PRICE_PAGE_SIZE} OFFSET ${(page - 1) * PRICE_PAGE_SIZE}`,
    db.$queryRaw<{ jami: number; topiviy: number; raqobatchi: number; qimmat: number }[]>`
      ${soldCte}
      SELECT COUNT(*)::float8 AS jami,
             COUNT(*) FILTER (WHERE COALESCE(sold.qty, 0) >= ${topThreshold})::float8 AS topiviy,
             COUNT(*) FILTER (WHERE w."competitorPrice" IS NOT NULL)::float8 AS raqobatchi,
             -- Tavsiya narxdan qimmat turganlar. Faqat tavsiyasi bor dorilar
             -- sanaladi: raqobatchi narxi bor yoki foizi qo'lda qo'yilgan.
             -- Aks holda tavsiya = tan narx bo'lib, hamma dori "qimmat"
             -- bo'lib chiqardi — chakana narx tan narxdan yuqori-ku.
             COUNT(*) FILTER (
               WHERE (
                       w."competitorPrice" IS NOT NULL
                       OR w.percent IS NOT NULL
                       OR ${costPercent}::numeric > 0
                     )
                 AND COALESCE(w."competitorPrice", p."costPrice") > 0
                 AND p."salePrice" > ROUND(
                   COALESCE(w."competitorPrice", p."costPrice") * (
                     1 + COALESCE(
                       w.percent,
                       CASE WHEN w."competitorPrice" IS NOT NULL
                            THEN ${percent}::numeric
                            ELSE ${costPercent}::numeric END
                     ) / 100
                   )
                 )
             )::float8 AS qimmat
      FROM "Product" p
      LEFT JOIN sold ON sold.pid = p.id
      ${watchJoin}
      WHERE p."isActive" = true AND p."branchId" = ${branchId} AND p.stock > 0
        ${searchFilter}`,
  ]);

  const items = rows.map((row) => {
    const competitor = row.competitorPrice === null ? null : num(row.competitorPrice);
    const our = num(row.salePrice);
    const cost = num(row.costPrice);
    const own = row.ownPercent === null ? null : num(row.ownPercent);

    // Arzonaptekada kuzatilsa raqobatchidan, bo'lmasa tan narxdan
    const basis: PriceBasis = competitor !== null ? "competitor" : "cost";
    // Raqobatchi narxi bor doriga dorixona foizi, qolganiga 0 — foizni
    // dorixona o'zi qo'yadi
    const usedPercent = own ?? (basis === "competitor" ? percent : costPercent);
    const baseValue = basis === "competitor" ? (competitor as number) : cost;
    // Tan narxli doriga foiz qo'yilmaguncha tavsiya berilmaydi: aks holda
    // tavsiya tan narxning o'zi bo'lib, har bir dori "qimmat" bo'lib chiqadi
    const hasTarget = basis === "competitor" || own !== null || costPercent > 0;
    const suggested =
      hasTarget && baseValue > 0 ? Math.round(baseValue * (1 + usedPercent / 100)) : null;
    const diff = suggested === null ? null : our - suggested;
    const perMonth = row.qty / months;

    return {
      // Narx sozlamasi PriceWatch da saqlanadi; hali yo'q bo'lsa null
      id: row.watchId,
      productId: row.id,
      sku: row.sku,
      name: row.name,
      sourceUrl: row.sourceUrl,
      competitor,
      checkedAt: row.checkedAt,
      our,
      cost,
      stock: row.stock,
      basis,
      percent: usedPercent,
      ownPercent: own,
      suggested,
      diff,
      diffPercent: diff !== null && suggested ? (diff / suggested) * 100 : null,
      sold: row.qty,
      perMonth: +perMonth.toFixed(1),
      group: (row.qty >= topThreshold ? "top" : "slow") as PriceGroup,
    };
  });

  const total = Math.round(num(totals[0]?.jami));
  const topCount = Math.round(num(totals[0]?.topiviy));

  let lastChecked: Date | null = null;
  if (!needsMigration) {
    const latest = await db.priceWatch
      .findFirst({ where: { checkedAt: { not: null } }, orderBy: { checkedAt: "desc" }, select: { checkedAt: true } })
      .catch(() => null);
    lastChecked = latest?.checkedAt ?? null;
  }

  return {
    needsMigration,
    filial,
    percent,
    enabled,
    costPercent,
    settings: settings.map((s) => ({
      unit: s.unit,
      enabled: s.enabled,
      percent: num(s.percent),
      costPercent: num((s as { costPercent?: unknown }).costPercent ?? 0),
    })),
    items,
    group,
    search,
    page,
    pageSize: PRICE_PAGE_SIZE,
    salesDays: PRICE_SALES_DAYS,
    topPerMonth: TOP_SELLER_PER_MONTH,
    total,
    topCount,
    slowCount: total - topCount,
    competitorCount: Math.round(num(totals[0]?.raqobatchi)),
    overpriced: Math.round(num(totals[0]?.qimmat)),
    overpricedOnPage: items.filter((item) => (item.diff ?? 0) > 0).length,
    lastChecked,
  };
}

/**
 * "Narx nazorati ro'yxati" — arzonapteka.uz da kuzatiladigan dorilar.
 *
 * Yangi qo'shilgani tepada: qo'shilgach topildimi, narxi qancha — darrov
 * ko'rinsin. Tavsiya = arzonaptekadagi eng arzon narx + ustama; topilmagan
 * yoki narxi hali olinmagan dorida tavsiya yo'q (null → "—").
 */
export async function getPriceWatchList(percent: number) {
  try {
    await ensurePriceWatchListed();
  } catch {
    return [];
  }
  const branchId = await getBranchId();
  const rows = await db.$queryRaw<
    {
      id: string;
      name: string;
      sourceUrl: string | null;
      sourceTitle: string | null;
      competitorPrice: unknown;
      percent: unknown;
      checkedAt: Date | null;
      productName: string | null;
      salePrice: unknown;
    }[]
  >`
    SELECT w.id, w.name, w."sourceUrl", w."sourceTitle", w."competitorPrice", w.percent,
           w."checkedAt", p.name AS "productName", p."salePrice"
    FROM "PriceWatch" w
    LEFT JOIN LATERAL (
      SELECT name, "salePrice" FROM "Product"
      WHERE sku = w.sku AND "branchId" = ${branchId}
      LIMIT 1
    ) p ON true
    WHERE w.listed = true
    ORDER BY w."createdAt" DESC, w.name ASC
  `;

  return rows.map((row) => {
    const competitor = row.competitorPrice === null ? null : num(row.competitorPrice);
    const ownPercent = row.percent === null ? null : num(row.percent);
    const suggested = competitor === null ? null : Math.round(competitor * (1 + (ownPercent ?? percent) / 100));
    const our = row.salePrice === null ? null : num(row.salePrice);
    // Havola yo'q: izlangan bo'lsa — topilmadi, bo'lmasa — navbatda
    const status = row.sourceUrl
      ? competitor === null
        ? ("waiting" as const)
        : ("ok" as const)
      : row.checkedAt
        ? ("missing" as const)
        : ("searching" as const);
    return {
      id: row.id,
      name: row.name,
      productName: row.productName,
      sourceUrl: row.sourceUrl,
      sourceTitle: row.sourceTitle,
      competitor,
      ownPercent,
      percent: ownPercent ?? percent,
      suggested,
      our,
      diff: suggested !== null && our !== null ? our - suggested : null,
      status,
      checkedAt: row.checkedAt,
    };
  });
}

export type PriceWatchListItem = Awaited<ReturnType<typeof getPriceWatchList>>[number];
