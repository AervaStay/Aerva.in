// /api/_listing-rules.js
// Rules about a listing that more than one endpoint has to enforce. Not
// an API endpoint itself — the leading underscore is what tells Vercel
// that, same convention as _compliance.js, _tiers.js, etc.

// ---------------------------------------------------------------------
// One property name per pincode.
//
// Two listings called "The Manor" in 412101 are indistinguishable to a
// guest reading search results, to an admin approving them, and to a host
// looking at their own dashboard — and a booking for the wrong one is
// found out at the door. The pincode is the right scope: the same name in
// another town is a different property and perfectly fine.
//
// Compared case-insensitively, with runs of whitespace collapsed, so
// "the manor", "The  Manor" and " THE MANOR " are all the same name.
// Without collapsing, a second space was enough to walk straight past
// this rule.
//
// Rejected and removed listings are ignored: a name is only taken while
// something live or awaiting review is using it. A listing is never
// compared against itself, so a host re-saving their own listing, or
// resubmitting a draft, is never blocked by its own name.
//
// Stays only. An experience has no pincode of its own — it inherits the
// property that hosts it — so this rule cannot be applied to one.
const NAME_BLOCKING_STATUSES = ['pending', 'approved', 'blocked'];

async function findNameClashInPincode(sql, { propertyName, pincode, excludeListingId = null }) {
  const name = String(propertyName || '').trim();
  const pin = String(pincode || '').trim();
  // No name or no pincode: nothing to compare. A missing pincode is
  // already handled where it is required; this rule stays silent rather
  // than inventing a second error about it.
  if (!name || !pin) return null;

  // NOTE the doubled backslash in the SQL below: this is a JS template
  // literal, where a lone \s is just the letter s — which silently made
  // the pattern collapse every "s" in a name instead of its whitespace.
  const normalized = name.replace(/\s+/g, ' ').toLowerCase();
  const rows = await sql`
    SELECT id, property_name, status, host_email
    FROM listings
    WHERE listing_type = 'stay'
      AND status = ANY(${NAME_BLOCKING_STATUSES})
      AND trim(pincode) = ${pin}
      AND lower(regexp_replace(btrim(property_name), '\\s+', ' ', 'g')) = ${normalized}
      AND (${excludeListingId}::int IS NULL OR id <> ${excludeListingId}::int)
    LIMIT 1
  `;
  return rows[0] || null;
}

// The message a host sees. Deliberately says what to do next, and never
// names the other host or their email — that a property with this name
// exists at this pincode is all a stranger needs to know.
function nameClashMessage(name, pincode) {
  return `Another property in ${pincode} is already listed as "${String(name).trim()}". `
    + 'Please use a name that tells guests the two apart — adding the building, block or floor usually does it. '
    + 'If this is your own listing, edit it from your dashboard instead of creating a second one.';
}

module.exports = { NAME_BLOCKING_STATUSES, findNameClashInPincode, nameClashMessage };
