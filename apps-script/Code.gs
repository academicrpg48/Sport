/**
 * ระบบกีฬาสีภายใน ประจำปีการศึกษา ๒๕๖๙ (Google Apps Script - Single File Backend)
 * โรงเรียนราชประชานุเคราะห์ ๔๘ จังหวัดจันทบุรี
 *
 * ฟีเจอร์หลัก
 *  - หน้าสาธารณะ: คะแนนรวม / ผลการแข่งขัน / กำหนดการ (ไม่ต้องเข้าสู่ระบบ)
 *  - จัดการสี นักเรียน (นำเข้า + แบ่งสีอัตโนมัติ) รายการแข่งขัน
 *  - ลงทะเบียนนักกีฬาโดยหัวหน้าสี (ตรวจเพศ/ระดับชั้น/จำนวนสูงสุด/จำนวนรายการต่อคน)
 *  - บันทึกผลการแข่งขัน คำนวณคะแนนสีและเหรียญอัตโนมัติ + คะแนนพิเศษ/หักคะแนน
 *  - บันทึกประวัติการแก้ไข (Logs)
 *
 * วิธีติดตั้งโดยย่อ: ดูไฟล์ README ที่ส่งมาพร้อมกัน หรือกดรัน setupSystem() 1 ครั้งหลังวางโค้ด
 */

/* ===================== MAIN CONFIG ===================== */
// เว้นว่างไว้ = ให้ระบบสร้าง Google Sheet ใหม่ให้อัตโนมัติ (หรือใช้ Sheet ที่ผูกกับสคริปต์)
// ห้ามใช้ Sheet ของระบบส่งแผนการสอนเดิมร่วมกัน เพื่อไม่ให้ข้อมูลปะปนกัน
var SPREADSHEET_ID = '';
var SESSION_TTL = 21600;      // อายุ session 6 ชั่วโมง (วินาที)
var LOGIN_MAX_FAIL = 8;       // ใส่รหัสผิดได้สูงสุดกี่ครั้ง
var LOGIN_LOCK_SEC = 600;     // ล็อกการเข้าสู่ระบบกี่วินาทีเมื่อผิดเกินกำหนด
var PUBLIC_CACHE_SEC = 30;    // แคชหน้าสาธารณะ (วินาที) ลดภาระ Sheet ตอนมีคนเปิดดูพร้อมกันมาก

const APP_TITLE = 'ระบบกีฬาสีภายใน ประจำปีการศึกษา ๒๕๖๙ - โรงเรียนราชประชานุเคราะห์ ๔๘ จังหวัดจันทบุรี';
const DB_NAME = 'ฐานข้อมูลระบบกีฬาสี_รปค48_2569';

// บทบาทผู้ใช้
//  admin      ผู้ดูแลระบบ        ทำได้ทุกอย่าง
//  organizer  คณะกรรมการจัดการแข่งขัน  จัดการรายการ/ลงทะเบียนแทนสี/บันทึกผล/ตั้งค่า/คะแนนพิเศษ
//  referee    กรรมการ/ผู้บันทึกผล   บันทึกผลการแข่งขัน
//  colorHead  ครูที่ปรึกษา/หัวหน้าสี  ลงทะเบียนนักกีฬาของสีตนเอง
//  viewer     ผู้บริหาร/ผู้ชม      ดูข้อมูลได้อย่างเดียว
const ROLES = ['admin', 'organizer', 'referee', 'colorHead', 'viewer'];
const EVENT_MODES = ['individual', 'team', 'color'];
const EVENT_GENDERS = ['ชาย', 'หญิง', 'ผสม'];
// ระดับ: ป.ต้น = ป.1-3, ป.ปลาย = ป.4-6, ประถม = ป.1-6, ม.ต้น = ม.1-3, ม.ปลาย = ม.4-6
const EVENT_LEVELS = ['ป.ต้น', 'ป.ปลาย', 'ประถม', 'ม.ต้น', 'ม.ปลาย', 'ทุกระดับ'];
const EVENT_STATUS = ['planned', 'ongoing', 'finished'];

// โครงสร้างตารางใน Google Sheets
const SCHEMA = {
  Users: ['id', 'username', 'passwordHash', 'fullname', 'role', 'colorId', 'position', 'active', 'mustChange', 'createdAt'],
  Colors: ['id', 'name', 'hex', 'advisors', 'motto', 'sortOrder'],
  Students: ['id', 'studentNo', 'fullname', 'gender', 'classLevel', 'room', 'colorId', 'active'],
  Events: ['id', 'code', 'name', 'category', 'gender', 'levelGroup', 'mode', 'maxPerColor', 'points', 'date', 'time', 'venue', 'status', 'sortOrder', 'note'],
  Entries: ['id', 'eventId', 'colorId', 'studentId', 'createdBy', 'createdAt'],
  Matches: ['id', 'eventId', 'stage', 'rd', 'round', 'no', 'colorA', 'colorB', 'srcA', 'srcB', 'scoreA', 'scoreB', 'winner', 'status', 'date', 'time', 'venue', 'note', 'updatedBy', 'updatedAt'],
  Banner: ['id', 'data'],
  CertTpl: ['id', 'data'],
  CertNo: ['key', 'no', 'at'],
  Seasons: ['id', 'year', 'archivedAt', 'archivedBy', 'data'],
  CertFont: ['id', 'data'],
  Results: ['id', 'eventId', 'rank', 'colorId', 'studentId', 'athleteName', 'record', 'points', 'updatedBy', 'updatedAt'],
  Adjustments: ['id', 'colorId', 'points', 'reason', 'createdBy', 'createdAt'],
  Settings: ['key', 'value'],
  Sessions: ['sessionId', 'userId', 'createdAt', 'expiresAt'],
  Logs: ['at', 'user', 'action', 'detail']
};

const DEFAULT_SETTINGS = {
  schoolName: 'โรงเรียนราชประชานุเคราะห์ ๔๘ จังหวัดจันทบุรี',
  orgName: 'สำนักบริหารงานการศึกษาพิเศษ',   // หน่วยงานต้นสังกัด (แสดงใต้ชื่อโรงเรียน)
  academicYear: '๒๕๖๙',
  eventName: 'กีฬาสีภายใน',
  startDate: '',
  endDate: '',
  venue: 'สนามกีฬาโรงเรียน',
  announcement: '',
  logoUrl: '',
  directorName: '',
  registrationOpen: 'true',      // เปิดรับลงทะเบียนนักกีฬา (หัวหน้าสีแก้ไขได้เมื่อเปิดอยู่)
  publicScoreVisible: 'true',    // แสดงคะแนน/ผลบนหน้าสาธารณะ (ปิดไว้เพื่อลุ้นก่อนประกาศผล)
  publicShowNames: 'false',      // แสดงชื่อนักกีฬาในผลบนหน้าสาธารณะ (ค่าเริ่มต้น: ไม่แสดง เพื่อความเป็นส่วนตัวของนักเรียน)
  defaultPoints: '5,3,2,1',
  maxEventsPerStudent: '3',      // นักเรียนลงแข่งได้สูงสุดกี่รายการ (0 = ไม่จำกัด)
  contestShown: '',              // รหัสรายการประกวดที่ประกาศผลบนหน้าสาธารณะแล้ว (คั่นด้วยจุลภาค) — ประกาศแยกทีละรายการ
  bannerVer: '',                 // รุ่นของป้ายการแข่งขัน (ว่าง = ไม่มีป้าย) — ตัวภาพเก็บในชีต Banner
  certOpen: 'false',             // เปิดให้ดาวน์โหลดเกียรติบัตร (สวิตช์รวม เฉพาะผู้ดูแลระบบเปิด/ปิด)
  certEvents: '',                // รหัสรายการที่เปิดให้โหลดเกียรติบัตร (คั่นด้วยจุลภาค)
  certChairName: '',             // ชื่อประธานกรรมการจัดการแข่งขัน (ลายเซ็นบนเกียรติบัตร)
  certChairTitle: 'ประธานกรรมการจัดการแข่งขัน',
  certRefs: '',
  certRefTitle: 'กรรมการตัดสิน',
  certTplVer: '',                // รุ่นของภาพแม่แบบเกียรติบัตร (ว่าง = ใช้แบบมาตรฐานของระบบ)
  certFontVer: '',               // รุ่นของไฟล์ฟอนต์เกียรติบัตรที่อัปโหลด (ว่าง = ใช้ฟอนต์ Sangkhamonthon ที่ติดตั้งในเครื่อง/ฟอนต์สำรอง)
  certLayout: '',                // ตำแหน่ง/สีตัวอักษรบนแม่แบบ (JSON)
  certNoOn: 'true',              // พิมพ์เลขที่เกียรติบัตร
  certNoPrefix: 'รปค.๔๘',        // คำนำหน้าเลขที่
  certNoStart: '1',              // เลขเริ่มต้น
  certNoPad: '3',                // จำนวนหลัก (เติม 0 ข้างหน้า)
  certNoYear: 'true',            // ต่อท้าย /ปีการศึกษา
  certNoThai: 'true',            // ใช้เลขไทย
  certDate: ''                   // วันที่ออกเกียรติบัตร (ว่าง = วันที่พิมพ์)
};
const PUBLIC_SETTING_KEYS = ['orgName', 'certFontVer', 'certTplVer', 'certLayout', 'certNoOn', 'certNoPrefix', 'certNoPad', 'certNoYear', 'certNoThai', 'schoolName', 'academicYear', 'eventName', 'startDate', 'endDate', 'venue', 'announcement', 'logoUrl', 'publicScoreVisible', 'publicShowNames', 'contestShown', 'directorName', 'bannerVer', 'certOpen', 'certEvents', 'certChairName', 'certChairTitle', 'certDate'];

// สีเริ่มต้นของระบบ (แก้ไข/เพิ่ม/ลบได้ในเมนู "สี")
const DEFAULT_COLORS = [
  { name: 'สีแดง', hex: '#DC2626' },
  { name: 'สีน้ำเงิน', hex: '#2563EB' },
  { name: 'สีเขียว', hex: '#16A34A' },
  { name: 'สีเหลือง', hex: '#EAB308' }
];

// แคชระดับ Execution
var _SS_MEMO = null;
var _SH_MEMO = {};

/* ===================== WEB APP ENTRY ===================== */
function doGet(e) {
  ensureDatabase_(false);
  let hasPage = true;
  try { HtmlService.createTemplateFromFile('index'); } catch (err) { hasPage = false; }
  if (!hasPage) return ContentService.createTextOutput('ระบบกีฬาสีภายใน: API พร้อมใช้งาน (ใช้งานผ่านแอป PWA)'); // โหมด PWA: ไม่ได้อัปโหลดไฟล์ index
  const t = HtmlService.createTemplateFromFile('index');
  // ฝังข้อมูลหน้าสาธารณะลงในหน้าเว็บเลย เพื่อให้แสดงผลทันทีโดยไม่ต้องรอเรียกเซิร์ฟเวอร์อีกรอบ
  let boot = 'null';
  try { boot = JSON.stringify(getPublicBoard()).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, ''); } catch (err) {}
  t.bootJson = boot;
  return t.evaluate()
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ===================== API สำหรับแอป PWA (โฮสต์บน GitHub Pages) =====================
 * รับ POST (Content-Type: text/plain) เป็น JSON { fn, args:[...] } คืน { ok, value } หรือ { ok:false, error }
 * ใช้ได้เฉพาะฟังก์ชันที่อยู่ในรายการอนุญาตด้านล่าง (ฟังก์ชันภายในที่ลงท้าย _ เรียกไม่ได้)
 */
const API_FUNCS_ = [
  'addProgramEvents', 'addSampleEvents', 'adminResetPassword', 'applyMatchRanking', 'applyRunLimits', 'archiveSeason',
  'assignCertNumbers', 'autoAssignColors', 'changePassword', 'clearAllMatches', 'clearDataCache', 'clearMatches',
  'deleteAdjustment', 'deleteColor', 'deleteEvent', 'deleteEvents', 'deleteMatch', 'deleteSeason',
  'deleteStudent', 'deleteUser', 'forceChangePassword', 'generateAllMatches', 'generateLanes', 'generateMatches',
  'getBanner', 'getBootstrap', 'getCertFont', 'getCertNumbers', 'getCertTemplate', 'getLogs',
  'getPublicBoard', 'getSeasons', 'importStudents', 'login', 'logout', 'publicCertNumbers',
  'resetCertNumbers', 'resetSeasonData', 'saveAdjustment', 'saveBanner', 'saveCertFont', 'saveCertSettings',
  'saveCertTemplate', 'saveColor', 'saveEntries', 'saveEvent', 'saveMatch', 'saveResults',
  'saveSettings', 'saveStudent', 'saveUser', 'setEventStatus', 'startNewSeason'
];
function doPost(e) {
  const out = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = String(req.fn || '');
    if (API_FUNCS_.indexOf(fn) < 0) return out({ ok: false, error: 'ไม่พบฟังก์ชัน ' + fn });
    ensureDatabase_(false);
    const args = Array.isArray(req.args) ? req.args : [];
    const value = (typeof globalThis !== 'undefined' ? globalThis : this)[fn].apply(null, args);
    return out({ ok: true, value: value === undefined ? null : value });
  } catch (err) {
    return out({ ok: false, error: String((err && err.message) || err).replace(/^Error:\s*/, '') });
  }
}

/**
 * กด Run ฟังก์ชันนี้ 1 ครั้งหลังวางโค้ด เพื่ออนุญาตสิทธิ์ สร้างตารางข้อมูล
 * และดูรหัสผ่านชั่วคราวของผู้ดูแลระบบ (ที่ View > Logs / Execution log)
 */
function setupSystem() {
  try { CacheService.getScriptCache().remove('DB_READY_V1'); } catch (e) {}
  ensureDatabase_(true);
  const ss = getSpreadsheet_();
  const pw = PropertiesService.getScriptProperties().getProperty('INITIAL_ADMIN_PASSWORD');
  Logger.log('ฐานข้อมูล: ' + ss.getUrl());
  Logger.log(pw
    ? 'บัญชีผู้ดูแลระบบ -> ชื่อผู้ใช้: admin / รหัสผ่านชั่วคราว: ' + pw + ' (ระบบจะบังคับเปลี่ยนเมื่อเข้าสู่ระบบครั้งแรก)'
    : 'ผู้ดูแลระบบเปลี่ยนรหัสผ่านแล้ว หากลืมรหัสผ่านให้รัน resetAdminPassword()');
}

/** กรณีลืมรหัสผ่านผู้ดูแลระบบ: รันจากหน้าแก้ไขสคริปต์ แล้วดูรหัสใหม่ใน Logs */
function resetAdminPassword() {
  ensureDatabase_(true);
  const sh = getSheet_('Users');
  const admin = sheetToObjects_(sh).find(u => u.role === 'admin' && u.active !== 'false');
  if (!admin) throw new Error('ไม่พบบัญชีผู้ดูแลระบบ');
  const temp = tempPassword_();
  updateRowById_(sh, admin.id, { passwordHash: hashPw_(admin.id, temp), mustChange: 'true' });
  PropertiesService.getScriptProperties().setProperty('INITIAL_ADMIN_PASSWORD', temp);
  Logger.log('ชื่อผู้ใช้: ' + admin.username + ' / รหัสผ่านชั่วคราวใหม่: ' + temp);
}

/* ===================== DATABASE ===================== */
function getSpreadsheet_() {
  if (_SS_MEMO) return _SS_MEMO;
  if (SPREADSHEET_ID && String(SPREADSHEET_ID).trim() !== '') {
    try {
      _SS_MEMO = SpreadsheetApp.openById(String(SPREADSHEET_ID).trim());
      return _SS_MEMO;
    } catch (e) {
      throw new Error('ไม่สามารถเปิด Google Sheet ตาม SPREADSHEET_ID ที่ระบุได้: ' + e.message);
    }
  }
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) {}
  if (ss) { _SS_MEMO = ss; return ss; }
  const props = PropertiesService.getScriptProperties();
  const savedId = props.getProperty('SPREADSHEET_ID');
  if (savedId) {
    try { _SS_MEMO = SpreadsheetApp.openById(savedId); return _SS_MEMO; } catch (e) {}
  }
  ss = SpreadsheetApp.create(DB_NAME);
  props.setProperty('SPREADSHEET_ID', ss.getId());
  _SS_MEMO = ss;
  return ss;
}

