"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Telegram eslatmasini yoqish/o'chirish kalitchasi.
 *
 * O'chirilgan bo'lsa eslatma umuman ketmaydi — bo'limning o'zi
 * ishlayveradi. Har bir eslatma o'z bo'limida turadi (qarzlar, narxlar).
 */
export function AlertToggle({
  enabled,
  label,
  onText,
  action,
}: {
  enabled: boolean;
  /** Ekran o'quvchi uchun nom: "Qarz eslatmasi" */
  label: string;
  /** Yoqilganda nima keladi */
  onText: string;
  action: (enabled: boolean) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  const [on, setOn] = useState(enabled);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();

  function toggle() {
    const next = !on;
    setOn(next);
    setError("");
    start(async () => {
      const result = await action(next);
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
        <div className="text-xs text-muted">{on ? onText : "O'chirilgan — xabar yuborilmaydi"}</div>
        {error && <div className="mt-1 text-xs text-danger">{error}</div>}
      </div>

      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
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
