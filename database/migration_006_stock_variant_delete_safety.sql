
BEGIN;

-- Find the existing FK by its columns, then replace its delete action.
DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT c.conname
  INTO fk_name
  FROM pg_constraint c
  WHERE c.conrelid = 'inventory_adjustment_requests'::regclass
    AND c.contype = 'f'
    AND c.conkey = ARRAY[
      (
        SELECT a.attnum
        FROM pg_attribute a
        WHERE a.attrelid = 'inventory_adjustment_requests'::regclass
          AND a.attname = 'variant_id'
      )
    ]::smallint[];

  IF fk_name IS NULL THEN
    RAISE EXCEPTION
      'Foreign key for inventory_adjustment_requests.variant_id not found; inspect schema before applying this migration.';
  END IF;

  EXECUTE format(
    'ALTER TABLE inventory_adjustment_requests DROP CONSTRAINT %I',
    fk_name
  );

  ALTER TABLE inventory_adjustment_requests
    ADD CONSTRAINT inventory_adjustment_requests_variant_id_fkey
    FOREIGN KEY (variant_id)
    REFERENCES product_variants(id)
    ON DELETE RESTRICT;
END $$;

COMMIT;