function getSheet_(name, checkColumns) {
  if (_SH_MEMO[name] && !checkColumns) return _SH_MEMO[name];
  const ss = getSpreadsheet_();
  let sh = ss.getSheetByName(name);
  const cols = SCHEMA[name] || [];
  if (!sh) {
    sh = ss.insertSheet(name);
    if (cols.length) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.setFrozenRows(1);
    }
  } else if (checkColumns && cols.length) {
    const lastCol = sh.getLastColumn();
    if (lastCol === 0) {
      sh.getRange(1, 1, 1, cols.length).setValues([cols]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else {
      const existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(c => String(c).trim());
      const missing = cols.filter(c => !existing.includes(c));
      if (missing.length) tblInvalidate_(name);
      if (missing.length) sh.getRange(1, lastCol + 1, 1, missing.length).setValues([missing]).setFontWeight('bold');
    }
  }
  _SH_MEMO[name] = sh;
  return sh;
}

function ensureDatabase_(force) {
  const cache = CacheService.getScriptCache();
  if (!force) {
    try { if (cache.get('DB_READY_V1') === '1') return; } catch (e) {}
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    Object.keys(SCHEMA).forEach(name => getSheet_(name, true));
    // ลบชีตเริ่มต้น "Sheet1"/"ชีต1" ที่ว่างเปล่าเมื่อสร้างไฟล์ใหม่
    try {
      const ss = getSpreadsheet_();
      ['Sheet1', 'ชีต1'].forEach(n => {
        const s = ss.getSheetByName(n);
        if (s && ss.getSheets().length > 1 && s.getLastRow() === 0) ss.deleteSheet(s);
      });
    } catch (e) {}

    // การตั้งค่า
    const stRows = sheetToObjects_(getSheet_('Settings'));
    const have = {};
    stRows.forEach(r => have[r.key] = true);
    Object.keys(DEFAULT_SETTINGS).forEach(k => {
      if (!have[k]) appendRowObject_(getSheet_('Settings'), { key: k, value: DEFAULT_SETTINGS[k] });
    });
    const flags = {};
    stRows.forEach(r => flags[r.key] = r.value);

    // สีเริ่มต้น (ครั้งเดียว)
    if (!flags._colorsSeeded) {
      if (!sheetToObjects_(getSheet_('Colors')).length) {
        appendRowsObjects_(getSheet_('Colors'), DEFAULT_COLORS.map((c, i) => ({
          id: newId_('c_'), name: c.name, hex: c.hex, advisors: '', motto: '', sortOrder: String(i + 1)
        })));
      }
      appendRowObject_(getSheet_('Settings'), { key: '_colorsSeeded', value: '1' });
    }
    // รายการแข่งขันตัวอย่าง (ครั้งเดียว) แก้ไข/ลบได้
    if (!flags._eventsSeeded) {
      if (!sheetToObjects_(getSheet_('Events')).length) seedSampleEvents_();
      appendRowObject_(getSheet_('Settings'), { key: '_eventsSeeded', value: '1' });
    }

    // บัญชีผู้ดูแลระบบ
    const users = sheetToObjects_(getSheet_('Users'));
    if (!users.some(u => u.role === 'admin')) {
      const id = newId_('u_');
      const temp = tempPassword_();
      appendRowObject_(getSheet_('Users'), {
        id: id, username: 'admin', passwordHash: hashPw_(id, temp), fullname: 'ผู้ดูแลระบบ',
        role: 'admin', colorId: '', position: 'ผู้ดูแลระบบ', active: 'true', mustChange: 'true',
        createdAt: new Date().toISOString()
      });
      PropertiesService.getScriptProperties().setProperty('INITIAL_ADMIN_PASSWORD', temp);
    }
    try { cache.put('DB_READY_V1', '1', 21600); } catch (e) {}
  } finally {
    try { tblFlush_(); } catch (e) {}
    lock.releaseLock();
  }
}

/** รายการแข่งขันตัวอย่าง (ชุดเริ่มต้น) ปรับแก้ได้ตามต้องการ */
function sampleEventDefs_() {
  const list = [];
  const sexes = ['ชาย', 'หญิง'];
  const lvls = ['ม.ต้น', 'ม.ปลาย'];
  const add = (name, category, gender, level, mode, max, points, venue) =>
    list.push({ name, category, gender, levelGroup: level, mode, maxPerColor: max, points, venue: venue || '' });
  ['100 เมตร', '200 เมตร', '400 เมตร'].forEach(n => lvls.forEach(l => sexes.forEach(s =>
    add('วิ่ง ' + n, 'กรีฑา', s, l, 'individual', 1, '5,3,2,1', 'ลู่วิ่งกรีฑา'))));
  lvls.forEach(l => sexes.forEach(s => add('กระโดดไกล', 'กรีฑา', s, l, 'individual', 2, '5,3,2,1', 'สนามกรีฑา')));
  lvls.forEach(l => sexes.forEach(s => add('วิ่งผลัด 4x100 เมตร', 'กรีฑา', s, l, 'team', 6, '5,3,2,1', 'ลู่วิ่งกรีฑา')));
  add('ฟุตบอล 7 คน', 'กีฬาประเภททีม', 'ชาย', 'ม.ต้น', 'team', 12, '5,3,2,1', 'สนามฟุตบอล');
  add('ฟุตบอล 7 คน', 'กีฬาประเภททีม', 'ชาย', 'ม.ปลาย', 'team', 12, '5,3,2,1', 'สนามฟุตบอล');
  add('วอลเลย์บอล', 'กีฬาประเภททีม', 'หญิง', 'ม.ต้น', 'team', 10, '5,3,2,1', 'สนามวอลเลย์บอล');
  add('วอลเลย์บอล', 'กีฬาประเภททีม', 'หญิง', 'ม.ปลาย', 'team', 10, '5,3,2,1', 'สนามวอลเลย์บอล');
  add('ตะกร้อ', 'กีฬาประเภททีม', 'ชาย', 'ทุกระดับ', 'team', 6, '5,3,2,1', 'สนามตะกร้อ');
  add('เปตอง', 'กีฬาประเภททีม', 'ผสม', 'ทุกระดับ', 'team', 4, '5,3,2,1', 'ลานเปตอง');
  add('ชักเย่อ', 'กีฬาประเภททีม', 'ผสม', 'ทุกระดับ', 'team', 12, '5,3,2,1', 'สนามกีฬา');
  add('ขบวนพาเหรด', 'ประกวด', 'ผสม', 'ทุกระดับ', 'color', 0, '5,3,2,1', 'สนามกีฬา');
  add('ประกวดกองเชียร์', 'ประกวด', 'ผสม', 'ทุกระดับ', 'color', 0, '5,3,2,1', 'สแตนด์เชียร์');
  add('ประกวดตกแต่งสแตนด์เชียร์', 'ประกวด', 'ผสม', 'ทุกระดับ', 'color', 0, '5,3,2,1', 'สแตนด์เชียร์');
  add('น้ำใจนักกีฬา', 'ประกวด', 'ผสม', 'ทุกระดับ', 'color', 0, '5,3,2,1', '');
  return list;
}

function seedSampleEvents_() {
  const defs = sampleEventDefs_();
  appendRowsObjects_(getSheet_('Events'), defs.map((d, i) => ({
    id: newId_('e_'), code: pad2_(i + 1), name: d.name, category: d.category, gender: d.gender,
    levelGroup: d.levelGroup, mode: d.mode, maxPerColor: String(d.maxPerColor), points: d.points,
    date: '', time: '', venue: d.venue, status: 'planned', sortOrder: String(i + 1), note: ''
  })));
}

/* ===================== SHEET HELPERS ===================== */
function getHeaders_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return [];
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
}

function readSheetRaw_(sh) {
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return [];
  const vals = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = vals[0].map(h => String(h).trim());
  const list = [];
  for (let r = 1; r < vals.length; r++) {
    const row = vals[r];
    if (row.every(c => c === '' || c === null)) continue;
    const obj = {};
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i];
      if (!h) continue;
      const v = row[i];
      obj[h] = v instanceof Date ? v.toISOString() : String(v === null || v === undefined ? '' : v);
    }
    list.push(obj);
  }
  return list;
}

/* ---- แคชตารางอ่านบ่อย (ลดเวลาโหลด) : อ่านจากแคชก่อน เขียนครั้งใดจะเปลี่ยนรุ่นแคชของตารางนั้นทันที ---- */
const CACHEABLE_TABLES_ = { Users: 1, Colors: 1, Students: 1, Events: 1, Entries: 1, Results: 1, Adjustments: 1, Matches: 1, Settings: 1 };
const TBL_CHUNK_ = 24000, TBL_TTL_ = 600;
let _LOCKED_ = false; // ระหว่างทำงานใน withLock_ อ่านจากชีตตรง ๆ เสมอ (กันข้อมูลเก่า)

const _DIRTY_ = {};
function tblFlush_() { Object.keys(_DIRTY_).forEach(n => { tblInvalidate_(n, true); delete _DIRTY_[n]; }); }
function tblInvalidate_(name, again) {
  if (!CACHEABLE_TABLES_[name]) return;
  if (!again) _DIRTY_[name] = true;
  try { CacheService.getScriptCache().put('TG_' + name, Utilities.getUuid(), 21600); } catch (e) {}
}

function sheetToObjects_(sh) {
  const name = sh.getName();
  if (!CACHEABLE_TABLES_[name] || _LOCKED_) return readSheetRaw_(sh);
  let cache = null, gen = null;
  try {
    cache = CacheService.getScriptCache();
    gen = cache.get('TG_' + name);
    if (!gen) { gen = Utilities.getUuid(); cache.put('TG_' + name, gen, 21600); }
    const meta = cache.get('TM_' + name + '_' + gen);
    if (meta) {
      const n = toInt_(meta, 0), keys = [];
      for (let i = 0; i < n; i++) keys.push('TD_' + name + '_' + gen + '_' + i);
      let got = {};
      if (typeof cache.getAll === 'function') got = cache.getAll(keys); else keys.forEach(k => { const v = cache.get(k); if (v !== null && v !== undefined) got[k] = v; });
      let ok = n > 0;
      const parts = [];
      for (let i = 0; i < n && ok; i++) { const v = got[keys[i]]; if (v === undefined || v === null) ok = false; else parts.push(v); }
      if (ok) return JSON.parse(parts.join(''));
    }
  } catch (e) { cache = null; }
  const list = readSheetRaw_(sh);
  if (cache) {
    try {
      if (cache.get('TG_' + name) === gen) { // ไม่มีใครเขียนระหว่างอ่าน
        const json = JSON.stringify(list), n = Math.ceil(json.length / TBL_CHUNK_);
        const put = {};
        for (let i = 0; i < n; i++) put['TD_' + name + '_' + gen + '_' + i] = json.substr(i * TBL_CHUNK_, TBL_CHUNK_);
        put['TM_' + name + '_' + gen] = String(n);
        if (typeof cache.putAll === 'function') cache.putAll(put, TBL_TTL_); else Object.keys(put).forEach(k => cache.put(k, put[k], TBL_TTL_));
      }
    } catch (e) {}
  }
  return list;
}

// เขียนค่าเป็นข้อความล้วน (@) เพื่อไม่ให้ Sheets แปลงวันที่/เลขนำหน้าศูนย์เอง
function objToRow_(headers, obj) {
  return headers.map(h => obj[h] !== undefined && obj[h] !== null ? String(obj[h]) : '');
}

function ensureRows_(sh, needRows) {
  const max = sh.getMaxRows();
  if (max < needRows) sh.insertRowsAfter(max, needRows - max);
}

function appendRowObject_(sh, obj) { appendRowsObjects_(sh, [obj]); }

function appendRowsObjects_(sh, objs) {
  if (!objs || !objs.length) return;
  tblInvalidate_(sh.getName());
  const headers = getHeaders_(sh);
  const start = Math.max(sh.getLastRow(), 1) + 1;
  ensureRows_(sh, start + objs.length - 1);
  const rng = sh.getRange(start, 1, objs.length, headers.length);
  rng.setNumberFormat('@');
  rng.setValues(objs.map(o => objToRow_(headers, o)));
}

function updateRowById_(sh, id, updates, keyField) {
  tblInvalidate_(sh.getName());
  const key = keyField || 'id';
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2) return false;
  const vals = sh.getRange(1, 1, lastRow, lastCol).getValues();
  const headers = vals[0].map(h => String(h).trim());
  const idIdx = headers.indexOf(key);
  if (idIdx === -1) return false;
  for (let r = 1; r < vals.length; r++) {
    if (String(vals[r][idIdx]) === String(id)) {
      const row = vals[r].slice();
      Object.keys(updates).forEach(k => {
        const c = headers.indexOf(k);
        if (c !== -1) row[c] = updates[k] === null || updates[k] === undefined ? '' : String(updates[k]);
      });
      const rng = sh.getRange(r + 1, 1, 1, lastCol);
      rng.setNumberFormat('@');
      rng.setValues([row]);
      return true;
    }
  }
  return false;
}

/** เขียนตารางทั้งชุดใหม่ (ใช้กับการแทนที่/ลบหลายรายการ) */
function writeTable_(name, objs) {
  tblInvalidate_(name);
  const sh = getSheet_(name);
  const headers = getHeaders_(sh);
  const lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  if (!objs.length) return;
  ensureRows_(sh, objs.length + 1);
  const rng = sh.getRange(2, 1, objs.length, headers.length);
  rng.setNumberFormat('@');
  rng.setValues(objs.map(o => objToRow_(headers, o)));
}

function deleteRowById_(sh, id, keyField) {
  const key = keyField || 'id';
  const name = sh.getName();
  const all = sheetToObjects_(sh);
  const rest = all.filter(r => String(r[key]) !== String(id));
  if (rest.length === all.length) return false;
  writeTable_(name, rest);
  return true;
}

function getSettingsMap_() {
  const map = Object.assign({}, DEFAULT_SETTINGS);
  sheetToObjects_(getSheet_('Settings')).forEach(r => { map[r.key] = r.value; });
  return map;
}

/* ===================== COMMON UTILS ===================== */
function newId_(prefix) { return prefix + Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function pad2_(n) { return (n < 10 ? '0' : '') + n; }
function toInt_(v, d) { const n = parseInt(v, 10); return isNaN(n) ? (d || 0) : n; }
function round2_(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function nowIso_() { return new Date().toISOString(); }
function thaiDigitsToArabic_(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[๐-๙]/g, c => String(c.charCodeAt(0) - 0x0E50));
}
function tempPassword_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw new Error('ระบบกำลังประมวลผลคำสั่งอื่นอยู่ กรุณาลองใหม่อีกครั้ง');
  const prev = _LOCKED_;
  _LOCKED_ = true;
  try { return fn(); } finally { _LOCKED_ = prev; try { tblFlush_(); } catch (e) {} lock.releaseLock(); }
}

/** ผู้ดูแลระบบ: ล้างแคชข้อมูลทั้งหมด (ใช้เมื่อแก้ข้อมูลในชีตโดยตรง) */
function clearDataCache(sid) {
  requireRole_(sid, ['admin']);
  Object.keys(CACHEABLE_TABLES_).forEach(n => tblInvalidate_(n));
  tblFlush_();
  bustPublicCache_();
  return { ok: true };
}

function bustPublicCache_() {
  try { CacheService.getScriptCache().remove('PUBLIC_BOARD_V1'); } catch (e) {}
}

function logAction_(u, action, detail) {
  try {
    appendRowObject_(getSheet_('Logs'), {
      at: nowIso_(), user: u ? (u.fullname + ' (' + u.username + ')') : '', action: action,
      detail: String(detail || '').slice(0, 900)
    });
  } catch (e) {}
}

/** แปลง "ม.1", "ม1", "ม.๑", "มัธยมศึกษาปีที่ 1" เป็นรูปแบบ "ม.1" */
function normalizeClassLevel_(s) {
  const t = thaiDigitsToArabic_(s).trim();
  if (!t) return '';
  const m = t.match(/(\d+)/);
  if (m && (/ประถม/.test(t) || /^ป\.?\s*\d/.test(t))) return 'ป.' + parseInt(m[1], 10);
  if (m && (/ม/.test(t) || /^\d+$/.test(t))) return 'ม.' + parseInt(m[1], 10);
  return t;
}
function normalizeRoom_(s) {
  const t = thaiDigitsToArabic_(s).trim();
  const m = t.match(/(\d+)/);
  return m ? String(parseInt(m[1], 10)) : t;
}
function levelGroupOf_(classLevel) {
  const t = thaiDigitsToArabic_(classLevel).trim();
  const p = t.match(/^ป\.?\s*(\d+)/);
  if (p) { const k = parseInt(p[1], 10); return k >= 1 && k <= 3 ? 'ป.ต้น' : (k >= 4 && k <= 6 ? 'ป.ปลาย' : ''); }
  const m = t.match(/ม\.?\s*(\d+)/);
  if (!m) return '';
  const n = parseInt(m[1], 10);
  if (n >= 1 && n <= 3) return 'ม.ต้น';
  if (n >= 4 && n <= 6) return 'ม.ปลาย';
  return '';
}
function normalizeGender_(g, fullname) {
  const t = String(g || '').trim().toLowerCase();
  if (['ช', 'ชาย', 'male', 'm', 'ด.ช.', 'นาย'].indexOf(t) !== -1) return 'ชาย';
  if (['ญ', 'หญิง', 'female', 'f', 'ด.ญ.', 'นาง', 'นางสาว', 'น.ส.'].indexOf(t) !== -1) return 'หญิง';
  const n = String(fullname || '').trim();
  if (/^(ด\.ช\.|เด็กชาย|นาย)/.test(n)) return 'ชาย';
  if (/^(ด\.ญ\.|เด็กหญิง|นางสาว|น\.ส\.|นาง)/.test(n)) return 'หญิง';
  return '';
}
function parsePoints_(s) {
  return String(s || '').split(/[,\s]+/).filter(x => x !== '').map(Number).filter(n => !isNaN(n));
}
function pointsForRank_(scheme, rank) {
  const arr = parsePoints_(scheme);
  return rank >= 1 && rank <= arr.length ? arr[rank - 1] : 0;
}
function levelMatches_(evLevel, classLevel) {
  if (!evLevel || evLevel === 'ทุกระดับ') return true;
  const g = levelGroupOf_(classLevel);
  if (!g) return false;
  if (evLevel === 'ประถม') return g === 'ป.ต้น' || g === 'ป.ปลาย';
  if (evLevel === 'ม.ปลาย') return g === 'ม.ต้น' || g === 'ม.ปลาย'; // ม.ต้นลงแข่งรุ่น ม.ปลายได้ แต่ ม.ปลายลงรุ่น ม.ต้นไม่ได้
  return g === evLevel;
}
function eligibilityProblem_(ev, st) {
  if (ev.gender === 'ชาย' && st.gender !== 'ชาย') return 'เพศไม่ตรงกับรายการ';
  if (ev.gender === 'หญิง' && st.gender !== 'หญิง') return 'เพศไม่ตรงกับรายการ';
  if (!levelMatches_(ev.levelGroup, st.classLevel)) {
    return 'ระดับชั้นไม่ตรงกับรายการ';
  }
  return '';
}
function eventLabel_(ev) {
  return ev.name + (ev.gender && ev.gender !== 'ผสม' ? ' ' + ev.gender : '') + (ev.levelGroup && ev.levelGroup !== 'ทุกระดับ' ? ' ' + ev.levelGroup : '');
}

/* ===================== SECURITY ===================== */
function getPepper_() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('PW_PEPPER');
  if (!p) { p = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('PW_PEPPER', p); }
  return p;
}

function hashPw_(userId, pw) {
  const raw = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    getPepper_() + '|' + String(userId) + '|' + String(pw), Utilities.Charset.UTF_8);
  return raw.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');
}

function validatePassword_(pw) {
  if (!pw || String(pw).length < 6) throw new Error('รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร');
}

function isStaff_(u) { return !!u && (u.role === 'admin' || u.role === 'organizer'); }
function canRecord_(u) { return !!u && (u.role === 'admin' || u.role === 'organizer' || u.role === 'referee'); }

function requireUser_(sid, preloadedUsers) {
  if (!sid) throw new Error('SESSION_EXPIRED');
  const cache = CacheService.getScriptCache();
  let userId = null;
  try { userId = cache.get('SID_' + sid); } catch (e) {}
  if (!userId) {
    const sSh = getSheet_('Sessions');
    const s = sheetToObjects_(sSh).find(x => x.sessionId === sid);
    if (!s) throw new Error('SESSION_EXPIRED');
    if (s.expiresAt && new Date(s.expiresAt) < new Date()) {
      deleteRowById_(sSh, sid, 'sessionId');
      throw new Error('SESSION_EXPIRED');
    }
    userId = s.userId;
    try { cache.put('SID_' + sid, userId, 3600); } catch (e) {}
  }
  const users = preloadedUsers || sheetToObjects_(getSheet_('Users'));
  const u = users.find(x => x.id === userId);
  if (!u || u.active === 'false') throw new Error('SESSION_EXPIRED');
  return u;
}

function requireRole_(sid, roles) {
  const u = requireUser_(sid);
  if (roles.indexOf(u.role) === -1) throw new Error('คุณไม่มีสิทธิ์ใช้งานส่วนนี้');
  return u;
}

/* ===================== PUBLIC & AUTH API ===================== */
function getPublicSettings() {
  const st = getSettingsMap_();
  const out = {};
  PUBLIC_SETTING_KEYS.forEach(k => out[k] = st[k] || '');
  return out;
}

