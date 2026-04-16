// GET /api/fb-callback — Facebook OAuth callback
// รับ code จาก Facebook → แลกเป็น long-lived token (60 วัน) → redirect กลับ app
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { code, error, error_description } = req.query;

  if (error) {
    return res.redirect(`/?fb_error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect('/?fb_error=no_code');
  }

  const APP_ID = '721475520495705';
  const APP_SECRET = process.env.FB_APP_SECRET || '3b90024730a5926071ba21cf247bd8b1';
  const REDIRECT_URI = `https://${req.headers.host}/api/fb-callback`;

  try {
    // 1. แลก code → short-lived token
    const tokenResp = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
      `client_id=${APP_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
      `&client_secret=${APP_SECRET}&code=${encodeURIComponent(code)}`
    );
    const tokenData = await tokenResp.json();

    if (tokenData.error) {
      return res.redirect(`/?fb_error=${encodeURIComponent(tokenData.error.message)}`);
    }

    // 2. แลก short-lived → long-lived token (60 วัน)
    const longResp = await fetch(
      `https://graph.facebook.com/v20.0/oauth/access_token?` +
      `grant_type=fb_exchange_token&client_id=${APP_ID}` +
      `&client_secret=${APP_SECRET}&fb_exchange_token=${encodeURIComponent(tokenData.access_token)}`
    );
    const longData = await longResp.json();

    const finalToken = longData.access_token || tokenData.access_token;
    const expiresIn = longData.expires_in || tokenData.expires_in || 5184000;

    // 3. redirect กลับ app พร้อม token
    return res.redirect(`/?fb_token=${encodeURIComponent(finalToken)}&fb_expires=${expiresIn}`);
  } catch (err) {
    return res.redirect(`/?fb_error=${encodeURIComponent(err.message)}`);
  }
}
