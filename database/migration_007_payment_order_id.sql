

BEGIN;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS provider_order_id TEXT;



CREATE INDEX IF NOT EXISTS idx_payments_provider_order_id
  ON payments (provider, provider_order_id);

COMMIT;
