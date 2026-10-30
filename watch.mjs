#!/usr/bin/env node
// Stock alert, one pass: reads every watch in watch.json once, pushes to ntfy when something new
// appears, becomes orderable or changes, and remembers what it saw in state.json. Never logs in, never buys.
//
//   NTFY_TOPIC=... node watch.mjs            normal pass: push only on changes
//   NTFY_TOPIC=... REPORT=1 node watch.mjs   test pass: always push the current status
//
// Two kinds of watch in watch.json:
//   "products": one product page each (400coups.ch, CS-Cart) → is THIS product orderable?
//   "searches": product lists of a shop + keyword filter → which matching products exist, are they orderable?
//               "shop": "prestashop" (red-line.shop), "woocommerce" (mix-image.ch), "shopify" (poke-swiss.ch)
//               "shopware" (amazingtoys.ch: one product per page, language = variant), "wix" (arcbleu.shop)
//               "cscart" (400coups.ch: search / category pages), "playin" (play-in.com: product pages,
//               online + one store's stock) or "prestashopHtml" (plain category / search pages, when the
//               shop refuses the JSON listing)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0 Safari/537.36';
const STATE_FILE = 'state.json';
// One slow shop must not eat the whole pass: the job is killed after 5 min (watch.yml).
const TIMEOUT = 15_000; // per request
const DEADLINE = Date.now() + 6 * 60_000; // no new watch is started after this
const topic = process.env.NTFY_TOPIC;
const report = process.env.REPORT === '1' || process.env.REPORT === 'true';
const config = JSON.parse(readFileSync('watch.json', 'utf8'));
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : {};
const log = (...a) => console.log(new Date().toISOString(), ...a);

// `orderable`: the push is about one product that can be ordered → tag "orderable", which the PC viewer
// (viewer/ntfy_viewer.pyw) reads instead of guessing from each shop's wording.
// Returns false when the push did not go out, so the caller keeps the old state and alerts again next pass.
async function push(title, message, url, orderable = false) {
  log(`🔔 ${title} — ${message}`);
  if (!topic) {
    log('⚠ NTFY_TOPIC not set — no push');
    return true;
  }
  const tags = orderable ? ['rotating_light', 'orderable'] : ['rotating_light'];
  const res = await fetch('https://ntfy.sh/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic, title, message, priority: 5, ...(url && { click: url }), tags }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e) => ({ ok: false, status: e.message }));
  if (!res.ok) log(`⚠ ntfy push failed: ${res.status}`);
  return res.ok;
}

class Skip extends Error {} // page not readable this time (429, 5xx, timeout): try again next pass, no alert

// One fetch; on 429 (too many requests) wait and try once more before giving up for this pass.
// 400 Coups' server refuses a request that comes less than ~4 s after the previous one, and GitHub's
// machines are shared, so another user's traffic can trigger it too.
async function fetchPolite(url, headers) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) }).catch((e) => {
      throw new Skip(e.message);
    });
    if (res.status !== 429) return res;
    if (attempt) throw new Skip('HTTP 429 (trop de requêtes)');
    const wait = Math.min(Number(res.headers.get('retry-after')) || 15, 30);
    log(`⏳ 429 sur ${new URL(url).host} — nouvel essai dans ${wait} s`);
    await pause(wait * 1000);
  }
}

async function get(url, accept) {
  // X-Requested-With only for JSON: PrestaShop needs it to answer in JSON, Shopware refuses it on HTML pages (403).
  const res = await fetchPolite(url, { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'fr-CH,fr;q=0.9', ...(accept.includes('json') && { 'X-Requested-With': 'XMLHttpRequest' }) });
  if (!res.ok) throw new Skip(`HTTP ${res.status}`);
  return res;
}

const decode = (s) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&[rl]squo;/g, '’').replace(/&amp;/g, '&');
const text = (html) => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// "Pokémon 30ème" → "pokemon 30eme"
const norm = (s) => s.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();

