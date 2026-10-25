"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui";
import { SearchBox } from "@/components/SearchBox";
import { Field, FormError, Input, Modal, SubmitButton } from "@/components/Modal";
import { formatNumber } from "@/lib/format";
import {
  addPriceWatchNames,
  importPriceWatchExcel,
  removePriceWatch,
  searchPriceWatchAgain,
  setPriceWatchUrl,
  type PriceListResult,
} from "@/lib/actions/prices";
import type { PriceWatchListItem } from "@/lib/queries";

type Item = Omit<PriceWatchListItem, "checkedAt"> & { checkedAt: string | Date | null };

function money(value: number | null) {
  return value === null ? "—" : formatNumber(value);
}

/** Qo'shish/yuklash natijasi bir qatorda: nechta qo'shildi, topildi, topilmadi */
function summary(result: Extract<PriceListResult, { ok: true }>) {
  const parts: string[] = [];
  if (result.added) parts.push(`${result.added} ta qo'shildi`);
  if (result.updated) parts.push(`${result.updated} ta yangilandi`);
  if (!result.added && !result.updated) parts.push("Hammasi ro'yxatda bor edi");
  if (result.found) {
    const waiting = result.found - result.priced;
    parts.push(
      `${result.found} tasi arzonaptekadan topildi` +
        (waiting > 0 ? ` (${waiting} tasining narxi bir necha daqiqada keladi)` : ""),
    );
  }
  if (result.notFound.length) parts.push(`${result.notFound.length} tasi topilmadi`);
  return parts.join(" · ");
}

function StatusCell({ item }: { item: Item }) {
  if (item.status === "missing") return <Badge color="red">topilmadi</Badge>;
  if (item.status === "searching") return <Badge color="blue">izlanmoqda</Badge>;
  return (
    <a
      href={item.sourceUrl ?? undefined}
      target="_blank"
      rel="noreferrer"
      className="block max-w-[220px] truncate text-xs text-primary hover:underline"
      title={item.sourceTitle ?? item.sourceUrl ?? ""}
    >
      {item.sourceTitle || (item.status === "waiting" ? "narx kutilmoqda…" : "sahifa")}
    </a>
  );
}

/**
 * Narx nazorati ro'yxati — arzonapteka.uz da kuzatiladigan dorilar.
 *
 * Nom qo'shilsa sayt o'zi izlab topadi va tavsiya narxni ko'rsatadi
 * (eng arzon narx + ustama). Topilmasa tavsiya "—" bo'lib turadi —
 * havolasini qo'lda biriktirish mumkin.
 */
