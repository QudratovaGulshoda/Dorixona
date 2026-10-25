"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui";
import { SearchBox } from "@/components/SearchBox";
import { Field, FormError, Input, Modal, SubmitButton } from "@/components/Modal";
import { formatDate, formatNumber, formatTime } from "@/lib/format";
import {
  refreshPricesNow,
  savePriceSetting,
  setDrugPercent,
  setPriceWatchUrl,
} from "@/lib/actions/prices";

type Item = {
  /** PriceWatch qatori; dori uchun sozlama hali yo'q bo'lsa null */
  id: string | null;
  productId: string;
  sku: string | null;
  name: string;
  sourceUrl: string | null;
  competitor: number | null;
  checkedAt: string | Date | null;
  our: number;
  cost: number;
  stock: number;
  /** Tavsiya nimadan hisoblangan */
  basis: "competitor" | "cost";
  percent: number;
  ownPercent: number | null;
  suggested: number | null;
  diff: number | null;
  diffPercent: number | null;
  sold: number;
  perMonth: number;
  group: "top" | "slow";
};

type Setting = { unit: string; enabled: boolean; percent: number; costPercent: number };
type Group = "slow" | "top" | "all";

/** Savdo bo'yicha ikki jadval — dorixona ikkisini alohida ko'radi */
const GROUPS: { key: Group; label: string }[] = [
  { key: "slow", label: "Kam sotilayotgan" },
  { key: "top", label: "Topiviy dorilar" },
  { key: "all", label: "Hammasi" },
];

function money(value: number | null) {
  return value === null ? "—" : formatNumber(value);
}

/**
 * Bitta doriga ustama foizi.
 *
 * arzonapteka.uz da kuzatiladigan doriga dorixona foizi (odatda 5%)
 * o'zi qo'yiladi, qolganiga 0 — foizni shu katakchada yozasiz.
 */
function PercentCell({ item }: { item: Item }) {
  const router = useRouter();
  const [value, setValue] = useState(item.ownPercent === null ? "" : String(item.ownPercent));
  const [pending, start] = useTransition();

  // Sahifa almashganda katakcha yangi doriga moslanishi kerak
  useEffect(() => {
    setValue(item.ownPercent === null ? "" : String(item.ownPercent));
  }, [item.ownPercent, item.productId]);

  function save(next: string) {
    const trimmed = next.trim();
    const percent = trimmed === "" ? null : Number(trimmed);
    if (percent !== null && !Number.isFinite(percent)) return;
    if (percent === item.ownPercent) return;
    start(async () => {
      await setDrugPercent({ watchId: item.id, sku: item.sku, name: item.name, percent });
      router.refresh();
    });
  }

  return (
    <input
      value={value}
      disabled={pending}
      onChange={(event) => setValue(event.target.value)}
      onBlur={(event) => save(event.target.value)}
      placeholder={String(item.percent)}
      title={
        item.basis === "competitor"
          ? "Bo'sh qoldirilsa dorixona ustamasi qo'llanadi"
          : "Tan narxga qo'shiladigan foiz"
      }
      className="w-14 rounded-lg border border-edge bg-card px-2 py-1 text-right text-sm outline-none focus:border-primary disabled:opacity-50"
    />
  );
}

/** Ustama sozlamasi — har dorixona uchun alohida yoqiladi */
function SettingRow({ setting }: { setting: Setting }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(setting.enabled);
  const [percent, setPercent] = useState(String(setting.percent));
  const [costPercent, setCostPercent] = useState(String(setting.costPercent));
  const [pending, start] = useTransition();

  function save(next: { enabled?: boolean; percent?: string; costPercent?: string }) {
    const nextEnabled = next.enabled ?? enabled;
    const value = Number(next.percent ?? percent);
    const costValue = Number(next.costPercent ?? costPercent);
    if (!Number.isFinite(value) || !Number.isFinite(costValue)) return;
    start(async () => {
      await savePriceSetting({
        unit: setting.unit,
        enabled: nextEnabled,
        percent: value,
        costPercent: costValue,
      });
      router.refresh();
    });
  }

  const field =
    "w-16 rounded-lg border border-edge bg-card px-2 py-1 text-right text-sm outline-none focus:border-primary disabled:opacity-50";

  return (
    <div className="rounded-lg border border-edge bg-surface px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-medium">{setting.unit}</div>

        {/* Yoqish/o'chirish kalitchasi */}
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${setting.unit} ustamasi`}
          disabled={pending}
          onClick={() => {
            const next = !enabled;
            setEnabled(next);
            save({ enabled: next });
          }}
          className={`relative h-6 w-11 shrink-0 rounded-full transition ${
            enabled ? "bg-primary" : "bg-edge"
          } disabled:opacity-60`}
        >
          <span
            className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
              enabled ? "left-[22px]" : "left-0.5"
            }`}
          />
        </button>
      </div>

      <div className="mt-2 space-y-1.5">
        <label className="flex items-center justify-between gap-2 text-xs text-muted">
          <span>Arzonapteka narxiga</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={100}
              step="0.5"
              value={percent}
              disabled={pending || !enabled}
              onChange={(event) => setPercent(event.target.value)}
              onBlur={(event) => save({ percent: event.target.value })}
              className={field}
            />
            %
          </span>
        </label>

        <label className="flex items-center justify-between gap-2 text-xs text-muted">
          <span>Tan narxga (qolgan dorilar)</span>
          <span className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={1000}
              step="1"
              value={costPercent}
              disabled={pending || !enabled}
              onChange={(event) => setCostPercent(event.target.value)}
              onBlur={(event) => save({ costPercent: event.target.value })}
              className={field}
            />
            %
          </span>
        </label>
      </div>

      {!enabled && (
        <div className="mt-1.5 text-xs text-muted">O&apos;chirilgan — tavsiya berilmaydi</div>
      )}
    </div>
  );
}

