const test = require('node:test');
const assert = require('node:assert');
const {
  generateMobileconfig,
  getCACertBase64,
  getSignedProfile,
  UPLOCKET_DOH_URL,
  SUPPLEMENTAL_MATCH_DOMAINS
} = require('../../admin/lib/mobileconfig');

test('getCACertBase64 extracts valid base64 certificate', () => {
  const b64 = getCACertBase64();
  assert.ok(b64.length > 500, 'Certificate base64 should be > 500 chars');
  assert.ok(!b64.includes('-----BEGIN'), 'Should not contain PEM header');
});

test('generateMobileconfig creates valid Apple XML plist', () => {
  const xml = generateMobileconfig('test1234');
  assert.ok(xml.includes('<!DOCTYPE plist'), 'Must have plist DOCTYPE');
  assert.ok(xml.includes('com.apple.security.root'), 'Must include root CA payload type');
  assert.ok(xml.includes('com.apple.dnsSettings.managed'), 'Must include managed DoH payload type');
  assert.ok(xml.includes('https://dns.nextdns.io/test1234'), 'Must include target NextDNS DoH URL');
  assert.ok(xml.includes(getCACertBase64()), 'Must embed Root CA base64 cert data');
});

test('generateMobileconfig default uses Xwuan_DNS and UpLocket DoH server with SupplementalMatchDomains', () => {
  const xml = generateMobileconfig();
  assert.ok(xml.includes('Xwuan_DNS'), 'Must include Xwuan_DNS display name');
  assert.ok(xml.includes(UPLOCKET_DOH_URL), 'Must include UpLocket DoH URL');
  assert.ok(xml.includes('SupplementalMatchDomains'), 'Must include SupplementalMatchDomains');
  for (const domain of ['api.revenuecat.com', 'firebaseremoteconfig.googleapis.com', 'spclient.wg.spotify.com']) {
    assert.ok(xml.includes(domain), `Must include match domain ${domain}`);
  }
});

test('getSignedProfile trả null khi không có profile tĩnh (sau khi dọn web)', () => {
  // public/ đã bị xoá cùng đợt dọn web, nên không còn file .mobileconfig đã ký trong repo.
  // Hàm vẫn phải trả null gọn gàng thay vì throw — để generateMobileconfig() rơi về
  // nhánh sinh XML, đó là đường dùng chính hiện nay.
  const signed = getSignedProfile();
  assert.strictEqual(signed, null, 'không có file thì phải trả null, không được throw');

  // Và nhánh XML vẫn phải hoạt động.
  const xml = generateMobileconfig();
  assert.ok(xml.includes('com.apple.dnsSettings.managed'), 'nhánh sinh XML phải dùng được');
});
