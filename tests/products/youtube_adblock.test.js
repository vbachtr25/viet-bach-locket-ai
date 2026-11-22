// Test cho engine chặn quảng cáo YouTube.
//
// Nguyên tắc: KHÔNG test bằng chuỗi giả. Mọi ca đều dựng protobuf thật bằng
// tay theo wire format, đưa qua engine, rồi parse lại để khẳng định:
//   1. field quảng cáo đã biến mất
//   2. mọi field khác giữ nguyên byte gốc (kể cả field lạ chưa biết)
//   3. length của message cha được ghi lại đúng
//
// Chạy: node --test tests/products/youtube_adblock.test.js

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const YT = require(path.resolve(__dirname, '../../products/youtube/engine/youtube_adblock.js'));

// ─── helper dựng protobuf ──────────────────────────────────────────────────

function varint(n) {
  const out = [];
  YT.writeVarint(n, out);
  return Buffer.from(out);
}

/** field length-delimited (wire 2), payload là Buffer */
function bytesField(num, payload) {
  return Buffer.concat([varint(num * 8 + 2), varint(payload.length), payload]);
}

/** field varint (wire 0) */
function intField(num, value) {
  return Buffer.concat([varint(num * 8), varint(value)]);
}

/** đọc field để kiểm chứng kết quả */
function fields(buf) {
  const res = YT.readFields(new Uint8Array(buf), 0, buf.length);
  assert.ok(res, 'readFields không được trả null');
  return res.map((f) => ({
    num: f.num,
    wire: f.wire,
    raw: buf.subarray(f.start, f.end),
    payload: buf.subarray(f.valStart, f.end)
  }));
}

const toU8 = (buf) => new Uint8Array(buf);

// ─── /youtubei/v1/player ───────────────────────────────────────────────────

test('player: xoá field 7 (adPlacements) và 68 (adSlots), giữ nguyên phần khác', () => {
  const adPlacements = bytesField(7, Buffer.from('CAASABgB'));      // nội dung bất kỳ
  const adSlots = bytesField(68, Buffer.from('pagead/slot/inner')); // chứa marker quảng cáo
  const videoDetails = bytesField(1, Buffer.from('dQw4w9WgXcQ'));   // videoId
  const streamingData = bytesField(4, Buffer.from('streaming-bytes'));
  const playability = bytesField(11, Buffer.from('OK'));

  const body = Buffer.concat([videoDetails, streamingData, adPlacements, playability, adSlots]);

  const res = YT.cleanPlayer(toU8(body), 0, body.length);
  assert.ok(res, 'cleanPlayer không được trả null');
  assert.strictEqual(res.removed, 2, 'phải xoá đúng 2 field');

  const out = Buffer.from(res.bytes);
  const nums = fields(out).map((f) => f.num);
  assert.ok(!nums.includes(7), 'field 7 phải biến mất');
  assert.ok(!nums.includes(68), 'field 68 phải biến mất');
  assert.deepStrictEqual(nums, [1, 4, 11], 'các field khác phải còn nguyên thứ tự');

  // byte của field không sửa phải y hệt
  const outFields = fields(out);
  assert.deepStrictEqual(Buffer.from(outFields[0].raw), videoDetails);
  assert.deepStrictEqual(Buffer.from(outFields[1].raw), streamingData);
  assert.deepStrictEqual(Buffer.from(outFields[2].raw), playability);
});

test('player: response không có quảng cáo thì trả removed=0 và byte y nguyên', () => {
  const body = Buffer.concat([
    bytesField(1, Buffer.from('videoId')),
    bytesField(4, Buffer.from('streaming'))
  ]);
  const res = YT.cleanPlayer(toU8(body), 0, body.length);
  assert.strictEqual(res.removed, 0);
  assert.deepStrictEqual(Buffer.from(res.bytes), body);
});

test('player: field lạ chưa biết trong tương lai vẫn đi qua nguyên vẹn', () => {
  const unknown = bytesField(9999, Buffer.from('youtube-them-sau-nay'));
  const body = Buffer.concat([unknown, bytesField(7, Buffer.from('ad')), bytesField(1, Buffer.from('id'))]);
  const res = YT.cleanPlayer(toU8(body), 0, body.length);
  const out = Buffer.from(res.bytes);
  const outFields = fields(out);
  assert.deepStrictEqual(Buffer.from(outFields[0].raw), unknown, 'field 9999 phải giữ nguyên byte');
  assert.deepStrictEqual(outFields.map((f) => f.num), [9999, 1]);
});

test('player: length của message cha được ghi lại đúng sau khi xoá', () => {
  const inner = Buffer.concat([bytesField(1, Buffer.from('id')), bytesField(7, Buffer.from('ad'))]);
  const outer = bytesField(5, inner); // player bọc trong field 5

  const res = YT.cleanPlayer(toU8(inner), 0, inner.length);
  const fixed = YT.wrapBytesField(5, res.bytes);

  // parse lại outer đã sửa: payload phải ngắn hơn và vẫn parse được
  const parsed = YT.readFields(new Uint8Array(fixed), 0, fixed.length);
  assert.ok(parsed && parsed.length === 1);
  assert.strictEqual(parsed[0].num, 5);
  assert.strictEqual(parsed[0].end, fixed.length, 'end phải bằng đúng độ dài mảng');
});

test('player: cấu trúc hỏng thì trả null để caller passthrough', () => {
  const broken = Buffer.from([0x3a, 0xff, 0xff]); // field 7 khai length quá dài
  const res = YT.cleanPlayer(toU8(broken), 0, broken.length);
  assert.strictEqual(res, null, 'phải trả null, không được ném exception');
});

