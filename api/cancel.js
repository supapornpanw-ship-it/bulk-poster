// POST /api/cancel — ยกเลิก QStash messages ตาม IDs ที่ extension ส่งมา
// ไม่ใช้ Redis แล้ว — extension เก็บ qstashIds ใน chrome.storage.local เอง

import { Client } from '@upstash/qstash';

const qstash = new Client({ token: process.env.QSTASH_TOKEN });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers['x-bp-secret'];
  if (auth !== 'bp_secret_2024') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { qstashIds } = req.body;
    if (!Array.isArray(qstashIds) || !qstashIds.length) {
      return res.status(400).json({ error: 'Missing qstashIds array' });
    }

    let cancelled = 0;
    for (const msgId of qstashIds) {
      try {
        await qstash.messages.delete(msgId);
        cancelled++;
      } catch (e) {
        // message อาจถูกส่งไปแล้ว ไม่เป็นไร
      }
    }

    return res.status(200).json({ success: true, cancelled });
  } catch (err) {
    console.error('Cancel error:', err);
    return res.status(500).json({ error: err.message });
  }
}
