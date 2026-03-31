// GET /api/jobs — ดึงรายการ job ทั้งหมดที่ยังไม่เสร็จ
// GET /api/jobs?jobId=xxx — ดึง job เดียว
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { jobId } = req.query;

    if (jobId) {
      // ดึง job เดียว
      const raw = await redis.get(`job:${jobId}`);
      if (!raw) return res.status(404).json({ error: 'Job not found' });
      const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return res.status(200).json(job);
    }

    // ดึงทุก job — scan keys ที่ขึ้นต้นด้วย job:
    const keys = [];
    let cursor = 0;
    do {
      const [next, found] = await redis.scan(cursor, { match: 'job:bp_*', count: 100 });
      cursor = next;
      keys.push(...found);
    } while (cursor !== 0);

    const jobs = [];
    for (const key of keys) {
      const raw = await redis.get(key);
      if (raw) {
        const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
        jobs.push(job);
      }
    }

    // เรียงตาม scheduledTime
    jobs.sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));
    return res.status(200).json({ jobs });
  } catch (err) {
    console.error('Jobs error:', err);
    return res.status(500).json({ error: err.message });
  }
}
