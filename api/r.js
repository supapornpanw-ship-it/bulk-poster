// Redirect endpoint ที่ให้ OG tags ตาม query params
// Facebook scrape URL นี้ → ได้ custom Card Link
// User คลิก → redirect ไป URL จริง

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default function handler(req, res) {
  const { url, title, desc, img, caption } = req.query;
  const safeUrl = url || '';
  const safeTitle = escapeHtml(title);
  const safeDesc = escapeHtml(desc);
  const safeImg = escapeHtml(img);
  const safeCaption = escapeHtml(caption);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDesc}" />
  ${safeImg ? `<meta property="og:image" content="${safeImg}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />` : ''}
  ${safeCaption ? `<meta property="og:site_name" content="${safeCaption}" />` : ''}
  <meta property="og:type" content="website" />
  <title>${safeTitle}</title>
</head>
<body>
  <p>กำลังไปยังหน้าสินค้า...</p>
  <script>window.location.replace(${JSON.stringify(safeUrl)});</script>
</body>
</html>`;

  // ไม่ cache เพื่อให้ Facebook scrape ใหม่ได้
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(200).send(html);
}
