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

// The same check for Google's pop-up sign-in (used with Aerva's own
// Google tile, not Google's drawn button): an ACCESS token instead of an
// ID token. Two calls to Google:
//   1. tokeninfo — confirms the token is real, unexpired, and was issued
//      to THIS app (aud / azp = GOOGLE_CLIENT_ID). Without this, a token
//      granted to any other website could be replayed here.
//   2. userinfo  — the person's Google id, email (verified?) and name.
async function verifyGoogleAccessToken(accessToken) {
  if (!accessToken || typeof accessToken !== 'string' || accessToken.length > 4096) return { error: 'Missing Google credential.' };
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.error('GOOGLE_CLIENT_ID not set — cannot verify Google sign-in.');
    return { error: 'Google sign-in is not available right now.' };
  }
  const fail = { error: 'That Google sign-in could not be verified — please try again.' };
  try {
    const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`);
    if (!infoRes.ok) return fail;
    const info = await infoRes.json().catch(() => null);
    if (!info) return fail;
    const issuedTo = info.aud || info.azp;
    if (issuedTo !== process.env.GOOGLE_CLIENT_ID) {
      console.error('Google access token issued to another app:', issuedTo);
      return fail;
    }
    if (Number(info.expires_in) <= 0) return fail;
    const userRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!userRes.ok) return fail;
    const u = await userRes.json().catch(() => null);
    if (!u || !u.sub || !u.email) return fail;
    if (info.sub && String(info.sub) !== String(u.sub)) return fail;
    if (u.email_verified !== true && u.email_verified !== 'true') return { error: 'Your Google account email is not verified.' };
    return { googleId: String(u.sub), email: String(u.email).toLowerCase(), name: u.name || null };
  } catch (err) {
    console.error('Google access-token check failed:', err);
    return { error: 'Could not verify Google sign-in right now. Please try again.' };
  }
}

module.exports = { verifyGoogleIdToken, verifyGoogleAccessToken };
