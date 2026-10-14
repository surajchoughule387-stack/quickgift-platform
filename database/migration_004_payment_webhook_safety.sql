
-- LAXIC: Payment webhook safety migration
-- Review and test before applying to any database.

BEGIN;

-- Keep Razorpay Order ID separate from Payment ID.
ALTER TABLE payments
ADD COLUMN IF NOT EXISTS provider_order_id TEXT,
ADD COLUMN IF NOT EXISTS provider_refund_id TEXT;

-- Store the Razorpay refund ID separately.
ALTER TABLE refunds
ADD COLUMN IF NOT EXISTS provider_refund_id TEXT;

-- Preserve existing Razorpay Order IDs stored in the old column.
UPDATE payments
SET provider_order_id = provider_payment_id,
provider_payment_id = NULL
WHERE provider = 'razorpay'
AND provider_order_id IS NULL
AND left(provider_payment_id, 6) = 'order_';

-- Indexes for locating payment records.
CREATE INDEX IF NOT EXISTS idx_payments_provider_order_id
ON payments (provider, provider_order_id);

CREATE INDEX IF NOT EXISTS idx_payments_provider_payment_id
ON payments (provider, provider_payment_id);

-- Record webhook event IDs to support idempotent processing.
CREATE TABLE IF NOT EXISTS payment_webhook_events (
id BIGSERIAL PRIMARY KEY,
provider TEXT NOT NULL,
provider_event_id TEXT NOT NULL,
event_type TEXT NOT NULL,
payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
processing_status TEXT NOT NULL DEFAULT 'received'
CHECK (processing_status IN (
'received', 'processing', 'processed', 'failed', 'ignored'
)),
payload_sha256 TEXT,
received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
processed_at TIMESTAMPTZ,
last_error TEXT,
UNIQUE (provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_webhook_events_payment
ON payment_webhook_events (payment_id);

COMMIT;
