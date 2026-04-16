// POST /api/publish — QStash เรียกตรงเวลา → publish โพสเพจเดียว
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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
    const { jobId, pageIndex } = req.body || {};
    if (!jobId || pageIndex === undefined) {
      return res.status(400).json({ error: 'Missing jobId or pageIndex' });
    }

    const raw = await redis.get(`job:${jobId}`);
    if (!raw) return res.status(404).json({ error: 'Job not found' });
    const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (job.status === 'cancelled') return res.status(200).json({ skipped: true, reason: 'cancelled' });

    const page = job.pages[pageIndex];
    if (!page || !page.postId) {
      return res.status(400).json({ error: 'Page not prepared', pageIndex });
    }

    if (!job.results) job.results = {};

    // ── ลอง Publish ด้วย pageToken เดิม ──
    let token = page.pageToken;
    let fbData = await tryPublish(page.postId, token);

    // ── ถ้า error → ลอง refresh page token ด้วย userToken ──
    if (fbData.error && job.userToken) {
      console.log(`[PUBLISH] ${page.name} failed with stored token, refreshing...`);
      const freshToken = await getFreshPageToken(job.userToken, page.id);
      if (freshToken) {
        token = freshToken;
        // อัพเดท token ใน job สำหรับเพจถัดไป
        job.pages[pageIndex].pageToken = freshToken;
        fbData = await tryPublish(page.postId, freshToken);
      }
    }

    // ── ถ้ายัง error → เช็คว่าโพสถูก publish ไปแล้วหรือยัง ──
    if (fbData.error) {
      const alreadyPublished = await checkPublished(page.postId, token);
      if (alreadyPublished) {
        job.results[page.id] = { success: true, postId: page.postId, pageName: page.name, note: 'already published' };
      } else {
        job.results[page.id] = { success: false, error: fbData.error.message, pageName: page.name };
      }
    } else {
      job.results[page.id] = { success: true, postId: page.postId, pageName: page.name };
    }

    // เช็คครบทุกเพจหรือยัง
    const doneCount = Object.keys(job.results).length;
    if (doneCount >= job.pages.length) {
      job.status = 'done';
      job.executedAt = Date.now();
    }

    await redis.set(`job:${jobId}`, JSON.stringify(job), { ex: 604800 });

    return res.status(200).json({
      success: !fbData.error,
      postId: page.postId,
      pageName: page.name,
      error: fbData.error?.message || null,
    });
  } catch (err) {
    console.error('Publish error:', err);
    return res.status(500).json({ error: err.message });
  }
}