// Language from a name or a "Langue" attribute. French wins when several are listed ("FR/EN"), since a
// bilingual product is fine for a French buyer. null = no language marker at all.
function nameLanguage(text) {
  // Codes only count in capitals ("FR", "JP"): lowercase "de", "en"… are ordinary French words.
  // In an all-caps name ("COFFRET DE COLLECTION", "… (EN STOCK)") "DE", "EN"… are words too, so there the
  // other codes only count at the end or next to a separator ("… - EN", "(JP)", "EN/DE", "EN, DE").
  // "FR" / "VF" are never words: they count anywhere.
  const caps = text === text.toUpperCase();
  const code = (codes, strict) =>
    strict
      ? new RegExp(`[-(\\[/,|]\\s*(${codes})([^A-Za-z]|$)|(^|[^A-Za-z])(${codes})\\s*([-)\\]/,|]|$)`)
      : new RegExp(`(^|[^A-Za-z])(${codes})([^A-Za-z]|$)`);
  const has = (codes, words, strict = caps) => code(codes, strict).test(text) || new RegExp(words).test(norm(text));
  if (has('FR|VF', 'francais|french', false)) return 'FR';
  if (has('JP|JPN|JAP', 'japonais|japanese')) return 'JPN';
  if (has('EN|ENG|US|UK', 'anglais|english')) return 'ENG';
  if (has('DE|GER', 'allemand|deutsch')) return 'DE';
  if (has('CN|CHS|CHT', 'chinois|chinese')) return 'CN';
  if (has('KR|KOR', 'coreen|korean')) return 'KR';
  return null;
}

// ---------- products: one CS-Cart product page (400coups.ch) ----------
//  - not orderable yet: the price block shows "ty-no-price" ("[Commande bientôt disponible]")
//  - orderable: a real add-to-cart control with id="button_cart_<ID>" (class "et-in-stock") exists
//  - sold out: no such control, the button reads "Rupture de stock" (class "et-out-of-stock")
// The real add-to-cart control has id="button_cart_<ID>". Sticky bars only point at it with
// data-ca-external-click-id="button_cart_<ID>", which must not count (it is there even when sold out).
const cartButton = (html, id) => new RegExp(`\\sid="button_cart_${id}"`).test(html);

function readCsCart(html) {
  const id = html.match(/id="price_update_(\d+)"/)?.[1];
  if (!id) return null;
  const tag = html.indexOf(`id="price_update_${id}"`);
  const start = html.indexOf('>', tag) + 1;
  const priceBlock = html.slice(start, html.indexOf(`<!--price_update_${id}-->`, start));
  const noPrice = priceBlock.match(/class="ty-no-price"[^>]*>([^<]*)</)?.[1].trim();
  const price = noPrice ? null : text(priceBlock).replace(/^(\d+) (\d{2})$/, '$1.$2') || null;
  const hasCartButton = cartButton(html, id);
  const soldOut = !hasCartButton && /et-out-of-stock|Rupture de stock/.test(html);
  const status = noPrice ?? (hasCartButton ? 'Ajouter au panier dispo' : soldOut ? 'Rupture de stock' : 'pas de bouton panier');
  return { orderable: !noPrice && hasCartButton, label: [price && `${price} CHF`, status].filter(Boolean).join(' — ') };
}

async function watchProduct(item) {
  const html = await (await get(item.url, 'text/html')).text();
  const r = readCsCart(html);
  if (!r) throw new Skip('format de page inconnu — le site a peut-être changé');
  log(`${r.orderable ? '✅' : '⏳'} ${item.name}: ${r.label}`);

  const prev = state[item.url];
  let sent = true;
  if (!prev) await push('Surveillance démarrée', `${item.name} — ${r.orderable ? 'COMMANDABLE !' : r.label}`, item.url);
  else if (r.orderable && !prev.orderable) sent = await push(`🚨 COMMANDABLE — ${item.name}`, `${item.name} — ${r.label}`, item.url, true);
  else if (r.label !== prev.label) sent = await push(`Changement — ${item.name}`, `${prev.label} → ${r.label}`, item.url);
  else if (report) await push(`Test OK — ${item.name}`, `${r.orderable ? 'COMMANDABLE !' : r.label} (rien n'a changé)`, item.url);
  if (sent) state[item.url] = { orderable: r.orderable, label: r.label, at: new Date().toISOString() };
}

// ---------- searches: PrestaShop product lists (red-line.shop) + keyword filter ----------
// PrestaShop answers listing/search pages with JSON when asked with X-Requested-With: XMLHttpRequest.
// add_to_cart_url is only filled when the product can actually be ordered.
async function listPrestaShop(base, path) {
  const url = new URL(path, base);
  url.searchParams.set('resultsPerPage', '100');
  const j = await (await get(url, 'application/json')).json();
  return (j.products ?? []).map((p) => ({
    id: String(p.id_product),
    name: decode(p.name),
    price: p.price,
    url: p.url,
    orderable: Boolean(p.add_to_cart_url),
    status: p.add_to_cart_url ? 'commandable' : 'pas encore commandable',
    categories: [],
    language: nameLanguage(decode(p.name)), // Red Line ends titles with "- FR" / "- ENG" / "- JPN"
  }));
}

