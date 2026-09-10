// ---------------------------------------------------------------------------
// Exchange rate service (spec section 8/47).
// Prices are stored in the seller's base currency (usually INR) and converted
// at read-time — never hardcode a fixed rate table in application logic.
//
// LIVE BY DEFAULT: uses open.er-api.com, a free public exchange-rate API that
// needs NO API key or signup. If you want a different provider (e.g. for
// higher rate limits or paid SLAs), set EXCHANGE_RATE_API_URL to override —
// it must accept a base currency in the path/query and return { rates: {...} }
// in the same shape as open.er-api.com.
// ---------------------------------------------------------------------------

let cache = { rates: null, fetchedAt: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — plenty fresh for gifting checkout, keeps us well under any provider's rate limit

// Only used if the live fetch fails (network blip, provider down) so the
// site never breaks at checkout — customers still see a price, just possibly
// a few hours/days stale until the next successful refresh.
const FALLBACK_RATES_BASE_INR = {
  INR: 1, USD: 0.012, AED: 0.044, GBP: 0.0095, AUD: 0.018, CAD: 0.0163, SGD: 0.0162
};

const DEFAULT_PROVIDER_URL = 'https://open.er-api.com/v6/latest/INR';

async function getRates() {
  const now = Date.now();
  if (cache.rates && now - cache.fetchedAt < CACHE_TTL_MS) return cache.rates;

  const url = process.env.EXCHANGE_RATE_API_URL || DEFAULT_PROVIDER_URL;
  try {
    const headers = process.env.EXCHANGE_RATE_API_KEY ? { Authorization: `Bearer ${process.env.EXCHANGE_RATE_API_KEY}` } : {};
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Exchange rate provider returned ${res.status}`);
    const data = await res.json();
    const rates = data.rates || data.conversion_rates; // open.er-api.com uses "rates"; some providers use "conversion_rates"
    if (!rates || !rates.INR) throw new Error('Unexpected response shape from exchange rate provider');
    cache = { rates, fetchedAt: now };
    return rates;
  } catch (err) {
    console.warn('[exchangeRate] Live fetch failed, using fallback table:', err.message);
    // Keep serving the fallback but don't cache it as if it were fresh —
    // retry the live provider again on the very next call.
    return FALLBACK_RATES_BASE_INR;
  }
}

async function convert(amountInInr, targetCurrencyCode) {
  if (targetCurrencyCode === 'INR') return amountInInr;
  const rates = await getRates();
  const rate = rates[targetCurrencyCode];
  if (!rate) throw new Error(`No exchange rate available for ${targetCurrencyCode}`);
  return Math.round(amountInInr * rate * 100) / 100;
}

module.exports = { getRates, convert };