function login(username, password) {
  ensureDatabase_(false);
  const uName = String(username || '').trim().toLowerCase();
  const pw = String(password || '');
  if (!uName || !pw) throw new Error('กรุณากรอกชื่อผู้ใช้และรหัสผ่าน');
  const cache = CacheService.getScriptCache();
  const failKey = 'LF_' + uName.replace(/[^a-z0-9_.-]/g, '').slice(0, 40);
  let fails = 0;
  try { fails = parseInt(cache.get(failKey) || '0', 10) || 0; } catch (e) {}
  if (fails >= LOGIN_MAX_FAIL) throw new Error('ใส่รหัสผ่านผิดหลายครั้งเกินไป กรุณารอ ' + Math.round(LOGIN_LOCK_SEC / 60) + ' นาที แล้วลองใหม่');

  const users = sheetToObjects_(getSheet_('Users'));
  const u = users.find(x => String(x.username || '').trim().toLowerCase() === uName);
  if (!u || hashPw_(u.id, pw) !== u.passwordHash) {
    try { cache.put(failKey, String(fails + 1), LOGIN_LOCK_SEC); } catch (e) {}
    throw new Error('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  if (u.active === 'false') throw new Error('บัญชีผู้ใช้นี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ');
  try { cache.remove(failKey); } catch (e) {}

  const sid = 'sid_' + Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  const now = new Date();
  const ttl = Number(SESSION_TTL) || 21600;
  const sSh = getSheet_('Sessions');
  // เก็บกวาด session ที่หมดอายุเป็นครั้งคราว
  if (sSh.getLastRow() > 150) {
    const alive = sheetToObjects_(sSh).filter(s => new Date(s.expiresAt) > now);
    writeTable_('Sessions', alive);
  }
  appendRowObject_(sSh, {
    sessionId: sid, userId: u.id, createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttl * 1000).toISOString()
  });
  try { cache.put('SID_' + sid, u.id, Math.min(ttl, 21600)); } catch (e) {}
  logAction_(u, 'login', '');
  return { sessionId: sid };
}

function logout(sid) {
  if (!sid) return { ok: true };
  try { CacheService.getScriptCache().remove('SID_' + sid); } catch (e) {}
  try { deleteRowById_(getSheet_('Sessions'), sid, 'sessionId'); } catch (e) {}
  return { ok: true };
}

function changePassword(sid, oldPw, newPw) {
  const u = requireUser_(sid);
  if (hashPw_(u.id, oldPw) !== u.passwordHash) throw new Error('รหัสผ่านเดิมไม่ถูกต้อง');
  validatePassword_(newPw);
  updateRowById_(getSheet_('Users'), u.id, { passwordHash: hashPw_(u.id, newPw), mustChange: 'false' });
  if (u.role === 'admin') { try { PropertiesService.getScriptProperties().deleteProperty('INITIAL_ADMIN_PASSWORD'); } catch (e) {} }
  logAction_(u, 'changePassword', '');
  return { ok: true };
}

function forceChangePassword(sid, newPw) {
  const u = requireUser_(sid);
  validatePassword_(newPw);
  updateRowById_(getSheet_('Users'), u.id, { passwordHash: hashPw_(u.id, newPw), mustChange: 'false' });
  if (u.role === 'admin') { try { PropertiesService.getScriptProperties().deleteProperty('INITIAL_ADMIN_PASSWORD'); } catch (e) {} }
  logAction_(u, 'changePassword', 'บังคับเปลี่ยนครั้งแรก');
  return { ok: true };
}

/* ===================== STANDINGS ===================== */
function sortByOrder_(list) {
  return list.slice().sort((a, b) => (toInt_(a.sortOrder, 9999) - toInt_(b.sortOrder, 9999)) || String(a.name).localeCompare(String(b.name), 'th'));
}

/** รายการประกวดระดับสี (ขบวนพาเหรด/ประกวดผู้นำเชียร์/ประกวดกองเชียร์ ฯลฯ) — แยกคะแนนออกจากคะแนนรวมกีฬา */
function isContestEvent_(e) { return e.category === 'ประกวด' || e.mode === 'color'; }

/** อันดับคะแนนประกวด (แยกจากคะแนนรวมกีฬา) */
/** รายการกรีฑา (วิ่งทุกประเภท) — แยกคะแนนเป็นคะแนนรวมกรีฑา ไม่นับรวมกับกีฬาชนิดอื่น */
function isAthleticsEvent_(e) { return e.category === 'กรีฑา' && !isContestEvent_(e); }

function computeContest_(colors, events, results, pred) {
  const evs = events.filter(pred || isContestEvent_), fin = {};
  evs.forEach(e => { if (e.status === 'finished') fin[e.id] = true; });
  const rows = {};
  colors.forEach(c => { rows[c.id] = { colorId: c.id, name: c.name, hex: c.hex, points: 0, gold: 0, silver: 0, bronze: 0, rank: 0, byEvent: {} }; });
  results.forEach(r => {
    const row = rows[r.colorId];
    if (!fin[r.eventId] || !row) return;
    const pt = Number(r.points) || 0;
    row.points += pt;
    row.byEvent[r.eventId] = round2_((row.byEvent[r.eventId] || 0) + pt);
    const rk = Number(r.rank);
    if (rk === 1) row.gold++; else if (rk === 2) row.silver++; else if (rk === 3) row.bronze++;
  });
  const list = Object.keys(rows).map(k => rows[k]);
  list.forEach(r => { r.points = round2_(r.points); });
  list.sort((a, b) => (b.points - a.points) || (b.gold - a.gold) || (b.silver - a.silver) || (b.bronze - a.bronze) || String(a.name).localeCompare(String(b.name), 'th'));
  let rank = 0, prev = null;
  list.forEach((r, i) => { const key = [r.points, r.gold, r.silver, r.bronze].join('|'); if (key !== prev) { rank = i + 1; prev = key; } r.rank = rank; });
  return { list: list, events: evs.map(e => ({ id: e.id, label: eventLabel_(e), finished: !!fin[e.id] })), finishedCount: Object.keys(fin).length, totalEvents: evs.length };
}

function computeStandings_(colors, allEvents, results, adjustments) {
  const contests = allEvents.filter(isContestEvent_).map(e => {
    const g = computeContest_(colors, [e], results, isContestEvent_);
    return { id: e.id, label: eventLabel_(e), finished: e.status === 'finished', list: g.list };
  });
  const athletics = computeContest_(colors, allEvents, results, isAthleticsEvent_);
  const events = allEvents.filter(e => !isContestEvent_(e) && !isAthleticsEvent_(e)); // คะแนนรวมกีฬาไม่รวมรายการประกวดและกรีฑา
  const finished = {};
  events.forEach(e => { if (e.status === 'finished') finished[e.id] = e; });
  const rows = {};
  colors.forEach(c => {
    rows[c.id] = { colorId: c.id, name: c.name, hex: c.hex, eventPoints: 0, adjust: 0, total: 0, gold: 0, silver: 0, bronze: 0, rank: 0 };
  });
  results.forEach(r => {
    const ev = finished[r.eventId];
    const row = rows[r.colorId];
    if (!ev || !row) return;
    row.eventPoints += Number(r.points) || 0;
    const rk = Number(r.rank);
    if (rk === 1) row.gold++; else if (rk === 2) row.silver++; else if (rk === 3) row.bronze++;
  });
  adjustments.forEach(a => {
    const row = rows[a.colorId];
    if (row) row.adjust += Number(a.points) || 0;
  });
  const list = Object.keys(rows).map(k => rows[k]);
  list.forEach(r => {
    r.eventPoints = round2_(r.eventPoints);
    r.adjust = round2_(r.adjust);
    r.total = round2_(r.eventPoints + r.adjust);
  });
  list.sort((a, b) => (b.total - a.total) || (b.gold - a.gold) || (b.silver - a.silver) || (b.bronze - a.bronze) ||
    String(a.name).localeCompare(String(b.name), 'th'));
  let rank = 0, prev = null;
  list.forEach((r, i) => {
    const key = [r.total, r.gold, r.silver, r.bronze].join('|');
    if (key !== prev) { rank = i + 1; prev = key; }
    r.rank = rank;
  });
  return { list: list, finishedCount: Object.keys(finished).length, totalEvents: events.length, contests: contests, athletics: athletics };
}

/* ===================== PUBLIC BOARD (ไม่ต้องเข้าสู่ระบบ) ===================== */
function getPublicBoard() {
  ensureDatabase_(false);
  const cache = CacheService.getScriptCache();
  try {
    const hit = cache.get('PUBLIC_BOARD_V1');
    if (hit) return JSON.parse(hit);
  } catch (e) {}
  const st = getSettingsMap_();
  const settings = {};
  PUBLIC_SETTING_KEYS.forEach(k => settings[k] = st[k] || '');
  const colors = sortByOrder_(sheetToObjects_(getSheet_('Colors'))).map(c => ({ id: c.id, name: c.name, hex: c.hex, motto: c.motto }));
  const fullEvents = sortByOrder_(sheetToObjects_(getSheet_('Events')));
  const shown = {};
  String(st.contestShown || '').split(',').forEach(x => { if (x) shown[x] = true; });
  const hideEv = e => isContestEvent_(e) && !shown[e.id]; // รายการประกวดที่ยังไม่ประกาศผลบนหน้าสาธารณะ (ประกาศแยกทีละรายการ)
  const events = fullEvents.map(e => ({
    id: e.id, code: e.code, name: e.name, category: e.category, gender: e.gender, levelGroup: e.levelGroup,
    mode: e.mode, date: e.date, time: e.time, venue: e.venue, status: hideEv(e) && e.status === 'finished' ? 'ongoing' : e.status, label: eventLabel_(e)
  }));
  const visible = st.publicScoreVisible !== 'false';
  const showNames = st.publicShowNames === 'true';
  let standings = null;
  let results = [];
  if (visible) {
    const allResults = sheetToObjects_(getSheet_('Results'));
    const adjustments = sheetToObjects_(getSheet_('Adjustments'));
    standings = computeStandings_(colors, fullEvents, allResults, adjustments);
    standings.contests = standings.contests.map(c => shown[c.id] ? c : { id: c.id, label: c.label, finished: false, hidden: true, list: [] });
    const finishedIds = {};
    fullEvents.forEach(e => { if (e.status === 'finished' && !hideEv(e)) finishedIds[e.id] = true; });
    const certOn = {};
    if (st.certOpen === 'true') String(st.certEvents || '').split(',').forEach(x => { if (x) certOn[x] = true; });
    results = allResults.filter(r => finishedIds[r.eventId]).map(r => ({
      eventId: r.eventId, rank: toInt_(r.rank), colorId: r.colorId, points: Number(r.points) || 0,
      athleteName: (showNames || certOn[r.eventId]) ? r.athleteName : '', record: r.record
    }));
  }
  let matches = loadMatches_().map(m => ({
    id: m.id, eventId: m.eventId, stage: m.stage, rd: m.rd, round: m.round, no: m.no, colorA: m.colorA, colorB: m.colorB,
    scoreA: visible ? m.scoreA : '', scoreB: visible ? m.scoreB : '', winner: visible ? m.winner : '',
    status: visible ? m.status : 'planned', date: m.date, time: m.time, venue: m.venue
  }));
  const out = { settings: settings, colors: colors, events: events, standings: standings, results: results, matches: matches, matchRank: visible ? matchRankMap_(matches) : {}, visible: visible, updatedAt: nowIso_() };
  try { cache.put('PUBLIC_BOARD_V1', JSON.stringify(out), PUBLIC_CACHE_SEC); } catch (e) {}
  return out;
}

/* ===================== BOOTSTRAP (หลังเข้าสู่ระบบ) ===================== */
function getBootstrap(sid) {
  ensureDatabase_(false);
  const rawUsers = sheetToObjects_(getSheet_('Users'));
  const u = requireUser_(sid, rawUsers);
  const settings = getSettingsMap_();
  Object.keys(settings).forEach(k => { if (k.charAt(0) === '_') delete settings[k]; });
  const colors = sortByOrder_(sheetToObjects_(getSheet_('Colors')));
  const events = sortByOrder_(sheetToObjects_(getSheet_('Events')));
  let students = sheetToObjects_(getSheet_('Students'));
  let entries = sheetToObjects_(getSheet_('Entries'));
  const results = sheetToObjects_(getSheet_('Results'));
  const adjustments = sheetToObjects_(getSheet_('Adjustments'));
  const matches = loadMatches_();
  if (u.role === 'colorHead') {
    students = students.filter(s => s.colorId === u.colorId);
    entries = entries.filter(e => e.colorId === u.colorId);
  }
  const users = u.role === 'admin' ? rawUsers.map(x => ({
    id: x.id, username: x.username, fullname: x.fullname, role: x.role, colorId: x.colorId,
    position: x.position, active: x.active || 'true'
  })) : [];
  return {
    user: { id: u.id, username: u.username, fullname: u.fullname, role: u.role, colorId: u.colorId, position: u.position, mustChange: u.mustChange || 'false' },
    settings: settings,
    colors: colors,
    events: events,
    students: students,
    entries: entries,
    results: results,
    adjustments: adjustments,
    matches: matches,
    matchRank: matchRankMap_(matches),
    users: users,
    standings: computeStandings_(colors, events, results, adjustments),
    serverTime: nowIso_()
  };
}

function getLogs(sid) {
  requireRole_(sid, ['admin']);
  const all = sheetToObjects_(getSheet_('Logs'));
  return all.slice(-200).reverse();
}

/* ===================== SETTINGS ===================== */
/** ตั้งค่าเกียรติบัตร (เฉพาะผู้ดูแลระบบ): สวิตช์รวม, รายการที่เปิดให้โหลด, ชื่อผู้ลงนาม, วันที่ */
function saveCertSettings(sid, p) {
  const u = requireRole_(sid, ['admin']);
  p = p || {};
  return withLock_(() => {
    const map = {};
    sheetToObjects_(getSheet_('Settings')).forEach(r => { map[r.key] = r.value; });
    if (p.open !== undefined) map.certOpen = (p.open === true || p.open === 'true') ? 'true' : 'false';
    if (p.events !== undefined) {
      const valid = {};
      sheetToObjects_(getSheet_('Events')).forEach(e => { valid[e.id] = true; });
      const ids = (Array.isArray(p.events) ? p.events : []).map(String).filter((x, i, a) => valid[x] && a.indexOf(x) === i);
      map.certEvents = ids.join(',');
    }
    ['directorName', 'certChairName', 'certChairTitle'].forEach(k => { if (p[k] !== undefined) map[k] = String(p[k] || '').trim().slice(0, 80); });
    if (p.certRefTitle !== undefined) map.certRefTitle = String(p.certRefTitle || '').trim().slice(0, 60) || 'กรรมการตัดสิน';
    if (p.certRefs !== undefined) {
      const names = (Array.isArray(p.certRefs) ? p.certRefs : String(p.certRefs || '').split(/\r?\n/))
        .map(x => String(x || '').replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)).filter((x, i, a) => x && a.indexOf(x) === i).slice(0, 300);
      map.certRefs = names.join('\n');
    }
    if (p.certNoPrefix !== undefined) map.certNoPrefix = String(p.certNoPrefix || '').trim().slice(0, 40);
    ['certNoOn', 'certNoYear', 'certNoThai'].forEach(k => { if (p[k] !== undefined) map[k] = (p[k] === true || p[k] === 'true') ? 'true' : 'false'; });
    if (p.certNoStart !== undefined) map.certNoStart = String(Math.max(1, Math.min(999999, toInt_(p.certNoStart, 1))));
    if (p.certNoPad !== undefined) map.certNoPad = String(Math.max(1, Math.min(8, toInt_(p.certNoPad, 3))));
    if (p.certLayout !== undefined) {
      let lay = {};
      try { lay = typeof p.certLayout === 'string' ? JSON.parse(p.certLayout || '{}') : (p.certLayout || {}); } catch (e) { throw new Error('รูปแบบตำแหน่งไม่ถูกต้อง'); }
      const out = {};
      Object.keys(lay).slice(0, 30).forEach(k => {
        if (!/^[a-zA-Z]{1,12}$/.test(k)) return;
        if (k === 'color' || k === 'nameColor') { if (/^#[0-9a-fA-F]{6}$/.test(String(lay[k]))) out[k] = String(lay[k]); } else { const n = Number(lay[k]); if (isFinite(n)) out[k] = Math.max(0, Math.min(100, n)); }
      });
      map.certLayout = JSON.stringify(out);
    }
    if (p.certDate !== undefined) {
      const d = String(p.certDate || '').trim();
      if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
      map.certDate = d;
    }
    writeTable_('Settings', Object.keys(map).map(k => ({ key: k, value: map[k] })));
    bustPublicCache_();
    logAction_(u, 'saveCertSettings', (p.open !== undefined ? 'สวิตช์รวม=' + map.certOpen + ' ' : '') + (p.events !== undefined ? 'รายการ ' + (map.certEvents ? map.certEvents.split(',').length : 0) : ''));
    return { ok: true };
  });
}

/* ---------- ป้ายการแข่งขัน (แบนเนอร์หน้าหลัก) ---------- */
const BANNER_CHUNK_ = 45000, BANNER_MAX_ = 180000;

/** อัปโหลด/ลบป้ายการแข่งขัน (ส่ง data URL ของภาพ หรือสตริงว่างเพื่อลบ) */
function saveBanner(sid, dataUrl) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const v = String(dataUrl || '').trim();
    let ver = '';
    const rows = [];
    if (v) {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(v)) throw new Error('ไฟล์ป้ายไม่ถูกต้อง กรุณาอัปโหลดภาพ PNG/JPG');
      if (v.length > BANNER_MAX_) throw new Error('ไฟล์ป้ายใหญ่เกินไป กรุณาใช้ภาพที่เล็กลง');
      ver = String(new Date().getTime());
      for (let i = 0; i * BANNER_CHUNK_ < v.length; i++) rows.push({ id: String(i), data: v.substr(i * BANNER_CHUNK_, BANNER_CHUNK_) });
    }
    writeTable_('Banner', rows);
    const map = {};
    sheetToObjects_(getSheet_('Settings')).forEach(r => { map[r.key] = r.value; });
    map.bannerVer = ver;
    writeTable_('Settings', Object.keys(map).map(k => ({ key: k, value: map[k] })));
    bustPublicCache_();
    logAction_(u, 'saveBanner', v ? 'อัปโหลดป้าย (' + Math.round(v.length / 1024) + ' KB)' : 'ลบป้าย');
    return { ok: true, ver: ver };
  });
}

/** ดึงภาพป้าย (สาธารณะ) — แยกจากข้อมูลหน้าหลักเพื่อไม่ให้หน้าแรกช้า; แคชตามรุ่น */
function getBanner(ver) {
  ensureDatabase_(false);
  const cur = String(getSettingsMap_().bannerVer || '');
  if (!cur) return { ok: true, ver: '', data: '' };
  const cache = CacheService.getScriptCache();
  const key = 'BANNER_' + cur;
  try { const hit = cache.get(key + '_n'); if (hit) { const n = +hit, parts = []; for (let i = 0; i < n; i++) { const c = cache.get(key + '_' + i); if (!c) { parts.length = 0; break; } parts.push(c); } if (parts.length === n) return { ok: true, ver: cur, data: parts.join('') }; } } catch (e) {}
  const rows = sheetToObjects_(getSheet_('Banner')).sort((a, b) => toInt_(a.id, 0) - toInt_(b.id, 0));
  const data = rows.map(r => r.data).join('');
  try { rows.forEach((r, i) => cache.put(key + '_' + i, r.data, 21600)); cache.put(key + '_n', String(rows.length), 21600); } catch (e) {}
  return { ok: true, ver: cur, data: data };
}

/* ---------- แม่แบบเกียรติบัตร (ภาพพื้นหลังที่อัปโหลด) ---------- */
const CERT_TPL_MAX_ = 900000;

function saveCertTemplate(sid, dataUrl) {
  const u = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const v = String(dataUrl || '').trim();
    let ver = '';
    const rows = [];
    if (v) {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(v)) throw new Error('ไฟล์แม่แบบไม่ถูกต้อง กรุณาอัปโหลดภาพ PNG/JPG');
      if (v.length > CERT_TPL_MAX_) throw new Error('ไฟล์แม่แบบใหญ่เกินไป กรุณาใช้ภาพที่เล็กลง');
      ver = String(new Date().getTime());
      for (let i = 0; i * BANNER_CHUNK_ < v.length; i++) rows.push({ id: String(i), data: v.substr(i * BANNER_CHUNK_, BANNER_CHUNK_) });
    }
    getSheet_('CertTpl', true);
    writeTable_('CertTpl', rows);
    const map = {};
    sheetToObjects_(getSheet_('Settings')).forEach(r => { map[r.key] = r.value; });
    map.certTplVer = ver;
    writeTable_('Settings', Object.keys(map).map(k => ({ key: k, value: map[k] })));
    bustPublicCache_();
    logAction_(u, 'saveCertTemplate', v ? 'อัปโหลดแม่แบบเกียรติบัตร (' + Math.round(v.length / 1024) + ' KB)' : 'ลบแม่แบบเกียรติบัตร');
    return { ok: true, ver: ver };
  });
}