// WooCommerce public Store API (no login): /wp-json/wc/store/v1/products?... → JSON product list.
// is_purchasable && is_in_stock = the "Ajouter au panier" button works (in stock, or preorder/backorder).
const wooLanguage = (p, name) =>
  nameLanguage(p.attributes?.find((a) => /^langue|^language/i.test(a.name))?.terms?.map((t) => t.name).join(', ') ?? '') ??
  nameLanguage(name);

async function listWooCommerce(base, path) {
  const url = new URL(path, base);
  const j = await (await get(url, 'application/json')).json();
  return j.map((p) => {
    const name = decode(p.name);
    const minor = p.prices?.currency_minor_unit ?? 2;
    const orderable = Boolean(p.is_purchasable && p.is_in_stock);
    return {
      id: String(p.id),
      name,
      price: p.prices?.price ? `${(Number(p.prices.price) / 10 ** minor).toFixed(2)} ${p.prices.currency_code ?? ''}`.trim() : '?',
      url: p.permalink,
      orderable,
      status: decode(p.stock_availability?.text || '') || (orderable ? 'commandable' : 'pas encore commandable'),
      categories: (p.categories ?? []).map((c) => c.slug),
      language: wooLanguage(p, name),
    };
  });
}

// Shopify public JSON: /products.json?limit=250&page=N, most recently published first. No stock count,
// but each variant says `available` (= "Ajouter au panier" works). Single cards there carry no tags,
// sealed products do ("Boosters", "Displays", "Coffrets…", "Elite Trainer Boxes & Tins").
// Also reads the shop's search suggestions (/search/suggest.json?q=…, 10 results per query): for shops
// whose catalogue is mostly thousands of single cards, a few targeted queries beat reading every page.
async function listShopify(base, path) {
  const j = await (await get(new URL(path, base), 'application/json')).json();
  return (j.products ?? j.resources?.results?.products ?? []).map((p) => {
    const name = decode(p.title);
    const orderable = p.available ?? p.variants?.some((v) => v.available) ?? false;
    const price = p.price ?? p.variants?.[0]?.price;
    return {
      id: String(p.id),
      name,
      price: price ? `${Number(price).toFixed(2)} CHF` : '?',
      url: new URL(`/products/${p.handle}`, base).href,
      orderable,
      status: orderable ? 'commandable' : 'épuisé / pas encore commandable',
      categories: (p.tags ?? []).map((t) => norm(t).replace(/[^a-z0-9]+/g, '-')),
      single: !(p.tags ?? []).length || (p.tags ?? []).some((t) => /carte a l.unite|single/i.test(norm(t))),
      language: nameLanguage(name),
    };
  });
}

// Shopware 6 (amazingtoys.ch). The search listing (already filtered on the wanted language through the
// shop's own "Sprache" filter) shows one box per product; most products have one variant per language and
// the box only says "Ansehen". So for each matching box the bot opens the page of the wanted-language
// variant, found once through the shop's variant switch and then remembered in state.json.
// On that page: schema.org availability (InStock / PreOrder / OutOfStock) + a real submit "In den Warenkorb".
const getHtml = async (url) => (await get(url, 'text/html')).text();
const between = (h, re) => h.match(re)?.[1];
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const shopwareDone = new Set();

function readShopwareProduct(h, url) {
  const availability = between(h, /itemprop="availability"\s+href="https?:\/\/schema\.org\/(\w+)"/);
  const canBuy = /<button[^>]*class="[^"]*btn-buy[^"]*"[^>]*type="submit"|<button[^>]*type="submit"[^>]*class="[^"]*btn-buy/.test(h);
  const delivery = text(between(h, /<p class="delivery-information[^"]*">([\s\S]*?)<\/p>/) ?? '');
  const name = text(between(h, /<h1[^>]*>([\s\S]*?)<\/h1>/) ?? '');
  const price = between(h, /<meta[^>]*itemprop="price"[^>]*content="([\d.]+)"/);
  return {
    name,
    price: price ? `${Number(price).toFixed(2)} CHF` : '?',
    url,
    orderable: canBuy && availability !== 'OutOfStock' && availability !== 'SoldOut',
    status: delivery || availability || '?',
  };
}

