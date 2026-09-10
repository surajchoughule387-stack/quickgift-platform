// ---------------------------------------------------------------------------
// Courier tracking integration interface (spec section 11/24).
// Each courier row in the `couriers` table stores tracking_url_template and
// the *name* of the env var holding its API key (never the key itself).
// TO GO LIVE: implement fetchTrackingEvents() per courier using their real API.
// ---------------------------------------------------------------------------
async function fetchTrackingEvents(courier, trackingNumber) {
  if (!courier.api_integration_key_env || !process.env[courier.api_integration_key_env]) {
    console.log(`[courier:stub] No live API key configured for ${courier.name}; returning no new events.`);
    return [];
  }
  // Real integration point, e.g.:
  // const apiKey = process.env[courier.api_integration_key_env];
  // const res = await fetch(`https://api.${courier.name}.com/track/${trackingNumber}`, { headers: { Authorization: apiKey }});
  // return res.json();
  return [];
}
module.exports = { fetchTrackingEvents };
