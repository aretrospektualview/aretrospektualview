/* A Retrospektual View — shop front end.
   Prices shown here are for display only; the server recalculates every
   amount at checkout, so editing anything in the browser changes nothing. */
(function () {
  'use strict';

  var API = '/api/shop';
  var STORE = 'arv-cart-v1';

  var grid     = document.getElementById('shop-grid');
  var notice   = document.getElementById('shop-notice');
  var cartEl   = document.getElementById('cart');
  var cartList = document.getElementById('cart-list');
  var cartCount= document.getElementById('cart-count');
  var cartTotal= document.getElementById('cart-total');
  var toggle   = document.getElementById('cart-toggle');
  var checkout = document.getElementById('cart-checkout');

  if (!grid) return;

  var catalog = null;
  var cart = load();

  /* ------------------------------------------------------------ storage */

  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      var val = raw ? JSON.parse(raw) : [];
      return Array.isArray(val) ? val : [];
    } catch (e) { return []; }
  }
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(cart)); } catch (e) {}
  }

  /* ------------------------------------------------------------ helpers */

  function money(cents) {
    return '$' + (cents / 100).toFixed(2);
  }
  function sizeAdd(id) {
    var s = catalog.sizes.filter(function (x) { return x.id === id; })[0];
    return s ? s.add : 0;
  }
  function designName(id) {
    var d = catalog.designs.filter(function (x) { return x.id === id; })[0];
    return d ? d.name : id;
  }
  function linePrice(item) {
    return (catalog.base_price + sizeAdd(item.size)) * item.qty;
  }
  function say(msg, kind) {
    notice.textContent = msg;
    notice.className = 'shop__notice' + (kind ? ' shop__notice--' + kind : '');
    notice.hidden = false;
  }

  /* ------------------------------------------------------------ catalog */

  fetch(API, { headers: { accept: 'application/json' } })
    .then(function (r) {
      if (!r.ok) throw new Error('bad status');
      return r.json();
    })
    .then(function (data) {
      catalog = data;
      renderGrid();
      renderCart();
    })
    .catch(function () {
      grid.innerHTML = '';
      say(
        'The online shop is temporarily unavailable. Call or text 832-799-9733 and ' +
        'we’ll take your order directly.',
        'warn'
      );
    });

  function renderGrid() {
    grid.innerHTML = '';
    catalog.designs.forEach(function (d) {
      var card = document.createElement('div');
      card.className = 'shirt' + (d.sold_out ? ' shirt--out' : '');

      var fig = document.createElement('div');
      fig.className = 'shirt__pic';
      var img = document.createElement('img');
      img.alt = d.name + ' t-shirt';
      img.loading = 'lazy';
      // listener first: a fast failure can fire before src is even assigned
      img.addEventListener('error', function () {
        fig.classList.add('shirt__pic--empty');
        img.remove();
      });
      img.src = d.image;
      fig.appendChild(img);

      var name = document.createElement('h3');
      name.className = 'shirt__name';
      name.textContent = d.name;

      var price = document.createElement('p');
      price.className = 'shirt__price';
      price.textContent = money(catalog.base_price);

      card.appendChild(fig);
      card.appendChild(name);
      card.appendChild(price);

      if (d.sold_out) {
        var out = document.createElement('p');
        out.className = 'shirt__flag';
        out.textContent = 'Sold out';
        card.appendChild(out);
        grid.appendChild(card);
        return;
      }

      var row = document.createElement('div');
      row.className = 'shirt__row';

      var sel = document.createElement('select');
      sel.className = 'shirt__size';
      sel.setAttribute('aria-label', 'Size for ' + d.name);
      catalog.sizes.forEach(function (s) {
        var o = document.createElement('option');
        o.value = s.id;
        o.textContent = s.id + (s.add ? '  +' + money(s.add) : '');
        sel.appendChild(o);
      });

      var add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn shirt__add';
      add.textContent = 'Add';
      add.addEventListener('click', function () {
        addToCart(d.id, sel.value);
        add.textContent = 'Added';
        setTimeout(function () { add.textContent = 'Add'; }, 1200);
      });

      row.appendChild(sel);
      row.appendChild(add);
      card.appendChild(row);
      grid.appendChild(card);
    });
  }

  /* --------------------------------------------------------------- cart */

  function addToCart(id, size) {
    var found = cart.filter(function (i) { return i.id === id && i.size === size; })[0];
    if (found) { found.qty = Math.min(found.qty + 1, 50); }
    else { cart.push({ id: id, size: size, qty: 1 }); }
    save();
    renderCart();
  }

  function setQty(i, qty) {
    if (qty < 1) { cart.splice(i, 1); }
    else { cart[i].qty = Math.min(qty, 50); }
    save();
    renderCart();
  }

  function renderCart() {
    if (!catalog) return;

    if (!cart.length) {
      cartEl.hidden = true;
      cartList.innerHTML = '';
      document.body.classList.remove('has-cart');
      return;
    }
    cartEl.hidden = false;
    document.body.classList.add('has-cart');

    var count = 0, total = 0;
    cartList.innerHTML = '';

    cart.forEach(function (item, i) {
      count += item.qty;
      total += linePrice(item);

      var li = document.createElement('li');
      li.className = 'cart__item';

      var label = document.createElement('span');
      label.className = 'cart__label';
      label.textContent = designName(item.id) + ' — ' + item.size;

      var qty = document.createElement('span');
      qty.className = 'cart__qty';

      var minus = document.createElement('button');
      minus.type = 'button';
      minus.textContent = '−';
      minus.setAttribute('aria-label', 'Remove one ' + designName(item.id));
      minus.addEventListener('click', function () { setQty(i, item.qty - 1); });

      var n = document.createElement('span');
      n.textContent = item.qty;

      var plus = document.createElement('button');
      plus.type = 'button';
      plus.textContent = '+';
      plus.setAttribute('aria-label', 'Add one ' + designName(item.id));
      plus.addEventListener('click', function () { setQty(i, item.qty + 1); });

      qty.appendChild(minus); qty.appendChild(n); qty.appendChild(plus);

      var sum = document.createElement('span');
      sum.className = 'cart__line';
      sum.textContent = money(linePrice(item));

      li.appendChild(label); li.appendChild(qty); li.appendChild(sum);
      cartList.appendChild(li);
    });

    cartCount.textContent = count + (count === 1 ? ' item' : ' items');
    cartTotal.textContent = money(total);
  }

  toggle.addEventListener('click', function () {
    var open = cartList.hidden;
    cartList.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
  });

  checkout.addEventListener('click', function () {
    if (!cart.length) return;
    checkout.disabled = true;
    checkout.textContent = 'Starting checkout…';

    fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: cart }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (res.ok && res.d.url) { window.location.href = res.d.url; return; }
        throw new Error(res.d && res.d.error ? res.d.error : 'Checkout failed.');
      })
      .catch(function (err) {
        say(err.message || 'Checkout could not be started. Please call 832-799-9733.', 'warn');
        checkout.disabled = false;
        checkout.textContent = 'Check out';
        document.getElementById('shop').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
  });

  /* ------------------------------------------------- returning from Stripe */

  var params = new URLSearchParams(window.location.search);
  if (params.get('order') === 'thanks') {
    cart = [];
    save();
    say('Thank you — your order is in. A receipt is on its way to your email.', 'good');
  } else if (params.get('order') === 'cancelled') {
    say('Checkout was cancelled. Your cart is still here whenever you’re ready.');
  }
})();
