

BEGIN;

-- Check for existing duplicate refund references first.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM transactions
    WHERE type = 'refund'
      AND provider_reference IS NOT NULL
    GROUP BY payment_id, provider_reference
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Duplicate refund references exist. Review them before adding the unique index.';
  END IF;
END $$;

-- Prevent the same provider refund from being recorded
-- more than once for the same payment.
CREATE UNIQUE INDEX IF NOT EXISTS
  uq_transactions_refund_provider_reference
ON transactions (payment_id, provider_reference)
WHERE type = 'refund'
  AND provider_reference IS NOT NULL;

COMMIT;
