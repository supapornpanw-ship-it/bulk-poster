// POST /api/clear-jobs — ลบ job ที่เสร็จแล้ว/error/cancelled ออกจาก Redis (เก็บ pending ไว้)
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers['x-bp-secret'];
  if (auth !== 'bp_secret_2024') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const jobIds = await redis.smembers('jobs:all');
    if (!jobIds || !jobIds.length) return res.status(200).json({ deleted: 0, kept: 0 });

    let deleted = 0;
    let kept = 0;
    const pipeline = redis.pipeline();

    for (const id of jobIds) {
      const raw = await redis.get(`job:${id}`);
      if (!raw) {
        // key หมดอายุแล้ว → ลบออกจาก set
        pipeline.srem('jobs:all', id);
        deleted++;
        continue;
      }
      const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

      // เก็บ job ที่กำลังรอ publish (pending / preparing)
      if (job.status === 'pending' || job.status === 'preparing') {
        kept++;
        continue;
      }

      // ลบ job ที่เสร็จแล้ว / error / cancelled
      pipeline.del(`job:${id}`);
      pipeline.del(`qstash:${id}`);
      pipeline.srem('jobs:all', id);
      deleted++;
    }

    await pipeline.exec();
    return res.status(200).json({ deleted, kept });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
