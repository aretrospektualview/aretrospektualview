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

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('session_id') || '';
  if (!/^cs_(live|test)_[A-Za-z0-9]{10,}$/.test(id)) {
    return json({ error: 'That order link is not valid.' }, 400);
  }
  if (!env.STRIPE_SECRET_KEY) return json({ error: 'Shop is not configured.' }, 503);

  let s;
  try {
    const r = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${id}?expand[]=line_items`,
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
  const shipCost = (s.shipping_cost && s.shipping_cost.amount_total) || 0;
  const pickup = shipCost === 0;
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
