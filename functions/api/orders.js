/* ===========================================================================
   A Retrospektual View — orders API (admin only)

   GET  /api/orders   -> recent paid orders, newest first
   POST /api/orders   -> save a tracking number, mark shipped, email customer

   Both require the admin password. There is no customer-facing route here.

   Needs in Cloudflare:
     STRIPE_SECRET_KEY   (Secret)
     ADMIN_PASSWORD      (Secret)  the password for /admin/
     RESEND_API_KEY      (Secret)
     ORDER_EMAIL_FROM    (Text)
   =========================================================================== */

const json = (d, s = 200) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

const money = c => '$' + (c / 100).toFixed(2);

/* Carriers offered in the admin dropdown, with their public tracking pages. */
const CARRIERS = {
  usps:   { name: 'USPS',   url: n => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}` },
  ups:    { name: 'UPS',    url: n => `https://www.ups.com/track?tracknum=${n}` },
  fedex:  { name: 'FedEx',  url: n => `https://www.fedex.com/fedextrack/?trknbr=${n}` },
  dhl:    { name: 'DHL',    url: n => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${n}` },
  other:  { name: 'Carrier', url: () => '' },
};

/* ------------------------------------------------------------------- auth */

function authed(request, env) {
  const given = request.headers.get('x-admin-key') || '';
  const want = env.ADMIN_PASSWORD || '';
  if (!want || !given) return false;
  if (given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function formEncode(obj, prefix = '', out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object' && !Array.isArray(v)) formEncode(v, key, out);
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return out.join('&');
}

async function stripe(env, path, opts = {}) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(opts.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(opts.headers || {}),
    },
  });
  const data = await r.json();
  if (!r.ok) {
    console.error('Stripe', path, r.status, data && data.error);
    throw new Error((data && data.error && data.error.message) || 'Stripe request failed');
  }
  return data;
}

async function sendMail(env, { to, subject, text }) {
  if (!env.RESEND_API_KEY || !env.ORDER_EMAIL_FROM) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `A Retrospektual View <${env.ORDER_EMAIL_FROM}>`,
      to: [to],
      // Customer replies go to your real inbox, not the send-only address.
      reply_to: env.ORDER_EMAIL_TO || undefined,
      subject,
      text,
    }),
  });
  if (!r.ok) console.error('Resend', r.status, await r.text());
  return r.ok;
}

/* --------------------------------------------------------------- GET list */

const orderNumber = pi => (pi ? 'ARV-' + String(pi).slice(-8).toUpperCase() : '');

export async function onRequestGet({ request, env }) {
  if (!authed(request, env)) return json({ error: 'Not authorised.' }, 401);
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Stripe key not set.' }, 503);

  let data;
  try {
    data = await stripe(
      env,
      'checkout/sessions?limit=40&expand[]=data.line_items&expand[]=data.payment_intent'
    );
  } catch (e) {
    return json({ error: e.message }, 502);
  }

  const orders = (data.data || [])
    .filter(s => s.payment_status === 'paid')
    .map(s => {
      const pi = s.payment_intent && typeof s.payment_intent === 'object' ? s.payment_intent : null;
      const meta = (pi && pi.metadata) || {};
      const cust = s.customer_details || {};
      const ship =
        (s.collected_information && s.collected_information.shipping_details) ||
        s.shipping_details ||
        null;
      const pickup = !!(s.shipping_cost && s.shipping_cost.amount_total === 0);

      return {
        id: s.id,
        payment_intent: pi ? pi.id : s.payment_intent || null,
        order_number: orderNumber(pi ? pi.id : s.payment_intent),
        created: s.created,
        total: s.amount_total,
        pickup,
        shipping_cost: (s.shipping_cost && s.shipping_cost.amount_total) || 0,
        items: ((s.line_items && s.line_items.data) || []).map(li => ({
          qty: li.quantity,
          name: li.description,
        })),
        customer: {
          name: (ship && ship.name) || cust.name || '',
          email: cust.email || '',
          phone: cust.phone || '',
        },
        address: (ship && ship.address) || null,
        shipped_at: meta.shipped_at || null,
        tracking_number: meta.tracking_number || null,
        carrier: meta.carrier || null,
      };
    });

  return json({ orders });
}

/* ----------------------------------------------------- POST mark as shipped */

export async function onRequestPost({ request, env }) {
  if (!authed(request, env)) return json({ error: 'Not authorised.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request.' }, 400); }

  const { payment_intent, carrier, tracking_number, notify } = body;
  const car = CARRIERS[carrier] || CARRIERS.other;
  const num = String(tracking_number || '').trim();

  if (!payment_intent) return json({ error: 'Missing order reference.' }, 400);
  if (!num) return json({ error: 'Enter a tracking number.' }, 400);
  if (num.length > 60) return json({ error: 'That tracking number looks too long.' }, 400);

  // Read the order so the email can name what shipped, and so we keep the
  // existing shipping name/address when we write tracking onto it.
  let pi;
  try { pi = await stripe(env, `payment_intents/${encodeURIComponent(payment_intent)}`); }
  catch (e) { return json({ error: e.message }, 502); }

  const shipping = pi.shipping || {};
  const update = {
    metadata: {
      ...(pi.metadata || {}),
      carrier: car.name,
      tracking_number: num,
      shipped_at: new Date().toISOString(),
    },
  };
  // Stripe needs name + address alongside carrier/tracking on the shipping object.
  if (shipping.name && shipping.address) {
    update.shipping = {
      name: shipping.name,
      phone: shipping.phone,
      address: {
        line1: shipping.address.line1,
        line2: shipping.address.line2,
        city: shipping.address.city,
        state: shipping.address.state,
        postal_code: shipping.address.postal_code,
        country: shipping.address.country,
      },
      carrier: car.name,
      tracking_number: num,
    };
  }

  try {
    await stripe(env, `payment_intents/${encodeURIComponent(payment_intent)}`, {
      method: 'POST',
      body: formEncode(update),
    });
  } catch (e) {
    return json({ error: e.message }, 502);
  }

  // Email the customer
  let emailed = false;
  const to = body.email;
  if (notify !== false && to) {
    const link = car.url(encodeURIComponent(num));
    const text = [
      `Your order ${orderNumber(payment_intent)} has shipped.`,
      '',
      `Carrier: ${car.name}`,
      `Tracking number: ${num}`,
      ...(link ? ['', `Track it here:`, link] : []),
      '',
      `Tracking can take up to 24 hours to start updating after a label is created.`,
      '',
      `Questions? Reply to this email or call 832-799-9733.`,
      '',
      `Thanks for the support.`,
      `A Retrospektual View`,
    ].join('\n');

    emailed = await sendMail(env, {
      to,
      subject: `Order ${orderNumber(payment_intent)} has shipped — A Retrospektual View`,
      text,
    });
  }

  return json({ ok: true, emailed, carrier: car.name, tracking_number: num });
}
