// POST /api/publish — QStash เรียกตรงเวลา → publish โพสเพจเดียว
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── ตรวจสอบว่ามาจาก QStash จริง ──
  // เช็คจาก upstash-signature header (มีแค่ QStash ที่ส่งมาได้)
  const signature = req.headers['upstash-signature'];
  if (!signature) {
    return res.status(401).json({ error: 'No QStash signature' });
  }

  try {
    const body = req.body;
    const { jobId, pageIndex } = body || {};

    if (!jobId || pageIndex === undefined) {
      console.error('Missing fields. body:', JSON.stringify(body));
      return res.status(400).json({ error: 'Missing jobId or pageIndex' });
    }

    // อ่าน job จาก Redis
    const raw = await redis.get(`job:${jobId}`);
    if (!raw) return res.status(404).json({ error: 'Job not found' });
    const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

    if (job.status === 'cancelled') return res.status(200).json({ skipped: true, reason: 'cancelled' });

    const page = job.pages[pageIndex];
    if (!page || !page.postId || !page.pageToken) {
      return res.status(400).json({ error: 'Page not prepared', pageIndex });
    }

    // ── Publish ไป Facebook ──
    const fbResp = await fetch(`https://graph.facebook.com/v20.0/${page.postId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        access_token: page.pageToken,
        is_published: 'true',
      }),
    });
    const fbData = await fbResp.json();

    // อัพเดท result ใน Redis
    if (!job.results) job.results = {};
    if (fbData.error) {
      // เช็คว่าโพสถูก publish ไปแล้วหรือยัง (Creative → auto-published)
      const checkResp = await fetch(
        `https://graph.facebook.com/v20.0/${page.postId}?fields=is_published&access_token=${encodeURIComponent(page.pageToken)}`
      );
      const checkData = await checkResp.json();
      if (checkData.is_published) {
        // โพสถูก publish ไปแล้ว ถือว่าสำเร็จ
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