// Finds the URL of the variant whose option label is `option` (e.g. "Französisch") on a product page.
async function shopwareVariantUrl(base, productUrl, option) {
  const h = await getHtml(productUrl);
  const re = new RegExp(`<input[^>]*name="([0-9a-f]{32})"[^>]*value="([0-9a-f]{32})"[^>]*>\\s*<label[^>]*title="${option}"`, 'i');
  const m = h.match(re);
  if (!m) return between(h, /<link rel="canonical" href="([^"]+)"/) ?? productUrl; // no variants: the product itself
  const switchUrl = between(h, /&quot;url&quot;:&quot;(https?:[^&]*?\\\/switch)&quot;/)?.replace(/\\\//g, '/');
  if (!switchUrl) throw new Skip('variante introuvable (format de page inconnu)');
  const j = await (await get(`${switchUrl}?options=${encodeURIComponent(JSON.stringify({ [m[1]]: m[2] }))}`, 'application/json')).json();
  return j.url;
}

// `ctx.unread` collects the products whose own page failed: their last known state is kept, so a failed
// page does not look like a sell-out (and the next successful read like a restock).
async function listShopware(base, path, s, ctx) {
  const h = await getHtml(new URL(path, base));
  const boxes = [...h.matchAll(/data-product-information="([^"]+)"([\s\S]*?)(?=data-product-information=|<\/main>|$)/g)].map(([, info, rest]) => {
    const p = JSON.parse(decode(info));
    // The product link is the <a> whose class has "product-name" or "btn-detail" (attribute order varies).
    const tag = [...rest.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]).find((a) => /class="[^"]*(product-name|btn-detail)/.test(a));
    return { id: p.id, name: decode(p.name), link: tag && decode(between(tag, /href="(https?:[^"]+)"/) ?? '') };
  });
  ctx.boxes += boxes.length;
  const cache = (state[`variants:${s.name}`] ??= {});
  const products = [];
  for (const b of boxes) {
    // Only open the pages of boxes that already look like a match (language is checked on the variant),
    // and each product once per pass even if it shows on several listing pages.
    if (!b.link || !matches({ name: b.name, categories: [] }, { ...s.match, language: null })) continue;
    if (shopwareDone.has(b.id)) continue;
    shopwareDone.add(b.id);
    try {
      cache[b.id] ??= await shopwareVariantUrl(base, b.link, s.variant ?? 'Französisch');
      await pause(500);
      const p = readShopwareProduct(await getHtml(cache[b.id]), cache[b.id]);
      products.push({ ...p, id: b.id, name: p.name || b.name, categories: [], language: nameLanguage(p.name || b.name) ?? s.match.language });
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      log(`⏭ ${b.name}: ${e.message}`);
      ctx.unread.add(b.id);
      if (e.message.includes('429')) throw e; // the shop asks us to slow down: stop this shop for this pass
    }
  }
  return products;
}

// Wix Stores (arcbleu.shop): a category page embeds its product list as JSON in the HTML, one object per product:
//   {"id":"<uuid>","options":[{"key":"Langue",…,"selections":[{"value":"Français",…,"inStock":true},…]}],…,
//    "price":24.9,…,"isInStock":true,"urlPart":"<slug>",…,"name":"<name>",…}
// When a "Langue" option exists, orderable = the wanted language's selection is in stock.
const jsonString = (s) => JSON.parse(`"${s}"`);
async function listWix(base, path, s) {
  const h = await getHtml(new URL(path, base));
  const wanted = { FR: /fran[cç]ais|french/i }[s.match.language] ?? null;
  const products = [];
  for (const chunk of h.split(/(?=\{"id":"[0-9a-f-]{36}","options":)/).slice(1)) {
    const stock = chunk.match(/"isInStock":(true|false),"urlPart":"((?:[^"\\]|\\.)*)"/);
    const name = chunk.match(/"name":"((?:[^"\\]|\\.)*)"/);
    if (!stock || !name) continue;
    const price = chunk.match(/"price":([\d.]+)/)?.[1];
    const langOption = chunk.match(/"key":"(?:Langue|Language|Sprache)"[\s\S]*?"selections":\[([\s\S]*?)\]\}/)?.[1] ?? '';
    const langs = [...langOption.matchAll(/"value":"((?:[^"\\]|\\.)*)"[\s\S]*?"inStock":(true|false)/g)].map(([, v, st]) => ({ value: jsonString(v), inStock: st === 'true' }));
    const wantedLang = wanted && langs.find((l) => wanted.test(l.value));
    const orderable = stock[1] === 'true' && (!langs.length || !wanted || Boolean(wantedLang?.inStock));
    const productName = jsonString(name[1]);
    products.push({
      id: chunk.match(/^\{"id":"([0-9a-f-]{36})"/)[1],
      name: productName,
      price: price ? `${Number(price).toFixed(2)} CHF` : '?',
      url: new URL(`/product-page/${jsonString(stock[2])}`, base).href,
      orderable,
      status: orderable ? 'en stock' : 'rupture de stock',
      categories: [],
      // Language: from the "Langue" option when there is one (wanted language offered → that language), else the name.
      language: wantedLang ? s.match.language : langs.length ? nameLanguage(langs.map((l) => l.value).join(', ')) : nameLanguage(productName),
    });
  }
  return products;
}

