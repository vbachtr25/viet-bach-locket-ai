# Audit: EeveeSpotifyReincarnated 7.5.0 ↔ products/spotify

**Ngày:** 2026-11-18
**Nguồn đối chiếu:** `SideloadLabs/EeveeSpotifyReincarnated`, commit `f6a3403`
("Fix Pixie logging and simplify download diagnostics (#253)"), Spotify mục tiêu 9.2.0.
**Giấy phép upstream:** GPL-3.0.

Mục đích: ghi lại *chính xác* những gì tweak làm, phần nào module Shadowrocket
làm được, phần nào **không thể**, và các điểm mà `products/spotify` trước đây
hiểu sai.

---

## 1. Kiến trúc upstream (5 tầng)

| Tầng | File tiêu biểu | Việc gì |
|---|---|---|
| Network hook | `DataLoaderServiceHooks.x.swift`, `HttpClientURLSessionHooks.x.swift` | Hook 2 URLSession delegate (SPTDataLoaderService + Connectivity_HttpClientKit), gom body rồi replay sau khi patch |
| Protobuf patch | `Premium/Helpers/SpotifyResponsePatcher.swift` | Điều phối: `bootstrap`, `customize`, `nebula attributes`, `remote-config-resolver`, plan row/badge/overview, DAC, browsita/casita/scrollsita |
| Chống 304 | `Premium/NebulaAttributes.swift` | Xoá `If-None-Match`/`If-Modified-Since` + `cachePolicy = .reloadIgnoringLocalCacheData`; mirror body đã patch vào UserDefaults để replay khi relaunch |
| Chặn endpoint | `Shared/.../URL+Extension.swift` | ~50 path marker ads/upsell/marketing + session-invalidation |
| Runtime/UI | 117 `HookGroup`, `EeveePremiumForce`, `SessionProtection`, `EeveeAdBlockerExtended`, `ClientMessagingPlatformBlocker` | Seed ObjC state, chặn `logout()`, chặn ad service, chặn popup CMP |

**Điểm cốt lõi cho kết luận:** chỉ tầng 1–4 nằm trên đường HTTP. Tầng 5 là
in-process và **không thể** tái tạo bằng module proxy.

---

## 2. Endpoint & điều kiện patch

Nguồn: `URL+Extension.swift`.

| Kind | Matcher thật | Ghi chú |
|---|---|---|
| bootstrap | `path.contains("v1/bootstrap")` | Không phụ thuộc prefix service |
| customize | `path.contains("v1/customize")` | |
| attributes | `path.contains("nebula/v1/configuration/attributes")` | **9.2 only** (`NebulaAttributes.isEnabled`) |
| remote config | `path.contains("remote-config-resolver/v3/configuration")` | 9.2 only |
| plan row | `v1/GetPremiumPlanRow` | |
| plan badge | `GetYourPremiumBadge` | |
| plan overview | `GetPlanOverview` | |
| lyrics | `color-lyrics/v2` | |

Chặn sau **30 giây grace** kể từ lúc tweak init (tránh phá first-launch/login):
`signup/public`, `apresolve`, `pushka-tokens`, `pses/screenconfig`,
`select-ondemand-set`, `trials-facade/start-trial`, `premium-marketing/upsellOffer`,
`pendragon/*FetchMessage*`, `DeleteToken`, `logout`, `sign-out`, `session/purge`,
`token/revoke`, `auth/expire`, `melody*check*`, `product-state`, `license*check*`.

Body giả khi chặn: `{"status":1,"country":"US","is_country_launched":true}`
(signup), `{"result":"NOT_ELIGIBLE"}` (trials), `{}` (marketing/screenconfig),
`{"status":"OK"}` (session-invalidation).

---

## 3. Wire format đã xác minh (dùng để viết `scripts/spotify_ucs.js`)

Lấy từ `Premium/Models/Protobuf/Account.pb.swift` (sinh từ `account.proto`):

