// GET /api/jobs — ดึงรายการ job ทั้งหมด (auto cleanup หมดเวลา)
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

    // ดึง job IDs จาก set
    const jobIds = await redis.smembers('jobs:all');
    if (!jobIds || !jobIds.length) return res.status(200).json({ jobs: [] });

    const now = Date.now();
    const EXPIRE_HOURS = 2; // job pending เกิน 2 ชม. หลังเวลาตั้ง → ลบ
    const jobs = [];
    const toDelete = [];

    for (const id of jobIds) {
      const raw = await redis.get(`job:${id}`);
      if (!raw) {
        // key หายแล้ว (TTL หมด) → ลบออกจาก set
        toDelete.push(id);
        continue;
      }
      const job = typeof raw === 'string' ? JSON.parse(raw) : raw;

      // Auto cleanup: pending + เลยเวลาไปเกิน 2 ชม. + ไม่มี result สำเร็จ
      const hasSuccess = Object.values(job.results || {}).some(r => r.success);
      const expired = job.scheduledTime && (now - job.scheduledTime > EXPIRE_HOURS * 3600000);

      if (job.status === 'pending' && expired && !hasSuccess) {
        toDelete.push(id);
        continue;
      }

      jobs.push(job);
    }

    // ลบ job หมดอายุออกจาก Redis
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
    return res.status(200).json({ jobs, cleaned: toDelete.length });
  } catch (err) {
    console.error('Jobs error:', err);
    return res.status(500).json({ error: err.message });
  }
}
