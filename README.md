# مجلس ظمرة — بث نادي الضمري (Majlis Aldhamri)

منصة بث مباشر وتفاعل جماعي فائقة السرعة بدون تأخير (Ultra Low-Latency WebRTC) مصممة لمجالس الأصدقاء وبطولات الألعاب.

---

## 🌟 البنية السحابية المتكاملة (Cloud Architecture)

تم نقل جميع المكونات والخدمات إلى السحابة بالكامل (Cloud-Native) دون الحاجة لتشغيل أي سيرفرات أو Docker على الجهاز المحلي:

1. **الواجهة الأمامية (Frontend Web App)**
   - استضافة سحابية على **Vercel** مع دعم CDN وشبكة حافة عالمية (Global Edge Network) عبر HTTPS.
   - مبنية بواسطة **React 19 + Vite 8** بواجهة تفاعلية فاخرة مستوحاة من الهوية العربية الأصيلة.

2. **سيرفر البث المباشر (Cloud Media Server - MediaMTX)**
   - يعمل على السحابة عبر حاوية Docker على منصة **Railway**:
   - رابط السيرفر السحابي: `https://mediamtx-production-dc92.up.railway.app`
   - الوسائط تمر عبر ICE-TCP (منفذ `iriguchi.proxy.rlwy.net:16534`) لأن Railway لا يفتح UDP — الإعداد في `server/mediamtx/`.
   - المشاهدة مفتوحة للجميع، أما بث المجلس الرئيسي فيحتاج اسم المستخدم `majlis-host` وكلمة المرور من متغيّر `PUBLISH_PASS` في Railway.
   - يدعم بروتوكولات **WHIP** (لبث الفيديو والصوت من المتصفح أو OBS) و **WHEP** (لمشاهدة البث بأقل من 500ms).

3. **سيرفر التفاعل والشات والديوانية الصوتية (Realtime Relay Server)**
   - يعمل على السحابة كخدمة WebSocket دائمة على **Railway**:
   - رابط السيرفر السحابي: `wss://realtime-production-988e.up.railway.app` (الكود في `server/realtime.js`)
   - يدير شات المجلس، التفاعلات السريعة، التصويت اللحظي، وقائمة المتحدثين في الديوانية الصوتية.

---

## 🚀 كيفية البث

### ١. من المتصفح مباشرة (Browser Studio)
- افتح الموقع واضغط على **ابدأ البث**.
- اختر مصدر البث (مشاركة الشاشة / لعبة / الكاميرا / بث تجريبي).
- حدد الدقة ومعدل الإطارات والكودك المفضل ثم اضغط **ابدأ البث الآن**.

### ٢. من برنامج OBS Studio
- افتح إعدادات OBS: `Settings -> Stream`
- Service: `WHIP`
- Server: `https://mediamtx-production-dc92.up.railway.app/majlis/whip`
- Bearer Token: `majlis-host:<كلمة المرور>` (كلمة المرور في متغيّر `PUBLISH_PASS` بخدمة mediamtx على Railway).
- اضغط **Start Streaming**.

---

## 💻 التشغيل السحابي بواسطة Docker (Cloud Docker)

يتوفر ملف `docker-compose.yml` جاهز لتشغيل الخدمات على أي خادم سحابي (VPS / Cloud VM):

```bash
docker compose up -d
```

---

## 🛠️ التطوير المحلي (Local Development)

```bash
# تثبيت الحزم
npm install

# تشغيل الواجهة
npm run dev

# فحص الكود والبناء
npm run lint
npm run build
```