```
SpotifyError              { 1:errorCode 2:errorMessage }
CustomizeMessage          { 1:UcsResponse response | 2:SpotifyError error }
UcsResponse               { 1:resolve 2:resolveError 3:attributes 4:attributesError 5:fetchTimeMillis }
ResolveResponse           { 1:configuration }
ResolveConfiguration      { 1:configurationAssignmentId 2:fetchTimeMillis 3:repeated assignedValues }
AssignedValue             { 1:propertyId 2:metadata 3:BoolValue | 4:IntValue | 5:EnumValue }
AssignedIdentifier        { 1:scope 2:name }
BoolValue / IntValue / EnumValue { 1:value }
AccountAttributesResponse { 1:map<string, AccountAttribute> }
AccountAttribute          { 2:boolValue | 3:longValue | 4:stringValue }   # oneof
BootstrapMessage          { 2:wrapper }
CustomizationMessageWrapper        { 1:oneMoreWrapper }
CustomizationMessageOneMoreWrapper { 1:message: CustomizeMessage }
```

Đường bootstrap đầy đủ:

```
BootstrapMessage.field2 → CustomizationMessageWrapper.field1
  → CustomizationMessageOneMoreWrapper.field1
    → CustomizeMessage.field1 (UcsResponse)
```

Hai bẫy đã gặp khi implement (test bắt được):

1. **`boolValue` là message, không phải varint trần** — phải encode
   `field 3 { field 1: 0|1 }`, nếu không Spotify đọc sai và flag kẹt.
2. **Heuristic "wrapper" lỏng làm hỏng payload** — entry đầu của
   `map<string,AccountAttribute>` trông giống một lớp bọc; nhận nhầm thì
   decode ra wire type 4 và mất toàn bộ attribute.

Schema khớp 100% với `archive/spotify/reference/scripts/spot-proto-eevee.js`
(`spotifyJson`) — không cần sửa schema, chỉ cần sửa *cách dùng*.

---

## 4. Chính sách attribute: hai điểm script cũ làm sai

### 4.1 Không được spoof attribute do server quyết định

`ServerSidedFeaturePolicy.serverAuthoritativeAccountAttributes` (12 key):

```
offline, can-use-offline, has-offline-state, max-offline-downloads-per-device,
max-offline-tracks, offline-backup, lyrics-offline, very-high-bitrate,
audio-quality, social-session, social-session-free-tier, jam-social-session
```

Eevee lưu giá trị gốc **trước** khi patch, rồi ghi lại nguyên trạng sau cùng
(`modifyAttributes`). Comment trong code: *"These values are real account
entitlements. Spoofing them only exposes incomplete UI; Spotify's backend
still rejects the operation."*

`spot-proto-eevee.js` cũ đang set `offline: true`, `audio-quality: "1"`,
`social-session: true`, `high-bitrate` → chỉ tạo UI sai (và với
`audio-quality` còn làm Very High không stream được).

→ `spotify_ucs.js` bỏ qua hoàn toàn các key này, giữ nguyên giá trị server trả.

### 4.2 Attribute bị xoá (không phải "set false")

`modifyAttributes` gọi `removeValue` cho: `payment-state`,
`last-premium-activation-date`, `on-demand-trial`, `on-demand-trial-in-progress`,
`smart-shuffle`, `at-signal`, `feature-set-id-masked`, `strider-key`,
`is-eligible-for-trial`, `is-eligible-for-upsell`, `upsell-state`,
`ad-session-persistence`, `ad-formats-preroll-video`, `is-premium-eligible`,
`is-premium-eligible-v1..v100`.

`spot-proto-eevee.js` cũ không xoá nhóm này → dễ bị backend "thấy" trạng thái
trial/upsell và đẩy user về Free hoặc logout.

### 4.3 Attribute Premium nên đặt

`type/catalogue/player-license/player-license-v2 = "premium"`,
`financial-product = "pr:premium,tc:0"`, `name = "Spotify Premium"`,
`on-demand/unrestricted/shuffle-eligible/high-bitrate = true`,
`product-expiry` & `subscription-enddate` = **now + 1 năm** (không phải 9999),
`loudness-levels = "1:-5.0,0.0,3.0:-2.0"`, `mixing-tools = "EDIT"`,
`your-library-tags/libspotify/mobile = true`,
`enable-crossfade-product-state`/`enable-gapless-product-state = "1"`.

