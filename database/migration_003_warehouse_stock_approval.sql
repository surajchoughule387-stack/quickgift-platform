
-- Warehouse approval and stock adjustment request workflow.
-- Existing warehouses remain approved; new warehouses default to pending.

BEGIN;

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS approval_status TEXT;

-- Preserve existing warehouses as approved.
UPDATE warehouses
SET approval_status = 'approved'
WHERE approval_status IS NULL;

-- Any newly inserted warehouse must await admin approval.
ALTER TABLE warehouses
  ALTER COLUMN approval_status SET DEFAULT 'pending';

ALTER TABLE warehouses
  ALTER COLUMN approval_status SET NOT NULL;

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
END $$;

-- Seller stock changes are requests, not immediate inventory updates.
CREATE TABLE IF NOT EXISTS inventory_adjustment_requests (
  id BIGSERIAL PRIMARY KEY,

  seller_id INTEGER NOT NULL
    REFERENCES sellers(id) ON DELETE CASCADE,

  product_id INTEGER NOT NULL
    REFERENCES products(id) ON DELETE CASCADE,

  variant_id INTEGER
    REFERENCES product_variants(id) ON DELETE SET NULL,

  warehouse_id INTEGER NOT NULL
    REFERENCES warehouses(id) ON DELETE RESTRICT,

  requested_by INTEGER
    REFERENCES users(id) ON DELETE SET NULL,

  requested_quantity INTEGER NOT NULL
    CHECK (requested_quantity >= 0),

  reason TEXT NOT NULL
    CHECK (length(btrim(reason)) > 0),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),

  reviewed_by INTEGER
    REFERENCES users(id) ON DELETE SET NULL,

  reviewed_at TIMESTAMPTZ,

  admin_note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS
  idx_inventory_adjustment_requests_seller_status
ON inventory_adjustment_requests
  (seller_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS
  idx_inventory_adjustment_requests_admin_status
ON inventory_adjustment_requests
  (status, created_at DESC);

COMMIT;
