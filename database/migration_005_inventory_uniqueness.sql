
BEGIN;

-- Stop safely if duplicate inventory records exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory
    WHERE product_id IS NOT NULL
      AND warehouse_id IS NOT NULL
      AND variant_id IS NULL
    GROUP BY product_id, warehouse_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Duplicate inventory rows found for products without variants. Review duplicates before retrying.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM inventory
    WHERE product_id IS NOT NULL
      AND warehouse_id IS NOT NULL
      AND variant_id IS NOT NULL
    GROUP BY product_id, variant_id, warehouse_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Duplicate inventory rows found for product variants. Review duplicates before retrying.';
  END IF;
END $$;

-- One inventory row per product and warehouse when no variant exists.
CREATE UNIQUE INDEX IF NOT EXISTS
  idx_inventory_product_warehouse_no_variant
ON inventory (product_id, warehouse_id)
WHERE variant_id IS NULL
  AND product_id IS NOT NULL
  AND warehouse_id IS NOT NULL;

-- One inventory row per product variant and warehouse.
CREATE UNIQUE INDEX IF NOT EXISTS
  idx_inventory_product_variant_warehouse
ON inventory (product_id, variant_id, warehouse_id)
WHERE variant_id IS NOT NULL
  AND product_id IS NOT NULL
  AND warehouse_id IS NOT NULL;

COMMIT;
