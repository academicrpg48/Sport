/* Service Worker: แคชตัวแอป (HTML/ไอคอน) ให้เปิดได้เร็วและเปิดหน้าแอปได้แม้ออฟไลน์
   ข้อมูลจริงมาจาก Google Apps Script เสมอ (ข้ามโดเมน ไม่ถูกแคชที่นี่) */
var CACHE = 'rajaprachagames-v22';
var SHELL = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.origin !== location.origin) return; // POST/ข้ามโดเมน (Apps Script) ไม่แตะ
  e.respondWith(fetch(req, { cache: 'no-cache' }).then(function (r) {                      // เครือข่ายก่อน เพื่อให้เวอร์ชันใหม่ขึ้นทันที
    if (r && r.ok) { var cp = r.clone(); caches.open(CACHE).then(function (c) { c.put(req, cp); }); }
    return r;
  }).catch(function () { return caches.match(req).then(function (m) { return m || caches.match('index.html'); }); }));
});
