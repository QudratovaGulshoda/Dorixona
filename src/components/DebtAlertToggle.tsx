"use client";

import { AlertToggle } from "@/components/AlertToggle";
import { setDebtAlert } from "@/lib/actions/debts";

/**
 * Qarz eslatmasi Telegram'ga yuborilsinmi.
 *
 * O'chirilgan bo'lsa kunlik eslatma umuman ketmaydi — qarzlar bo'limi
 * o'zi ishlayveradi. Dorixona egasi qachon kerakligini o'zi hal qiladi.
 */
export function DebtAlertToggle({ enabled }: { enabled: boolean }) {
  return (
    <AlertToggle
      enabled={enabled}
      label="Qarz eslatmasi"
      onText="Muddati yaqin qarzlar haqida kuniga bir marta xabar keladi"
      action={setDebtAlert}
    />
  );
}
