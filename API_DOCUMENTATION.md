# QuickGift API Documentation

Base URL (local): `http://localhost:4000/api`

All authenticated routes require `Authorization: Bearer <JWT>`. Get a token from
`/auth/login`, `/auth/register`, or `/auth/otp/verify`.

Role names used below: `customer`, `seller`, `admin`, `super_admin`, `ops_manager`,
`support_agent`, `finance_manager`.

---

## Auth — `/api/auth`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | – | Create a customer account |
| POST | `/login` | – | Email/phone + password login |
| POST | `/otp/request` | – | Request phone OTP (stub without Twilio creds) |
| POST | `/otp/verify` | – | Verify OTP, creates account if new |
| POST | `/google` | – | Google login (stub — needs `GOOGLE_CLIENT_ID`) |
| GET | `/me` | any | Current user profile |

## Products — `/api/products`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | – | Search/browse. Query: `q, category, minPrice, maxPrice, minRating, country, seller, sort, page, limit, currency` |
| GET | `/:slug` | – | Full product detail (images, variants, countries, stock) |
| POST | `/` | seller | Create product (goes to `pending_approval`) |
| PUT | `/:id` | seller (owner) | Edit product (re-enters `pending_approval`) |
| DELETE | `/:id` | seller (owner) / admin | Delete product |
| GET | `/admin/pending` | admin | Approval queue |
| PATCH | `/:id/approve` | admin | Approve product |
| PATCH | `/:id/reject` | admin | Reject product |
| PATCH | `/:id/feature` | admin | Toggle homepage featuring |

## Categories — `/api/categories`
GET `/` (public) · POST / PATCH / DELETE (admin)

## Cart — `/api/cart`
GET `/` · POST `/items` · PUT `/items/:id` · DELETE `/items/:id` — all customer-authenticated.

## Wishlist — `/api/wishlist`
GET `/` · POST `/:productId` · DELETE `/:productId` · POST `/:productId/move-to-cart`

## Orders — `/api/orders`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/checkout` | customer | **Server calculates price, tax, discount, stock — never trusts the client.** Returns order + payment intent. |
| GET | `/` | customer | My orders |
| GET | `/:id` | owner / staff | Order detail + items + status history |
| GET | `/:id/tracking` | owner / staff | Shipment + tracking events |
| POST | `/:id/cancel` | owner | Cancel (only while cancellable) |
| PATCH | `/:id/status` | admin/ops | Force status change |

## Payments — `/api/payments`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/order/:orderId` | owner / finance | Payment history for an order |
| POST | `/webhook` | – (signature-verified) | **Only place a payment is marked captured.** Mounted with raw body. |
| POST | `/:id/refund` | admin/finance | Issue a refund |

## Sellers (Partner app) — `/api/sellers`
| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/register` | any logged-in user | Apply to become a seller (status: pending) |
| GET | `/me` | seller | Own seller profile |
| GET | `/me/dashboard` | seller | Today's orders, revenue, pending orders, low stock, ratings |
| GET | `/me/products` | seller | Own catalog (all statuses) |
| PUT | `/me/products/:id/inventory` | seller | Update stock |
| GET | `/me/orders` | seller | Order items for this seller |
| PATCH | `/me/orders/:itemId/status` | seller | accept / reject / preparing / packed (+ tracking number) |
| GET | `/me/payouts` | seller | Payout history |

## Admin — `/api/admin`
| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/dashboard` | staff | GMV, orders, revenue, commission, refunds, country-wise sales, top sellers |
| GET | `/users` | staff | Search/list users |
| GET | `/users/:id/orders` | staff | A user's orders |
| PATCH | `/users/:id/block` `/unblock` | staff | Block/unblock |
| PATCH | `/users/:id/role` | super_admin | Change role |
| POST | `/create-staff` | super_admin | Provision admin/ops/support/finance accounts |
| GET | `/sellers` | staff | List sellers, filter by `status` |
| PATCH | `/sellers/:id/approve` `/reject` `/suspend` | staff | Seller lifecycle |
| PATCH | `/sellers/:id/commission` | staff | Set commission rate |
| GET/POST | `/sellers/:id/payouts` | admin/finance | View/create payouts |
| GET | `/orders` | staff | All orders, filter by `status`, `country` |
| GET/PUT | `/settings/:key` | staff/admin | Feature flags, legal page content, etc. |

## Countries / Currencies — `/api/countries`, `/api/currencies`
Dynamic, DB-backed — never hardcoded. GET is public; admin manages via POST/PATCH.
`GET /api/currencies/rates` and `/convert?amount=&to=` expose live/fallback FX rates.

## Coupons — `/api/coupons`
POST `/validate` (any authenticated user, used by cart preview) · admin CRUD on the rest.

## Reviews — `/api/reviews`
GET `/product/:productId` (public) · POST `/` (customer, **delivered orders only**) ·
POST `/:id/report` · PATCH `/:id/moderate` (admin/support)

## Support — `/api/support`
POST `/` (create ticket) · GET `/` (mine, or all for staff) · GET `/:id` · POST `/:id/messages` ·
PATCH `/:id/status` (staff)

## Notifications — `/api/notifications`
GET `/` · PATCH `/:id/read` · PATCH `/read-all`

---

## Error format
```json
{ "error": "Human-readable message" }
```
Standard HTTP status codes are used throughout (400 validation, 401 auth, 403 permission,
404 not found, 409 conflict, 500 server error).