function getCertTemplate(ver) {
  ensureDatabase_(false);
  const cur = String(getSettingsMap_().certTplVer || '');
  if (!cur) return { ok: true, ver: '', data: '' };
  const cache = CacheService.getScriptCache();
  const key = 'CERTTPL_' + cur;
  try { const hit = cache.get(key + '_n'); if (hit) { const n = +hit, parts = []; for (let i = 0; i < n; i++) { const c = cache.get(key + '_' + i); if (!c) { parts.length = 0; break; } parts.push(c); } if (parts.length === n && n > 0) return { ok: true, ver: cur, data: parts.join('') }; } } catch (e) {}
  const rows = sheetToObjects_(getSheet_('CertTpl', true)).sort((a, b) => toInt_(a.id, 0) - toInt_(b.id, 0));
  const data = rows.map(r => r.data).join('');
  try { rows.forEach((r, i) => cache.put(key + '_' + i, r.data, 21600)); cache.put(key + '_n', String(rows.length), 21600); } catch (e) {}
  return { ok: true, ver: cur, data: data };
}

/* ---------- ฟอนต์เกียรติบัตร (ไฟล์ .ttf/.otf/.woff2 ที่อัปโหลด) ---------- */
function saveCertFont(sid, dataUrl) {
  const u = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const v = String(dataUrl || '').trim();
    let ver = '';
    const rows = [];
    if (v) {
      if (!/^data:[A-Za-z0-9\/\-\.+]{3,60};base64,[A-Za-z0-9+\/=]+$/.test(v)) throw new Error('ไฟล์ฟอนต์ไม่ถูกต้อง');
      if (v.length > CERT_TPL_MAX_) throw new Error('ไฟล์ฟอนต์ใหญ่เกินไป (ไม่เกินประมาณ 650 KB)');
      ver = String(new Date().getTime());
      for (let i = 0; i * BANNER_CHUNK_ < v.length; i++) rows.push({ id: String(i), data: v.substr(i * BANNER_CHUNK_, BANNER_CHUNK_) });
    }
    getSheet_('CertFont', true);
    writeTable_('CertFont', rows);
    const map = {};
    sheetToObjects_(getSheet_('Settings')).forEach(r => { map[r.key] = r.value; });
    map.certFontVer = ver;
    writeTable_('Settings', Object.keys(map).map(k => ({ key: k, value: map[k] })));
    bustPublicCache_();
    logAction_(u, 'saveCertFont', v ? 'อัปโหลดฟอนต์เกียรติบัตร (' + Math.round(v.length / 1024) + ' KB)' : 'ลบฟอนต์เกียรติบัตร');
    return { ok: true, ver: ver };
  });
}

function getCertFont(ver) {
  ensureDatabase_(false);
  const cur = String(getSettingsMap_().certFontVer || '');
  if (!cur) return { ok: true, ver: '', data: '' };
  const cache = CacheService.getScriptCache();
  const key = 'CERTFONT_' + cur;
  try { const hit = cache.get(key + '_n'); if (hit) { const n = +hit, parts = []; for (let i = 0; i < n; i++) { const c = cache.get(key + '_' + i); if (!c) { parts.length = 0; break; } parts.push(c); } if (parts.length === n && n > 0) return { ok: true, ver: cur, data: parts.join('') }; } } catch (e) {}
  const rows = sheetToObjects_(getSheet_('CertFont', true)).sort((a, b) => toInt_(a.id, 0) - toInt_(b.id, 0));
  const data = rows.map(r => r.data).join('');
  try { rows.forEach((r, i) => cache.put(key + '_' + i, r.data, 21600)); cache.put(key + '_n', String(rows.length), 21600); } catch (e) {}
  return { ok: true, ver: cur, data: data };
}

/* ---------- เลขที่เกียรติบัตร (รันเลขต่อเนื่อง จำได้ถาวร) ---------- */
function certKey_(r) { return [r.eventId, toInt_(r.rank, 0), r.colorId, String(r.athleteName || '')].join('|'); }

/** ออกเลขให้คีย์ที่ยังไม่มีเลข (ต้องเรียกภายใน withLock_) คืนแผนที่ key -> เลข */
function assignCertNos_(keys) {
  const sh = getSheet_('CertNo', true);
  const rows = sheetToObjects_(sh), have = {};
  let max = 0;
  rows.forEach(r => { const n = toInt_(r.no, 0); have[r.key] = n; if (n > max) max = n; });
  let next = Math.max(toInt_(getSettingsMap_().certNoStart, 1), max + 1);
  const add = [];
  keys.forEach(k => { if (have[k] === undefined) { have[k] = next; add.push({ key: k, no: String(next), at: new Date().toISOString() }); next++; } });
  if (add.length) appendRowsObjects_(sh, add);
  const out = {};
  keys.forEach(k => { out[k] = have[k]; });
  return out;
}

function validCertKeys_(onlyEnabled) {
  const st = getSettingsMap_(), on = {};
  String(st.certEvents || '').split(',').forEach(x => { if (x) on[x] = true; });
  const ev = {};
  sheetToObjects_(getSheet_('Events')).forEach(e => { ev[e.id] = e; });
  const list = [];
  sheetToObjects_(getSheet_('Results')).forEach(r => {
    const rk = toInt_(r.rank, 0);
    if (rk < 1 || rk > 4 || !ev[r.eventId]) return;
    if (onlyEnabled && !on[r.eventId]) return;
    list.push({ key: certKey_(r), eventId: r.eventId, rank: rk, so: toInt_(ev[r.eventId].sortOrder, 0), code: String(ev[r.eventId].code || '') });
  });
  list.sort((a, b) => a.so - b.so || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || a.rank - b.rank);
  return list;
}

/** เจ้าหน้าที่: ออกเลขให้ keys ที่ระบุ หรือ all=true ออกเลขให้ทุกรางวัลตามลำดับรายการ */
function assignCertNumbers(sid, keys, all) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const valid = validCertKeys_(false), ok = {};
    valid.forEach(v => { ok[v.key] = true; });
    String(getSettingsMap_().certRefs || '').split('\n').forEach(n => { n = n.trim(); if (n) ok['ref|' + n] = true; }); // เกียรติบัตรกรรมการ
    let ks = all ? valid.map(v => v.key) : (Array.isArray(keys) ? keys.map(String).filter(k => ok[k]) : []);
    ks = ks.filter((k, i) => ks.indexOf(k) === i).slice(0, 500);
    const nos = assignCertNos_(ks);
    if (all) logAction_(u, 'assignCertNumbers', 'ออกเลขทั้งหมด ' + ks.length + ' ฉบับ');
    return { ok: true, nos: nos };
  });
}

/** เจ้าหน้าที่: ดึงเลขที่ออกไปแล้วทั้งหมด */
function getCertNumbers(sid) {
  requireRole_(sid, ['admin', 'organizer']);
  const nos = {};
  sheetToObjects_(getSheet_('CertNo', true)).forEach(r => { nos[r.key] = toInt_(r.no, 0); });
  return { ok: true, nos: nos };
}

/** สาธารณะ: ออกเลขให้เกียรติบัตรที่เปิดให้โหลดเท่านั้น (ต้องเปิดสวิตช์รวม) */
function publicCertNumbers(keys) {
  ensureDatabase_(false);
  if (getSettingsMap_().certOpen !== 'true') throw new Error('ยังไม่เปิดให้ดาวน์โหลดเกียรติบัตร');
  return withLock_(() => {
    const ok = {};
    validCertKeys_(true).forEach(v => { ok[v.key] = true; });
    let ks = (Array.isArray(keys) ? keys.map(String) : []).filter(k => ok[k]);
    ks = ks.filter((k, i) => ks.indexOf(k) === i).slice(0, 50);
    return { ok: true, nos: assignCertNos_(ks) };
  });
}

/* ===================== จัดการปีการศึกษา ===================== */
/** สรุปผลปีปัจจุบันเป็น JSON แบบย่อ (ต้องเรียกภายใน withLock_) */
function seasonSnapshot_() {
  const st = getSettingsMap_();
  const colors = sheetToObjects_(getSheet_('Colors')), events = sheetToObjects_(getSheet_('Events'));
  const results = sheetToObjects_(getSheet_('Results')), adj = sheetToObjects_(getSheet_('Adjustments'));
  const cm = {}; colors.forEach(c => { cm[c.id] = c; });
  const sd = computeStandings_(colors, events, results, adj);
  const evs = events.filter(e => e.status === 'finished').sort((a, b) => toInt_(a.sortOrder, 0) - toInt_(b.sortOrder, 0)).map(e => ({
    code: e.code, label: eventLabel_(e), win: results.filter(r => r.eventId === e.id && toInt_(r.rank, 0) >= 1 && toInt_(r.rank, 0) <= 4)
      .sort((a, b) => toInt_(a.rank, 0) - toInt_(b.rank, 0)).map(r => [toInt_(r.rank, 0), (cm[r.colorId] || {}).name || '', String(r.athleteName || '')])
  }));
  const slim = l => l.map(r => ({ name: r.name, hex: r.hex, total: r.total !== undefined ? r.total : r.points, gold: r.gold, silver: r.silver, bronze: r.bronze, rank: r.rank }));
  const data = {
    year: String(st.academicYear || ''), eventName: String(st.eventName || ''),
    standings: slim(sd.list), athletics: slim(sd.athletics.list || []),
    contests: sd.contests.map(c => ({ label: c.label, list: slim(c.list) })),
    finished: events.filter(e => e.status === 'finished').length, totalEvents: events.length, events: evs
  };
  let json = JSON.stringify(data);
  if (json.length > 48000) { data.events = data.events.map(e => ({ code: e.code, label: e.label, win: e.win.slice(0, 1) })); json = JSON.stringify(data); }
  if (json.length > 48000) { data.events = []; json = JSON.stringify(data); }
  return { data: data, json: json };
}

/** บันทึก/อัปเดตสรุปปีนี้ลงตาราง Seasons (ต้องเรียกภายใน withLock_) */
function saveSeasonRow_(u) {
  const snap = seasonSnapshot_(), sh = getSheet_('Seasons', true), rows = sheetToObjects_(sh);
  const year = snap.data.year, rest = rows.filter(r => String(r.year) !== year);
  rest.push({ id: newId_('ss'), year: year, archivedAt: new Date().toISOString(), archivedBy: (u && u.fullname) || '', data: snap.json });
  writeTable_('Seasons', rest);
  return snap.data;
}

function getSeasons(sid) {
  requireRole_(sid, ['admin']);
  const rows = sheetToObjects_(getSheet_('Seasons', true)).map(r => {
    let d = null; try { d = JSON.parse(r.data || 'null'); } catch (e) {}
    return { id: r.id, year: r.year, archivedAt: r.archivedAt, archivedBy: r.archivedBy, data: d };
  });
  rows.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
  return { ok: true, seasons: rows };
}

function archiveSeason(sid) {
  const u = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const d = saveSeasonRow_(u);
    logAction_(u, 'archiveSeason', 'เก็บสรุปผลปีการศึกษา ' + d.year);
    return { ok: true, year: d.year };
  });
}

function deleteSeason(sid, id) {
  const u = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const rows = sheetToObjects_(getSheet_('Seasons', true)), keep = rows.filter(r => r.id !== String(id));
    if (keep.length === rows.length) throw new Error('ไม่พบรายการที่จะลบ');
    writeTable_('Seasons', keep);
    logAction_(u, 'deleteSeason', 'ลบสรุปผลปีการศึกษา ' + (rows.find(r => r.id === String(id)) || {}).year);
    return { ok: true };
  });
}

/**
 * เริ่มปีการศึกษาใหม่: เก็บสรุปปีเดิมอัตโนมัติ แล้วล้างผล/คะแนนพิเศษ/ตารางแข่ง/การลงทะเบียน/เลขเกียรติบัตร
 * opts: { year, clearStudents, clearRefs }  ยืนยันด้วยข้อความ "เริ่มปีใหม่"
 */
function startNewSeason(sid, opts, confirmText) {
  const u = requireRole_(sid, ['admin']);
  if (String(confirmText || '').trim() !== 'เริ่มปีใหม่') throw new Error('กรุณาพิมพ์คำว่า "เริ่มปีใหม่" เพื่อยืนยัน');
  const o = opts || {}, year = String(o.year || '').trim().replace(/[๐-๙]/g, d => '๐๑๒๓๔๕๖๗๘๙'.indexOf(d));
  if (!/^\d{4}$/.test(year)) throw new Error('ปีการศึกษาต้องเป็นตัวเลข 4 หลัก เช่น 2570');
  return withLock_(() => {
    const cur = String(getSettingsMap_().academicYear || '');
    const asc = x => String(x).replace(/[๐-๙]/g, d => '๐๑๒๓๔๕๖๗๘๙'.indexOf(d));
    if (asc(cur) === year) throw new Error('ปีการศึกษาใหม่ต้องไม่ซ้ำกับปีปัจจุบัน (' + cur + ')');
    const yearOut = /[๐-๙]/.test(cur) ? year.replace(/\d/g, d => '๐๑๒๓๔๕๖๗๘๙'[+d]) : year; // คงรูปแบบตัวเลขเดิม (ไทย/อารบิก)
    saveSeasonRow_(u); // เก็บสรุปปีเดิมก่อนล้าง
    writeTable_('Results', []); writeTable_('Matches', []); writeTable_('Adjustments', []); writeTable_('Entries', []);
    const evs = sheetToObjects_(getSheet_('Events')); evs.forEach(e => { e.status = 'planned'; }); writeTable_('Events', evs);
    getSheet_('CertNo', true); writeTable_('CertNo', []);
    if (o.clearStudents) writeTable_('Students', []);
    const map = {};
    sheetToObjects_(getSheet_('Settings')).forEach(r => { map[r.key] = r.value; });
    map.academicYear = yearOut; map.certEvents = ''; map.certOpen = 'false'; map.certDate = ''; map.contestShown = '';
    if (o.clearRefs) map.certRefs = '';
    writeTable_('Settings', Object.keys(map).map(k => ({ key: k, value: map[k] })));
    bustPublicCache_();
    logAction_(u, 'startNewSeason', 'เริ่มปีการศึกษา ' + yearOut + ' (เก็บสรุปปี ' + cur + ')' + (o.clearStudents ? ' ล้างรายชื่อนักเรียน' : ''));
    return { ok: true, year: yearOut, previous: cur };
  });
}

/** ผู้ดูแลระบบ: ล้างเลขที่ทั้งหมดเพื่อเริ่มรันใหม่ */
function resetCertNumbers(sid) {
  const u = requireRole_(sid, ['admin']);
  return withLock_(() => {
    getSheet_('CertNo', true);
    writeTable_('CertNo', []);
    logAction_(u, 'resetCertNumbers', 'ล้างเลขที่เกียรติบัตรทั้งหมด');
    return { ok: true };
  });
}

function saveSettings(sid, payload) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const cur = getSettingsMap_();
    const stored = sheetToObjects_(getSheet_('Settings'));
    const map = {};
    stored.forEach(r => map[r.key] = r.value);
    Object.keys(payload || {}).forEach(k => {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k)) return;
      let v = String(payload[k] === null || payload[k] === undefined ? '' : payload[k]).trim();
      if (k === 'defaultPoints') {
        if (!parsePoints_(v).length) throw new Error('คะแนนมาตรฐานต้องเป็นตัวเลขคั่นด้วยจุลภาค เช่น 5,3,2,1');
      }
      if (k === 'maxEventsPerStudent') v = String(Math.max(0, toInt_(v, 0)));
      if (['registrationOpen', 'publicScoreVisible', 'publicShowNames'].indexOf(k) !== -1) v = (v === 'true' || v === '1') ? 'true' : 'false';
      if (k === 'logoUrl' && v) {
        const isData = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(v);
        if (!isData && !/^https:\/\//i.test(v)) throw new Error('รูปโลโก้ไม่ถูกต้อง กรุณาอัปโหลดไฟล์ภาพ PNG/JPG');
        if (isData && v.length > 45000) throw new Error('ไฟล์โลโก้ใหญ่เกินไป กรุณาใช้ภาพที่เล็กลง');
      }
      map[k] = v;
    });
    writeTable_('Settings', Object.keys(map).map(k => ({ key: k, value: map[k] })));
    bustPublicCache_();
    logAction_(u, 'saveSettings', Object.keys(payload || {}).join(','));
    return { ok: true };
  });
}

/* ===================== COLORS ===================== */
function saveColor(sid, payload) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const name = String(payload.name || '').trim();
    const hex = String(payload.hex || '').trim();
    if (!name) throw new Error('กรุณาระบุชื่อสี');
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error('รหัสสีต้องเป็นรูปแบบ #RRGGBB');
    const sh = getSheet_('Colors');
    const all = sheetToObjects_(sh);
    if (all.some(c => c.name === name && c.id !== payload.id)) throw new Error('มีชื่อสีนี้อยู่แล้ว');
    const data = {
      name: name, hex: hex.toUpperCase(), advisors: String(payload.advisors || '').trim(),
      motto: String(payload.motto || '').trim()
    };
    if (payload.id) {
      if (!all.some(c => c.id === payload.id)) throw new Error('ไม่พบสีที่ต้องการแก้ไข');
      data.sortOrder = String(toInt_(payload.sortOrder, 0) || toInt_(all.find(c => c.id === payload.id).sortOrder, 0));
      updateRowById_(sh, payload.id, data);
    } else {
      data.id = newId_('c_');
      data.sortOrder = String(all.reduce((m, c) => Math.max(m, toInt_(c.sortOrder, 0)), 0) + 1);
      appendRowObject_(sh, data);
    }
    bustPublicCache_();
    logAction_(u, 'saveColor', name);
    return { ok: true };
  });
}

function deleteColor(sid, id) {
  const u = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const used = sheetToObjects_(getSheet_('Students')).some(s => s.colorId === id) ||
      sheetToObjects_(getSheet_('Entries')).some(e => e.colorId === id) ||
      sheetToObjects_(getSheet_('Results')).some(r => r.colorId === id) ||
      sheetToObjects_(getSheet_('Adjustments')).some(a => a.colorId === id);
    if (used) throw new Error('ไม่สามารถลบสีที่มีนักเรียน/รายชื่อ/ผลคะแนนผูกอยู่ กรุณาย้ายหรือล้างข้อมูลที่เกี่ยวข้องก่อน');
    deleteRowById_(getSheet_('Colors'), id);
    bustPublicCache_();
    logAction_(u, 'deleteColor', id);
    return { ok: true };
  });
}

/* ===================== STUDENTS ===================== */
function studentKey_(s) {
  return s.studentNo ? 'no:' + s.studentNo : 'nm:' + normName_(s.fullname) + '|' + s.classLevel + '|' + s.room;
}
function normName_(s) { return String(s || '').replace(/\s+/g, '').trim(); }

