-- 2026-11-12-03-decline-request.sql — turning a support request down is an
-- outcome like any other, and goes to a reviewer the same way
-- (owner, 12 Nov 2026). Safe to run more than once; widens one CHECK.
-- Code: api/_support-actions.js (kind 'decline').
--
-- Nothing is paid and nothing on the booking changes. The person is told,
-- word for word, what the representative wrote, and the request is marked
-- resolved — so a refusal is on the record with who proposed it, who
-- approved it, and why.

ALTER TABLE support_actions DROP CONSTRAINT IF EXISTS support_actions_kind_check;
ALTER TABLE support_actions ADD CONSTRAINT support_actions_kind_check
  CHECK (kind IN ('cancel_refund', 'partial_refund', 'deposit_refund',
                  'report_guest', 'report_host', 'block_guest_listing', 'decline'));
