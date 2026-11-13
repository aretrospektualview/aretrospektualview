/* ===========================================================================
   A Retrospektual View — order notification webhook
   Cloudflare Pages Function.

   Stripe calls this the moment an order is paid. It emails you a packing
   list so you can pull shirts without opening the dashboard, and emails the
   customer a branded order confirmation with their order number.

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

const orderNumber = pi => (pi ? 'ARV-' + String(pi).slice(-8).toUpperCase() : '');

const esc = v =>
  String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SITE = 'https://aretrospektualview.com';

/* Branded order confirmation. Table layout + inline styles because email apps
   (Gmail, Outlook, iPhone Mail) ignore most modern CSS. */
function confirmationHtml({ number, firstName, items, subtotal, shipping, total, pickup, shipTo, email }) {
  const rows = items.map(it => `
        <tr>
          <td style="padding:12px 0;border-bottom:1px solid #E6E0D4;width:72px;vertical-align:top;">
            ${it.image ? `<img src="${esc(it.image)}" width="60" height="60" alt="" style="display:block;border-radius:4px;background:#ffffff;">` : ''}
          </td>
          <td style="padding:12px 12px;border-bottom:1px solid #E6E0D4;font-size:15px;line-height:1.4;color:#1A1714;vertical-align:top;">
            ${esc(it.name)}<br><span style="color:#7A7268;font-size:13px;">Qty ${it.qty}</span>
          </td>
          <td align="right" style="padding:12px 0;border-bottom:1px solid #E6E0D4;font-size:15px;color:#1A1714;vertical-align:top;white-space:nowrap;">
            ${money(it.amount)}
          </td>
        </tr>`).join('');

  const delivery = pickup
    ? `<p style="margin:0;font-size:15px;line-height:1.5;color:#1A1714;"><strong>Local pickup in Rosharon.</strong><br>We'll text or email you when your order is ready to pick up.</p>`
    : `<p style="margin:0 0 6px;font-size:13px;color:#7A7268;">Shipping to</p>
       <p style="margin:0;font-size:15px;line-height:1.5;color:#1A1714;">${shipTo.map(esc).join('<br>')}</p>
       <p style="margin:10px 0 0;font-size:13px;line-height:1.5;color:#7A7268;">We'll email your tracking number as soon as it ships.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Order ${esc(number)} confirmed</title></head>
<body style="margin:0;padding:0;background:#F2EEE6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2EEE6;">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:6px;overflow:hidden;">
      <tr><td align="center" style="background:#0E0D0C;padding:28px 24px 22px;">
        <a href="${SITE}"><img src="${SITE}/assets/img/email-logo.png" width="180" alt="A Retrospektual View" style="display:block;width:180px;height:auto;border:0;"></a>
      </td></tr>
      <tr><td style="height:4px;background:#C1272D;font-size:0;line-height:0;">&nbsp;</td></tr>
      <tr><td style="padding:32px 28px 8px;">
        <h1 style="margin:0 0 8px;font-size:24px;line-height:1.25;color:#1A1714;">Thanks${firstName ? ', ' + esc(firstName) : ''}. Your order is in.</h1>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:#4A443D;">We've received your payment and we're getting your shirts ready.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="background:#F7F4EE;border-left:3px solid #C9A227;width:100%;">
          <tr><td style="padding:14px 16px;">
            <span style="display:block;font-size:13px;color:#7A7268;">Order number</span>
            <span style="display:block;font-size:22px;font-weight:700;letter-spacing:.04em;color:#1A1714;">${esc(number)}</span>
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:20px 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${rows}
          <tr><td></td><td style="padding:12px 12px 4px;font-size:14px;color:#4A443D;">Subtotal</td>
              <td align="right" style="padding:12px 0 4px;font-size:14px;color:#4A443D;">${money(subtotal)}</td></tr>
          <tr><td></td><td style="padding:4px 12px;font-size:14px;color:#4A443D;">${pickup ? 'Local pickup' : 'Shipping'}</td>
              <td align="right" style="padding:4px 0;font-size:14px;color:#4A443D;">${shipping ? money(shipping) : 'Free'}</td></tr>
          <tr><td></td><td style="padding:8px 12px 0;font-size:16px;font-weight:700;color:#1A1714;">Total paid</td>
              <td align="right" style="padding:8px 0 0;font-size:16px;font-weight:700;color:#1A1714;">${money(total)}</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:28px 28px 8px;">${delivery}</td></tr>
      <tr><td style="padding:24px 28px 32px;">
        <p style="margin:0;font-size:14px;line-height:1.6;color:#4A443D;">Questions about your order? Reply to this email or call
          <a href="tel:+18327999733" style="color:#C1272D;text-decoration:none;">832-799-9733</a>. Mention order <strong>${esc(number)}</strong>.</p>
      </td></tr>
      <tr><td style="background:#0E0D0C;padding:20px 28px;">
        <p style="margin:0;font-size:12px;line-height:1.6;color:#A9A196;">A Retrospektual View &middot; Rosharon, Texas<br>
          <a href="${SITE}/shop/" style="color:#E0BC4A;text-decoration:none;">Merchandise Shop</a> &nbsp; 
          <a href="${SITE}/privacy/" style="color:#A9A196;">Privacy policy</a></p>
        <p style="margin:8px 0 0;font-size:12px;color:#7A7268;">This receipt was sent to ${esc(email)}.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendMail(env, { to, subject, text, html }) {
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
      // Customer replies land in your real inbox, not the send-only address.
      reply_to: env.ORDER_EMAIL_TO || undefined,
      subject,
      text,
      html: html || undefined,
    }),
  });
  if (!r.ok) console.error('Resend error', r.status, await r.text());
  return r.ok;
}


/* Shipping vs. pickup. Decided by the name of the option the customer picked
   (expanded from Stripe), then by the amount charged. Missing data never
   counts as pickup, so a shipped order can't be mislabeled. */
function shippingInfo(s) {
  const sc = s.shipping_cost || null;
  const rate = sc && sc.shipping_rate && typeof sc.shipping_rate === 'object' ? sc.shipping_rate : null;
  let cost;
  if (sc && Number.isFinite(sc.amount_total)) cost = sc.amount_total;
  else if (s.total_details && Number.isFinite(s.total_details.amount_shipping)) cost = s.total_details.amount_shipping;
  else cost = Math.max(0, (s.amount_total || 0) - (s.amount_subtotal || 0));
  const pickup = rate && rate.display_name ? /pickup/i.test(rate.display_name) : cost === 0 && !!sc;
  return { cost, pickup };
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
      `https://api.stripe.com/v1/checkout/sessions/${sessionId}?expand[]=line_items&expand[]=line_items.data.price.product&expand[]=shipping_cost.shipping_rate`,
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

  const shipInfo = shippingInfo(s);
  const shippingLine = shipInfo.pickup
    ? 'LOCAL PICKUP — do not ship'
    : `Shipping: ${money(shipInfo.cost)}`;

  const number = orderNumber(s.payment_intent);

  const text = [
    `New merch order ${number} — ${money(s.amount_total)}`,
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
    subject: `Order ${number} — ${money(s.amount_total)} — ${(ship && ship.name) || cust.name || 'customer'}`,
    text,
  });

  /* ------------------------------------------- customer confirmation email */
  if (cust.email) {
    const lineItems = (s.line_items && s.line_items.data) || [];
    const { cost: shipCost, pickup } = shipInfo;
    const a = ship && ship.address;
    const shipTo = !pickup && a
      ? [
          (ship && ship.name) || cust.name || '',
          a.line1 || '',
          a.line2 || '',
          [a.city, a.state].filter(Boolean).join(', ') + (a.postal_code ? ' ' + a.postal_code : ''),
        ].filter(Boolean)
      : [];
    const items = lineItems.map(li => {
      const prod = li.price && typeof li.price.product === 'object' ? li.price.product : null;
      return {
        qty: li.quantity,
        name: li.description,
        amount: li.amount_total,
        image: prod && prod.images && prod.images[0],
      };
    });
    const firstName = ((ship && ship.name) || cust.name || '').split(' ')[0];

    const custText = [
      `Thanks${firstName ? ', ' + firstName : ''}. Your order is in.`,
      '',
      `Order number: ${number}`,
      '',
      ...items.map(it => `${it.qty} x ${it.name}   ${money(it.amount)}`),
      '',
      `Subtotal: ${money(s.amount_subtotal)}`,
      `${pickup ? 'Local pickup' : 'Shipping'}: ${shipCost ? money(shipCost) : 'Free'}`,
      `Total paid: ${money(s.amount_total)}`,
      '',
      pickup
        ? "Local pickup in Rosharon. We'll text or email you when it's ready."
        : ['Shipping to:', ...shipTo, '', "We'll email your tracking number as soon as it ships."].join('\n'),
      '',
      `Questions? Reply to this email or call 832-799-9733 and mention order ${number}.`,
      '',
      'A Retrospektual View',
    ].join('\n');

    await sendMail(env, {
      to: cust.email,
      subject: `Order ${number} confirmed — A Retrospektual View`,
      text: custText,
      html: confirmationHtml({
        number,
        firstName,
        items,
        subtotal: s.amount_subtotal,
        shipping: shipCost,
        total: s.amount_total,
        pickup,
        shipTo,
        email: cust.email,
      }),
    });
  }

  return ok();
}
