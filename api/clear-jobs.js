// POST /api/clear-jobs — ลบ job ทั้งหมดออกจาก Redis
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
    if (!jobIds || !jobIds.length) return res.status(200).json({ deleted: 0 });

    const pipeline = redis.pipeline();
    for (const id of jobIds) {
      pipeline.del(`job:${id}`);
      pipeline.del(`qstash:${id}`);
      pipeline.srem('jobs:all', id);
    }
    await pipeline.exec();

    return res.status(200).json({ deleted: jobIds.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
