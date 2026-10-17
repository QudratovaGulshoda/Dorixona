"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setDebtAlert } from "@/lib/actions/debts";

/**
 * Qarz eslatmasi Telegram'ga yuborilsinmi.
 *
 * O'chirilgan bo'lsa kunlik eslatma umuman ketmaydi — qarzlar bo'limi
 * o'zi ishlayveradi. Dorixona egasi qachon kerakligini o'zi hal qiladi.
 */
export function DebtAlertToggle({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    setError("");
    start(async () => {
      const result = await setDebtAlert(next);
      if (!result.ok) {
        setOn(!next);
        setError(result.error ?? "Saqlanmadi");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-surface px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">Telegram eslatmasi</div>
        <div className="text-xs text-muted">
          {on
            ? "Muddati yaqin qarzlar haqida kuniga bir marta xabar keladi"
            : "O'chirilgan — xabar yuborilmaydi"}
        </div>
        {error && <div className="mt-1 text-xs text-danger">{error}</div>}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Qarz eslatmasi"
        disabled={pending}
        onClick={toggle}
        className={`relative h-6 w-11 shrink-0 rounded-full transition ${
          on ? "bg-primary" : "bg-edge"
        } disabled:opacity-60`}
      >
        <span
          className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
            on ? "left-[22px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}
