// POST /api/schedule — รับ prepared posts จาก extension แล้วตั้งเวลา publish ผ่าน QStash
import { Redis } from '@upstash/redis';
import { Client } from '@upstash/qstash';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ตรวจ secret
  const auth = req.headers['x-bp-secret'];
  if (auth !== process.env.BP_API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { jobId, pages, scheduledTime, delay, postData } = req.body;
    if (!jobId || !pages?.length || !scheduledTime) {
      return res.status(400).json({ error: 'Missing jobId, pages, or scheduledTime' });
    }

    // เก็บ job ใน Redis (TTL 7 วัน)
    const job = {
      jobId,
      pages,
      scheduledTime,
      delay: delay || 0,
      postData: postData || {},
      status: 'pending',
      createdAt: Date.now(),
      results: {},
    };
    await redis.set(`job:${jobId}`, JSON.stringify(job), { ex: 604800 });

    // ตั้ง QStash schedule แยกต่อเพจ
    const baseUrl = `https://${req.headers.host}/api/publish`;
    const qstashIds = [];

    for (let i = 0; i < pages.length; i++) {
      const fireAt = Math.floor((scheduledTime + i * (delay || 0)) / 1000);
      const msg = await qstash.publishJSON({
        url: baseUrl,
        body: { jobId, pageIndex: i },
        notBefore: fireAt,
        retries: 3,
      });
      qstashIds.push(msg.messageId);
    }

    // เก็บ QStash message IDs สำหรับ cancel
    await redis.set(`qstash:${jobId}`, JSON.stringify(qstashIds), { ex: 604800 });

    return res.status(200).json({ success: true, jobId, scheduled: pages.length });
  } catch (err) {
    console.error('Schedule error:', err);
    return res.status(500).json({ error: err.message });
  }
}
