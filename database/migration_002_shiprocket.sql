
-- Shiprocket tracking lookup support.
-- The base schema already provides shipments.tracking_number.
-- Add an index for efficient tracking-number lookups.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_shipments_tracking_number
ON shipments (tracking_number);

COMMIT;
