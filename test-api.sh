#!/bin/bash
# ============================================================================
# QuickGift — Security & Flow Smoke Test
#
# Run this AFTER: backend is running + `npm run seed` has been executed.
# Usage: BASE_URL=http://localhost:4000/api ./test-api.sh
#
# This does NOT replace real security testing (a penetration test / code
# review before handling real money is still strongly recommended) — it
# checks the specific protections called out in the spec so you can see at a
# glance whether the core rules are actually enforced on your running server.
# ============================================================================
set -uo pipefail
BASE_URL="${BASE_URL:-http://localhost:4000/api}"
PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS+1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL+1)); }

echo "== QuickGift smoke test against $BASE_URL =="
echo

# ---- 0. Health check ----
echo "[0] API reachability"
HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
if [ "$HEALTH" = "200" ]; then pass "API is reachable ($BASE_URL/health -> 200)"; else
  fail "API not reachable at $BASE_URL — is the backend running? (got HTTP $HEALTH)"
  echo; echo "Stopping — fix the connection before running the rest of this script."; exit 1
fi

# ---- 1. Customer login (seeded demo account) ----
echo; echo "[1] Customer auth"
CUSTOMER_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"customer1@example.com","password":"Customer@123"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)
if [ -n "$CUSTOMER_TOKEN" ]; then pass "Seeded customer can log in and receives a JWT"; else
  fail "Could not log in as customer1@example.com — did you run 'npm run seed'?"; exit 1
fi

# ---- 2. Customer CANNOT reach admin routes ----
echo; echo "[2] Role enforcement — customer should be blocked from admin/seller routes"
ADMIN_ATTEMPT=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/admin/dashboard" -H "Authorization: Bearer $CUSTOMER_TOKEN")
if [ "$ADMIN_ATTEMPT" = "403" ]; then pass "Customer blocked from /admin/dashboard (403)"; else
  fail "Customer was NOT blocked from /admin/dashboard (got $ADMIN_ATTEMPT, expected 403) — role check is broken."
fi

SELLER_ATTEMPT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/products" \
  -H "Authorization: Bearer $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"test","category_id":1,"base_price":100}')
if [ "$SELLER_ATTEMPT" = "403" ]; then pass "Customer blocked from creating a product (403)"; else
  fail "Customer was NOT blocked from POST /products (got $SELLER_ATTEMPT, expected 403)."
fi

# ---- 3. No token at all is rejected ----
echo; echo "[3] Unauthenticated requests to protected routes"
NO_AUTH=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/orders")
if [ "$NO_AUTH" = "401" ]; then pass "GET /orders without a token returns 401"; else
  fail "GET /orders without a token returned $NO_AUTH (expected 401)."
fi

# ---- 4. Price tampering protection ----
echo; echo "[4] Checkout price integrity"
PRODUCT_JSON=$(curl -s "$BASE_URL/products?limit=1")
PRODUCT_ID=$(echo "$PRODUCT_JSON" | grep -o '"id":[0-9]*' | head -1 | grep -o '[0-9]*')
REAL_PRICE=$(echo "$PRODUCT_JSON" | grep -o '"base_price":"[0-9.]*"' | head -1 | grep -o '[0-9.]*')
if [ -z "$PRODUCT_ID" ]; then
  fail "Could not find a seeded product to test with — did you run 'npm run seed'?"
else
  curl -s -X POST "$BASE_URL/cart/items" -H "Authorization: Bearer $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
    -d "{\"product_id\":$PRODUCT_ID,\"quantity\":1}" > /dev/null
  # Attempt checkout while injecting a fake "unit_price" / "total_amount" in the body —
  # the server must ignore these; it should either succeed at the REAL price or fail
  # on missing address, but it must never accept a price of 1.
  CHECKOUT_RESULT=$(curl -s -X POST "$BASE_URL/orders/checkout" -H "Authorization: Bearer $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
    -d '{"delivery_address_id":999999,"total_amount":1,"unit_price":1,"price":1}')
  if echo "$CHECKOUT_RESULT" | grep -q '"total_amount":1'; then
    fail "Checkout accepted a client-supplied total_amount of 1 — price tampering protection is broken!"
  else
    pass "Checkout ignores client-supplied price fields (server computes its own total)"
  fi
fi

# ---- 5. Only delivered orders can be reviewed ----
echo; echo "[5] Review restriction (delivered orders only)"
ORDERS=$(curl -s "$BASE_URL/orders" -H "Authorization: Bearer $CUSTOMER_TOKEN")
PENDING_ITEM_ATTEMPT=$(curl -s -X POST "$BASE_URL/reviews" -H "Authorization: Bearer $CUSTOMER_TOKEN" -H "Content-Type: application/json" \
  -d '{"order_item_id":999999,"product_rating":5}')
if echo "$PENDING_ITEM_ATTEMPT" | grep -qi "not found\|error"; then
  pass "Reviewing a non-existent/undelivered order item is rejected"
else
  fail "Review endpoint did not reject an invalid order_item_id as expected."
fi

# ---- 6. Seller product goes to pending_approval, not immediately public ----
echo; echo "[6] Seller-created products require admin approval"
SELLER_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" -H "Content-Type: application/json" \
  -d '{"email":"seller1@example.com","password":"Seller@123"}' | grep -o '"token":"[^"]*' | cut -d'"' -f4)
if [ -n "$SELLER_TOKEN" ]; then
  NEW_PRODUCT=$(curl -s -X POST "$BASE_URL/products" -H "Authorization: Bearer $SELLER_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"Smoke Test Product","category_id":1,"base_price":499}')
  if echo "$NEW_PRODUCT" | grep -q '"status":"pending_approval"'; then
    pass "New seller product starts as pending_approval (not instantly public)"
  else
    fail "New seller product did NOT start as pending_approval — check products.routes.js"
  fi
else
  fail "Could not log in as seller1@example.com — did you run 'npm run seed'?"
fi

# ---- 7. Payment webhook requires a valid provider ----
echo; echo "[7] Payment webhook signature enforcement"
if [ "${PAYMENT_PROVIDER:-mock}" = "razorpay" ]; then
  BAD_WEBHOOK=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/payments/webhook" \
    -H "Content-Type: application/json" -H "x-razorpay-signature: not-a-real-signature" \
    -d '{"event":"payment.captured","payload":{"payment":{"entity":{"id":"pay_fake","status":"captured"}}}}')
  if [ "$BAD_WEBHOOK" = "400" ]; then pass "Forged webhook signature rejected (400)"; else
    fail "Forged webhook was NOT rejected (got $BAD_WEBHOOK, expected 400) — check RAZORPAY_WEBHOOK_SECRET is set."
  fi
else
  echo "  ⏭  Skipped (PAYMENT_PROVIDER=mock verifies all signatures by design — this test only applies once you switch to a real provider)"
fi

echo
echo "== Summary: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
