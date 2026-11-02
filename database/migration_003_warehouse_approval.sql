-- Phase 1: warehouse approval status
-- Safe, idempotent migration.
-- Existing warehouse rows are backfilled to pending and never auto-approved.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'warehouses'
      AND column_name = 'status'
  ) THEN
    ALTER TABLE warehouses ADD COLUMN status TEXT;
  END IF;
END $$;

UPDATE warehouses
SET status = 'pending'
WHERE status IS NULL
   OR status NOT IN ('pending', 'approved', 'rejected', 'suspended');

ALTER TABLE warehouses
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE warehouses
  ALTER COLUMN status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    WHERE tc.table_schema = current_schema()
      AND tc.table_name = 'warehouses'
      AND tc.constraint_name = 'warehouses_status_check'
  ) THEN
    ALTER TABLE warehouses
      ADD CONSTRAINT warehouses_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'suspended'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_warehouses_seller_status
  ON warehouses (seller_id, status);
