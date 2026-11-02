const VALID_WAREHOUSE_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];

function isWarehouseUsableForInventory(warehouse) {
  if (!warehouse) return false;
  const isActive = warehouse.is_active === true || warehouse.is_active === 1 || warehouse.is_active === 'true';
  return warehouse.status === 'approved' && isActive;
}

function isValidWarehouseTransition(currentStatus, nextStatus) {
  const allowedTransitions = {
    pending: ['approved', 'rejected'],
    approved: ['suspended', 'rejected'],
    suspended: ['approved'],
    rejected: []
  };

  if (!VALID_WAREHOUSE_STATUSES.includes(currentStatus)) {
    return false;
  }
  if (!VALID_WAREHOUSE_STATUSES.includes(nextStatus)) {
    return false;
  }

  return (allowedTransitions[currentStatus] || []).includes(nextStatus);
}

module.exports = {
  VALID_WAREHOUSE_STATUSES,
  isWarehouseUsableForInventory,
  isValidWarehouseTransition
};
