// /api/_social-auth.js
// Verifies a Google Sign-In credential server-side — never trust the
// browser's word that "this is really user X"; Google hands back a
// signed token whose signature has to be independently checked before
// any of its claims (email, name, Google user id) are believed. Used by
// guest-auth.js's 'google' mode. Not an API endpoint itself — the
// leading underscore is what tells Vercel that, same convention as
// _approval-token.js and _razorpay-verify.js.

// Google's own tokeninfo endpoint does the signature verification for
// us — the simplest correct option, and avoids pulling in a JWT/JWK
// library just for this one provider. It's rate-limited for high-volume
// production use per Google's docs, but is exactly what it's designed
// for at normal login volume; if Aerva's login traffic ever gets heavy
// enough to matter, this can be swapped for verifying the JWK signature
// locally instead (fetch Google's public keys and check RS256 with
// Node's own crypto).
async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') return { error: 'Missing Google credential.' };
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.error('GOOGLE_CLIENT_ID not set — cannot verify Google sign-in.');
    return { error: 'Google sign-in is not available right now.' };
  }
  let res;
  try {
    res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  } catch (err) {
    console.error('Google tokeninfo request failed:', err);
    return { error: 'Could not verify Google sign-in right now. Please try again.' };
  }
  if (!res.ok) {
    return { error: 'That Google sign-in could not be verified — please try again.' };
  }
  const data = await res.json().catch(() => null);
  if (!data) return { error: 'That Google sign-in could not be verified — please try again.' };

  // aud must be THIS app's client id — otherwise a token meant for a
  // completely different Google-sign-in-using app would be accepted here.
  if (data.aud !== process.env.GOOGLE_CLIENT_ID) {
    console.error('Google token aud mismatch:', data.aud);
    return { error: 'That Google sign-in could not be verified — please try again.' };
  }
  if (data.iss !== 'https://accounts.google.com' && data.iss !== 'accounts.google.com') {
    return { error: 'That Google sign-in could not be verified — please try again.' };
  }
  if (data.email_verified !== 'true' && data.email_verified !== true) {
    return { error: 'Your Google account email is not verified.' };
  }
  if (!data.email || !data.sub) {
    return { error: 'That Google sign-in could not be verified — please try again.' };
  }

  return { googleId: data.sub, email: data.email.toLowerCase(), name: data.name || null };
}

module.exports = { verifyGoogleIdToken };