function saveStudent(sid, payload) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const fullname = String(payload.fullname || '').trim();
    if (!fullname) throw new Error('กรุณาระบุชื่อ-สกุล');
    const gender = normalizeGender_(payload.gender, fullname);
    if (!gender) throw new Error('กรุณาระบุเพศ (ชาย/หญิง)');
    const classLevel = normalizeClassLevel_(payload.classLevel);
    if (!classLevel) throw new Error('กรุณาระบุระดับชั้น เช่น ม.1');
    const colorId = String(payload.colorId || '');
    if (colorId && !sheetToObjects_(getSheet_('Colors')).some(c => c.id === colorId)) throw new Error('ไม่พบสีที่เลือก');
    const sh = getSheet_('Students');
    const all = sheetToObjects_(sh);
    const studentNo = String(payload.studentNo || '').trim();
    if (studentNo && all.some(s => s.studentNo === studentNo && s.id !== payload.id)) throw new Error('เลขประจำตัวนี้มีอยู่แล้ว');
    const data = {
      studentNo: studentNo, fullname: fullname, gender: gender, classLevel: classLevel,
      room: normalizeRoom_(payload.room), colorId: colorId, active: payload.active === false || payload.active === 'false' ? 'false' : 'true'
    };
    if (payload.id) {
      const old = all.find(s => s.id === payload.id);
      if (!old) throw new Error('ไม่พบนักเรียน');
      if (old.colorId !== colorId) assertColorChangeAllowed_(payload.id, old);
      updateRowById_(sh, payload.id, data);
    } else {
      data.id = newId_('s_');
      appendRowObject_(sh, data);
    }
    logAction_(u, 'saveStudent', fullname);
    return { ok: true };
  });
}

// ย้ายสีนักเรียนไม่ได้ถ้าลงทะเบียนแข่งขันหรือมีผลการแข่งขันไว้แล้ว (ป้องกันคะแนนสลับสี)
function assertColorChangeAllowed_(studentId, st) {
  const hasEntry = sheetToObjects_(getSheet_('Entries')).some(e => e.studentId === studentId);
  if (hasEntry) throw new Error('นักเรียน "' + st.fullname + '" ลงทะเบียนแข่งขันแล้ว ต้องยกเลิกการลงทะเบียนก่อนจึงจะย้ายสีได้');
}

function deleteStudent(sid, id) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const st = sheetToObjects_(getSheet_('Students')).find(s => s.id === id);
    if (!st) throw new Error('ไม่พบนักเรียน');
    writeTable_('Entries', sheetToObjects_(getSheet_('Entries')).filter(e => e.studentId !== id));
    deleteRowById_(getSheet_('Students'), id);
    logAction_(u, 'deleteStudent', st.fullname);
    return { ok: true };
  });
}

function importStudents(sid, rows, options) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  if (!Array.isArray(rows) || !rows.length) throw new Error('ไม่พบข้อมูลนักเรียนสำหรับนำเข้า');
  if (rows.length > 3000) throw new Error('นำเข้าได้สูงสุดครั้งละ 3,000 รายการ');
  const updateExisting = !!(options && options.updateExisting);
  return withLock_(() => {
    const colors = sheetToObjects_(getSheet_('Colors'));
    const colorByName = {};
    colors.forEach(c => { colorByName[normName_(c.name)] = c.id; colorByName[normName_(c.name.replace(/^สี/, ''))] = c.id; });
    // ชื่อสีเรียกต่างกันได้: ฟ้า = น้ำเงิน (ถ้าระบบมีสีใดสีหนึ่ง)
    if (colorByName['ฟ้า'] && !colorByName['น้ำเงิน']) colorByName['น้ำเงิน'] = colorByName['ฟ้า'];
    if (colorByName['น้ำเงิน'] && !colorByName['ฟ้า']) colorByName['ฟ้า'] = colorByName['น้ำเงิน'];
    const all = sheetToObjects_(getSheet_('Students'));
    const index = {};
    all.forEach(s => { index[studentKey_(s)] = s; });
    const registered = {};
    sheetToObjects_(getSheet_('Entries')).forEach(e => { registered[e.studentId] = true; });
    let added = 0, updated = 0, skipped = 0;
    const errors = [];
    rows.forEach((r, i) => {
      const fullname = String(r.fullname || '').trim();
      const gender = normalizeGender_(r.gender, fullname);
      const classLevel = normalizeClassLevel_(r.classLevel);
      if (!fullname || !gender || !classLevel) {
        skipped++;
        if (errors.length < 10) errors.push('แถวที่ ' + (i + 1) + ': ข้อมูลไม่ครบ (ชื่อ/เพศ/ชั้น)');
        return;
      }
      const obj = {
        studentNo: String(r.studentNo || '').trim(), fullname: fullname, gender: gender, classLevel: classLevel,
        room: normalizeRoom_(r.room), colorId: '', active: 'true'
      };
      const cn = normName_(r.colorName || '');
      if (cn && colorByName[cn]) obj.colorId = colorByName[cn];
      const key = studentKey_(obj);
      const found = index[key];
      if (found) {
        if (!updateExisting) { skipped++; return; }
        found.fullname = obj.fullname; found.gender = obj.gender; found.classLevel = obj.classLevel; found.room = obj.room;
        if (obj.colorId && !registered[found.id]) found.colorId = obj.colorId; // คนที่ลงทะเบียนแข่งแล้วไม่ย้ายสี
        found.active = 'true';
        updated++;
      } else {
        obj.id = newId_('s_');
        all.push(obj);
        index[key] = obj;
        added++;
      }
    });
    writeTable_('Students', all);
    logAction_(u, 'importStudents', 'เพิ่ม ' + added + ' แก้ไข ' + updated + ' ข้าม ' + skipped);
    return { ok: true, added: added, updated: updated, skipped: skipped, errors: errors };
  });
}

/**
 * แบ่งสีให้นักเรียนอัตโนมัติ แบบกระจายสมดุลตาม (ชั้น/ห้อง/เพศ) ให้แต่ละสีมีสัดส่วนใกล้เคียงกัน
 * options.onlyUnassigned = true  -> เฉพาะคนที่ยังไม่มีสี (ค่าเริ่มต้น)
 * options.onlyUnassigned = false -> แบ่งใหม่ทั้งหมด (ปฏิเสธถ้ามีการลงทะเบียนแข่งขันแล้ว)
 */
function autoAssignColors(sid, options) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  const onlyUnassigned = !options || options.onlyUnassigned !== false;
  return withLock_(() => {
    const colors = sortByOrder_(sheetToObjects_(getSheet_('Colors')));
    if (!colors.length) throw new Error('ยังไม่มีสีในระบบ');
    const students = sheetToObjects_(getSheet_('Students'));
    if (!onlyUnassigned && (sheetToObjects_(getSheet_('Entries')).length || sheetToObjects_(getSheet_('Results')).length)) {
      throw new Error('มีการลงทะเบียนนักกีฬา/ผลการแข่งขันแล้ว ไม่สามารถแบ่งสีใหม่ทั้งหมดได้ (เลือก "เฉพาะนักเรียนที่ยังไม่มีสี")');
    }
    const groupOf = s => [s.classLevel, s.room, s.gender].join('|');
    const gCount = {}, tCount = {};
    colors.forEach(c => { tCount[c.id] = 0; });
    const todo = [];
    students.forEach(s => {
      if (s.active === 'false') return;
      const keep = onlyUnassigned && s.colorId && tCount[s.colorId] !== undefined;
      if (keep) {
        const g = groupOf(s);
        gCount[g] = gCount[g] || {};
        gCount[g][s.colorId] = (gCount[g][s.colorId] || 0) + 1;
        tCount[s.colorId]++;
      } else {
        todo.push(s);
      }
    });
    todo.sort((a, b) => groupOf(a).localeCompare(groupOf(b), 'th') ||
      String(a.studentNo).localeCompare(String(b.studentNo), 'th', { numeric: true }) ||
      String(a.fullname).localeCompare(String(b.fullname), 'th'));
    todo.forEach(s => {
      const g = groupOf(s);
      gCount[g] = gCount[g] || {};
      let best = colors[0].id;
      let bestKey = null;
      colors.forEach((c, idx) => {
        const key = [gCount[g][c.id] || 0, tCount[c.id], idx];
        if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
          best = c.id; bestKey = key;
        }
      });
      s.colorId = best;
      gCount[g][best] = (gCount[g][best] || 0) + 1;
      tCount[best]++;
    });
    writeTable_('Students', students);
    logAction_(u, 'autoAssignColors', 'แบ่งสี ' + todo.length + ' คน');
    return { ok: true, assigned: todo.length, perColor: tCount };
  });
}

/* ===================== EVENTS ===================== */
function saveEvent(sid, payload) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const name = String(payload.name || '').trim();
    if (!name) throw new Error('กรุณาระบุชื่อรายการแข่งขัน');
    const mode = EVENT_MODES.indexOf(payload.mode) !== -1 ? payload.mode : 'individual';
    const gender = EVENT_GENDERS.indexOf(payload.gender) !== -1 ? payload.gender : 'ผสม';
    const levelGroup = EVENT_LEVELS.indexOf(payload.levelGroup) !== -1 ? payload.levelGroup : 'ทุกระดับ';
    const points = String(payload.points || '').trim() || getSettingsMap_().defaultPoints;
    if (!parsePoints_(points).length) throw new Error('คะแนนต้องเป็นตัวเลขคั่นด้วยจุลภาค เช่น 5,3,2,1');
    const date = String(payload.date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
    const time = String(payload.time || '').trim();
    if (time && !/^\d{1,2}:\d{2}$/.test(time)) throw new Error('รูปแบบเวลาไม่ถูกต้อง (เช่น 09:30)');
    const sh = getSheet_('Events');
    const all = sheetToObjects_(sh);
    const data = {
      name: name, category: String(payload.category || '').trim(), gender: gender, levelGroup: levelGroup, mode: mode,
      maxPerColor: String(mode === 'color' ? 0 : Math.max(0, toInt_(payload.maxPerColor, 0))),
      points: points, date: date, time: time, venue: String(payload.venue || '').trim(),
      note: String(payload.note || '').trim()
    };
    if (payload.id) {
      const old = all.find(e => e.id === payload.id);
      if (!old) throw new Error('ไม่พบรายการแข่งขัน');
      if (old.mode !== mode && sheetToObjects_(getSheet_('Entries')).concat(sheetToObjects_(getSheet_('Results'))).some(x => x.eventId === old.id)) {
        throw new Error('รายการนี้มีรายชื่อหรือผลการแข่งขันแล้ว ไม่สามารถเปลี่ยนประเภทการแข่งขันได้');
      }
      data.code = String(payload.code || old.code || '').trim();
      data.sortOrder = String(toInt_(payload.sortOrder, 0) || toInt_(old.sortOrder, 0));
      // คะแนนเปลี่ยน -> คำนวณคะแนนของผลเดิมใหม่
      if (old.points !== points) {
        const rs = sheetToObjects_(getSheet_('Results'));
        let changed = false;
        rs.forEach(r => { if (r.eventId === old.id) { r.points = String(pointsForRank_(points, toInt_(r.rank))); changed = true; } });
        if (changed) writeTable_('Results', rs);
      }
      updateRowById_(sh, payload.id, data);
    } else {
      const maxOrder = all.reduce((m, e) => Math.max(m, toInt_(e.sortOrder, 0)), 0);
      data.id = newId_('e_');
      data.code = String(payload.code || '').trim() || pad2_(all.length + 1);
      data.status = 'planned';
      data.sortOrder = String(maxOrder + 1);
      appendRowObject_(sh, data);
    }
    bustPublicCache_();
    logAction_(u, 'saveEvent', name);
    return { ok: true };
  });
}

function deleteEvent(sid, id) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const ev = sheetToObjects_(getSheet_('Events')).find(e => e.id === id);
    if (!ev) throw new Error('ไม่พบรายการแข่งขัน');
    writeTable_('Entries', sheetToObjects_(getSheet_('Entries')).filter(e => e.eventId !== id));
    writeTable_('Results', sheetToObjects_(getSheet_('Results')).filter(r => r.eventId !== id));
    writeTable_('Matches', sheetToObjects_(getSheet_('Matches', true)).filter(m => m.eventId !== id));
    deleteRowById_(getSheet_('Events'), id);
    bustPublicCache_();
    logAction_(u, 'deleteEvent', eventLabel_(ev));
    return { ok: true };
  });
}

/** ลบหลายรายการพร้อมกัน (พร้อมรายชื่อและผลของรายการเหล่านั้น) */
function deleteEvents(sid, ids) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  const set = {};
  (Array.isArray(ids) ? ids : []).forEach(x => { set[String(x)] = true; });
  if (!Object.keys(set).length) throw new Error('ยังไม่ได้เลือกรายการ');
  return withLock_(() => {
    const evs = sheetToObjects_(getSheet_('Events'));
    const del = evs.filter(e => set[e.id]);
    if (!del.length) throw new Error('ไม่พบรายการที่เลือก');
    writeTable_('Entries', sheetToObjects_(getSheet_('Entries')).filter(e => !set[e.eventId]));
    writeTable_('Results', sheetToObjects_(getSheet_('Results')).filter(r => !set[r.eventId]));
    writeTable_('Matches', sheetToObjects_(getSheet_('Matches', true)).filter(m => !set[m.eventId]));
    writeTable_('Events', evs.filter(e => !set[e.id]));
    bustPublicCache_();
    logAction_(u, 'deleteEvents', del.length + ' รายการ: ' + del.slice(0, 5).map(eventLabel_).join(', ') + (del.length > 5 ? ' ...' : ''));
    return { ok: true, deleted: del.length };
  });
}

/** เปิด/ปิดสถานะรายการ (เช่น เปิดแก้ไขผลที่ประกาศแล้ว) */
function setEventStatus(sid, id, status) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  if (EVENT_STATUS.indexOf(status) === -1) throw new Error('สถานะไม่ถูกต้อง');
  return withLock_(() => {
    const ev = sheetToObjects_(getSheet_('Events')).find(e => e.id === id);
    if (!ev) throw new Error('ไม่พบรายการแข่งขัน');
    updateRowById_(getSheet_('Events'), id, { status: status });
    bustPublicCache_();
    logAction_(u, 'setEventStatus', eventLabel_(ev) + ' -> ' + status);
    return { ok: true };
  });
}

/** จำนวนผู้เข้าแข่งต่อสีของรายการวิ่งเดี่ยว: วิ่งทั่วไป 1 คน, มินิมาราธอน 2 คน (ไม่ใช่รายการวิ่งเดี่ยว = null) */
function runLimitFor_(e) {
  if (e.mode !== 'individual' || e.category !== 'กรีฑา') return null;
  const n = String(e.name || '');
  if (n.indexOf('มินิมาราธอน') !== -1) return 2;
  if (/^วิ่ง/.test(n)) return 1;
  return null;
}

/** ตั้งจำนวนต่อสีของรายการวิ่งเดี่ยวทั้งหมดตามเกณฑ์ (วิ่ง = 1 คน/สี, มินิมาราธอน = 2 คน/สี) */
function applyRunLimits(sid) {
  const u = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const evs = sheetToObjects_(getSheet_('Events'));
    const lim = {};
    let n = 0;
    evs.forEach(e => { const m = runLimitFor_(e); if (m === null) return; lim[e.id] = m; if (toInt_(e.maxPerColor, 0) !== m) { e.maxPerColor = String(m); n++; } });
    if (n) writeTable_('Events', evs);
    const cnt = {};
    sheetToObjects_(getSheet_('Entries')).forEach(r => { if (lim[r.eventId] === undefined) return; const k = r.eventId + '|' + r.colorId; cnt[k] = (cnt[k] || 0) + 1; });
    let over = 0;
    Object.keys(cnt).forEach(k => { if (cnt[k] > lim[k.split('|')[0]]) over++; });
    bustPublicCache_();
    logAction_(u, 'applyRunLimits', n + ' รายการ / เกินกำหนด ' + over + ' สี');
    return { ok: true, events: n, over: over };
  });
}

/** ตั้งคะแนนทุกรายการเป็นเกณฑ์มาตรฐาน (ค่าเริ่มต้น 5,3,2,1: ที่ 1=5, ที่ 2=3, ที่ 3=2, ที่ 4=1; สีที่ไม่ส่ง/ไม่ได้อันดับ=0) แล้วคำนวณคะแนนผลที่บันทึกไว้ใหม่ */
function applyStandardPoints(sid) {
  const u = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const scheme = String(getSettingsMap_().defaultPoints || '5,3,2,1');
    if (!parsePoints_(scheme).length) throw new Error('คะแนนมาตรฐานไม่ถูกต้อง');
    const sh = getSheet_('Events');
    const evs = sheetToObjects_(sh);
    let n = 0;
    evs.forEach(e => { if (e.points !== scheme) { e.points = scheme; n++; } });
    if (n) writeTable_('Events', evs);
    const byId = {};
    evs.forEach(e => { byId[e.id] = e; });
    const rs = sheetToObjects_(getSheet_('Results'));
    let rc = 0;
    rs.forEach(r => { if (byId[r.eventId]) { const p = String(pointsForRank_(scheme, toInt_(r.rank))); if (r.points !== p) { r.points = p; rc++; } } });
    if (rc) writeTable_('Results', rs);
    bustPublicCache_();
    logAction_(u, 'applyStandardPoints', scheme + ' / ' + n + ' รายการ / ผล ' + rc + ' แถว');
    return { ok: true, scheme: scheme, events: n, results: rc };
  });
}

/** โปรแกรมการแข่งขัน "ราชประชาเกมส์" ๒๕๖๙ (ตามเอกสารโปรแกรมการแข่งขัน) */
function programEventDefs_() {
  const list = [];
  const P = 'ประถม', PT = 'ป.ต้น', PP = 'ป.ปลาย', MT = 'ม.ต้น', MP = 'ม.ปลาย', ALL = 'ทุกระดับ';
  const span = { 'ประถม': 'ป.1-ป.6', 'ป.ต้น': 'ป.1-ป.3', 'ป.ปลาย': 'ป.4-ป.6', 'ม.ต้น': 'ม.1-ม.3', 'ม.ปลาย': 'ม.4-ม.6', 'ทุกระดับ': 'ป.1-ม.6' };
  const add = (name, cat, g, lv, mode, max, pts, venue) => list.push({
    name: name, category: cat, gender: g, levelGroup: lv, mode: mode, maxPerColor: max, points: pts, venue: venue || '', note: 'ระดับชั้น ' + span[lv]
  });
  const each = (name, cat, pairs, mode, max, pts, venue) => pairs.forEach(p => add(name, cat, p[1], p[0], mode, max, pts, venue));
  const MF = [[MT, 'ชาย'], [MT, 'หญิง'], [MP, 'ชาย'], [MP, 'หญิง']];
  const PMF = [[P, 'ชาย'], [P, 'หญิง']].concat(MF);
  const T = '5,3,2,1', I = '5,3,2,1';
  each('ฟุตบอล 9 คน', 'ฟุตบอล', [[P, 'ชาย'], [MT, 'ชาย'], [MP, 'ชาย'], [ALL, 'หญิง']], 'team', 12, T, 'สนามฟุตบอล');
  each('วอลเลย์บอล', 'วอลเลย์บอล', MF, 'team', 10, T, 'สนามวอลเลย์บอล');
  each('บาสเกตบอล 3x3', 'บาสเกตบอล 3x3', MF, 'team', 5, T, 'สนามบาสเกตบอล');
  each('เซปักตะกร้อ', 'เซปักตะกร้อ', PMF, 'team', 5, T, 'สนามตะกร้อ');
  each('เทเบิลเทนนิส (ปิงปองเดี่ยว)', 'เทเบิลเทนนิส', MF, 'individual', 1, I, 'ห้องกีฬาในร่ม');
  each('แชร์บอล', 'แชร์บอล', [[P, 'ชาย'], [P, 'หญิง']], 'team', 10, T, 'สนามแชร์บอล');
  each('เปตอง ประเภทเดี่ยว', 'เปตอง', PMF, 'individual', 1, I, 'ลานเปตอง');
  each('เปตอง ประเภทคู่', 'เปตอง', PMF, 'team', 2, T, 'ลานเปตอง');
  each('เปตอง ประเภททีม', 'เปตอง', PMF, 'team', 4, T, 'ลานเปตอง');
  [['วิ่ง 60 เมตร'], ['วิ่ง 80 เมตร']].forEach(n => each(n[0], 'กรีฑา', [[PT, 'ชาย'], [PT, 'หญิง'], [PP, 'ชาย'], [PP, 'หญิง']], 'individual', 1, I, 'ลู่วิ่งกรีฑา'));
  const R = [[PP, 'ชาย'], [PP, 'หญิง']].concat(MF);
  each('วิ่ง 100 เมตร', 'กรีฑา', R, 'individual', 1, I, 'ลู่วิ่งกรีฑา');
  each('วิ่ง 200 เมตร', 'กรีฑา', R, 'individual', 1, I, 'ลู่วิ่งกรีฑา');
  each('มินิมาราธอน (ระดับชั้นละ 2 คน)', 'กรีฑา', PMF, 'individual', 2, I, 'เส้นทางวิ่งโรงเรียน');
  ['ขบวนพาเหรด', 'ประกวดผู้นำเชียร์', 'ประกวดกองเชียร์'].forEach(n => list.push({
    name: n, category: 'ประกวด', gender: 'ผสม', levelGroup: ALL, mode: 'color', maxPerColor: 0, points: '5,3,2,1', venue: 'สนามกีฬา',
    note: n === 'ขบวนพาเหรด' ? 'ขบวน: เทิดพระเกียรติพระพันปีหลวง, ต้านยาเสพติด, ผู้นำเชียร์, นักกีฬา, ครู' : (n === 'ประกวดผู้นำเชียร์' ? 'ผู้นำเชียร์ 7 คนขึ้นไป แสดงไม่เกิน 12 นาที (นับตั้งแต่จัดอุปกรณ์) เพลงบังคับ "ส่งนางฟ้าขึ้นสวรรค์" แต่งกายเรียบร้อย ไม่โป๊' : 'นักเรียนบนแสตนด์ไม่น้อยกว่า 40 คน เชียร์สอดคล้องกับผู้นำเชียร์ และเชียร์ต่อเนื่อง')
  }));
  return list;
}
function evKey_(e) { return [e.name, e.gender, e.levelGroup].join('|'); }

