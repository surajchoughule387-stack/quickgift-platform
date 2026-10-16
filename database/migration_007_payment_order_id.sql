

BEGIN;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider_order_id TEXT;

-- Purane pending Razorpay orders ka reference preserve karo.


CREATE INDEX IF NOT EXISTS idx_payments_provider_order_id
  ON payments (provider, provider_order_id);

COMMIT;
