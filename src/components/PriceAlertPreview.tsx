"use client";

import { useState, useTransition } from "react";
import { FormError, Modal } from "@/components/Modal";
import { previewPriceAlert, sendPriceAlertNow } from "@/lib/actions/prices";

/**
 * Narx eslatmasini saytning o'zida ko'rish va xohlasa hozir yuborish.
 * Tokenli tekshiruv havolasi kerak bo'lmasin.
 */
export function PriceAlertPreview() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, start] = useTransition();

  function show() {
    setOpen(true);
    setError("");
    setNotice("");
    setText(null);
    start(async () => {
      const result = await previewPriceAlert();
      if (!result.ok) setError(result.error);
      else if (!result.text) setNotice("Hozir yuboradigan narsa yo'q — hamma narx tavsiyaga mos.");
      else setText(result.text);
    });
  }

  function send() {
    setError("");
    setNotice("");
    start(async () => {
      const result = await sendPriceAlertNow();
      if (!result.ok) setError(result.error);
      else setNotice(`Telegramga yuborildi: ${result.sent}/${result.total} kishi`);
    });
  }

  return (
    <>
      <button type="button" onClick={show} className="btn btn-ghost btn-sm self-center">
        Xabarni ko&apos;rish
      </button>

      <Modal open={open} title="Narx eslatmasi — Telegram'da shunday keladi" onClose={() => setOpen(false)} wide>
        <div className="space-y-3">
          {pending && !text && <p className="text-sm text-muted">Hisoblanmoqda…</p>}
          <FormError message={error} />
          {notice && <p className="rounded-lg bg-surface px-3 py-2 text-sm">{notice}</p>}
          {text && (
            <>
              {/* Matn bizning xabar yasovchidan: nomlar ekranlangan, faqat <b>/<i> */}
              <div
                className="max-h-[60vh] overflow-auto whitespace-pre-line rounded-lg border border-edge bg-surface p-3 text-sm"
                dangerouslySetInnerHTML={{ __html: text }}
              />
              <button type="button" disabled={pending} onClick={send} className="btn btn-primary btn-sm">
                {pending ? "Yuborilmoqda…" : "Telegramga hozir yuborish"}
              </button>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
