

const SHIPROCKET_BASE_URL = 'https://apiv2.shiprocket.in/v1/external';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getShiprocketToken() {
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  if (!process.env.SHIPROCKET_EMAIL || !process.env.SHIPROCKET_PASSWORD) {
    throw new Error('Shiprocket credentials are not configured.');
  }

  const response = await fetch(`${SHIPROCKET_BASE_URL}/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email: process.env.SHIPROCKET_EMAIL,
      password: process.env.SHIPROCKET_PASSWORD
    })
  });

  const data = await response.json();

  if (!response.ok || !data.token) {
    throw new Error(
      `Shiprocket authentication failed: ${data.message || response.statusText}`
    );
  }

  cachedToken = data.token;

  // Shiprocket tokens are valid for a limited period.
  // Refresh slightly before expiry.
  tokenExpiresAt = Date.now() + (9 * 24 * 60 * 60 * 1000);

  return cachedToken;
}

async function shiprocketRequest(path, options = {}) {
  const token = await getShiprocketToken();

  const response = await fetch(`${SHIPROCKET_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Shiprocket API error: ${data.message || response.statusText}`
    );
  }

  return data;
}

async function createOrder(orderData) {
  return shiprocketRequest('/orders/create/adhoc', {
    method: 'POST',
    body: JSON.stringify(orderData)
  });
}

async function assignAwb(shipmentId, courierId = null) {
  const body = {
    shipment_id: shipmentId
  };

  if (courierId) {
    body.courier_id = courierId;
  }

  return shiprocketRequest('/courier/assign/awb', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

async function generatePickup(shipmentIds) {
  return shiprocketRequest('/courier/generate/pickup', {
    method: 'POST',
    body: JSON.stringify({
      shipment_id: shipmentIds
    })
  });
}

async function trackByAwb(awbCode) {
  return shiprocketRequest(`/courier/track/awb/${encodeURIComponent(awbCode)}`, {
    method: 'GET'
  });
}

module.exports = {
  getShiprocketToken,
  createOrder,
  assignAwb,
  generatePickup,
  trackByAwb
};
