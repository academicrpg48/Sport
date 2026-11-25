// Service worker: หน้าเว็บโหลดจากเครือข่ายก่อน (ได้ไฟล์ล่าสุดเสมอ) ถ้าออฟไลน์ใช้ที่แคชไว้
// เปลี่ยนเลขรุ่นนี้ทุกครั้งที่อัปโหลดไฟล์ใหม่ เพื่อล้างแคชเก่า
var VER = 'rpg48-v5';
var FILES = ['./', 'index.html', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(VER).then(function (c) { return c.addAll(FILES); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== VER; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var r = e.request;
  if (r.method !== 'GET' || new URL(r.url).origin !== location.origin) return;   // ไม่แตะคำขอไป Apps Script / ฟอนต์
  e.respondWith(fetch(r).then(function (res) { var cp = res.clone(); caches.open(VER).then(function (c) { c.put(r, cp); }); return res; }).catch(function () { return caches.match(r).then(function (m) { return m || caches.match('index.html'); }); }));
});
