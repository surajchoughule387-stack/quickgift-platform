

BEGIN;

-- 1. Existing warehouses stay approved.
--    New warehouses default to pending after this migration.
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS approval_status
    TEXT NOT NULL DEFAULT 'approved';

ALTER TABLE warehouses
  ALTER COLUMN approval_status SET DEFAULT 'pending';

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS approved_by
    INTEGER REFERENCES users(id);

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

-- Validate warehouse approval status.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'warehouses_approval_status_check'
      AND conrelid = 'warehouses'::regclass
  ) THEN
    ALTER TABLE warehouses
      ADD CONSTRAINT warehouses_approval_status_check
      CHECK (
        approval_status IN ('pending', 'approved', 'rejected')
      );
  END IF;
END
$$;

-- 2. Stock change requests.
--    Requested quantity does not change live inventory by itself.
CREATE TABLE IF NOT EXISTS stock_change_requests (
  id SERIAL PRIMARY KEY,

  seller_id INTEGER NOT NULL
    REFERENCES sellers(id),

  product_id INTEGER NOT NULL
    REFERENCES products(id) ON DELETE CASCADE,

  variant_id INTEGER
    REFERENCES product_variants(id) ON DELETE CASCADE,

  warehouse_id INTEGER NOT NULL
    REFERENCES warehouses(id),

  current_quantity INTEGER NOT NULL
    CHECK (current_quantity >= 0),

  requested_quantity INTEGER NOT NULL
    CHECK (requested_quantity >= 0),

  reason TEXT NOT NULL
    CHECK (length(trim(reason)) > 0),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),

  requested_by INTEGER NOT NULL
    REFERENCES users(id),

  reviewed_by INTEGER
    REFERENCES users(id),

  reviewed_at TIMESTAMPTZ,

  admin_note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Efficient lookup of requests awaiting Admin review.
CREATE INDEX IF NOT EXISTS idx_stock_requests_pending
  ON stock_change_requests (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_stock_requests_seller_history
  ON stock_change_requests (seller_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_requests_product_warehouse
  ON stock_change_requests (product_id, warehouse_id);

-- 4. Prevent multiple pending requests for the same stock item.
--    Separate indexes correctly handle NULL variant IDs.
CREATE UNIQUE INDEX IF NOT EXISTS
  idx_stock_request_pending_no_variant
  ON stock_change_requests (product_id, warehouse_id)
  WHERE variant_id IS NULL AND status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS
  idx_stock_request_pending_variant
  ON stock_change_requests (product_id, variant_id, warehouse_id)
  WHERE variant_id IS NOT NULL AND status = 'pending';

COMMIT;
