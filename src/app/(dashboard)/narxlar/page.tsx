import { Card, MetricCard, PageHeader } from "@/components/ui";
import { AlertToggle } from "@/components/AlertToggle";
import { PricePanel } from "@/components/panels/PricePanel";
import { PriceWatchListPanel } from "@/components/panels/PriceWatchListPanel";
import { setPriceAlert } from "@/lib/actions/prices";
import { isPriceAlertOn } from "@/lib/app-settings";
import { formatDate, formatNumber, formatTime } from "@/lib/format";
import { getPriceWatchData, getPriceWatchList, type PriceGroup } from "@/lib/queries";

export const dynamic = "force-dynamic";
// Ro'yxatga qo'shilganda arzonaptekadan izlash va narx olish vaqt oladi
export const maxDuration = 60;

function parseGroup(value?: string): PriceGroup | "all" {
  return value === "top" || value === "all" ? value : "slow";
}

export default async function NarxlarPage({
  searchParams,
}: {
  searchParams: Promise<{ guruh?: string; q?: string; sahifa?: string }>;
}) {
  const sp = await searchParams;
  const [d, alertOn] = await Promise.all([
    getPriceWatchData({
      group: parseGroup(sp.guruh),
      search: sp.q,
      page: Number(sp.sahifa) || 1,
    }),
    isPriceAlertOn(),
  ]);
  const list = d.needsMigration ? [] : await getPriceWatchList(d.percent);

  return (
    <div>
      <PageHeader title="Narx nazorati" />

      {d.needsMigration && (
        <div className="mb-5 rounded-lg border border-danger bg-danger-light p-3 text-sm">
          <b>Jadval hali yaratilmagan.</b> Supabase → SQL Editor da avval{" "}
          <code>prisma/manual/narx-nazorati.sql</code>, so&apos;ng{" "}
          <code>prisma/manual/narx-royxati.sql</code> ni ishga tushiring.
        </div>
      )}

      <div className="mb-5 sm:max-w-md">
        <AlertToggle
          enabled={alertOn}
          label="Narx eslatmasi"
          onText="Arzonaptekadagi dorilardan narxi tavsiyaga mos kelmaganlari har kuni ombor eslatmasidan yarim soat keyin keladi"
          action={setPriceAlert}
        />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          icon="🐌"
          label="Kam sotilayotgan"
          value={formatNumber(d.slowCount)}
        />
        <MetricCard
          icon="🔥"
          label="Topiviy dorilar"
          value={formatNumber(d.topCount)}
        />
        <MetricCard
          icon="⚠️"
          label="Bizda qimmat"
          value={formatNumber(d.overpriced)}
          valueColor={d.overpriced > 0 ? "var(--c-danger)" : undefined}
        />
        <MetricCard
          icon="🕐"
          label="Oxirgi tekshiruv"
          value={d.lastChecked ? formatTime(d.lastChecked) : "—"}
          sub={d.lastChecked ? formatDate(d.lastChecked) : "hali tekshirilmagan"}
        />
      </div>

      <Card title="Dorilar ro'yxati" icon="💹">
        <PricePanel
          items={d.items}
          settings={d.settings}
          group={d.group}
          search={d.search}
          page={d.page}
          pageSize={d.pageSize}
          total={d.total}
          topCount={d.topCount}
          slowCount={d.slowCount}
        />
      </Card>

      <Card title="Arzonapteka ro'yxati" icon="📋" className="mt-5">
        <PriceWatchListPanel items={list} />
      </Card>
    </div>
  );
}
