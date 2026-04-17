// POST /api/schedule — ตั้งเวลาผ่าน QStash โดยไม่ใช้ Redis
// ข้อมูลทั้งหมด (pageToken, postId, userToken) ถูกยัดลงใน QStash message body
// พอ QStash ยิง → publish.js อ่านจาก body ได้เลย ไม่ต้อง Redis

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers['x-bp-secret'];
  if (auth !== 'bp_secret_2024') return res.status(401).json({ error: 'Unauthorized' });

  try {
    const { jobId, pages, scheduledTime, delay, postData, userToken } = req.body;
    if (!jobId || !pages?.length || !scheduledTime) {
      return res.status(400).json({ error: 'Missing jobId, pages, or scheduledTime' });
    }

    const baseUrl = `https://${req.headers.host}/api/publish`;
    const qstashToken = process.env.QSTASH_TOKEN;
    const qstashIds = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const fireAt = Math.floor((scheduledTime + i * (delay || 0)) / 1000);

      // ── ยัดทุกอย่างที่ publish.js ต้องใช้ลงใน body ──
      const messageBody = {
        jobId,
        pageIndex: i,
        pageId: page.id,
        pageName: page.name,
        pageToken: page.pageToken,
        postId: page.postId,
        userToken: userToken || null, // สำหรับ refresh token ตอน publish 24hr+
      };

      const qstashResp = await fetch(`https://qstash-us-east-1.upstash.io/v2/publish/${baseUrl}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${qstashToken}`,
          'Content-Type': 'application/json',
          'Upstash-Not-Before': String(fireAt),
          'Upstash-Retries': '5',
        },
        body: JSON.stringify(messageBody),
      });

      const qstashData = await qstashResp.json();

      if (!qstashResp.ok) {
        console.error('QStash publish error:', qstashData);
        throw new Error(`QStash error: ${JSON.stringify(qstashData)}`);
      }

      qstashIds.push(qstashData.messageId);
    }

    // ส่ง qstashIds กลับให้ extension เก็บใน chrome.storage.local สำหรับ cancel
    return res.status(200).json({
      success: true,
      jobId,
      scheduled: pages.length,
      qstashIds,
    });
  } catch (err) {
    console.error('Schedule error:', err);
    return res.status(500).json({ error: err.message });
  }
}
