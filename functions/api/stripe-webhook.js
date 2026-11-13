/* ===========================================================================
   A Retrospektual View — order notification webhook
   Cloudflare Pages Function.

   Stripe calls this the moment an order is paid. It emails you a packing
   list so you can pull shirts without opening the dashboard.

   Needs these in Cloudflare (Settings -> Variables and Secrets):
     STRIPE_SECRET_KEY        your sk_live_ key            (Secret)
     STRIPE_WEBHOOK_SECRET    the whsec_ signing secret    (Secret)
     RESEND_API_KEY           your Resend key              (Secret)
     ORDER_EMAIL_TO           where packing lists go       (Text)
     ORDER_EMAIL_FROM         e.g. orders@aretrospektualview.com  (Text)

   SHOP-SETUP.txt walks through getting each one.
   =========================================================================== */

const ok   = () => new Response('ok', { status: 200 });
const bad  = (m, s = 400) => new Response(m, { status: s });

/* ------------------------------------------------- Stripe signature check */

/* Stripe signs every webhook. Without this check anyone who found the URL
   could post fake orders at it, so we verify before trusting anything. */
async function verify(rawBody, header, secret) {
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(',').map(p => {
      const i = p.indexOf('=');
      return [p.slice(0, i), p.slice(i + 1)];
    })
  );
  const t = parts.t;
  const sig = parts.v1;
  if (!t || !sig) return false;

  // reject anything older than 5 minutes (replay protection)
  const age = Math.abs(Date.now() / 1000 - Number(t));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${t}.${rawBody}`)
  );
  const expected = [...new Uint8Array(mac)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // constant-time compare
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

/* ----------------------------------------------------------------- helpers */

const money = c => '$' + (c / 100).toFixed(2);

function addressLines(addr, name) {
  if (!addr) return ['(no shipping address — this may be a pickup order)'];
  return [
    name || '',
    addr.line1 || '',
    addr.line2 || '',
    [addr.city, addr.state, addr.postal_code].filter(Boolean).join(', '),
  ].filter(Boolean);
}

async function sendMail(env, { to, subject, text }) {
  if (!env.RESEND_API_KEY || !env.ORDER_EMAIL_FROM) {
    console.error('Email not configured: RESEND_API_KEY or ORDER_EMAIL_FROM missing');
    return false;
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `A Retrospektual View <${env.ORDER_EMAIL_FROM}>`,
      to: [to],
      subject,
      text,
    }),
  });
  if (!r.ok) console.error('Resend error', r.status, await r.text());
  return r.ok;
}

/* -------------------------------------------------------------------- POST */

export async function onRequestPost({ request, env }) {
  const raw = await request.text();

  const good = await verify(
    raw,
    request.headers.get('stripe-signature'),
    env.STRIPE_WEBHOOK_SECRET || ''
  );
  if (!good) return bad('bad signature', 400);

  let event;
  try { event = JSON.parse(raw); } catch { return bad('bad json'); }

  if (event.type !== 'checkout.session.completed') return ok();

  const sessionId = event.data && event.data.object && event.data.object.id;
  if (!sessionId) return ok();

  // Re-fetch the session so we get the line items, which the event omits.
  let s;
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items`,
      { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    s = await r.json();
    if (!r.ok) throw new Error('fetch failed');
  } catch (e) {
    console.error('Could not load session', sessionId, e);
    return ok(); // tell Stripe we got it; retrying would not help
  }

  const cust = s.customer_details || {};
  const ship =
    (s.collected_information && s.collected_information.shipping_details) ||
    s.shipping_details ||
    null;

  const items = ((s.line_items && s.line_items.data) || [])
    .map(li => `  ${li.quantity} x ${li.description}   ${money(li.amount_total)}`)
    .join('\n');

  const shippingLine =
    s.shipping_cost && s.shipping_cost.amount_total === 0
      ? 'LOCAL PICKUP — do not ship'
      : `Shipping: ${money((s.shipping_cost && s.shipping_cost.amount_total) || 0)}`;

  const text = [
    `New merch order — ${money(s.amount_total)}`,
    '',
    'ITEMS',
    items || '  (none listed)',
    '',
    shippingLine,
    `Total paid: ${money(s.amount_total)}`,
    '',
    'SHIP TO',
    ...addressLines(ship && ship.address, (ship && ship.name) || cust.name).map(l => '  ' + l),
    '',
    'CUSTOMER',
    `  ${cust.email || '(no email)'}`,
    `  ${cust.phone || '(no phone)'}`,
    '',
    `Mark it shipped: https://aretrospektualview.com/admin/`,
    `View in Stripe:  https://dashboard.stripe.com/payments/${s.payment_intent || ''}`,
  ].join('\n');

  await sendMail(env, {
    to: env.ORDER_EMAIL_TO || env.ORDER_EMAIL_FROM,
    subject: `Order — ${money(s.amount_total)} — ${(ship && ship.name) || cust.name || 'customer'}`,
    text,
  });

  return ok();
}
