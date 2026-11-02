const { readFileSync } = require('fs');
const { join } = require('path');
const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isWarehouseUsableForInventory,
  isValidWarehouseTransition
} = require('../src/utils/warehouseApproval');

test('approved active warehouse is usable', () => {
  assert.equal(
    isWarehouseUsableForInventory({ status: 'approved', is_active: true }),
    true
  );
});

test('pending warehouse is not usable', () => {
  assert.equal(
    isWarehouseUsableForInventory({ status: 'pending', is_active: true }),
    false
  );
});

test('inactive warehouse is not usable even when approved', () => {
  assert.equal(
    isWarehouseUsableForInventory({ status: 'approved', is_active: false }),
    false
  );
});

test('valid transitions are enforced', () => {
  assert.equal(isValidWarehouseTransition('pending', 'approved'), true);
  assert.equal(isValidWarehouseTransition('pending', 'rejected'), true);
  assert.equal(isValidWarehouseTransition('approved', 'suspended'), true);
  assert.equal(isValidWarehouseTransition('suspended', 'approved'), true);
  assert.equal(isValidWarehouseTransition('rejected', 'approved'), false);
  assert.equal(isValidWarehouseTransition('approved', 'approved'), false);
});

const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
assert.equal(packageJson.name, 'quickgift-backend');