export function PricePanel({
  items,
  settings,
  group,
  search,
  page,
  pageSize,
  total,
  topCount,
  slowCount,
}: {
  items: Item[];
  settings: Setting[];
  group: Group;
  search: string;
  page: number;
  pageSize: number;
  total: number;
  topCount: number;
  slowCount: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState(search);
  const [linking, setLinking] = useState<Item | null>(null);
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const [navigating, startNav] = useTransition();

  // Ro'yxat katta — filtr va sahifa serverda, manzil satrida saqlanadi
  function go(next: { guruh?: Group; q?: string; sahifa?: number }) {
    const url = new URLSearchParams(params.toString());
    if (next.guruh !== undefined) {
      url.set("guruh", next.guruh);
      url.delete("sahifa");
    }
    if (next.q !== undefined) {
      if (next.q) url.set("q", next.q);
      else url.delete("q");
      url.delete("sahifa");
    }
    if (next.sahifa !== undefined) {
      if (next.sahifa > 1) url.set("sahifa", String(next.sahifa));
      else url.delete("sahifa");
    }
    startNav(() => router.push(`/narxlar?${url.toString()}`, { scroll: false }));
  }

  function run(action: () => Promise<{ ok: boolean; error?: string }>, done?: () => void) {
    setError("");
    start(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "Xatolik");
        return;
      }
      done?.();
      router.refresh();
    });
  }

  const counts: Record<Group, number> = { slow: slowCount, top: topCount, all: total };
  const shownTotal = counts[group];
  const lastPage = Math.max(1, Math.ceil(shownTotal / pageSize));
  const from = shownTotal === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, shownTotal);

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        {settings.map((setting) => (
          <SettingRow key={setting.unit} setting={setting} />
        ))}
      </div>

      {/* Savdo bo'yicha ikki jadval */}
      <div className="rounded-lg border border-edge bg-surface p-1">
        <div className="flex flex-wrap gap-1">
          {GROUPS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => go({ guruh: option.key })}
              className={`flex-1 rounded-md px-3 py-2 text-xs font-medium transition ${
                group === option.key ? "bg-card text-fg shadow-sm" : "text-muted hover:text-fg"
              }`}
            >
              {option.label}
              <span className="ml-1.5 text-muted">{formatNumber(counts[option.key])}</span>
            </button>
          ))}
        </div>
      </div>


      <div className="flex flex-wrap items-center gap-2">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            go({ q: query });
          }}
          className="flex flex-1 flex-wrap gap-2"
        >
          <SearchBox
            value={query}
            onChange={(value) => {
              setQuery(value);
              // Tozalansa darrov qaytamiz, aks holda Enter kutiladi
              if (!value && search) go({ q: "" });
            }}
            placeholder="Dori nomi"
            className="min-w-[160px] flex-1 sm:max-w-[240px]"
          />
          <button type="submit" className="btn btn-ghost btn-sm">
            Qidirish
          </button>
        </form>

        <div className="flex gap-2">
          {/* F-Apteka'da qo'lda tuzatish uchun ro'yxat */}
          <a
            href="/api/export/narxlar?format=xlsx"
            className="btn btn-ghost btn-sm"
            title="Narxni tushirish kerak bo'lganlar ro'yxati"
          >
            Excelga
          </a>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => refreshPricesNow())}
            className="btn btn-primary btn-sm"
          >
            {pending ? "Yangilanmoqda…" : "Narxlarni yangilash"}
          </button>
        </div>
      </div>

      <FormError message={error} />

      <div className={`overflow-x-auto transition-opacity ${navigating ? "opacity-50" : ""}`}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Dori</th>
              <th>Sotilgan</th>
              <th>Tan narx</th>
              <th>Bizda</th>
              <th>Asos</th>
              <th>Ustama %</th>
              <th>Tavsiya</th>
              <th>Farq</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-muted">
                  Hech narsa topilmadi.
                </td>
              </tr>
            )}

            {items.map((item) => {
              const over = (item.diff ?? 0) > 0;
              const under = item.diff !== null && item.diff < 0;
              return (
                <tr key={item.productId}>
                  <td className="text-left">
                    <div className="max-w-[260px] truncate font-medium" title={item.name}>
                      {item.name}
                    </div>
                    <div className="text-xs text-muted">{item.stock} dona qoldiq</div>
                  </td>
                  <td className="whitespace-nowrap text-xs">
                    <span className={item.group === "top" ? "font-semibold text-primary" : undefined}>
                      {item.perMonth}
                    </span>
                    <span className="text-muted"> dona/oy</span>
                  </td>
                  <td className="whitespace-nowrap">{money(item.cost)}</td>
                  <td className="whitespace-nowrap">{money(item.our)}</td>
                  <td className="whitespace-nowrap text-xs">
                    {item.basis === "competitor" ? (
                      item.sourceUrl ? (
                        <a
                          href={item.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                          title="Arzonaptekadagi eng arzon narx"
                        >
                          {money(item.competitor)}
                        </a>
                      ) : (
                        <span className="text-muted" title="Arzonaptekadagi eng arzon narx">
                          {money(item.competitor)}
                        </span>
                      )
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setError("");
                          setLinking(item);
                        }}
                        className="text-muted underline"
                        title="Arzonapteka havolasini biriktirish"
                      >
                        Tan narx
                      </button>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    <PercentCell item={item} />
                  </td>
                  <td className="whitespace-nowrap font-semibold">{money(item.suggested)}</td>
                  <td className="whitespace-nowrap">
                    {item.diff === null ? (
                      "—"
                    ) : over ? (
                      <span className="text-danger">
                        +{formatNumber(item.diff)}
                        {item.diffPercent !== null && (
                          <span className="ml-1 text-xs">({item.diffPercent.toFixed(1)}%)</span>
                        )}
                      </span>
                    ) : under ? (
                      <span style={{ color: "var(--c-primary)" }}>{formatNumber(item.diff)}</span>
                    ) : (
                      <Badge color="green">mos</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Sahifalash */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {formatNumber(from)}–{formatNumber(to)} / {formatNumber(shownTotal)} ta dori
          {items[0]?.checkedAt && (
            <>
              {" · "}oxirgi tekshiruv {formatDate(items[0].checkedAt)}{" "}
              {formatTime(items[0].checkedAt)}
            </>
          )}
        </span>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={page <= 1 || navigating}
            onClick={() => go({ sahifa: page - 1 })}
            className="btn btn-ghost btn-sm disabled:opacity-40"
          >
            ← Oldingi
          </button>
          <span className="self-center">
            {page} / {lastPage}
          </span>
          <button
            type="button"
            disabled={page >= lastPage || navigating}
            onClick={() => go({ sahifa: page + 1 })}
            className="btn btn-ghost btn-sm disabled:opacity-40"
          >
            Keyingi →
          </button>
        </div>
      </div>

      {/* Havola biriktirish — dori arzonaptekadan kuzatilsin */}
      <Modal
        open={linking !== null}
        title={`Arzonapteka havolasi — ${linking?.name ?? ""}`}
        onClose={() => setLinking(null)}
      >
        {linking && (
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              const fd = new FormData(event.currentTarget);
              run(
                () =>
                  setPriceWatchUrl({
                    watchId: linking.id,
                    sku: linking.sku,
                    name: linking.name,
                    sourceUrl: String(fd.get("sourceUrl") ?? ""),
                  }),
                () => setLinking(null),
              );
            }}
          >
            <p className="text-xs text-muted">
              Havola qo&apos;shilsa, tavsiya narx tan narxdan emas, Toshkentdagi eng arzon
              narxdan hisoblanadi.
            </p>
            <Field label="arzonapteka.uz havolasi">
              <Input
                name="sourceUrl"
                defaultValue={linking.sourceUrl ?? ""}
                placeholder="https://arzonapteka.uz/uz/products/..."
              />
            </Field>
            <a
              href={`https://arzonapteka.uz/uz/search?q=${encodeURIComponent(linking.name)}`}
              target="_blank"
              rel="noreferrer"
              className="block text-xs text-primary hover:underline"
            >
              &laquo;{linking.name}&raquo; ni saytda qidirish →
            </a>
            <SubmitButton pending={pending}>Saqlash</SubmitButton>
          </form>
        )}
      </Modal>
    </div>
  );
}
