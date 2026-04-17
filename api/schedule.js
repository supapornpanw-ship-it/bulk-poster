// POST /api/schedule — รับ prepared posts จาก extension แล้วตั้งเวลา publish ผ่าน QStash REST API
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ตรวจ secret (hardcoded — personal project)
  const auth = req.headers['x-bp-secret'];
  if (auth !== 'bp_secret_2024') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { jobId, pages, scheduledTime, delay, postData, userToken } = req.body;
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
      userToken: userToken || null, // long-lived token สำหรับ refresh page token ตอน publish
      status: 'pending',
      createdAt: Date.now(),
      results: {},
    };
    await redis.set(`job:${jobId}`, JSON.stringify(job), { ex: 604800 });
    await redis.sadd('jobs:all', jobId);

    // ตั้ง QStash schedule แยกต่อเพจ — ใช้ REST API ตรงๆ แทน SDK
    const baseUrl = `https://${req.headers.host}/api/publish`;
    const qstashToken = process.env.QSTASH_TOKEN;
    const qstashIds = [];

    for (let i = 0; i < pages.length; i++) {
      const fireAt = Math.floor((scheduledTime + i * (delay || 0)) / 1000);
      const qstashResp = await fetch(`https://qstash-us-east-1.upstash.io/v2/publish/${baseUrl}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${qstashToken}`,
          'Content-Type': 'application/json',
          'Upstash-Not-Before': String(fireAt),
          'Upstash-Retries': '5',
        },
        body: JSON.stringify({ jobId, pageIndex: i }),
      });

      const qstashData = await qstashResp.json();

      if (!qstashResp.ok) {
        console.error('QStash publish error:', qstashData);
        throw new Error(`QStash error: ${JSON.stringify(qstashData)}`);
      }

      qstashIds.push(qstashData.messageId);
    }

    // เก็บ QStash message IDs สำหรับ cancel
    await redis.set(`qstash:${jobId}`, JSON.stringify(qstashIds), { ex: 604800 });

    return res.status(200).json({ success: true, jobId, scheduled: pages.length });
  } catch (err) {
    console.error('Schedule error:', err);
    return res.status(500).json({ error: err.message });
  }
}
