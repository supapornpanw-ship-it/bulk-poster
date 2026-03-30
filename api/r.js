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
  ${safeImg ? `<meta property="og:image" content="${safeImg}" />` : ''}
  ${safeCaption ? `<meta property="og:site_name" content="${safeCaption}" />` : ''}
  <meta property="og:type" content="website" />
  <meta http-equiv="refresh" content="0;url=${escapeHtml(safeUrl)}" />
  <title>${safeTitle}</title>
</head>
<body>
  <p>Redirecting...</p>
  <script>window.location.href = decodeURIComponent("${encodeURIComponent(safeUrl)}");</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000');
  res.status(200).send(html);
}
