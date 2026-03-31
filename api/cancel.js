// POST /api/cancel — ยกเลิก scheduled job
import { Redis } from '@upstash/redis';
import { Client } from '@upstash/qstash';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers['x-bp-secret'];
  if (auth !== process.env.BP_API_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { jobId } = req.body;
    if (!jobId) return res.status(400).json({ error: 'Missing jobId' });

    // อัพเดท status ใน Redis
    const raw = await redis.get(`job:${jobId}`);
    if (raw) {
      const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
      job.status = 'cancelled';
      await redis.set(`job:${jobId}`, JSON.stringify(job), { ex: 604800 });
    }

    // ลบ QStash scheduled messages
    const qRaw = await redis.get(`qstash:${jobId}`);
    if (qRaw) {
      const ids = typeof qRaw === 'string' ? JSON.parse(qRaw) : qRaw;
      for (const msgId of ids) {
        try {
          await qstash.messages.delete(msgId);
        } catch (e) {
          // message อาจถูกส่งไปแล้ว ไม่เป็นไร
        }
      }
      await redis.del(`qstash:${jobId}`);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Cancel error:', err);
    return res.status(500).json({ error: err.message });
  }
}
