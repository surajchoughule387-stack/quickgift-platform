
BEGIN;

ALTER TABLE refunds
  ADD COLUMN IF NOT EXISTS provider_refund_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_refunds_provider_refund_id
ON refunds (provider_refund_id)
WHERE provider_refund_id IS NOT NULL;

COMMIT;