export function PriceWatchListPanel({ items }: { items: Item[] }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [names, setNames] = useState("");
  const [filter, setFilter] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [editing, setEditing] = useState<Item | null>(null);
  const [message, setMessage] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [pending, start] = useTransition();

  function run(label: string, action: () => Promise<PriceListResult | { ok: boolean; error?: string }>, done?: () => void) {
    setError("");
    setMessage("");
    setWarnings([]);
    setBusy(label);
    start(async () => {
      const result = await action();
      setBusy("");
      if (!result.ok) {
        setError(("error" in result && result.error) || "Xatolik");
        return;
      }
      if ("added" in result) {
        setMessage(summary(result));
        setWarnings([
          ...(result.notFound.length ? [`Topilmadi: ${result.notFound.join(", ")}`] : []),
          ...result.warnings,
        ]);
      }
      done?.();
      router.refresh();
    });
  }

  const query = filter.trim().toUpperCase();
  const missingCount = items.filter((item) => item.status === "missing").length;
  const shown = items.filter(
    (item) =>
      (!onlyMissing || item.status === "missing") &&
      (!query || item.name.includes(query) || item.productName?.toUpperCase().includes(query)),
  );

  return (
    <div className="space-y-4">
      {/* Qo'shish: qo'lda yoki Excel'dan */}
      <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!names.trim()) return;
            run("Arzonaptekadan izlanmoqda…", () => addPriceWatchNames(names), () => setNames(""));
          }}
        >
          <Input
            value={names}
            onChange={(event) => setNames(event.target.value)}
            placeholder="Dori nomi: ВИЗИН, ДЕПО-МЕДРОЛ (bir nechta bo'lsa vergul bilan)"
            className="min-w-[220px] flex-1"
            disabled={pending}
          />
          <button type="submit" disabled={pending || !names.trim()} className="btn btn-primary btn-sm">
            Qo&apos;shish
          </button>
        </form>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const fd = new FormData();
              fd.set("file", file);
              run("Excel o'qilmoqda, arzonaptekadan izlanmoqda…", () => importPriceWatchExcel(fd));
            }}
          />
          <button
            type="button"
            disabled={pending}
            onClick={() => fileRef.current?.click()}
            className="btn btn-ghost btn-sm"
          >
            Excel yuklash
          </button>
          <a
            href="/api/prices/namuna"
            className="btn btn-ghost btn-sm"
            title="Qaysi ustunga nima yozilishi va qoidalar"
          >
            Namuna (Excel)
          </a>
        </div>
      </div>

      {busy && <p className="text-sm text-muted">{busy}</p>}
      <FormError message={error} />
      {message && (
        <div className="rounded-lg border border-edge bg-surface px-3 py-2 text-sm">
          <div>{message}</div>
          {warnings.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-xs text-muted">
              {warnings.slice(0, 8).map((warning) => (
                <li key={warning}>• {warning}</li>
              ))}
              {warnings.length > 8 && <li>… yana {warnings.length - 8} ta</li>}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={filter} onChange={setFilter} placeholder="Ro'yxatdan izlash" className="min-w-[160px] flex-1 sm:max-w-[240px]" />
        <label className="flex items-center gap-1.5 text-xs text-muted">
          <input type="checkbox" checked={onlyMissing} onChange={(event) => setOnlyMissing(event.target.checked)} />
          Faqat topilmaganlar ({formatNumber(missingCount)})
        </label>
        <span className="ml-auto text-xs text-muted">{formatNumber(items.length)} ta dori</span>
      </div>

      {/* Ro'yxat uzun bo'lsa sahifani cho'zmasin — o'zi ichida aylanadi */}
      <div className="max-h-[480px] overflow-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Dori</th>
              <th>Arzonaptekada</th>
              <th>Eng arzon</th>
              <th>Ustama</th>
              <th>Tavsiya</th>
              <th>Bizda</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-muted">
                  {items.length ? "Hech narsa topilmadi." : "Ro'yxat bo'sh — dori nomini yozing yoki Excel yuklang."}
                </td>
              </tr>
            )}

            {shown.map((item) => {
              const over = item.diff !== null && item.diff > 0;
              return (
                <tr key={item.id}>
                  <td className="text-left">
                    <div className="max-w-[220px] truncate font-medium" title={item.name}>
                      {item.name}
                    </div>
                    <div className="max-w-[220px] truncate text-xs text-muted" title={item.productName ?? ""}>
                      {item.productName ?? "omborda yo'q"}
                    </div>
                  </td>
                  <td className="text-left">
                    <StatusCell item={item} />
                  </td>
                  <td className="whitespace-nowrap">{money(item.competitor)}</td>
                  <td className="whitespace-nowrap text-xs">
                    <span className={item.ownPercent !== null ? "font-semibold" : "text-muted"}>{item.percent}%</span>
                  </td>
                  <td className="whitespace-nowrap font-semibold">{money(item.suggested)}</td>
                  <td className="whitespace-nowrap">
                    <span
                      className={over ? "text-danger" : undefined}
                      style={item.diff !== null && item.diff < 0 ? { color: "var(--c-primary)" } : undefined}
                      title={item.diff !== null ? `Tavsiyadan ${item.diff > 0 ? "+" : ""}${formatNumber(item.diff)}` : undefined}
                    >
                      {money(item.our)}
                    </span>
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <button
                      type="button"
                      onClick={() => {
                        setError("");
                        setEditing(item);
                      }}
                      className="text-xs text-primary hover:underline"
                    >
                      Havola
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        if (!confirm(`«${item.name}» ro'yxatdan o'chirilsinmi?`)) return;
                        run("O'chirilmoqda…", () => removePriceWatch(item.id));
                      }}
                      className="ml-3 text-sm text-muted hover:text-danger disabled:opacity-40"
                      aria-label={`${item.name} ni o'chirish`}
                      title="Ro'yxatdan o'chirish"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Havola: qo'lda biriktirish yoki qayta izlash */}
      <Modal open={editing !== null} title={`Arzonapteka havolasi — ${editing?.name ?? ""}`} onClose={() => setEditing(null)}>
        {editing && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const fd = new FormData(event.currentTarget);
              run(
                "Saqlanmoqda…",
                () => setPriceWatchUrl({ watchId: editing.id, name: editing.name, sourceUrl: String(fd.get("sourceUrl") ?? "") }),
                () => setEditing(null),
              );
            }}
          >
            <p className="text-xs text-muted">
              Avtomatik topilgan mahsulot boshqa shakl (doza, qadoq) bo&apos;lsa, to&apos;g&apos;ri sahifa havolasini
              qo&apos;ying. Bo&apos;sh qoldirsangiz dori &laquo;topilmadi&raquo; bo&apos;lib turadi.
            </p>
            <Field label="arzonapteka.uz havolasi">
              <Input name="sourceUrl" defaultValue={editing.sourceUrl ?? ""} placeholder="https://arzonapteka.uz/uz/products/..." />
            </Field>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <a
                href={`https://arzonapteka.uz/uz/search?q=${encodeURIComponent(editing.name)}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline"
              >
                &laquo;{editing.name}&raquo; ni saytda qidirish →
              </a>
              <button
                type="button"
                disabled={pending}
                onClick={() => run("Arzonaptekadan izlanmoqda…", () => searchPriceWatchAgain(editing.id), () => setEditing(null))}
                className="btn btn-ghost btn-sm"
              >
                Avtomatik qayta izlash
              </button>
            </div>
            <SubmitButton pending={pending}>Saqlash</SubmitButton>
          </form>
        )}
      </Modal>
    </div>
  );
}
