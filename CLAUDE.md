# Bulk Poster — Chrome Extension

## สถานะปัจจุบัน (31 มี.ค. 2569)
- **โพสทันที**: ใช้งานได้ ✅ — Card Link (รูป, Card Title, Description, CTA, Display Link ครบ)
- **ตั้งเวลาโพส**: ใช้งานได้ ✅ — alarm แยกต่อเพจ publish ตรงเวลา
- **เชื่อมต่อ Facebook**: ใช้ EAA Token จาก Graph API Explorer (manual paste)

## สถาปัตยกรรม

### การโพส Card Link (Marketing API — 4 ขั้นตอน)
1. **Upload image** → `act_{id}/adimages` → ได้ image_hash
2. **Create creative** → `act_{id}/adcreatives` + `object_story_spec` (FormData) → ได้ creative_id
3. **Poll post_id** → GET `/{creative_id}?fields=effective_object_story_id` (วนรอ 10 ครั้ง × 3 วิ)
4. **Publish** → POST `/{post_id}` + `is_published=true`

### การตั้งเวลา (2 Phase)
- **Phase 1** (ทันทีหลังกดตั้งเวลา): ทำ step 1-3 สร้าง Card Link ทุกเพจ แต่ **ข้าม step 4** (ไม่ publish) → เก็บ postId + pageToken ใน `job.preparedPosts`
- **Phase 2** (ถึงเวลา): alarm แยกต่อเพจ (`bp_{id}_pub_{idx}`) ยิง → publish ด้วย `is_published=true`
- ดีเลย์ระหว่างเพจ = alarm เวลาต่างกัน (เช่น เพจ 1 ที่ 22:30, เพจ 2 ที่ 22:31)
- **Facebook native `scheduled_publish_time` ใช้กับ adcreatives posts ไม่ได้** → ต้องใช้ alarm แทน

### ข้อจำกัดที่ค้นพบ
- `/{page_id}/feed` ไม่ให้ custom Card Title/Image สำหรับ URL ที่ไม่ใช่ของเรา (error #100)
- `scheduled_publish_time` ใช้ได้เฉพาะโพสที่สร้างจาก `/{page_id}/feed` เท่านั้น ใช้กับ adcreatives post ไม่ได้
- Ad Account ID ต้อง clean prefix: `String(id).replace(/^act_/, '')` ก่อนใส่ `act_` กลับ
- `object_story_spec` ต้องส่งเป็น FormData (multipart) ไม่ใช่ URLSearchParams → Card Title ถึงจะขึ้น
- `call_to_action` ต้องมี `value.link`
- Facebook App ต้องเป็น Live mode (ไม่ใช่ development)
- `caption` (Display Link) ต้องเป็น URL format

### ไฟล์สำคัญ
- `background.js` — Service worker: Marketing API, alarm handler, message handler
- `content.js` — Bridge ระหว่าง web page กับ extension
- `public/index.html` — UI หลัก
- `public/app.js` — Logic ฝั่ง web
- `manifest.json` — Extension config (ต้องมี `unlimitedStorage`)

### Deploy
- Web app: `bulk-poster.vercel.app` (deploy จาก `public/` folder)
- Extension: โหลดจาก `/Users/diewjrs/Downloads/FeedConnector/`

## สิ่งที่ยังไม่ได้ทำ
- Facebook OAuth Login (มี App ID แล้ว แต่ยังใช้ manual token paste)
- UI รายละเอียด job ใน scheduled list (user ร้องขอ)