/** นำเข้ารายการตามโปรแกรมราชประชาเกมส์ (ข้ามรายการที่มีอยู่แล้ว) */
function addProgramEvents(sid, opts) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  opts = opts || {};
  return withLock_(() => {
    const sh = getSheet_('Events');
    let all = sheetToObjects_(sh);
    let removed = 0;
    if (opts.removeUnusedSamples) {
      const used = {};
      sheetToObjects_(getSheet_('Entries')).concat(sheetToObjects_(getSheet_('Results')), loadMatches_()).forEach(x => { used[x.eventId] = true; });
      const sample = {};
      sampleEventDefs_().forEach(d => { sample[evKey_(d)] = true; });
      programEventDefs_().forEach(d => { delete sample[evKey_(d)]; }); // รายการที่ตรงกับโปรแกรมให้คงไว้
      const keep = all.filter(e => !(sample[evKey_(e)] && !used[e.id] && e.status === 'planned'));
      removed = all.length - keep.length;
      if (removed) { writeTable_('Events', keep); all = keep; }
    }
    const have = {};
    all.forEach(e => { have[evKey_(e)] = true; });
    const defs = programEventDefs_().filter(d => !have[evKey_(d)]);
    const maxOrder = all.reduce((m, e) => Math.max(m, toInt_(e.sortOrder, 0)), 0);
    const maxCode = all.reduce((m, e) => Math.max(m, toInt_(e.code, 0)), 0);
    appendRowsObjects_(sh, defs.map((d, i) => ({
      id: newId_('e_'), code: pad2_(maxCode + i + 1), name: d.name, category: d.category, gender: d.gender,
      levelGroup: d.levelGroup, mode: d.mode, maxPerColor: String(d.maxPerColor), points: d.points,
      date: '', time: '', venue: d.venue, status: 'planned', sortOrder: String(maxOrder + i + 1), note: d.note || ''
    })));
    bustPublicCache_();
    logAction_(u, 'addProgramEvents', 'เพิ่ม ' + defs.length + ' / ข้าม ' + (programEventDefs_().length - defs.length) + ' / ลบตัวอย่าง ' + removed);
    return { ok: true, added: defs.length, skipped: programEventDefs_().length - defs.length, removed: removed };
  });
}

function addSampleEvents(sid) {
  const u = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const sh = getSheet_('Events');
    const all = sheetToObjects_(sh);
    const maxOrder = all.reduce((m, e) => Math.max(m, toInt_(e.sortOrder, 0)), 0);
    const defs = sampleEventDefs_();
    appendRowsObjects_(sh, defs.map((d, i) => ({
      id: newId_('e_'), code: pad2_(all.length + i + 1), name: d.name, category: d.category, gender: d.gender,
      levelGroup: d.levelGroup, mode: d.mode, maxPerColor: String(d.maxPerColor), points: d.points,
      date: '', time: '', venue: d.venue, status: 'planned', sortOrder: String(maxOrder + i + 1), note: ''
    })));
    bustPublicCache_();
    logAction_(u, 'addSampleEvents', String(defs.length));
    return { ok: true, added: defs.length };
  });
}

/* ===================== ENTRIES (ลงทะเบียนนักกีฬา) ===================== */
function canRegisterFor_(u, colorId) {
  if (isStaff_(u)) return true;
  return u.role === 'colorHead' && !!u.colorId && u.colorId === colorId;
}

/**
 * บันทึกรายชื่อนักกีฬาของ "สี" หนึ่ง ใน "รายการ" หนึ่ง (แทนที่รายชื่อเดิมทั้งชุด)
 */
function saveEntries(sid, eventId, colorId, studentIds) {
  const u = requireUser_(sid);
  return withLock_(() => {
    const settings = getSettingsMap_();
    const ev = sheetToObjects_(getSheet_('Events')).find(e => e.id === eventId);
    if (!ev) throw new Error('ไม่พบรายการแข่งขัน');
    if (ev.mode === 'color') throw new Error('รายการนี้เป็นการประกวดระดับสี ไม่ต้องลงทะเบียนรายชื่อนักกีฬา');
    const color = sheetToObjects_(getSheet_('Colors')).find(c => c.id === colorId);
    if (!color) throw new Error('ไม่พบสี');
    if (!canRegisterFor_(u, colorId)) throw new Error('คุณไม่มีสิทธิ์ลงทะเบียนให้สีนี้');
    if (!isStaff_(u)) {
      if (settings.registrationOpen !== 'true') throw new Error('ขณะนี้ปิดรับการลงทะเบียนแล้ว หากต้องการแก้ไขกรุณาติดต่อคณะกรรมการจัดการแข่งขัน');
      if (ev.status === 'finished') throw new Error('รายการนี้แข่งขันเสร็จสิ้นแล้ว ไม่สามารถแก้ไขรายชื่อได้');
    }
    const ids = [];
    (Array.isArray(studentIds) ? studentIds : []).forEach(x => { if (ids.indexOf(String(x)) === -1) ids.push(String(x)); });
    const max = toInt_(ev.maxPerColor, 0);
    if (max && ids.length > max) throw new Error('รายการนี้ลงทะเบียนได้สูงสุด ' + max + ' คนต่อสี (เลือกมา ' + ids.length + ' คน)');

    const students = sheetToObjects_(getSheet_('Students'));
    const byId = {};
    students.forEach(s => byId[s.id] = s);
    ids.forEach(id => {
      const s = byId[id];
      if (!s) throw new Error('พบรหัสนักเรียนที่ไม่มีในระบบ');
      if (s.active === 'false') throw new Error(s.fullname + ' ถูกระงับสถานะนักเรียน');
      if (s.colorId !== colorId) throw new Error(s.fullname + ' ไม่ได้อยู่ในสีนี้');
      const prob = eligibilityProblem_(ev, s);
      if (prob) throw new Error(s.fullname + ': ' + prob);
    });

    const allEntries = sheetToObjects_(getSheet_('Entries'));
    const results = sheetToObjects_(getSheet_('Results'));
    // ห้ามถอดชื่อคนที่มีผลการแข่งขันในรายการนี้แล้ว
    const removed = allEntries.filter(e => e.eventId === eventId && e.colorId === colorId && ids.indexOf(e.studentId) === -1);
    removed.forEach(e => {
      if (results.some(r => r.eventId === eventId && r.studentId === e.studentId)) {
        const s = byId[e.studentId];
        throw new Error('ไม่สามารถถอด ' + (s ? s.fullname : 'นักกีฬา') + ' ออกได้ เพราะมีผลการแข่งขันบันทึกไว้แล้ว');
      }
    });
    // จำกัดจำนวนรายการต่อคน
    const capEv = toInt_(settings.maxEventsPerStudent, 0);
    if (capEv > 0) {
      const events = sheetToObjects_(getSheet_('Events'));
      const evById = {};
      events.forEach(e => evById[e.id] = e);
      ids.forEach(id => {
        const other = {};
        allEntries.forEach(e => { if (e.studentId === id && e.eventId !== eventId && evById[e.eventId]) other[e.eventId] = true; });
        if (Object.keys(other).length + 1 > capEv) {
          throw new Error(byId[id].fullname + ' ลงแข่งขันครบ ' + capEv + ' รายการแล้ว (กำหนดสูงสุดต่อคน)');
        }
      });
    }
    const keep = allEntries.filter(e => !(e.eventId === eventId && e.colorId === colorId));
    const existing = {};
    allEntries.forEach(e => { if (e.eventId === eventId && e.colorId === colorId) existing[e.studentId] = e; });
    const now = nowIso_();
    ids.forEach(id => {
      keep.push(existing[id] || { id: newId_('n_'), eventId: eventId, colorId: colorId, studentId: id, createdBy: u.fullname, createdAt: now });
    });
    writeTable_('Entries', keep);
    logAction_(u, 'saveEntries', eventLabel_(ev) + ' / ' + color.name + ' = ' + ids.length + ' คน');
    return { ok: true, count: ids.length };
  });
}

/* ===================== RESULTS (บันทึกผลการแข่งขัน) ===================== */
/**
 * rows: [{ rank, colorId, studentId?, record? }]
 *  - individual : ระบุ studentId (ต้องลงทะเบียนในรายการนี้) ได้หลายคนต่อสี
 *  - team/color : 1 แถวต่อสี
 * finalize = true  -> ประกาศผล (นับคะแนนรวม)   false -> บันทึกร่าง (ยังไม่นับคะแนนรวม)
 */
function saveResults(sid, eventId, rows, finalize) {
  const u = requireUser_(sid);
  if (!canRecord_(u)) throw new Error('คุณไม่มีสิทธิ์บันทึกผลการแข่งขัน');
  return withLock_(() => saveResultsCore_(u, eventId, rows, finalize));
}
function saveResultsCore_(u, eventId, rows, finalize) {
  return (() => {
    const evSh = getSheet_('Events');
    const ev = sheetToObjects_(evSh).find(e => e.id === eventId);
    if (!ev) throw new Error('ไม่พบรายการแข่งขัน');
    if (ev.status === 'finished' && !isStaff_(u)) throw new Error('รายการนี้ประกาศผลแล้ว เฉพาะคณะกรรมการจัดการแข่งขัน/ผู้ดูแลระบบเท่านั้นที่แก้ไขได้');
    const colors = sheetToObjects_(getSheet_('Colors'));
    const colorIds = {};
    colors.forEach(c => colorIds[c.id] = true);
    const students = sheetToObjects_(getSheet_('Students'));
    const sById = {};
    students.forEach(s => sById[s.id] = s);
    const entries = sheetToObjects_(getSheet_('Entries')).filter(e => e.eventId === eventId);
    const list = Array.isArray(rows) ? rows : [];
    if (finalize && !list.length) throw new Error('กรุณาบันทึกอันดับอย่างน้อย 1 อันดับก่อนประกาศผล');

    const seenColor = {}, seenStudent = {};
    const now = nowIso_();
    const out = list.map(r => {
      const rank = toInt_(r.rank, 0);
      if (rank < 1 || rank > 99) throw new Error('อันดับต้องเป็นเลขจำนวนเต็ม 1-99');
      if (!colorIds[r.colorId]) throw new Error('พบสีที่ไม่มีในระบบ');
      let studentId = '', athleteName = '';
      if (ev.mode === 'individual') {
        studentId = String(r.studentId || '');
        const s = sById[studentId];
        if (!s) throw new Error('กรุณาเลือกนักกีฬาให้ครบทุกอันดับ');
        if (!entries.some(e => e.studentId === studentId && e.colorId === r.colorId)) {
          throw new Error(s.fullname + ' ไม่ได้ลงทะเบียนในรายการนี้ (หรือสีไม่ตรง)');
        }
        if (seenStudent[studentId]) throw new Error(s.fullname + ' ถูกบันทึกซ้ำในรายการเดียวกัน');
        seenStudent[studentId] = true;
        athleteName = s.fullname + (s.classLevel ? ' (' + s.classLevel + (s.room ? '/' + s.room : '') + ')' : '');
      } else {
        if (seenColor[r.colorId]) throw new Error('สีเดียวกันบันทึกซ้ำในรายการเดียวกัน');
        seenColor[r.colorId] = true;
      }
      return {
        id: newId_('r_'), eventId: eventId, rank: String(rank), colorId: r.colorId, studentId: studentId,
        athleteName: athleteName, record: String(r.record || '').trim().slice(0, 60),
        points: String(pointsForRank_(ev.points, rank)), updatedBy: u.fullname, updatedAt: now
      };
    });
    out.sort((a, b) => toInt_(a.rank) - toInt_(b.rank));
    const rest = sheetToObjects_(getSheet_('Results')).filter(r => r.eventId !== eventId);
    writeTable_('Results', rest.concat(out));
    updateRowById_(evSh, eventId, { status: finalize ? 'finished' : (out.length ? 'ongoing' : 'planned') });
    bustPublicCache_();
    logAction_(u, finalize ? 'finalizeResults' : 'saveResultsDraft', eventLabel_(ev) + ' / ' + out.length + ' แถว');
    return { ok: true, count: out.length };
  })();
}

/* ===================== MATCHES (จับคู่/ตารางการแข่งขัน) ===================== */
// รูปแบบ: พบกันหมด (roundrobin) และแพ้คัดออก (knockout) ระหว่าง "สี" ต่อ 1 รายการแข่งขัน
//  stage 'rr' = พบกันหมด, 'ko' = แพ้คัดออก
//  rd (เฉพาะ ko) = จำนวนทีมในรอบ: '2' ชิงชนะเลิศ, '4' รองชนะเลิศ, '8' ก่อนรองฯ, '3' = ชิงอันดับ 3
//  srcA/srcB (เฉพาะ ko) = ที่มาของทีม เช่น 'W:m_xxxx' ผู้ชนะคู่นั้น, 'L:m_xxxx' ผู้แพ้คู่นั้น
function loadMatches_() {
  return sheetToObjects_(getSheet_('Matches'));
}
function sortMatches_(list) {
  return list.slice().sort((a, b) => (toInt_(a.no, 9999) - toInt_(b.no, 9999)));
}
function addMinutes_(hhmm, add) {
  const p = String(hhmm || '').split(':');
  if (p.length !== 2) return '';
  let t = toInt_(p[0]) * 60 + toInt_(p[1]) + add;
  t = ((t % 1440) + 1440) % 1440;
  return pad2_(Math.floor(t / 60)) + ':' + pad2_(t % 60);
}

function buildRoundRobin_(ids, legs) {
  const arr = ids.slice();
  if (arr.length % 2) arr.push(null);
  const n = arr.length, rounds = n - 1, out = [];
  let cur = arr.slice();
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = cur[i], b = cur[n - 1 - i];
      if (a && b) out.push({ stage: 'rr', rd: '', round: 'รอบที่ ' + (r + 1), colorA: a, colorB: b, srcA: '', srcB: '' });
    }
    cur = [cur[0]].concat([cur[n - 1]], cur.slice(1, n - 1));
  }
  if (legs === 2) {
    const first = out.slice();
    first.forEach(m => out.push({ stage: 'rr', rd: '', round: 'รอบที่ ' + (toInt_(m.round.replace(/\D/g, '')) + rounds) + ' (เหย้า-เยือนกลับ)', colorA: m.colorB, colorB: m.colorA, srcA: '', srcB: '' }));
  }
  return out;
}
function seedSlots_(p) {
  let s = [1];
  while (s.length < p) {
    const n = s.length * 2, t = [];
    s.forEach(x => { t.push(x); t.push(n + 1 - x); });
    s = t;
  }
  return s;
}
function koRoundName_(k) {
  return k === 2 ? 'ชิงชนะเลิศ' : k === 4 ? 'รอบรองชนะเลิศ' : k === 8 ? 'รอบก่อนรองชนะเลิศ' : 'รอบ ' + k + ' ทีม';
}
function buildKnockout_(ids, third) {
  const n = ids.length;
  let p = 1;
  while (p < n) p *= 2;
  // จับคู่ตามลำดับที่ให้มา: สี 1 พบ สี 2, สี 3 พบ สี 4 ... ถ้าสีไม่ครบ 2^k ให้สีลำดับต้นๆ ได้บายเข้ารอบถัดไป
  const byes = p - n;
  let entries = [];
  ids.forEach((c, i) => {
    entries.push({ c: c });
    if (i < byes) entries.push(null);
  });
  const out = [];
  while (entries.length > 1) {
    const k = entries.length, next = [], here = [];
    for (let i = 0; i < k; i += 2) {
      const a = entries[i], b = entries[i + 1];
      if (!a || !b) { next.push(a || b); continue; } // ได้บาย ผ่านเข้ารอบถัดไปเลย
      const m = { id: newId_('m_'), stage: 'ko', rd: String(k), round: koRoundName_(k), colorA: a.c || '', colorB: b.c || '', srcA: a.src || '', srcB: b.src || '' };
      out.push(m); here.push(m); next.push({ src: 'W:' + m.id });
    }
    if (k === 4 && third && here.length === 2) {
      out.push({ id: newId_('m_'), stage: 'ko', rd: '3', round: 'ชิงอันดับ ๓', colorA: '', colorB: '', srcA: 'L:' + here[0].id, srcB: 'L:' + here[1].id });
    }
    entries = next;
  }
  return out;
}

/** คำนวณสีของคู่ถัดไปจากผลของคู่ก่อนหน้า (แพ้คัดออก) */
function resolveBracket_(ms) {
  const byId = {};
  ms.forEach(m => { byId[m.id] = m; });
  sortMatches_(ms).forEach(m => {
    ['A', 'B'].forEach(side => {
      const src = m['src' + side];
      if (!src) return;
      const ref = byId[src.slice(2)];
      let c = '';
      if (ref && ref.status === 'finished' && ref.winner && ref.winner !== 'draw') {
        const loser = ref.winner === ref.colorA ? ref.colorB : ref.colorA;
        c = src.charAt(0) === 'W' ? ref.winner : loser;
      }
      m['color' + side] = c;
    });
  });
}

