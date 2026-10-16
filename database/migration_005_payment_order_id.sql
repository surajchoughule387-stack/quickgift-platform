
BEGIN;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider_order_id TEXT;

-- Purane pending Razorpay orders ka reference preserve karo.
UPDATE payments
SET provider_order_id = provider_payment_id
WHERE provider = 'razorpay'
  AND status = 'created'
  AND provider_order_id IS NULL
  AND provider_payment_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payments_provider_order_id
  ON payments (provider, provider_order_id);

COMMIT;