// CS-Cart listing (400coups.ch search or category page): each product box has the same price block as the
// product page (price_update_<ID>, "ty-no-price" = "[Commande bientôt disponible]") and, when it can be
// ordered, a real add-to-cart control id="button_cart_<ID>". Name and link: the last "product-title" before it.
function listCsCartHtml(h, base) {
  const byUrl = new Map();
  for (const [, id] of h.matchAll(/id="price_update_(\d+)"/g)) {
    const at = h.indexOf(`id="price_update_${id}"`);
    const before = h.slice(Math.max(0, at - 8000), at);
    const title = [...before.matchAll(/class="product-title"[^>]*>([^<]+)</g)].pop()?.[1];
    const url = [...before.matchAll(/<a href="(https?:\/\/[^"]+\.html)"/g)].pop()?.[1];
    if (!title || !url || byUrl.has(url)) continue;
    const end = h.indexOf(`<!--price_update_${id}-->`, at);
    const priceBlock = h.slice(h.indexOf('>', at) + 1, end);
    const noPrice = priceBlock.match(/class="ty-no-price"[^>]*>([^<]*)</)?.[1].trim();
    const price = noPrice ? null : text(priceBlock).replace(/^(\d+) (\d{2})$/, '$1.$2');
    const hasCart = cartButton(h, id);
    byUrl.set(url, {
      id: url,
      name: decode(title.trim()),
      price: price ? `${price} CHF` : '?',
      url,
      orderable: !noPrice && hasCart,
      status: noPrice ?? (hasCart ? 'Ajouter au panier dispo' : 'rupture / pas de bouton panier'),
      categories: [],
      language: nameLanguage(title),
    });
  }
  return [...byUrl.values()];
}
const listCsCart = async (base, path) => listCsCartHtml(await getHtml(new URL(path, base)), base);

// 400 Coups creates product pages long before showing them. In CS-Cart a product is Active (listed),
// Hidden (open by direct link but not listed — can be ordered without ever showing up!) or Disabled (404).
// Even a 404 reveals the product's name: /index.php?dispatch=products.view&product_id=N redirects to its
// slug ("/pokemon-mini-tin-30eme-anniversaire.html") before answering 404.
//  - `hidden`: product ids found that way; each pass opens the ones the listings did not show.
//  - `probe`: each pass also tries the next few ids after the highest known one, so pages created later
//    are found too; matching ones are added to the hidden list (kept in state.json).
async function csCartById(base, id) {
  const res = await fetchPolite(new URL(`/index.php?dispatch=products.view&product_id=${id}`, base), { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'fr-CH,fr;q=0.9' });
  const url = res.url;
  const slug = decodeURIComponent(new URL(url).pathname.replace(/^\/|\.html$/g, ''));
  if (res.status === 404) return { url, slug, exists: !/^index\.php/.test(slug) && slug !== '', visible: false };
  if (!res.ok) throw new Skip(`HTTP ${res.status}`);
  const h = await res.text();
  const r = readCsCart(h);
  const name = text(between(h, /<h1[^>]*>([\s\S]*?)<\/h1>/) ?? '') || slug;
  return { url, slug, exists: Boolean(r), visible: true, name, ...r };
}
const slugName = (slug) => slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

async function hiddenCsCart(s, seen) {
  const key = `hidden:${s.name}`;
  const st = (state[key] ??= { ids: [...(s.hidden ?? [])], maxId: Math.max(0, ...(s.hidden ?? []), s.probe?.from ?? 0) });
  for (const id of s.hidden ?? []) if (!st.ids.includes(id)) st.ids.push(id);
  const products = [];
  const add = (id, r) =>
    products.push({
      id: r.url,
      name: r.visible ? r.name : `${slugName(r.slug)} (fiche cachée)`,
      price: r.visible && r.label.match(/^[\d.]+ CHF/)?.[0] || '?',
      url: r.url,
      orderable: Boolean(r.visible && r.orderable),
      hidden: !r.visible,
      status: r.visible ? r.label.replace(/^[\d.]+ CHF — /, '') : 'pas encore en ligne',
      categories: [],
      language: s.defaultLanguage ?? null,
    });
  const shown = new Set([...seen.values()].map((p) => p.url));
  // st.urls: page address of each id, so ids already shown by the listings are not opened again (fewer requests).
  st.urls ??= {};
  for (const id of st.ids) {
    if (shown.has(st.urls[id])) continue;
    await pause(s.pauseMs ?? 2000);
    const r = await csCartById(s.base, id);
    if (r.exists) st.urls[id] = r.url;
    if (r.exists && !shown.has(r.url)) add(id, r);
  }
  // New pages created since last pass: try the next few ids. Deleted ids leave gaps, so every id of the
  // window is tried and the window then moves to the highest one that exists.
  const from = st.maxId;
  for (let id = from + 1; id <= from + (s.probe?.count ?? 0); id++) {
    await pause(s.pauseMs ?? 2000);
    const r = await csCartById(s.base, id);
    if (!r.exists) continue;
    st.maxId = Math.max(st.maxId, id);
    if (st.ids.includes(id)) continue;
    if (matches({ name: r.visible ? r.name : slugName(r.slug), categories: [] }, { ...s.match, language: null })) {
      log(`🔍 ${s.name}: nouvelle fiche trouvée #${id} ${r.slug}`);
      st.ids.push(id);
      if (!shown.has(r.url)) add(id, r);
    }
  }
  return products;
}