/** สร้างแถวคู่แข่งขันของ 1 รายการ จากลำดับสีที่กำหนด */
function matchRowsFor_(ev, ids, format, opts, u) {
    const list = format === 'roundrobin' ? buildRoundRobin_(ids, toInt_(opts.legs, 1) === 2 ? 2 : 1) : buildKnockout_(ids, opts.thirdPlace !== false);
    const date = String(opts.date || ev.date || '').trim();
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
    let start = String(opts.startTime || ev.time || '').trim();
    if (start && !/^\d{1,2}:\d{2}$/.test(start)) throw new Error('รูปแบบเวลาไม่ถูกต้อง (เช่น 09:30)');
    const gap = Math.max(0, toInt_(opts.interval, 30));
    const venue = String(opts.venue || ev.venue || '').trim();
    const now = nowIso_();
    const rows = list.map((m, i) => ({
      id: m.id || newId_('m_'), eventId: ev.id, stage: m.stage, rd: m.rd, round: m.round, no: String(i + 1),
      colorA: m.colorA, colorB: m.colorB, srcA: m.srcA, srcB: m.srcB, scoreA: '', scoreB: '', winner: '', status: 'planned',
      date: date, time: start ? addMinutes_(start, gap * i) : '', venue: venue, note: '', updatedBy: u.fullname, updatedAt: now
    }));
  return rows;
}

function generateMatches(sid, eventId, format, opts) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  opts = opts || {};
  if (['roundrobin', 'knockout'].indexOf(format) === -1) throw new Error('รูปแบบการจับคู่ไม่ถูกต้อง');
  return withLock_(() => {
    const ev = sheetToObjects_(getSheet_('Events')).find(e => e.id === eventId);
    if (!ev) throw new Error('ไม่พบรายการแข่งขัน');
    const colors = sortByOrder_(sheetToObjects_(getSheet_('Colors')));
    const valid = {};
    colors.forEach(c => { valid[c.id] = true; });
    let ids = (Array.isArray(opts.colorIds) && opts.colorIds.length ? opts.colorIds : colors.map(c => c.id)).filter(x => valid[x]);
    ids = ids.filter((x, i) => ids.indexOf(x) === i);
    if (ids.length < 2) throw new Error('ต้องมีอย่างน้อย 2 สีจึงจะจับคู่ได้');
    if (ids.length > 16) throw new Error('จับคู่ได้ไม่เกิน 16 สี');
    const all = loadMatches_();
    const old = all.filter(m => m.eventId === eventId);
    if (old.some(m => m.status === 'finished') && !opts.force) throw new Error('รายการนี้มีคู่ที่บันทึกผลแล้ว หากจับคู่ใหม่ผลเดิมจะหายไป');
    if (opts.shuffle) {
      for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = ids[i]; ids[i] = ids[j]; ids[j] = t;
      }
    }
    const rows = matchRowsFor_(ev, ids, format, opts, u);
    writeTable_('Matches', all.filter(m => m.eventId !== eventId).concat(rows));
    bustPublicCache_();
    logAction_(u, 'generateMatches', eventLabel_(ev) + ' / ' + (format === 'roundrobin' ? 'พบกันหมด' : 'แพ้คัดออก') + ' / ' + rows.length + ' คู่');
    return { ok: true, count: rows.length };
  });
}

/* ---------- จัดช่องวิ่ง (รายการวิ่ง) ---------- */
// รายการวิ่งที่ใช้ลู่ (ชื่อขึ้นต้นด้วย "วิ่ง" เช่น วิ่ง 100 เมตร, วิ่งผลัด) — มินิมาราธอนปล่อยตัวพร้อมกัน จึงไม่ใช้ช่องวิ่ง
function isLaneEvent_(ev) { return /^วิ่ง/.test(String(ev.name || '').trim()) && ev.mode !== 'color'; }

/** นับจำนวนครั้งที่แต่ละสีเคยได้ช่องนั้นๆ จากตารางที่มีอยู่ (ใช้กระจายช่องในหลายรายการให้เท่าๆ กัน) */
function laneCounts_(matches) {
  const cnt = {};
  matches.forEach(m => {
    if (m.stage !== 'lane' || !m.colorA) return;
    const c = cnt[m.colorA] = cnt[m.colorA] || {};
    c[m.rd] = (c[m.rd] || 0) + 1;
  });
  return cnt;
}

/** เลือกช่องที่ใช้เมื่อมีผู้แข่งน้อยกว่าจำนวนช่อง: ใช้ช่องกลางก่อน */
function laneSet_(size, lanes) {
  const mid = (lanes + 1) / 2, all = [];
  for (let i = 1; i <= lanes; i++) all.push(i);
  all.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
  return all.slice(0, size).sort((a, b) => a - b);
}

/** จัดผู้แข่งในฮีตเดียวลงช่อง ให้สีที่เคยได้ช่องนั้นน้อยที่สุด */
function assignLanes_(colorsInHeat, laneNos, cnt) {
  const n = colorsInHeat.length;
  const cost = (c, l) => { const x = (cnt[c] || {})[l] || 0; return x * x; };
  let best = null, bestCost = Infinity;
  if (n <= 8) {
    const used = new Array(n).fill(false), cur = [];
    (function rec(acc) {
      if (acc >= bestCost) return;
      if (cur.length === n) { bestCost = acc; best = cur.slice(); return; }
      const c = colorsInHeat[cur.length];
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        used[i] = true; cur.push(laneNos[i]); rec(acc + cost(c, laneNos[i])); cur.pop(); used[i] = false;
      }
    })(0);
  } else {
    const left = laneNos.slice();
    best = colorsInHeat.map(c => {
      let bi = 0;
      left.forEach((l, i) => { if (cost(c, l) < cost(c, left[bi])) bi = i; });
      return left.splice(bi, 1)[0];
    });
  }
  return best;
}

/** แถวตารางช่องวิ่งของ 1 รายการ (อัปเดต cnt ให้รายการถัดไปใช้ต่อ) */
/** รายชื่อนักกีฬาที่ลงทะเบียนไว้ต่อรายการต่อสี: { eventId: { colorId: [ชื่อ ชั้น] } } */
function laneRosterMap_() {
  const stu = {};
  sheetToObjects_(getSheet_('Students')).forEach(s => { stu[s.id] = s; });
  const out = {};
  sheetToObjects_(getSheet_('Entries')).forEach(n => {
    const s = stu[n.studentId]; if (!s) return;
    const e = out[n.eventId] = out[n.eventId] || {};
    (e[n.colorId] = e[n.colorId] || []).push(String(s.fullname || '').trim() + (s.classLevel ? ' (' + s.classLevel + (s.room ? '/' + s.room : '') + ')' : ''));
  });
  return out;
}

/** แถวตารางช่องวิ่งของ 1 รายการ: วิ่งรอบเดียวจบ ทุกสีที่เข้าแข่งอยู่ในการแข่งครั้งเดียว (อัปเดต cnt ให้รายการถัดไปใช้ต่อ) */
function laneRowsFor_(ev, ids, opts, cnt, u, roster) {
  const date = String(opts.date || ev.date || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
  const start = String(opts.startTime || ev.time || '').trim();
  if (start && !/^\d{1,2}:\d{2}$/.test(start)) throw new Error('รูปแบบเวลาไม่ถูกต้อง (เช่น 09:30)');
  const venue = String(opts.venue || ev.venue || '').trim();
  const reg = (roster || {})[ev.id] || {};
  // วิ่งรอบเดียว: 1 สี = 1 ช่องวิ่ง (สีละ 1 คน) จึงมีช่องวิ่งเท่าจำนวนสีที่เข้าแข่ง (ปกติ 4 ช่อง)
  const entries = ids.map(c => ({ c: c, name: (reg[c] || [])[0] || '' }));
  const colorsOnly = entries.map(x => x.c);
  const laneNos = laneSet_(entries.length, entries.length); // ช่องวิ่ง 1..N ตามจำนวนผู้แข่ง
  const asg = assignLanes_(colorsOnly, laneNos, cnt);
  const items = entries.map((x, i) => ({ c: x.c, name: x.name, l: asg[i] })).sort((a, b) => a.l - b.l);
  const now = nowIso_(), rows = [];
  items.forEach(it => {
    cnt[it.c] = cnt[it.c] || {};
    cnt[it.c][it.l] = (cnt[it.c][it.l] || 0) + 1;
    rows.push({
      id: newId_('m_'), eventId: ev.id, stage: 'lane', rd: String(it.l), round: 'ช่องวิ่ง', no: String(rows.length + 1),
      colorA: it.c, colorB: '', srcA: '', srcB: '', scoreA: '', scoreB: '', winner: '', status: 'planned',
      date: date, time: start, venue: venue, note: it.name, updatedBy: u.fullname, updatedAt: now
    });
  });
  return rows;
}

function generateLanes(sid, eventId, opts) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  opts = opts || {};
  return withLock_(() => {
    const ev = sheetToObjects_(getSheet_('Events')).find(e => e.id === eventId);
    if (!ev) throw new Error('ไม่พบรายการแข่งขัน');
    if (!isLaneEvent_(ev)) throw new Error('จัดช่องวิ่งได้เฉพาะรายการวิ่ง');
    const colors = sortByOrder_(sheetToObjects_(getSheet_('Colors')));
    const valid = {};
    colors.forEach(c => { valid[c.id] = true; });
    let ids = (Array.isArray(opts.colorIds) && opts.colorIds.length ? opts.colorIds : colors.map(c => c.id)).filter(x => valid[x]);
    ids = ids.filter((x, i) => ids.indexOf(x) === i);
    if (ids.length < 2) throw new Error('ต้องมีอย่างน้อย 2 สี');
    const all = loadMatches_();
    const keep = all.filter(m => m.eventId !== eventId);
    {
      const old = all.filter(m => m.eventId === eventId);
      if (old.some(m => m.status === 'finished') && !opts.force) throw new Error('รายการนี้มีคู่ที่บันทึกผลแล้ว');
    }
    if (opts.shuffle) {
      for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = ids[i]; ids[i] = ids[j]; ids[j] = t; }
    }
    const rows = laneRowsFor_(ev, ids, opts, laneCounts_(keep), u, laneRosterMap_());
    writeTable_('Matches', keep.concat(rows));
    bustPublicCache_();
    logAction_(u, 'generateLanes', eventLabel_(ev) + ' / ' + rows.length + ' ช่อง');
    return { ok: true, count: rows.length };
  });
}

/* ---------- จับคู่ทุกรายการ โดยกระจายการพบกันของแต่ละสีให้เท่ากัน ---------- */
function pairKey_(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

/** คู่แรกของสายแพ้คัดออกจากลำดับสี + สีที่ได้บาย (ตรงกับ buildKnockout_) */
function firstRoundOf_(order) {
  const n = order.length;
  let p = 1;
  while (p < n) p *= 2;
  const byes = p - n;
  let entries = [];
  order.forEach((c, i) => { entries.push({ c: c }); if (i < byes) entries.push(null); });
  const pairs = [], byeTeams = [];
  let first = true;
  while (entries.length > 1) {
    const next = [];
    for (let i = 0; i < entries.length; i += 2) {
      const a = entries[i], b = entries[i + 1];
      if (!a || !b) { const t = a || b; next.push(t); if (first && t && t.c) byeTeams.push(t.c); continue; }
      if (a.c && b.c) pairs.push([a.c, b.c]);   // คู่ที่ทราบสีทั้งสองฝ่ายตั้งแต่ตอนจับคู่
      next.push({ u: true });
    }
    entries = next; first = false;
  }
  return { pairs: pairs, byeTeams: byeTeams };
}

/** เลือกลำดับสีที่ทำให้คู่ที่ต้องพบกันรอบแรก "เคยพบกันน้อยที่สุด" (กระจายให้เท่ากัน) */
function bestOrder_(ids, pc, byeC) {
  const n = ids.length;
  let best = null, bestCost = Infinity;
  const test = ord => {
    const f = firstRoundOf_(ord);
    let cost = 0;
    f.pairs.forEach(pr => { const c = pc[pairKey_(pr[0], pr[1])] || 0; cost += 2 * c + 1; });
    f.byeTeams.forEach(t => { cost += 0.001 * (byeC[t] || 0); }); // บายเป็นเงื่อนไขรอง
    if (cost < bestCost) { bestCost = cost; best = ord.slice(); }
  };
  if (n <= 7) {
    const used = new Array(n).fill(false), cur = [];
    (function rec() {
      if (cur.length === n) { test(cur); return; }
      for (let i = 0; i < n; i++) {
        if (used[i]) continue;
        used[i] = true; cur.push(ids[i]); rec(); cur.pop(); used[i] = false;
      }
    })();
  } else {
    test(ids);
    for (let t = 0; t < 4000; t++) {
      const a = ids.slice();
      for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const x = a[i]; a[i] = a[j]; a[j] = x; }
      test(a);
    }
  }
  return best || ids.slice();
}

function pairSummary_(matches, colors) {
  const pc = {};
  matches.forEach(m => { if (!m.srcA && !m.srcB && m.colorA && m.colorB) { const k = pairKey_(m.colorA, m.colorB); pc[k] = (pc[k] || 0) + 1; } });
  const list = [];
  for (let i = 0; i < colors.length; i++) for (let j = i + 1; j < colors.length; j++) list.push({ a: colors[i].id, b: colors[j].id, count: pc[pairKey_(colors[i].id, colors[j].id)] || 0 });
  return list;
}

/**
 * จับคู่แพ้คัดออกให้หลายรายการพร้อมกัน
 * opts: eventIds (ไม่ระบุ = ทุกรายการที่ไม่ใช่ประกวด), colorIds, thirdPlace, replace (จับคู่ทับรายการที่มีแล้ว), interval
 * รายการที่มีคู่ที่บันทึกผลแล้วจะไม่ถูกแตะต้อง
 */
function generateAllMatches(sid, opts) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  opts = opts || {};
  return withLock_(() => {
    const events = sortByOrder_(sheetToObjects_(getSheet_('Events')));
    const colors = sortByOrder_(sheetToObjects_(getSheet_('Colors')));
    const valid = {};
    colors.forEach(c => { valid[c.id] = true; });
    let ids = (Array.isArray(opts.colorIds) && opts.colorIds.length ? opts.colorIds : colors.map(c => c.id)).filter(x => valid[x]);
    ids = ids.filter((x, i) => ids.indexOf(x) === i);
    if (ids.length < 2) throw new Error('ต้องมีอย่างน้อย 2 สีจึงจะจับคู่ได้');
    if (ids.length > 16) throw new Error('จับคู่ได้ไม่เกิน 16 สี');
    const want = {};
    const hasList = Array.isArray(opts.eventIds) && opts.eventIds.length;
    if (hasList) opts.eventIds.forEach(x => { want[String(x)] = true; });
    const all = loadMatches_();
    const byEv = {};
    all.forEach(m => { (byEv[m.eventId] = byEv[m.eventId] || []).push(m); });
    const targets = [], skipped = { hasMatches: 0, finished: 0 };
    events.forEach(e => {
      if (e.mode === 'color') return;
      if (hasList && !want[e.id]) return;
      const old = byEv[e.id] || [];
      if (old.some(m => m.status === 'finished')) { skipped.finished++; return; }
      if (old.length && !opts.replace) { skipped.hasMatches++; return; }
      targets.push(e);
    });
    if (!targets.length) throw new Error('ไม่มีรายการที่ต้องจับคู่ (รายการที่เลือกมีตารางแข่งแล้ว หรือมีคู่ที่บันทึกผลแล้ว)');
    const replaced = {};
    targets.forEach(e => { replaced[e.id] = true; });
    const kept = all.filter(m => !replaced[m.eventId]);
    // จำนวนครั้งที่แต่ละคู่สีพบกันแล้ว (จากรายการที่คงไว้)
    const pc = {}, byeC = {};
    kept.forEach(m => { if (!m.srcA && !m.srcB && m.colorA && m.colorB) { const k = pairKey_(m.colorA, m.colorB); pc[k] = (pc[k] || 0) + 1; } });
    const rows = [], laneCnt = laneCounts_(kept), roster = laneRosterMap_();
    let laneEvents = 0;
    targets.forEach(e => {
      if (isLaneEvent_(e)) {
        laneRowsFor_(e, ids, {}, laneCnt, u, roster).forEach(r => rows.push(r));
        laneEvents++;
        return;
      }
      const order = bestOrder_(ids, pc, byeC);
      const f = firstRoundOf_(order);
      f.pairs.forEach(pr => { const k = pairKey_(pr[0], pr[1]); pc[k] = (pc[k] || 0) + 1; });
      f.byeTeams.forEach(t => { byeC[t] = (byeC[t] || 0) + 1; });
      matchRowsFor_(e, order, 'knockout', { thirdPlace: opts.thirdPlace !== false, interval: opts.interval }, u).forEach(r => rows.push(r));
    });
    writeTable_('Matches', kept.concat(rows));
    bustPublicCache_();
    const summary = pairSummary_(kept.concat(rows), ids.map(id => colors.find(c => c.id === id)));
    const cnts = summary.map(x => x.count);
    const mn = cnts.length ? Math.min.apply(null, cnts) : 0, mx = cnts.length ? Math.max.apply(null, cnts) : 0;
    logAction_(u, 'generateAllMatches', targets.length + ' รายการ (ช่องวิ่ง ' + laneEvents + ') / ' + rows.length + ' แถว / พบกันต่ำสุด ' + mn + ' สูงสุด ' + mx);
    return { ok: true, events: targets.length, laneEvents: laneEvents, matches: rows.length, skipped: skipped, pairs: summary, min: mn, max: mx };
  });
}

function clearMatches(sid, eventId) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const ev = sheetToObjects_(getSheet_('Events')).find(e => e.id === eventId);
    if (!ev) throw new Error('ไม่พบรายการแข่งขัน');
    const all = loadMatches_();
    const n = all.filter(m => m.eventId === eventId).length;
    writeTable_('Matches', all.filter(m => m.eventId !== eventId));
    bustPublicCache_();
    logAction_(u, 'clearMatches', eventLabel_(ev) + ' / ' + n + ' คู่');
    return { ok: true, deleted: n };
  });
}

/** ล้างการจับคู่/ตารางช่องวิ่งของทุกรายการ (ไม่แตะผลการแข่งขันที่ประกาศแล้ว) */
function clearAllMatches(sid) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const n = loadMatches_().length;
    if (n) writeTable_('Matches', []);
    bustPublicCache_();
    logAction_(u, 'clearAllMatches', 'ล้างการจับคู่ทั้งหมด ' + n + ' รายการ');
    return { ok: true, deleted: n };
  });
}

function scoreOrEmpty_(v, label) {
  const t = String(v === undefined || v === null ? '' : v).trim();
  if (t === '') return '';
  if (!/^\d{1,3}$/.test(t)) throw new Error(label + 'ต้องเป็นเลขจำนวนเต็มตั้งแต่ 0 ขึ้นไป');
  return String(parseInt(t, 10));
}

/**
 * บันทึกคู่แข่งขัน
 *  - ไม่มี id = เพิ่มคู่เอง (เฉพาะคณะกรรมการจัดการแข่งขัน)
 *  - payload.finalize = บันทึกผลและปิดคู่, payload.reopen = เปิดแก้ไขคู่ที่บันทึกผลแล้ว
 */
