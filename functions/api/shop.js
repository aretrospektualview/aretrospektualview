/* ===========================================================================
   A Retrospektual View — shop API
   Cloudflare Pages Function. Runs on the server, not in the browser.

   GET  /api/shop   -> the catalog, for the page to render
   POST /api/shop   -> creates a Stripe Checkout Session, returns its URL

   WHY PRICES LIVE HERE: the browser only ever sends design ids, sizes and
   quantities. Every dollar amount is calculated on this side, so nobody can
   edit a price in their browser and check out for a dollar.

   ---------------------------------------------------------------------------
   TO EDIT YOUR SHIRTS: change the DESIGNS list below. Nothing else.
   - id    : lowercase, no spaces. Also the image filename.
   - name  : what customers see.
   - image : /assets/img/shirts/<id>.jpg   (put the photo there)
   - sold_out : add  sold_out: true  to hide the buy button for one design.
   =========================================================================== */

const BASE_PRICE = 3000; // $30.00, in cents

const SIZES = [
  { id: 'S',   add: 0   },
  { id: 'M',   add: 0   },
  { id: 'L',   add: 0   },
  { id: 'XL',  add: 0   },
  { id: '2XL', add: 300 }, // +$3
  { id: '3XL', add: 500 }, // +$5
  { id: '4XL', add: 500 },
  { id: '5XL', add: 500 },
];

const DESIGNS = [
  { id: 'arv-script-tee',                        name: 'A Retrospektual View Script Tee' },
  { id: 'joes-house-music-studio-tee',           name: "Joe's House Music Studio Tee" },
  { id: 'its-so-simple-tee',                     name: "It's So Simple" },
  { id: 'peace-of-mind-tee',                     name: "Can't Put a Price Tag on a Peace of Mind" },
  { id: 'conversation-before-confrontation-tee', name: "It's a Conversation Before It's a Confrontation" },
  { id: 'things-to-see-people-to-do-tee',        name: 'Got Things to See and People to Do' },
  { id: 'where-ya-heart-at-tee',                 name: 'Where Ya Heart At?' },
  { id: 'licky-licky-sticky-sticky-tee',         name: 'Licky Licky Sticky Sticky' },
  { id: '416-joe-lee-rd-tee',                    name: '416 Joe Lee Rd' },
];

/* Shipping is priced by how many shirts are in the order, because shirt
   weight is predictable: roughly 6-7 oz each plus the mailer. Edit the cents
   values to change what you charge. "upTo" is the shirt count for that tier. */
const SHIPPING_TIERS = [
  { upTo: 2,        cents: 600,  label: 'Standard shipping' },
  { upTo: 5,        cents: 900,  label: 'Standard shipping' },
  { upTo: 11,       cents: 1300, label: 'Standard shipping' },
  { upTo: Infinity, cents: 1800, label: 'Standard shipping' },
];
const PICKUP_LABEL = 'Local pickup — Rosharon, TX';
const MAX_QTY      = 50;             // per line, sanity cap

/* Set to true to also generate an itemized PDF invoice for every order.
   Stripe charges a separate fee per invoice, so this is off by default.
   The normal receipt already lists what was bought. */
const CREATE_INVOICES = false;

/* ---------------------------------------------------------------- helpers */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

function catalog() {
  return {
    base_price: BASE_PRICE,
    sizes: SIZES.map(s => ({ id: s.id, add: s.add })),
    designs: DESIGNS.map(d => ({
      id: d.id,
      name: d.name,
      image: d.image || `/assets/img/shirts/${d.id}.jpg`,
      sold_out: !!d.sold_out,
    })),
  };
}

// Stripe's API takes form-encoded bodies with bracketed nested keys.
function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) =>
        typeof item === 'object'
          ? formEncode(item, `${key}[${i}]`, out)
          : out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`)
      );
    } else if (typeof v === 'object') {
      formEncode(v, key, out);
    } else {
      out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  return out.join('&');
}

/* -------------------------------------------------------------------- GET */

export const onRequestGet = () => json(catalog());

/* ------------------------------------------------------------------- POST */

export async function onRequestPost({ request, env }) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key) {
    return json(
      { error: 'The shop is not finished being set up yet. Please call or text 832-799-9733 to order.' },
      503
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Could not read your cart. Please try again.' }, 400);
  }

  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return json({ error: 'Your cart is empty.' }, 400);
  if (items.length > 20) return json({ error: 'Too many items in one order. Please split it or call us.' }, 400);

  // Rebuild every line from our own data. Nothing priced by the browser.
  const line_items = [];
  for (const raw of items) {
    const design = DESIGNS.find(d => d.id === raw.id);
    const size = SIZES.find(s => s.id === raw.size);
    const qty = Math.floor(Number(raw.qty));

    if (!design) return json({ error: 'One of those shirts is no longer available.' }, 400);
    if (design.sold_out) return json({ error: `${design.name} is sold out.` }, 400);
    if (!size) return json({ error: 'Please pick a size for every shirt.' }, 400);
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) {
      return json({ error: 'That quantity is not valid.' }, 400);
    }

    line_items.push({
      quantity: qty,
      price_data: {
        currency: 'usd',
        unit_amount: BASE_PRICE + size.add,
        product_data: {
          name: `${design.name} — ${size.id}`,
          images: [new URL(design.image || `/assets/img/shirts/${design.id}.jpg`, request.url).href],
        },
      },
    });
  }

  const origin = new URL(request.url).origin;

  // total shirts decides the shipping tier
  const totalShirts = line_items.reduce((n, li) => n + li.quantity, 0);
  const tier = SHIPPING_TIERS.find(t => totalShirts <= t.upTo) ||
               SHIPPING_TIERS[SHIPPING_TIERS.length - 1];

  // a one-line packing summary, visible on the payment in your Stripe dashboard
  const summary = line_items
    .map(li => `${li.quantity}x ${li.price_data.product_data.name}`)
    .join(' | ')
    .slice(0, 480);

  const payload = {
    mode: 'payment',
    line_items,
    // {CHECKOUT_SESSION_ID} is filled in by Stripe, so the thank-you page can look the order up.
    success_url: `${origin}/order/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/shop/?order=cancelled`,
    billing_address_collection: 'required',
    phone_number_collection: { enabled: true },
    shipping_address_collection: { allowed_countries: ['US'] },
    metadata: { order_summary: summary, shirt_count: String(totalShirts) },
    payment_intent_data: {
      description: `Merch order — ${totalShirts} shirt${totalShirts === 1 ? '' : 's'}`,
      metadata: { order_summary: summary, shirt_count: String(totalShirts) },
    },
    shipping_options: [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: tier.label,
          fixed_amount: { amount: tier.cents, currency: 'usd' },
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 3 },
            maximum: { unit: 'business_day', value: 7 },
          },
        },
      },
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: PICKUP_LABEL,
          fixed_amount: { amount: 0, currency: 'usd' },
        },
      },
    ],
  };

  if (CREATE_INVOICES) payload.invoice_creation = { enabled: true };

  let res, data;
  try {
    res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: formEncode(payload),
    });
    data = await res.json();
  } catch {
    return json({ error: 'Could not reach checkout. Please try again in a moment.' }, 502);
  }

  if (!res.ok || !data.url) {
    // Log the real reason for the site owner; show the customer something plain.
    console.error('Stripe error', res.status, data && data.error);
    return json(
      { error: 'Checkout could not be started. Please try again, or call 832-799-9733.' },
      502
    );
  }

  return json({ url: data.url });
}
