import assert from "node:assert/strict";
import test from "node:test";

import { latinTokens, matchCatalog, parseCatalog } from "./price-match";

const loc = (slug: string) => `<url><loc>https://arzonapteka.uz/ru/products/${slug}</loc></url>`;

const catalog = parseCatalog(
  [
    "vizin-0-05-15-ml-kapli-glaz-8985",
    "vizin-alergi-0-05-4-ml-kapli-glaz-33187",
    "vizinalgin-tab-10-55555",
    "prednizolon-5-mg-tab-100-4710",
    "prednizolon-5-mg-g-10-g-maz-4713",
    "mikardisplyus-12-5-80-mg-tab-28-71205",
    "hlorgeksidina-biglyukonat-0-05-100-ml-flak-30438",
    "devit-3-50000-me-kaps-8-72599",
  ]
    .map(loc)
    .join("\n"),
);

test("kirill nomni sayt havolasidagidek lotinchaga o'giradi", () => {
  assert.deepEqual(latinTokens("МИКАРДИС ПЛЮС 80МГ №28"), ["mikardis", "plyus", "80", "mg", "28"]);
  assert.deepEqual(latinTokens("Хлоргексидин 0,05%"), ["hlorgeksidin", "0", "05"]);
  assert.deepEqual(latinTokens("Микардис+"), ["mikardis", "plyus"]);
});

test("havola ID'si nomga kirmaydi", () => {
  assert.deepEqual(catalog[0].tokens, ["vizin", "0", "05", "15", "ml", "kapli", "glaz"]);
});

test("nom so'z chegarasida tugaganini afzal ko'radi", () => {
  assert.equal(matchCatalog("ВИЗИН", null, catalog), "vizin-0-05-15-ml-kapli-glaz-8985");
});

test("ombordagi to'liq nom qaysi shaklligini hal qiladi", () => {
  assert.equal(matchCatalog("ПРЕДНИЗОЛОН", "ПРЕДНИЗОЛОН 5МГ ТАБ №100", catalog), "prednizolon-5-mg-tab-100-4710");
  assert.equal(matchCatalog("ПРЕДНИЗОЛОН", "ПРЕДНИЗОЛОН МАЗЬ 10Г", catalog), "prednizolon-5-mg-g-10-g-maz-4713");
});

test("bo'sh joyli nom qo'shib yozilgan havolaga ham mos keladi", () => {
  assert.equal(matchCatalog("МИКАРДИС ПЛЮС", null, catalog), "mikardisplyus-12-5-80-mg-tab-28-71205");
});

test("nomdagi raqam havolada bo'lmasa topilmadi", () => {
  assert.equal(matchCatalog("ДЕВИТ-30000", null, catalog), null);
  assert.equal(matchCatalog("ВАЛОКАРДИН", null, catalog), null);
  assert.equal(matchCatalog("", null, catalog), null);
});
