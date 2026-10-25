import { auth } from "@/auth";
import { buildPriceListTemplate } from "@/lib/price-list-excel";

export const runtime = "nodejs";

/** Narx nazorati ro'yxatini Excel'dan yuklash uchun namuna fayl */
export async function GET() {
  const session = await auth();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });

  const buffer = await buildPriceListTemplate();
  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="narx-nazorati-namuna.xlsx"',
    },
  });
}
