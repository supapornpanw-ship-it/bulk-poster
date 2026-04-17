// POST /api/publish — QStash เรียกตรงเวลา → publish โพสเพจเดียว
// ข้อมูลทั้งหมดอ่านจาก request body (ไม่ใช้ Redis)

async function getFreshPageToken(userToken, pageId) {
  if (!userToken) return null;
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v20.0/me/accounts?fields=id,access_token&limit=200&access_token=${encodeURIComponent(userToken)}`
    );
    const data = await resp.json();
    if (data.error || !data.data) return null;
    const page = data.data.find(p => p.id === pageId);
    return page?.access_token || null;
  } catch {
    return null;
  }
}

async function tryPublish(postId, pageToken) {
  const resp = await fetch(`https://graph.facebook.com/v20.0/${postId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ access_token: pageToken, is_published: 'true' }),
  });
  return resp.json();
}

async function checkPublished(postId, pageToken) {
  try {
    const resp = await fetch(
      `https://graph.facebook.com/v20.0/${postId}?fields=is_published&access_token=${encodeURIComponent(pageToken)}`
    );
    const data = await resp.json();
    return data.is_published === true;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const signature = req.headers['upstash-signature'];
  if (!signature) return res.status(401).json({ error: 'No QStash signature' });

  try {
    // ── อ่านทุกอย่างจาก body (ไม่มี Redis) ──
    const { jobId, pageIndex, pageId, pageName, pageToken, postId, userToken } = req.body || {};

    if (!postId || !pageToken) {
      return res.status(400).json({ error: 'Missing postId or pageToken in body' });
    }

    // ── ลอง Publish ด้วย pageToken เดิม ──
    let token = pageToken;
    let fbData = await tryPublish(postId, token);

    // ── ถ้า error → refresh page token ด้วย userToken ──
    if (fbData.error && userToken) {
      console.log(`[PUBLISH] ${pageName} failed with stored token, refreshing...`);
      const freshToken = await getFreshPageToken(userToken, pageId);
      if (freshToken) {
        token = freshToken;
        fbData = await tryPublish(postId, freshToken);
      }
    }

    // ── ถ้ายัง error → เช็คว่าโพสถูก publish ไปแล้วหรือยัง ──
    if (fbData.error) {
      const alreadyPublished = await checkPublished(postId, token);
      if (alreadyPublished) {
        return res.status(200).json({
          success: true,
          postId,
          pageName,
          note: 'already published',
        });
      }
      return res.status(200).json({
        success: false,
        postId,
        pageName,
        error: fbData.error.message,
      });
    }

    return res.status(200).json({
      success: true,
      postId,
      pageName,
    });
  } catch (err) {
    console.error('Publish error:', err);
    return res.status(500).json({ error: err.message });
  }
}