// Play-in (Next.js). Its search runs in the browser, so the bot reads product pages directly
// (/fr/produit/<id>/x — the slug does not matter). Each page embeds the product data:
//   "productStores":{…"collection":[{"storeStockState":"STOCK_IN_STORE","store":{"shortName":"Annecy",…}},…]},
//   "warehouseStockState":"OUT_OF_STOCK","releasedAt":"2026-11-27T…","transName":"<name>"
// `pages` = product ids. `store` = the shop to watch (e.g. "Annecy"): orderable = in stock there or online.
async function listPlayin(base, id, s) {
  const raw = await getHtml(new URL(`/fr/produit/${id}/x`, base));
  const h = raw.replace(/\\"/g, '"');
  const at = h.indexOf('"productStores"');
  if (at < 0) throw new Skip('format de page inconnu');
  const block = h.slice(at, h.indexOf('"transName"', at));
  const name = decode(between(h.slice(at), /"transName":"([^"]+)"/) ?? `#${id}`);
  const online = between(block, /"warehouseStockState":"(\w+)"/) ?? '?';
  const store = s.store ?? 'Annecy';
  const inStore = new RegExp(`"storeStockState":"(\\w+)"[^{}]*"store":\\{[^}]*"shortName":"${store}"`).exec(block)?.[1] ?? 'OUT_OF_STOCK';
  const release = between(block, /"releasedAt":"(\d{4}-\d\d-\d\d)/);
  const storeOk = /STOCK_IN_STORE|IN_STOCK/.test(inStore);
  const onlineOk = !/OUT_OF_STOCK/.test(online) && online !== '?';
  const words = { STOCK_IN_STORE: 'en stock', OUT_OF_STOCK: 'rupture', STOCK_IN_WAREHOUSE: 'en stock' };
  // Price: "sellPrice" of the product object that holds "productStores" (0 until the shop sets it). The page
  // also embeds other products (menus, suggestions) with their own prices.
  const price = Number(between(h.slice(h.lastIndexOf('"product":{', at), at), /"sellPrice":([\d.]+)/));
  return [{
    id: String(id),
    name,
    price: price ? `${price.toFixed(2)} €` : '?',
    url: new URL(`/fr/produit/${id}/x`, base).href,
    orderable: storeOk || onlineOk,
    status: `magasin ${store} : ${words[inStore] ?? inStore} — en ligne : ${words[online] ?? online}${release ? ` — sortie ${release.split('-').reverse().join('/')}` : ''}`,
    categories: [],
    language: nameLanguage(name),
  }];
}

// PrestaShop pages read as plain HTML, for shops whose firewall refuses the JSON (XHR) listing.
// Each <article class="product-miniature" data-id-product="…">: link, title, price, "badge out-of-stock",
// and an add-to-cart button that is `disabled` when it cannot be ordered.
async function listPrestaShopHtml(base, path) {
  const h = await getHtml(new URL(path, base));
  return h.split(/<article class="product-miniature/).slice(1).map((chunk) => {
    const c = chunk.slice(0, chunk.indexOf('</article>') + 1 || undefined);
    const outOfStock = /badge out-of-stock/.test(c);
    const button = c.match(/<button[^>]*add-to-cart[^>]*>/)?.[0] ?? '';
    const orderable = !outOfStock && Boolean(button) && !/disabled/.test(button);
    const name = decode(text(between(c, /class="product-title"[^>]*>([\s\S]*?)<\/h\d>/) ?? ''));
    return {
      id: between(c, /data-id-product="(\d+)"/),
      name,
      price: decode(text(between(c, /class="price"[^>]*>([\s\S]*?)<\/span>/) ?? '?')),
      url: between(c, /<a href="([^"]+)"/),
      orderable,
      status: orderable ? 'commandable' : outOfStock ? 'en rupture' : 'pas commandable',
      categories: [],
      language: nameLanguage(name),
    };
  }).filter((p) => p.id && p.name);
}

