// Human-readable, still-unique order numbers: QG-<year><month>-<random6>
function generateOrderNumber() {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `QG-${ym}-${rand}`;
}
module.exports = { generateOrderNumber };
