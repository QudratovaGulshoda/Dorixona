"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { recalcDebt } from "@/lib/debts";
import { DEBT_ALERT_KEY, writeFlag } from "@/lib/app-settings";
import { activeBranch, fail, requireUser, type ActionResult } from "./_shared";

/**
 * Qarzlar: firmadan olingan tovar qarzi va ko'chadagi naqd qarz.
 *
 * Har bir qarzning tarixi bor: yangi qarz olinsa CHARGE, to'lov qilinsa
 * PAYMENT yoziladi. Qoldiq shu ikkisining farqi — "shuncha berildi,
 * shuncha qoldi" degani.
 */

const debtSchema = z.object({
  counterparty: z.string().min(2, "Kim ekanini yozing"),
  kind: z.enum(["FIRM", "STREET"]).default("FIRM"),
  currency: z.enum(["UZS", "USD"]).default("UZS"),
  direction: z.enum(["PAYABLE", "RECEIVABLE"]).default("PAYABLE"),
  amount: z.number().positive("Summa musbat bo'lishi kerak"),
  dueDate: z.string().optional(),
  unit: z.string().optional(),
  note: z.string().optional(),
});

const entrySchema = z.object({
  debtId: z.string().min(1),
  type: z.enum(["CHARGE", "PAYMENT"]),
  amount: z.number().positive("Summa musbat bo'lishi kerak"),
  happenedAt: z.string().optional(),
  note: z.string().optional(),
});

function normalizeUnit(unit?: string) {
  const value = unit?.trim();
  if (!value || value === "Umumiy") return null;
  return value;
}

function parseDate(value?: string) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function revalidateAll() {
  revalidatePath("/qarzlar");
  revalidatePath("/harajatlar");
  revalidatePath("/moliya");
}


export async function createDebt(input: z.input<typeof debtSchema>): Promise<ActionResult> {
  try {
    await requireUser();
    const data = debtSchema.parse(input);
    const branch = await activeBranch();

    await db.debt.create({
      data: {
        counterparty: data.counterparty.trim(),
        kind: data.kind,
        currency: data.currency,
        direction: data.direction,
        totalAmount: data.amount,
        paidAmount: 0,
        dueDate: parseDate(data.dueDate),
        unit: normalizeUnit(data.unit),
        note: data.note?.trim() || null,
        branchId: branch.id,
        entries: {
          create: { type: "CHARGE", amount: data.amount, note: data.note?.trim() || null },
        },
      },
    });

    revalidateAll();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Yangi qarz qo'shish yoki to'lov kiritish */
export async function addDebtEntry(input: z.input<typeof entrySchema>): Promise<ActionResult> {
  try {
    await requireUser();
    const data = entrySchema.parse(input);

    const debt = await db.debt.findUnique({ where: { id: data.debtId }, select: { id: true } });
    if (!debt) return { ok: false, error: "Qarz topilmadi" };

    await db.debtEntry.create({
      data: {
        debtId: data.debtId,
        type: data.type,
        amount: data.amount,
        happenedAt: parseDate(data.happenedAt) ?? new Date(),
        note: data.note?.trim() || null,
      },
    });

    await recalcDebt(data.debtId);
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Muddatni o'zgartirish (kirim sanasiga qarab qo'yiladi) */
export async function updateDebtDueDate(id: string, dueDate?: string): Promise<ActionResult> {
  try {
    await requireUser();
    if (!id) return { ok: false, error: "Qarz topilmadi" };
    await db.debt.update({ where: { id }, data: { dueDate: parseDate(dueDate) } });
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDebtEntry(id: string): Promise<ActionResult> {
  try {
    await requireUser();
    const entry = await db.debtEntry.findUnique({ where: { id }, select: { debtId: true } });
    if (!entry) return { ok: false, error: "Yozuv topilmadi" };
    await db.debtEntry.delete({ where: { id } });
    await recalcDebt(entry.debtId);
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteDebt(id: string): Promise<ActionResult> {
  try {
    await requireUser();
    if (!id) return { ok: false, error: "Qarz topilmadi" };
    await db.debt.delete({ where: { id } });
    revalidateAll();
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}

/** Qarz eslatmasi Telegram'ga yuborilsinmi — Qarzlar bo'limidagi kalitcha */
export async function setDebtAlert(enabled: boolean): Promise<ActionResult> {
  try {
    await requireUser();
    await writeFlag(DEBT_ALERT_KEY, enabled);
    revalidatePath("/qarzlar");
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