const LISTERS = { prestashop: listPrestaShop, woocommerce: listWooCommerce, shopify: listShopify, shopware: listShopware, wix: listWix, cscart: listCsCart, playin: listPlayin, prestashopHtml: listPrestaShopHtml };

// Each group is a list of words; the name must contain at least one word of EVERY group, and none of `exclude`.
const hasWord = (name, w) => new RegExp(`(^|[^a-z0-9])${norm(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(name);
// A product is kept when:
//  - its name contains a word of every `allOf` group (or of every group of one `anyOf` set),
//    OR it is in one of `categories` (e.g. "30th-celebration"),
//  - and its name has none of `exclude`, and it is in none of `excludeCategories` (prefix match: "accessoires"),
//  - and, if `language` is set, its language is that one (unknown language is kept, flagged "langue ?").
// `anyOf` = several `allOf` sets, the name may satisfy any one of them.
function matches(p, { allOf, anyOf = [allOf], exclude = [], categories = [], excludeCategories = [], language }) {
  const n = norm(p.name);
  const byName = anyOf.some((set) => set.every((group) => group.some((w) => hasWord(n, w))));
  const byCategory = p.categories.some((c) => categories.includes(c));
  if (!byName && !byCategory) return false;
  if (exclude.some((w) => hasWord(n, w))) return false;
  if (p.categories.some((c) => excludeCategories.some((x) => c.startsWith(x)))) return false;
  if (language && p.language && p.language !== language) return false;
  return true;
}
const describe = (p, language) =>
  `${p.name} — ${p.price} — ${p.status}${p.single ? ' (carte à l’unité)' : ''}${language && !p.language ? ' (langue ?)' : ''}`;
// Several lines in one push: the first ones, then "+ N autres".
const summary = (lines, max = 8) => lines.slice(0, max).join('\n') + (lines.length > max ? `\n+ ${lines.length - max} autres` : '');

async function watchSearch(s) {
  const seen = new Map();
  // unread: products whose own page failed this pass (Shopware), left as they were.
  // boxes: products listed before Shopware's own filtering (its `seen` only holds the matching ones).
  const ctx = { unread: new Set(), boxes: 0 };
  let read = 0;
  for (const [i, path] of s.pages.entries()) {
    if (i && s.pauseMs) await pause(s.pauseMs); // gentle with touchy shops (400 Coups)
    try {
      for (const p of await LISTERS[s.shop ?? 'prestashop'](s.base, path, s, ctx)) seen.set(p.id, p);
      read++;
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      log(`⏭ ${s.name} ${path}: ${e.message}`);
      if (e.message.includes('429')) break; // the shop asks us to slow down: stop this pass
    }
  }
  if (!read) throw new Skip('aucune page lue');
  let complete = read === s.pages.length; // every list read: a product missing from them is really gone
  if (s.shop === 'cscart' && (s.hidden?.length || s.probe)) {
    try {
      for (const p of await hiddenCsCart(s, seen)) seen.set(p.id, p);
    } catch (e) {
      if (!(e instanceof Skip)) throw e;
      log(`⏭ ${s.name} fiches cachées: ${e.message}`);
      complete = false; // the hidden pages not read this time must not look sold out
    }
  }

  if (s.defaultLanguage) for (const p of seen.values()) p.language ??= s.defaultLanguage;
  const hits = [...seen.values()].filter((p) => matches(p, s.match));
  log(`🔎 ${s.name}: ${seen.size} produits lus, ${hits.length} correspondent`);
  for (const p of hits) log(`   ${p.orderable ? '✅' : '⏳'} #${p.id} [${p.language ?? '??'}] ${describe(p, s.match.language)}`);

  const key = `search:${s.name}`;
  const first = !state[key];
  const known = state[key]?.products ?? {};
  // A page whose layout changed is read as an empty list, not as an error: say it once, after a few passes.
  let empty = seen.size || ctx.boxes ? 0 : (state[key]?.empty ?? 0) + 1;
  if (empty === 3 && !(await push(`⚠ ${s.name}`, `Aucun produit lu depuis ${empty} passages : le site a peut-être changé.`, s.link))) empty = 2;
  const line = (p) => `${p.orderable ? '✅' : '⏳'} ${describe(p, s.match.language)}`;
  const fresh = first ? [] : hits.filter((p) => !known[p.id]);
  // Back in stock / now orderable. Single cards ("singles": "once") are only announced when they first appear.
  const nowOrderable = hits.filter((p) => known[p.id] && p.orderable && !known[p.id].orderable && !(p.single && s.singles === 'once'));
  // A hidden page that went online (still not orderable): worth knowing, the drop is close.
  const nowVisible = hits.filter((p) => known[p.id]?.hidden && !p.hidden && !p.orderable);

  // New products: sealed ones always get their own push; single cards are grouped when a batch arrives
  // (e.g. 15 cards added at once), so a coffret is never buried in a list of singles.
  // An alert that did not go out leaves its product as it was, so the next pass sends it again.
  // 🚨 / 👀: the shop on the first line, then the usual "name — price — status" line (read by the viewer).
  const failed = new Set();
  const freshSingles = fresh.filter((p) => p.single);
  const alone = freshSingles.length > 3 ? fresh.filter((p) => !p.single) : fresh;
  for (const p of alone) if (!(await push(`🆕 ${s.name}${p.orderable ? ' — COMMANDABLE' : ''}`, describe(p, s.match.language), p.url, p.orderable))) failed.add(p.id);
  if (freshSingles.length > 3 && !(await push(`🆕 ${s.name} — ${freshSingles.length} nouvelles cartes à l’unité`, summary(freshSingles.map(line)), s.link))) for (const p of freshSingles) failed.add(p.id);
  for (const p of nowOrderable) if (!(await push(`🚨 COMMANDABLE — ${p.name}`, `${s.name}\n${describe(p, s.match.language)}`, p.url, true))) failed.add(p.id);
  for (const p of nowVisible) if (!(await push(`👀 En ligne — ${p.name}`, `${s.name}\n${describe(p, s.match.language)}`, p.url))) failed.add(p.id);

  const all = summary(hits.map(line));
  if (first) {
    // Not sent: stay a first pass, or the products listed in it would be known without ever being announced.
    if (!(await push('Surveillance démarrée', `${s.name}\n${hits.length ? all : 'aucun article pour l’instant'}`, s.link))) return;
  } else if (report) await push(`Test OK — ${s.name}`, hits.length ? all : `aucun article pour l’instant (${seen.size} produits lus)`, s.link);

  // Products that disappeared from the lists are kept (a delisting during a drop must not re-trigger "new"),
  // but marked not orderable: many shops hide sold-out products, and the restock must alert again.
  // Only when every list was read, so a page that failed to load does not fake a sell-out.
  const gone = complete ? Object.fromEntries(Object.entries(known).filter(([id]) => !seen.has(id) && !ctx.unread.has(id)).map(([id, k]) => [id, { ...k, orderable: false }])) : {};
  const updated = hits.filter((p) => !failed.has(p.id)).map((p) => [p.id, { name: p.name, orderable: p.orderable, hidden: Boolean(p.hidden) }]);
  state[key] = {
    products: { ...known, ...gone, ...Object.fromEntries(updated) },
    empty,
    at: new Date().toISOString(),
  };
}

