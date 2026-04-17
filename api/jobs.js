// GET /api/jobs — ดึงรายการ job ทั้งหมด (ใช้ mget batch + in-memory cache)
// GET /api/jobs?jobId=xxx — ดึง job เดียว
import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── In-memory cache (ลด Redis requests จาก 11+/call → 0 ถ้า cache ยังสด) ──
let cachedJobs = null;
let cacheTime = 0;
const CACHE_TTL = 15000; // 15 วินาที

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

    // ── ใช้ cache ถ้ายังสด ──
    const now = Date.now();
    if (cachedJobs && (now - cacheTime) < CACHE_TTL) {
      res.setHeader('X-Cache', 'HIT');
      return res.status(200).json(cachedJobs);
    }

    // ดึง job IDs จาก set (1 Redis call)
    const jobIds = await redis.smembers('jobs:all');
    if (!jobIds || !jobIds.length) {
      const result = { jobs: [], cleaned: 0 };
      cachedJobs = result;
      cacheTime = now;
      return res.status(200).json(result);
    }

    // ── ใช้ mget ดึงทุก job ในครั้งเดียว (1 Redis call แทน N calls) ──
    const keys = jobIds.map(id => `job:${id}`);
    const rawResults = await redis.mget(...keys);

    const EXPIRE_HOURS = 2;
    const jobs = [];
    const toDelete = [];

    for (let i = 0; i < jobIds.length; i++) {
      const raw = rawResults[i];
      if (!raw) {
        toDelete.push(jobIds[i]);
        continue;
      }
      const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

      const hasSuccess = Object.values(job.results || {}).some(r => r.success);
      const expired = job.scheduledTime && (now - job.scheduledTime > EXPIRE_HOURS * 3600000);

      if (job.status === 'pending' && expired && !hasSuccess) {
        toDelete.push(jobIds[i]);
        continue;
      }

      jobs.push(job);
    }

    // ลบ job หมดอายุ (1 pipeline call)
    if (toDelete.length > 0) {
      const pipeline = redis.pipeline();
      for (const id of toDelete) {
        pipeline.del(`job:${id}`);
        pipeline.del(`qstash:${id}`);
        pipeline.srem('jobs:all', id);
      }
      await pipeline.exec();
    }

    jobs.sort((a, b) => (b.scheduledTime || 0) - (a.scheduledTime || 0));
    const result = { jobs, cleaned: toDelete.length };

    // ── Update cache ──
    cachedJobs = result;
    cacheTime = now;

    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);
  } catch (err) {
    console.error('Jobs error:', err);
    return res.status(500).json({ error: err.message });
  }
}