function saveMatch(sid, p) {
  const u = requireUser_(sid);
  if (!canRecord_(u)) throw new Error('คุณไม่มีสิทธิ์บันทึกผลการแข่งขัน');
  p = p || {};
  return withLock_(() => {
    const all = loadMatches_();
    const colors = {};
    sheetToObjects_(getSheet_('Colors')).forEach(c => { colors[c.id] = c; });
    const now = nowIso_();
    if (!p.id) {
      if (!isStaff_(u)) throw new Error('เฉพาะคณะกรรมการจัดการแข่งขัน/ผู้ดูแลระบบเท่านั้นที่เพิ่มคู่ได้');
      const ev = sheetToObjects_(getSheet_('Events')).find(e => e.id === p.eventId);
      if (!ev) throw new Error('ไม่พบรายการแข่งขัน');
      if (!colors[p.colorA] || !colors[p.colorB] || p.colorA === p.colorB) throw new Error('กรุณาเลือกสีที่แข่งขันให้ครบและต้องเป็นคนละสี');
      const mine = all.filter(m => m.eventId === ev.id);
      const nm = {
        id: newId_('m_'), eventId: ev.id, stage: mine.length ? mine[0].stage : 'rr', rd: '', round: String(p.round || '').trim() || 'นัดพิเศษ',
        no: String(mine.reduce((x, m) => Math.max(x, toInt_(m.no, 0)), 0) + 1), colorA: p.colorA, colorB: p.colorB, srcA: '', srcB: '',
        scoreA: '', scoreB: '', winner: '', status: 'planned', date: String(p.date || ev.date || ''), time: String(p.time || ''), venue: String(p.venue || ev.venue || ''),
        note: '', updatedBy: u.fullname, updatedAt: now
      };
      writeTable_('Matches', all.concat([nm]));
      bustPublicCache_();
      logAction_(u, 'addMatch', eventLabel_(ev) + ' / ' + colors[p.colorA].name + ' - ' + colors[p.colorB].name);
      return { ok: true };
    }
    const m = all.find(x => x.id === p.id);
    if (!m) throw new Error('ไม่พบคู่แข่งขัน');
    if (m.stage === 'lane') throw new Error('ตารางช่องวิ่งไม่มีการบันทึกคะแนนรายคู่ — บันทึกผลในหน้า "บันทึกผลการแข่งขัน"');
    const mine = all.filter(x => x.eventId === m.eventId);
    if (m.status === 'finished' && !p.reopen && !isStaff_(u)) throw new Error('คู่นี้บันทึกผลแล้ว เฉพาะคณะกรรมการจัดการแข่งขัน/ผู้ดูแลระบบเท่านั้นที่แก้ไขได้');
    if (p.reopen && !isStaff_(u)) throw new Error('เฉพาะคณะกรรมการจัดการแข่งขัน/ผู้ดูแลระบบเท่านั้นที่เปิดแก้ไขได้');

    if (isStaff_(u)) {
      if (p.date !== undefined) {
        const d = String(p.date || '').trim();
        if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('รูปแบบวันที่ไม่ถูกต้อง');
        m.date = d;
      }
      if (p.time !== undefined) {
        const t = String(p.time || '').trim();
        if (t && !/^\d{1,2}:\d{2}$/.test(t)) throw new Error('รูปแบบเวลาไม่ถูกต้อง (เช่น 09:30)');
        m.time = t;
      }
      if (p.venue !== undefined) m.venue = String(p.venue || '').trim().slice(0, 80);
      if (!m.srcA && !m.srcB && m.status !== 'finished' && p.colorA && p.colorB) {
        if (!colors[p.colorA] || !colors[p.colorB] || p.colorA === p.colorB) throw new Error('กรุณาเลือกสีให้ครบและต้องเป็นคนละสี');
        m.colorA = p.colorA; m.colorB = p.colorB;
      }
    }
    if (p.note !== undefined) m.note = String(p.note || '').trim().slice(0, 120);

    if (m.status === 'finished' && !p.reopen && !p.finalize && (p.scoreA !== undefined || p.scoreB !== undefined)) {
      throw new Error('คู่นี้บันทึกผลแล้ว กรุณากด "ยกเลิกผล (เปิดแก้ไข)" ก่อนแก้คะแนน หรือกด "บันทึกผลใหม่"');
    }
    if (p.reopen) {
      m.status = 'planned'; m.winner = '';
    } else {
      if (p.scoreA !== undefined || p.scoreB !== undefined) {
        m.scoreA = scoreOrEmpty_(p.scoreA, 'คะแนนของ' + (colors[m.colorA] ? colors[m.colorA].name : 'ทีม A'));
        m.scoreB = scoreOrEmpty_(p.scoreB, 'คะแนนของ' + (colors[m.colorB] ? colors[m.colorB].name : 'ทีม B'));
      }
      if (p.finalize) {
        if (!colors[m.colorA] || !colors[m.colorB]) throw new Error('ยังไม่ทราบคู่แข่งขัน (รอผลคู่ก่อนหน้า)');
        if (m.scoreA === '' || m.scoreB === '') throw new Error('กรุณากรอกคะแนนทั้งสองฝ่ายก่อนบันทึกผล');
        const a = toInt_(m.scoreA), b = toInt_(m.scoreB);
        if (a > b) m.winner = m.colorA;
        else if (b > a) m.winner = m.colorB;
        else if (m.stage === 'ko') {
          if (p.winner !== m.colorA && p.winner !== m.colorB) throw new Error('คะแนนเสมอกัน กรุณาเลือกผู้ชนะ (เช่น จากการดวลจุดโทษ/ต่อเวลา) เพราะเป็นการแข่งแบบแพ้คัดออก');
          m.winner = p.winner;
        } else m.winner = 'draw';
        m.status = 'finished';
      } else if (m.status !== 'finished') {
        m.winner = '';
      }
    }
    m.updatedBy = u.fullname; m.updatedAt = now;

    // ส่งผู้ชนะ/ผู้แพ้เข้าสู่คู่ถัดไป (แพ้คัดออก)
    if (m.stage === 'ko') {
      const before = {};
      mine.forEach(x => { before[x.id] = x.colorA + '|' + x.colorB; });
      resolveBracket_(mine);
      mine.forEach(x => {
        if (x.id !== m.id && x.status === 'finished' && before[x.id] !== x.colorA + '|' + x.colorB) {
          throw new Error('แก้ไขไม่ได้ เพราะคู่ถัดไป (' + x.round + ') บันทึกผลแล้ว กรุณาเปิดแก้ไขคู่ถัดไปก่อน');
        }
      });
    }
    writeTable_('Matches', all);
    bustPublicCache_();
    const ev = sheetToObjects_(getSheet_('Events')).find(e => e.id === m.eventId);
    logAction_(u, p.reopen ? 'reopenMatch' : (p.finalize ? 'finalizeMatch' : 'saveMatch'), (ev ? eventLabel_(ev) : '') + ' / ' + m.round + ' / ' +
      (colors[m.colorA] ? colors[m.colorA].name : '?') + ' ' + m.scoreA + '-' + m.scoreB + ' ' + (colors[m.colorB] ? colors[m.colorB].name : '?'));
    return { ok: true };
  });
}

function deleteMatch(sid, id) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const all = loadMatches_();
    const m = all.find(x => x.id === id);
    if (!m) throw new Error('ไม่พบคู่แข่งขัน');
    if (all.some(x => x.srcA.slice(2) === id || x.srcB.slice(2) === id)) throw new Error('ลบไม่ได้ เพราะเป็นคู่ที่ใช้ในสายแพ้คัดออก ให้ใช้ "ล้างการจับคู่" แล้วจับคู่ใหม่');
    writeTable_('Matches', all.filter(x => x.id !== id));
    bustPublicCache_();
    logAction_(u, 'deleteMatch', m.round);
    return { ok: true };
  });
}

/** ตารางคะแนน/อันดับจากผลคู่แข่งขันของ 1 รายการ */
function computeMatchRanking_(ms, colorOrder) {
  if (!ms.length) return { kind: '', complete: false, rows: [] };
  const fin = ms.filter(m => m.status === 'finished');
  const kind = ms[0].stage === 'ko' ? 'ko' : 'rr';
  const complete = ms.every(m => m.status === 'finished');
  const ord = {};
  (colorOrder || []).forEach((id, i) => { ord[id] = i; });
  if (kind === 'rr') {
    const t = {};
    ms.forEach(m => [m.colorA, m.colorB].forEach(c => {
      if (c && !t[c]) t[c] = { colorId: c, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0, h2h: 0, rank: 0 };
    }));
    fin.forEach(m => {
      const a = t[m.colorA], b = t[m.colorB];
      if (!a || !b) return;
      const sa = toInt_(m.scoreA), sb = toInt_(m.scoreB);
      a.played++; b.played++; a.gf += sa; a.ga += sb; b.gf += sb; b.ga += sa;
      if (m.winner === 'draw') { a.d++; b.d++; a.pts++; b.pts++; }
      else if (m.winner === m.colorA) { a.w++; b.l++; a.pts += 3; }
      else { b.w++; a.l++; b.pts += 3; }
    });
    const rows = Object.keys(t).map(k => t[k]);
    rows.forEach(r => { r.gd = r.gf - r.ga; });
    const groups = {};
    rows.forEach(r => { (groups[r.pts] = groups[r.pts] || []).push(r.colorId); });
    rows.forEach(r => {   // ผลการพบกันเอง (เฉพาะทีมที่แต้มเท่ากัน)
      const g = groups[r.pts];
      if (g.length < 2) return;
      fin.forEach(m => {
        if (g.indexOf(m.colorA) < 0 || g.indexOf(m.colorB) < 0) return;
        if (m.winner === 'draw') { if (r.colorId === m.colorA || r.colorId === m.colorB) r.h2h++; }
        else if (m.winner === r.colorId) r.h2h += 3;
      });
    });
    rows.sort((x, y) => (y.pts - x.pts) || (y.h2h - x.h2h) || (y.gd - x.gd) || (y.gf - x.gf) || ((ord[x.colorId] || 0) - (ord[y.colorId] || 0)));
    let rank = 0, prev = null;
    rows.forEach((r, i) => {
      const key = [r.pts, r.h2h, r.gd, r.gf].join('|');
      if (key !== prev) { rank = i + 1; prev = key; }
      r.rank = fin.length ? rank : 0;
      r.record = r.pts + ' แต้ม (ชนะ ' + r.w + ' เสมอ ' + r.d + ' แพ้ ' + r.l + ')';
    });
    return { kind: kind, complete: complete, rows: fin.length ? rows : [] };
  }
  const rows = [];
  const loser = m => (m.winner === m.colorA ? m.colorB : m.colorA);
  const fn = ms.find(m => m.rd === '2'), th = ms.find(m => m.rd === '3');
  if (fn && fn.status === 'finished') {
    rows.push({ colorId: fn.winner, rank: 1, record: 'ชนะเลิศ' });
    rows.push({ colorId: loser(fn), rank: 2, record: 'รองชนะเลิศ' });
  }
  if (th) {
    if (th.status === 'finished') {
      rows.push({ colorId: th.winner, rank: 3, record: 'อันดับ 3' });
      rows.push({ colorId: loser(th), rank: 4, record: 'อันดับ 4' });
    }
  } else {
    ms.filter(m => m.rd === '4' && m.status === 'finished').forEach(m => rows.push({ colorId: loser(m), rank: 3, record: 'แพ้รอบรองชนะเลิศ' }));
  }
  ms.filter(m => toInt_(m.rd) >= 8 && m.status === 'finished').forEach(m => rows.push({ colorId: loser(m), rank: toInt_(m.rd) / 2 + 1, record: 'แพ้' + m.round }));
  rows.sort((a, b) => a.rank - b.rank);
  return { kind: kind, complete: complete, rows: rows };
}

function matchRankMap_(matches) {
  const by = {};
  (matches || []).forEach(m => { (by[m.eventId] = by[m.eventId] || []).push(m); });
  const colorOrder = sortByOrder_(sheetToObjects_(getSheet_('Colors'))).map(c => c.id);
  const out = {};
  Object.keys(by).forEach(k => { if (by[k][0].stage !== 'lane') out[k] = computeMatchRanking_(sortMatches_(by[k]), colorOrder); });
  return out;
}

/** นำอันดับจากผลคู่แข่งขันไปบันทึกเป็นผลการแข่งขันของรายการ (ร่าง หรือ ประกาศผลเลย) */
function applyMatchRanking(sid, eventId, finalize) {
  const u = requireUser_(sid);
  if (!canRecord_(u)) throw new Error('คุณไม่มีสิทธิ์บันทึกผลการแข่งขัน');
  return withLock_(() => {
    const ev = sheetToObjects_(getSheet_('Events')).find(e => e.id === eventId);
    if (!ev) throw new Error('ไม่พบรายการแข่งขัน');
    if (isLaneEvent_(ev)) throw new Error('รายการวิ่งใช้ตารางช่องวิ่ง ไม่มีอันดับจากคู่แข่งขัน — บันทึกผลในหน้า "บันทึกผลการแข่งขัน"');
    if (ev.mode === 'individual') throw new Error('รายการแบบบุคคลต้องเลือกชื่อนักกีฬาในหน้า "บันทึกผลการแข่งขัน" (ระบบจัดอันดับสีให้อัตโนมัติได้เฉพาะรายการแบบทีม/ประกวด)');
    const colorOrder = sortByOrder_(sheetToObjects_(getSheet_('Colors'))).map(c => c.id);
    const r = computeMatchRanking_(sortMatches_(loadMatches_().filter(m => m.eventId === eventId)), colorOrder);
    if (!r.rows.length) throw new Error('ยังไม่มีผลคู่แข่งขันที่บันทึกแล้ว จึงยังจัดอันดับไม่ได้');
    if (finalize && !r.complete) throw new Error('ยังมีคู่ที่ยังไม่บันทึกผล จึงประกาศผลไม่ได้ (บันทึกเป็นร่างได้)');
    const res = saveResultsCore_(u, eventId, r.rows.map(x => ({ rank: x.rank, colorId: x.colorId, record: x.record || '' })), !!finalize);
    logAction_(u, 'applyMatchRanking', eventLabel_(ev) + (finalize ? ' (ประกาศผล)' : ' (ร่าง)'));
    return res;
  });
}

/* ===================== ADJUSTMENTS (คะแนนพิเศษ/หักคะแนน) ===================== */
function saveAdjustment(sid, payload) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    const pts = Number(payload.points);
    if (isNaN(pts) || pts === 0) throw new Error('กรุณาระบุคะแนน (บวก = เพิ่ม, ลบ = หัก)');
    const reason = String(payload.reason || '').trim();
    if (!reason) throw new Error('กรุณาระบุเหตุผล');
    if (!sheetToObjects_(getSheet_('Colors')).some(c => c.id === payload.colorId)) throw new Error('ไม่พบสี');
    appendRowObject_(getSheet_('Adjustments'), {
      id: newId_('a_'), colorId: payload.colorId, points: String(round2_(pts)), reason: reason.slice(0, 200),
      createdBy: u.fullname, createdAt: nowIso_()
    });
    bustPublicCache_();
    logAction_(u, 'saveAdjustment', payload.colorId + ' ' + pts + ' ' + reason);
    return { ok: true };
  });
}

function deleteAdjustment(sid, id) {
  const u = requireRole_(sid, ['admin', 'organizer']);
  return withLock_(() => {
    deleteRowById_(getSheet_('Adjustments'), id);
    bustPublicCache_();
    logAction_(u, 'deleteAdjustment', id);
    return { ok: true };
  });
}

/* ===================== USERS (ผู้ดูแลระบบ) ===================== */
function saveUser(sid, payload) {
  const admin = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const sh = getSheet_('Users');
    const users = sheetToObjects_(sh);
    const username = String(payload.username || '').trim();
    const fullname = String(payload.fullname || '').trim();
    if (!/^[A-Za-z0-9_.-]{3,30}$/.test(username)) throw new Error('ชื่อผู้ใช้ต้องเป็นตัวอักษรอังกฤษ/ตัวเลข 3-30 ตัว');
    if (!fullname) throw new Error('กรุณากรอกชื่อ-สกุล');
    const role = ROLES.indexOf(payload.role) !== -1 ? payload.role : 'viewer';
    const colorId = String(payload.colorId || '');
    if (role === 'colorHead' && !colorId) throw new Error('หัวหน้าสีต้องระบุสีที่รับผิดชอบ');
    if (colorId && !sheetToObjects_(getSheet_('Colors')).some(c => c.id === colorId)) throw new Error('ไม่พบสีที่เลือก');
    if (users.some(x => String(x.username).toLowerCase() === username.toLowerCase() && x.id !== payload.id)) {
      throw new Error('ชื่อผู้ใช้นี้มีอยู่ในระบบแล้ว');
    }
    const active = payload.active === false || payload.active === 'false' ? 'false' : 'true';
    if (payload.id) {
      const old = users.find(x => x.id === payload.id);
      if (!old) throw new Error('ไม่พบผู้ใช้');
      if (old.id === admin.id && (role !== 'admin' || active === 'false')) throw new Error('ไม่สามารถลดสิทธิ์หรือระงับบัญชีของตนเองได้');
      const upd = { username: username, fullname: fullname, role: role, colorId: role === 'colorHead' || colorId ? colorId : '', position: String(payload.position || '').trim(), active: active };
      if (payload.password) {
        validatePassword_(payload.password);
        upd.passwordHash = hashPw_(old.id, payload.password);
        upd.mustChange = 'true';
      }
      updateRowById_(sh, payload.id, upd);
    } else {
      validatePassword_(payload.password);
      const id = newId_('u_');
      appendRowObject_(sh, {
        id: id, username: username, passwordHash: hashPw_(id, payload.password), fullname: fullname, role: role,
        colorId: colorId, position: String(payload.position || '').trim(), active: active, mustChange: 'true', createdAt: nowIso_()
      });
    }
    logAction_(admin, 'saveUser', username + ' (' + role + ')');
    return { ok: true };
  });
}

function deleteUser(sid, id) {
  const admin = requireRole_(sid, ['admin']);
  if (admin.id === id) throw new Error('ไม่สามารถลบบัญชีของตนเองได้');
  return withLock_(() => {
    deleteRowById_(getSheet_('Users'), id);
    logAction_(admin, 'deleteUser', id);
    return { ok: true };
  });
}

function adminResetPassword(sid, userId) {
  const admin = requireRole_(sid, ['admin']);
  return withLock_(() => {
    const sh = getSheet_('Users');
    const u = sheetToObjects_(sh).find(x => x.id === userId);
    if (!u) throw new Error('ไม่พบผู้ใช้นี้');
    const temp = tempPassword_();
    updateRowById_(sh, userId, { passwordHash: hashPw_(userId, temp), mustChange: 'true' });
    logAction_(admin, 'adminResetPassword', u.username);
    return { username: u.username, fullname: u.fullname, password: temp };
  });
}

/* ===================== NEW SEASON (เริ่มปีการศึกษาใหม่) ===================== */
/**
 * ล้างข้อมูลการแข่งขันเพื่อเริ่มปีใหม่ (เฉพาะผู้ดูแลระบบ) ต้องพิมพ์คำยืนยัน "ล้างข้อมูล"
 * opts: { entries, results, adjustments, students }  (true = ล้าง)
 */
function resetSeasonData(sid, opts, confirmText) {
  const u = requireRole_(sid, ['admin']);
  if (String(confirmText || '').trim() !== 'ล้างข้อมูล') throw new Error('กรุณาพิมพ์คำว่า "ล้างข้อมูล" เพื่อยืนยัน');
  return withLock_(() => {
    const o = opts || {};
    const done = [];
    if (o.entries || o.students) { writeTable_('Entries', []); done.push('รายชื่อลงทะเบียน'); }
    if (o.results) {
      writeTable_('Results', []);
      writeTable_('Matches', []);
      const evs = sheetToObjects_(getSheet_('Events'));
      evs.forEach(e => { e.status = 'planned'; });
      writeTable_('Events', evs);
      done.push('ผลการแข่งขัน');
    }
    if (o.adjustments) { writeTable_('Adjustments', []); done.push('คะแนนพิเศษ'); }
    if (o.students) { writeTable_('Students', []); done.push('รายชื่อนักเรียน'); }
    bustPublicCache_();
    logAction_(u, 'resetSeasonData', done.join(', '));
    return { ok: true, cleared: done };
  });
}
