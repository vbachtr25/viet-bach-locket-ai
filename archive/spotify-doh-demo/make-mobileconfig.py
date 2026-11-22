import base64, uuid, pathlib

DIR = pathlib.Path(__file__).parent
SERVER_URL = "https://192.168.50.100:8443/dns-query"  # đổi IP/port nếu cần
OUT = DIR / "Eevee-Spotify-DNS-Demo.mobileconfig"
CA_DER = DIR / "root-ca.cer"

SPOTIFY_DOMAINS = [
    "spclient.wg.spotify.com",
    "gae2-spclient.spotify.com",
    "gew1-spclient.spotify.com",
    "gew4-spclient.spotify.com",
    "guc3-spclient.spotify.com",
    "gue1-spclient.spotify.com",
    "spclient.spotify.com",
    "apresolve.spotify.com",
    "login5.spotify.com",
    "audio-ak-spotify-com.akamaized.net",
    "audio-akp-quic-spotify-com.akamaized.net",
    "heads-ak-spotify-com.akamaized.net",
]

ca_b64 = base64.b64encode(CA_DER.read_bytes()).decode("ascii")
# wrap base64 for readability
ca_wrapped = "\n\t\t\t".join(ca_b64[i:i+64] for i in range(0, len(ca_b64), 64))

def U():
    return str(uuid.uuid4()).upper()

plist = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>PayloadContent</key>
\t<array>
\t\t<dict>
\t\t\t<key>PayloadCertificateFileName</key>
\t\t\t<string>EeveeDemoRootCA.cer</string>
\t\t\t<key>PayloadContent</key>
\t\t\t<data>
\t\t\t{ca_wrapped}
\t\t\t</data>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>Eevee Demo Root CA</string>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>com.eevee.demo.ca</string>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.security.root</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>{U()}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t\t<dict>
\t\t\t<key>DNSSettings</key>
\t\t\t<dict>
\t\t\t\t<key>DNSProtocol</key>
\t\t\t\t<string>HTTPS</string>
\t\t\t\t<key>ServerURL</key>
\t\t\t\t<string>{SERVER_URL}</string>
\t\t\t\t<key>SupplementalMatchDomains</key>
\t\t\t\t<array>
''' + ''.join(f"\t\t\t\t\t<string>{d}</string>\n" for d in SPOTIFY_DOMAINS) + f'''\t\t\t\t</array>
\t\t\t\t<key>SupplementalMatchDomainsNoSearch</key>
\t\t\t\t<true/>
\t\t\t</dict>
\t\t\t<key>PayloadDisplayName</key>
\t\t\t<string>Eevee Spotify DNS Rewrite (Demo)</string>
\t\t\t<key>PayloadIdentifier</key>
\t\t\t<string>com.eevee.demo.dns</string>
\t\t\t<key>PayloadType</key>
\t\t\t<string>com.apple.dnsSettings.managed</string>
\t\t\t<key>PayloadUUID</key>
\t\t\t<string>{U()}</string>
\t\t\t<key>PayloadVersion</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t</array>
\t<key>PayloadDescription</key>
\t<string>Demo DoH + Root CA cho DNS rewrite Spotify tren may local. Sau khi cai, can tin cay chung chi Eevee Demo Root CA trong Cai dat.</string>
\t<key>PayloadDisplayName</key>
\t<string>Eevee Spotify DNS Demo</string>
\t<key>PayloadIdentifier</key>
\t<string>com.eevee.demo.profile</string>
\t<key>PayloadOrganization</key>
\t<string>Eevee Demo</string>
\t<key>PayloadRemovalDisallowed</key>
\t<false/>
\t<key>PayloadType</key>
\t<string>Configuration</string>
\t<key>PayloadUUID</key>
\t<string>{U()}</string>
\t<key>PayloadVersion</key>
\t<integer>1</integer>
</dict>
</plist>
'''

OUT.write_text(plist, encoding='utf-8')
print(f'Wrote {OUT}')