// ---------- one pass ----------
const watches = [
  ...(config.products ?? []).map((w) => ({ name: w.name, link: w.url, run: () => watchProduct(w) })),
  ...(config.searches ?? []).map((w) => ({ name: w.name, link: w.link, run: () => watchSearch(w) })),
];
// Start from a different watch each pass (every 10 min): when a pass runs out of time, it is not always
// the same last shops that get skipped.
const start = Math.floor(Date.now() / 600_000) % (watches.length || 1);
for (const w of [...watches.slice(start), ...watches.slice(0, start)]) {
  if (Date.now() > DEADLINE) {
    log(`⏱ plus de temps : ${w.name} et les suivantes au prochain passage`);
    break;
  }
  try {
    await w.run();
  } catch (e) {
    if (e instanceof Skip) {
      log(`⏭ ${w.name}: ${e.message} — on réessaie au prochain passage`);
      if (report) await push(`Test — ${w.name}`, `Page non lue : ${e.message}`, w.link);
    } else {
      // A bug or an unexpected answer (an HTML page instead of JSON…) in one shop must not stop the others.
      log(`❌ ${w.name}:`, e);
      process.exitCode = 1; // the run still shows as failed in Actions
      if (report) await push(`Test — ${w.name}`, `Erreur : ${e.message}`, w.link);
    }
  }
  // Saved after each watch: if the pass dies later (crash, job timeout), the alerts already sent are not sent again.
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}
