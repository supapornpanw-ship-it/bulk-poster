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

    // ── ใช้ mget ดึงทุก job ในครั้งเดียว (1 Redis call แทน N calls) ──
    const keys = jobIds.map(id => `job:${id}`);
    const rawResults = await redis.mget(...keys);

    let deleted = 0;
    let kept = 0;
    const pipeline = redis.pipeline();

    for (let i = 0; i < jobIds.length; i++) {
      const raw = rawResults[i];
      if (!raw) {
        pipeline.srem('jobs:all', jobIds[i]);
        deleted++;
        continue;
      }
      const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (job.status === 'pending' || job.status === 'preparing') {
        kept++;
        continue;
      }

      pipeline.del(`job:${jobIds[i]}`);
      pipeline.del(`qstash:${jobIds[i]}`);
      pipeline.srem('jobs:all', jobIds[i]);
      deleted++;
    }

    await pipeline.exec();
    return res.status(200).json({ deleted, kept });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
