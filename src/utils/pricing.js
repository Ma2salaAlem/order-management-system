// Computes the true total for one order line, including any priced extras.
// Always derive this from the stored unitPrice + selectedExtras snapshot —
// never trust a client-supplied total, since that's exactly the kind of
// value tampering this system's audit trail exists to catch.
function lineTotal(orderItem) {
  const base = Number(orderItem.unitPrice);
  const extras = Array.isArray(orderItem.selectedExtras) ? orderItem.selectedExtras : [];
  const extrasSum = extras.reduce((sum, e) => sum + Number(e.price || 0), 0);
  return (base + extrasSum) * orderItem.quantity;
}

module.exports = { lineTotal };
