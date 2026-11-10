-- Free cancellation price (owner, 11 Nov 2026): any whole amount from ₹0
-- (was ₹100) up to ₹1,00,000. Each booking still pays it kept between 5% and
-- 30% of its stay price.
ALTER TABLE listings DROP CONSTRAINT IF EXISTS listings_free_cancel_fee_check;
ALTER TABLE listings ADD CONSTRAINT listings_free_cancel_fee_check CHECK (
  free_cancel_fee IS NULL OR (free_cancel_fee >= 0 AND free_cancel_fee <= 100000)
);
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_free_cancel_fixed_check;
ALTER TABLE orders ADD CONSTRAINT orders_free_cancel_fixed_check CHECK (free_cancel_fixed IS NULL OR free_cancel_fixed >= 0);