// ─── feed (browse / next / search) ─────────────────────────────────────────

const EL = YT.FIELD_ELEMENT_RENDERER;

function elementRenderer(inner) {
  return bytesField(EL, inner);
}

test('feed: xoá elementRenderer là quảng cáo, giữ video thật', () => {
  // ad card: có 'pagead' + đủ lớn
  const adInner = Buffer.concat([
    bytesField(1, Buffer.from('ad-video-id')),
    bytesField(2, Buffer.from('pagead/adunit/tracker?x=1'.padEnd(250, '.')))
  ]);
  const ad = elementRenderer(adInner);

  const realInner = Buffer.concat([
    bytesField(1, Buffer.from('real-video-id')),
    bytesField(2, Buffer.from('Video thật không có nhãn quảng cáo'))
  ]);
  const real = elementRenderer(realInner);

  const section = bytesField(1, Buffer.concat([real, ad]));

  const res = YT.pruneAds(toU8(section), 0, section.length, 0);
  assert.ok(res);
  assert.strictEqual(res.removed, 1, 'phải xoá đúng 1 ad element');

  const out = Buffer.from(res.bytes);
  const flat = out.toString('latin1');
  assert.ok(flat.includes('real-video-id'), 'video thật phải còn');
  assert.ok(!flat.includes('ad-video-id'), 'ad phải bị xoá');
});

test('feed: element quá nhỏ thì không xoá dù có chữ pagead', () => {
  const tiny = elementRenderer(bytesField(1, Buffer.from('pagead')));
  const section = bytesField(1, tiny);
  const res = YT.pruneAds(toU8(section), 0, section.length, 0);
  assert.strictEqual(res.removed, 0, 'dưới MIN_AD_ELEMENT_SIZE phải bỏ qua');
});

test('feed: ad shelf chứa elementRenderer con thì KHÔNG xoá cả shelf', () => {
  const child = elementRenderer(bytesField(1, Buffer.from('child-video')));
  const shelfInner = Buffer.concat([
    bytesField(2, Buffer.from('promoted'.padEnd(250, '.'))), // có pattern ad
    child
  ]);
  const shelf = elementRenderer(shelfInner);
  const section = bytesField(1, shelf);

  const res = YT.pruneAds(toU8(section), 0, section.length, 0);
  assert.strictEqual(res.removed, 0, 'có element lồng bên trong thì không xoá shelf');
});

test('feed: response không có ad thì byte y nguyên', () => {
  const section = bytesField(1, elementRenderer(bytesField(1, Buffer.from('bình thường'))));
  const res = YT.pruneAds(toU8(section), 0, section.length, 0);
  assert.strictEqual(res.removed, 0);
  assert.deepStrictEqual(Buffer.from(res.bytes), section);
});

// ─── shorts ────────────────────────────────────────────────────────────────

test('shorts: bỏ entry có cờ isAd, giữ entry thường', () => {
  // entry ad: pattern 'adClientParams'
  const adEntry = bytesField(1, Buffer.from('reel-ad|adClientParams|more'));
  const okEntry = bytesField(1, Buffer.from('reel-bình-thường'));
  // entry ad thứ hai: dùng cặp byte PAT_IS_AD
  const flagEntry = bytesField(2, Buffer.from([0x0a, 0x82, 0x01, 0x02, 0x08, 0x01, 0x10]));

  const body = Buffer.concat([adEntry, okEntry, flagEntry]);
  const res = YT.dropShortsAds(toU8(body));
  assert.ok(res);
  assert.strictEqual(res.removed, 2, 'phải bỏ 2 entry ad');

  // So byte, không so chuỗi: 'bình' là UTF-8 nhiều byte nên latin1 không
  // round-trip được.
  const out = Buffer.from(res.bytes);
  assert.deepStrictEqual(out, okEntry, 'phải còn đúng entry thường, byte y nguyên');
});

test('shorts: không có ad thì trả removed=0', () => {
  const body = Buffer.concat([bytesField(1, Buffer.from('reel1')), bytesField(1, Buffer.from('reel2'))]);
  const res = YT.dropShortsAds(toU8(body));
  assert.strictEqual(res.removed, 0);
  assert.deepStrictEqual(Buffer.from(res.bytes), body);
});

// ─── body decode ───────────────────────────────────────────────────────────

test('bodyToBytes: nhận Uint8Array, ArrayBuffer, view và string latin1', () => {
  const bytes = Buffer.from([0x0a, 0x02, 0x68, 0x69]);
  assert.deepStrictEqual(Buffer.from(YT.bodyToBytes(new Uint8Array(bytes))), bytes);
  assert.deepStrictEqual(Buffer.from(YT.bodyToBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length))), bytes);

  const str = String.fromCharCode.apply(null, Array.from(bytes));
  assert.deepStrictEqual(Buffer.from(YT.bodyToBytes(str)), bytes);

  assert.strictEqual(YT.bodyToBytes(null), null);
  assert.strictEqual(YT.bodyToBytes(''), null);
});

test('varint: round-trip với các giá trị biên', () => {
  [0, 1, 127, 128, 300, 16383, 16384, 153515154, 4294967295].forEach((n) => {
    const enc = varint(n);
    const dec = YT.readVarint(new Uint8Array(enc), 0, enc.length);
    assert.ok(dec, 'phải decode được ' + n);
    assert.strictEqual(dec.value, n, 'varint round-trip sai ở ' + n);
    assert.strictEqual(dec.next, enc.length);
  });
});

test('varint: chuỗi cụt thì trả null', () => {
  const cut = new Uint8Array([0x80, 0x80]);
  assert.strictEqual(YT.readVarint(cut, 0, cut.length), null);
});
