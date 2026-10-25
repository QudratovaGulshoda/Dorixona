import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { refreshPriceWatch } from "@/lib/price-watch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Narxlarni yangilash — dorixona kompyuteridagi ko'prik skript chaqiradi.
 *
 * Har chaqiruvda eskirgan yozuvlardan ozi olinadi (60 soniyaga sig'sin).
 * Skript har 15 daqiqada ishlagani uchun ro'yxat uch soatda bir aylanadi.
 *
 *   POST /api/prices/refresh?token=<FAPTEKA_SITE_TOKEN>&limit=12
 */

function allowed(request: NextRequest) {
  const expected = process.env.CRON_SECRET?.trim() || process.env.FAPTEKA_SITE_TOKEN?.trim();
  if (!expected) return false;
  const auth = request.headers.get("authorization")?.trim();
  const bearer = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return bearer === expected || request.nextUrl.searchParams.get("token")?.trim() === expected;
}

async function handle(request: NextRequest) {
  if (!allowed(request)) {
    return NextResponse.json({ ok: false, error: "Token noto'g'ri" }, { status: 401 });
  }

  const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limit") ?? 12) || 12, 1), 25);
  const result = await refreshPriceWatch(limit);

  try {
    await db.integrationLog.create({
      data: {
        source: "narx-nazorati",
        rowCount: result.checked,
        note:
          `yangilandi: ${result.updated}, omborga bog'landi: ${result.linked}` +
          (result.searched ? `, izlandi: ${result.searched} (topildi ${result.found})` : "") +
          (result.errors.length ? ` | ${result.errors.slice(0, 3).join("; ")}` : ""),
        ok: result.ok,
      },
    });
  } catch {
    // Jurnal yozilmasa ham asosiy ish buzilmasin
  }

  return NextResponse.json(result);
}

export async function GET(request: NextRequest) {
  return handle(request);
}

export async function POST(request: NextRequest) {
  return handle(request);
}
