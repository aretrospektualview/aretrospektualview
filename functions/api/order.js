/* ===========================================================================
   A Retrospektual View — order lookup for the thank-you page
   Cloudflare Pages Function:  GET /api/order?session_id=cs_...

   After paying, Stripe sends the customer to /order/?session_id=...
   The thank-you page calls this to show the order number and what was bought.
   The session id is a long random value only the buyer has, the same way
   Stripe's own receipt links work. Nothing is returned for unpaid sessions.

   Needs: STRIPE_SECRET_KEY (already set for the shop).
   =========================================================================== */

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

// Same rule everywhere: ARV- plus the last 8 characters of the Stripe payment.
const orderNumber = pi =>
  pi ? 'ARV-' + String(pi).slice(-8).toUpperCase() : '';


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

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_(live|test)_[A-Za-z0-9]{10,}$/.test(id)) {
    return json({ error: 'That order link is not valid.' }, 400);
  }
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Shop is not configured.' }, 503);

  let s;
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${id}?expand[]=line_items&expand[]=shipping_cost.shipping_rate`,
      { headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    s = await r.json();
    if (!r.ok) return json({ error: 'We could not find that order.' }, 404);
  } catch {
    return json({ error: 'Could not reach the order system. Please refresh in a moment.' }, 502);
  }

  if (s.payment_status !== 'paid') {
    return json({ error: 'This order has not been paid.' }, 404);
  }

  const cust = s.customer_details || {};
  const ship =
    (s.collected_information && s.collected_information.shipping_details) ||
    s.shipping_details ||
    null;
  const { cost: shipCost, pickup } = shippingInfo(s);
  const a = ship && ship.address;

  return json({
    order_number: orderNumber(s.payment_intent),
    created: s.created,
    first_name: ((ship && ship.name) || cust.name || '').split(' ')[0],
    email: cust.email || '',
    pickup,
    items: ((s.line_items && s.line_items.data) || []).map(li => ({
      qty: li.quantity,
      name: li.description,
      amount: li.amount_total,
    })),
    subtotal: s.amount_subtotal,
    shipping: shipCost,
    total: s.amount_total,
    ship_to: !pickup && a
      ? [
          ship.name || '',
          a.line1 || '',
          a.line2 || '',
          [a.city, a.state].filter(Boolean).join(', ') + (a.postal_code ? ' ' + a.postal_code : ''),
        ].filter(Boolean)
      : [],
  });
}
