import { Card, MetricCard, PageHeader } from "@/components/ui";
import { DebtsPanel } from "@/components/panels/DebtsPanel";
import { FILIALS } from "@/lib/filial";
import { formatDate, formatNumber } from "@/lib/format";
import { getDebtsData } from "@/lib/queries";
import { isDebtAlertOn } from "@/lib/app-settings";
import { DebtAlertToggle } from "@/components/DebtAlertToggle";

export const dynamic = "force-dynamic";

function money(amount: number, currency: "UZS" | "USD") {
  return currency === "USD" ? `$${formatNumber(Math.round(amount))}` : formatNumber(amount);
}

export default async function QarzlarPage() {
  const [d, alertOn] = await Promise.all([getDebtsData(), isDebtAlertOn()]);
  const units = FILIALS.filter((unit) => unit !== "Umumiy");

  return (
    <div>
      <PageHeader
        title="Qarzlar"
        subtitle="Firmadan olingan tovar qarzi va ko'chadagi naqd qarz — qancha berildi, qancha qoldi"
      />

      {d.needsMigration && (
        <div className="mb-5 rounded-lg border border-danger bg-danger-light p-3 text-sm">
          <b>Jadval hali yaratilmagan.</b> Supabase → SQL Editor da{" "}
          <code>prisma/manual/qarzlar.sql</code> faylini ishga tushiring, shundan keyin bu bo&apos;lim
          ishlaydi.
        </div>
      )}

      <div className="mb-5 sm:max-w-md">
        <DebtAlertToggle enabled={alertOn} />
      </div>

      {(d.overdue.length > 0 || d.dueSoon.length > 0) && (
        <div className="mb-5 space-y-2">
          {d.overdue.length > 0 && (
            <div className="rounded-lg border border-danger bg-danger-light p-3 text-sm">
              <b>Muddati o&apos;tgan {d.overdue.length} ta qarz:</b>{" "}
              {d.overdue
                .map((debt) => `${debt.counterparty} — ${money(debt.remaining, debt.currency)}`)
                .join(" · ")}
            </div>
          )}
          {d.dueSoon.length > 0 && (
            <div className="rounded-lg border border-edge bg-accent-light p-3 text-sm">
              <b>Muddati yaqin {d.dueSoon.length} ta qarz:</b>{" "}
              {d.dueSoon
                .map(
                  (debt) =>
                    `${debt.counterparty} — ${money(debt.remaining, debt.currency)} (${
                      debt.dueDate ? formatDate(debt.dueDate) : ""
                    })`,
                )
                .join(" · ")}
            </div>
          )}
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard
          icon="🏢"
          label="Firmaga qarz (so'm)"
          value={formatNumber(d.totals.firmUzs)}
          valueColor="var(--c-danger)"
        />
        <MetricCard icon="🏢" label="Firmaga qarz (dollar)" value={`$${formatNumber(Math.round(d.totals.firmUsd))}`} />
        <MetricCard
          icon="💰"
          label="Ko'cha qarzi (so'm)"
          value={formatNumber(d.totals.streetUzs)}
          valueColor="var(--c-danger)"
        />
        <MetricCard
          icon="💰"
          label="Ko'cha qarzi (dollar)"
          value={`$${formatNumber(Math.round(d.totals.streetUsd))}`}
          sub={`${d.openCount} ta ochiq qarz`}
        />
      </div>

      <Card title="Qarzlar ro'yxati" icon="💳">
        <DebtsPanel debts={d.debts} units={[...units]} />
      </Card>
    </div>
  );
}
