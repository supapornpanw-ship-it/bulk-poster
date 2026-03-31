// GET /api/jobs — ดึงรายการ job ทั้งหมด
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
      const raw = await redis.get(`job:${jobId}`);
      if (!raw) return res.status(404).json({ error: 'Job not found' });
      const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return res.status(200).json(job);
    }

    // ดึง job IDs จาก set (เร็วกว่า SCAN)
    const jobIds = await redis.smembers('jobs:all');
    if (!jobIds || !jobIds.length) return res.status(200).json({ jobs: [] });

    const jobs = [];
    for (const id of jobIds) {
      const raw = await redis.get(`job:${id}`);
      if (raw) {
        const job = typeof raw === 'string' ? JSON.parse(raw) : raw;
        jobs.push(job);
      }
    }

    jobs.sort((a, b) => (a.scheduledTime || 0) - (b.scheduledTime || 0));
    return res.status(200).json({ jobs });
  } catch (err) {
    console.error('Jobs error:', err);
    return res.status(500).json({ error: err.message });
  }
}