---

## 5. Rule UCS: 260 replacement

`propertyReplacements` trong `DynamicPremium+ModifyingFunctions.swift`:
**260 rule** — `setBool` 190, `forceBool` 41, `remove` 28, `setEnum` 1.

Ngữ nghĩa (port chính xác vào `patchAssignedValues`):

- `name`/`scope` là **nullable matcher**: `scope == nil` ⇒ khớp mọi scope cùng tên.
  Đây là lý do rule `enable_ads` (không scope) tắt cả `something-else.enable_ads`.
- `forceBool` = `setBool` + **thêm mới** AssignedValue nếu chưa tồn tại (cần cả
  name và scope). Dùng cho `crossfade_enabled`, `automix_enabled`.
- Sau khi áp rule, Eevee chạy thêm **cohort ad/upsell kill**
  (`isCohortAdOrUpsellFlag`): quét mọi bool flag đang `true`, nếu
  `scope.name` chứa token `ad/ads/adsbase/instreamads/leavebehind/marquee/
  upsell/sponsored/adssponsoredcontext/realtimead` thì set false; bỏ qua
  `disable_*`, `*dismissible*`, `*skip_button*`.

Repo cũ có 219 rule → thiếu 46 (chủ yếu `forceBool` cho crossfade/automix,
upsell theo scope `ios-*`, lyrics share). `scripts/spotify_ucs.js` nhúng bản
đồng bộ 260 rule qua `tools/sync_ucs_rules.py`.

---

## 6. Những gì module Shadowrocket KHÔNG làm được

1. **Session protection**: `SPTAuthSessionImplementation.logout()`,
   `logoutWithReason`, Ably revocation — chặn ở ObjC, không có HTTP.
2. **Ad service layer**: `EeveeAdBlockerExtended` hook `SPTService -load` của
   ~30 service (Evo brand ads, NPV under-player, in-stream audio...). Chặn
   HTTP không làm các service này inert.
3. **CMP presentation**: popup đã lưu trong SQLite vẫn hiện dù network đã chặn
   (`ClientMessagingPlatformBlocker` là safety net ở UI).
4. **Product state 9.2**: `nebula/v1/configuration/attributes` → 
   `productStateUpdated` sau ~73ms. Patch được body thì tốt, nhưng nếu request
   đi qua đường khác (hoặc 304) thì core fallback cache Free.
5. **ObjC seeding**: `trackRowsEnabled`, `EeveePremiumForce` (NSUserDefaults),
   `SPTFreeTierArtistHubRemoteURLResolver` — thuần in-process.
6. **Lyrics**: thay provider (Genius/LRCLIB/Petit) là logic client.

---

## 7. Việc đã làm trong repo này

| File | Trạng thái |
|---|---|
| `scripts/spotify_ucs.js` | **Mới** - engine protobuf tự chứa, không phụ thuộc protobufjs |
| `tools/sync_ucs_rules.py` | **Mới** - đồng bộ 260 rule + 12 attribute server-authoritative từ upstream |
| `data/ucs-rules.json` | **Mới** - snapshot có thể diff khi upstream đổi |
| `modules/spotify-premium-ucs.module` | **Mới** - module Shadowrocket đầy đủ marker |
| `tests/research/spotify_ucs.test.js` | **Mới** - 14 test, dựng payload protobuf thật |
| `scripts/spot-proto-eevee.js` | Giữ nguyên (tham chiếu lịch sử). **Không dùng cho bản mới** vì các lỗi ở §4. |
| `scripts/eevee_spotify.js` | Giữ nguyên (khung demo). |

---

## 8. Ghi chú giấy phép

Rule table là *dữ liệu cấu hình* trích từ upstream GPL-3.0. Repo này là public.
Nếu muốn tránh ràng buộc GPL cho toàn repo, hoặc (a) chấp nhận GPL cho phần
`products/spotify`, hoặc (b) thay `data/ucs-rules.json` bằng danh sách tự dựng
từ quan sát traffic. Không có mã nguồn Swift/protobuf nào được copy vào repo.
