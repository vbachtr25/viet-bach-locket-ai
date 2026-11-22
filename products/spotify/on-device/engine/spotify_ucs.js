/*
 * ============================================================================
 * Spotify UCS/AccountAttributes patch engine - Shadowrocket / Surge / Loon
 * ============================================================================
 *
 * File này tự chứa (không cần protobufjs, không cần fetch schema từ mạng) nên
 * chạy được trong môi trường script của Shadowrocket.
 *
 * Patch đúng 3 loại payload, dựa trên wire-format thật của Spotify 9.x:
 *
 *   1. BootstrapMessage                     (spclient .../bootstrap/v1/bootstrap)
 *      field 2 -> wrapper (1) -> oneMoreWrapper (1) -> message (1) -> CustomizeMessage
 *      CustomizeMessage: { 1: UcsResponse response | 2: SpotifyError error }
 *
 *   2. UcsResponseWrapper                   (.../user-customization-service/v1/customize)
 *      field 1 -> success (1) -> UcsResponse
 *      Cũng chấp nhận payload là UcsResponse trần hoặc BootstrapResponse (bọc thêm 1 lớp field 1).
 *
 *   3. AccountAttributesResponse            (.../nebula/v1/configuration/attributes)
 *      field 1 -> map<string, AccountAttribute>
 *      (bản 9.2 có thể bọc thêm 1 lớp field 1 - engine tự dò)
 *
 *   4. ResolveResponse                      (.../remote-config-resolver/vN/configuration)
 *      field 1 -> Configuration { 1: id, 2: fetchTimeMillis, 3: repeated AssignedValue }
 *      AssignedValue { 1: Identifier{1:scope,2:name}, 3: BoolValue, 4: IntValue, 5: EnumValue }
 *
 * Toàn bộ encode lại dùng wire-format thuần: mỗi field đã đọc được giữ nguyên
 * byte gốc và chỉ thay đúng field bị sửa, nên mọi field lạ (version mới) đều
 * được bảo toàn nguyên vẹn.
 *
 * Không có protobuf schema nào của Spotify bị chép vào file này.
 * Danh sách rule đồng bộ từ EeveeSpotifyReincarnated (GPL-3.0) bằng
 * tools/sync_ucs_rules.py - xem products/spotify/README.md.
 * ============================================================================
 */

/* Trạng thái patch, có thể đổi bằng `argument=` trong [Script].
 * "full"    : attribute Premium + ad/upsell flags + bỏ query/upsell
 * "ads"     : chỉ chặn quảng cáo
 * "off"     : passthrough
 * Mặc định "full". */
var SPOTIFY_PATCH_MODE = "full";

/* true  = chỉ sửa payload là protobuf (không đụng JSON)
 * false = thử cả JSON (một số endpoint trả JSON ở một số build) */
var SPOTIFY_TRY_JSON = true;

/* Bật log chẩn đoán ra console Shadowrocket. Đặt false khi dùng hằng ngày. */
var SPOTIFY_DEBUG = false;

var SPOTIFY_ATTRIBUTE_OVERRIDES = {};
var SPOTIFY_ATTRIBUTE_REMOVALS = [
    "payment-state",
    "last-premium-activation-date",
    "on-demand-trial",
    "on-demand-trial-in-progress",
    "smart-shuffle",
    "at-signal",
    "feature-set-id-masked",
    "strider-key",
    "is-eligible-for-trial",
    "is-eligible-for-upsell",
    "upsell-state",
    "ad-session-persistence",
    "ad-formats-preroll-video",
    "is-premium-eligible",
    "ad-use-adlogic",
    "ad-catalogues",
    "shuffle"
];

/* ========================================================================== */

function spotifyLog(message) {
    if (SPOTIFY_DEBUG) {
        console.log("[spotify-ucs] " + message);
    }
}

/* Body của một response protobuf trên Shadowrocket là binary: runtime đưa vào
 * dưới dạng vài kiểu khác nhau tuỳ phiên bản (Uint8Array / ArrayBuffer /
 * Buffer-like / string ISO-8859-1). Hàm dưới đây nhận diện kiểu và trả về
 * Uint8Array. Trả null khi không có body. */
function shadowrocketBodyToBytes(body) {
    if (body === null || body === undefined) return null;
    if (typeof body === "string") {
        if (body.length === 0) return null;
        var out = new Uint8Array(body.length);
        for (var i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
        return out;
    }
    if (typeof Uint8Array !== "undefined" && body instanceof Uint8Array) {
        return body.length ? body : null;
    }
    if (typeof ArrayBuffer !== "undefined") {
        if (body instanceof ArrayBuffer) {
            return body.byteLength ? new Uint8Array(body) : null;
        }
        if (typeof ArrayBuffer.isView === "function" && ArrayBuffer.isView(body)) {
            var view = new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength);
            return view.length ? view : null;
        }
    }
    return null;
}

/* Chẩn đoán: mô tả kiểu + vài byte đầu của body, để log Shadowrocket cho biết
 * ngay hook có chạy và body có đúng là protobuf hay không. Chỉ chạy khi
 * SPOTIFY_DEBUG bật nên không tốn CPU lúc dùng hằng ngày. */
function describeBodyForLog(bytes) {
    if (!bytes) return "none";
    var n = Math.min(12, bytes.length);
    var parts = [];
    for (var i = 0; i < n; i++) {
        var h = bytes[i].toString(16);
        parts.push(h.length < 2 ? "0" + h : h);
    }
    return bytes.length + " bytes, head=" + parts.join(" ");
}

/* ------------------------------------------------------------------ varint */

function readVarint(buf, pos) {
    var value = 0;
    var shift = 0;
    var byte;
    do {
        if (pos >= buf.length) throw new Error("truncated varint");
        byte = buf[pos++];
        value += (byte & 0x7f) * Math.pow(2, shift);
        shift += 7;
        if (shift > 70) throw new Error("varint too long");
    } while (byte & 0x80);
    return { value: value, pos: pos };
}

function writeVarint(value) {
    var out = [];
    value = Math.floor(value);
    while (value >= 0x80) {
        out.push((value % 0x80) | 0x80);
        value = Math.floor(value / 0x80);
    }
    out.push(value);
    return out;
}

function tagBytes(fieldNumber, wireType) {
    return writeVarint(fieldNumber * 8 + wireType);
}

/* --------------------------------------------------------------- decoding */

/* Tách message thành danh sách field. Mỗi field giữ `raw` (toàn bộ byte của
 * field đó, kể cả tag) để lúc encode lại không phải dựng lại field không sửa. */
function decodeFields(buf) {
    var fields = [];
    var pos = 0;
    while (pos < buf.length) {
        var start = pos;
        var tag = readVarint(buf, pos);
        pos = tag.pos;
        var fieldNumber = Math.floor(tag.value / 8);
        var wireType = tag.value % 8;
        var payloadStart = pos;
        var payloadEnd = pos;

        if (wireType === 0) {
            var v = readVarint(buf, pos);
            pos = v.pos;
            payloadEnd = pos;
        } else if (wireType === 1) {
            pos += 8;
            payloadEnd = pos;
        } else if (wireType === 2) {
            var len = readVarint(buf, pos);
            pos = len.pos + len.value;
            payloadStart = len.pos;
            payloadEnd = pos;
        } else if (wireType === 5) {
            pos += 4;
            payloadEnd = pos;
        } else {
            throw new Error("unsupported wire type " + wireType);
        }
        if (pos > buf.length) throw new Error("truncated field");

        fields.push({
            number: fieldNumber,
            wireType: wireType,
            payloadStart: payloadStart,
            payloadEnd: payloadEnd,
            raw: buf.subarray(start, pos)
        });
    }
    return fields;
}

function encodeFields(fields) {
    var total = 0;
    var i;
    for (i = 0; i < fields.length; i++) total += fields[i].raw.length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < fields.length; i++) {
        out.set(fields[i].raw, off);
        off += fields[i].raw.length;
    }
    return out;
}

/* Body của field dạng length-delimited (bỏ tag + length). */
function fieldPayload(buf, field) {
    return buf.subarray(field.payloadStart, field.payloadEnd);
}

/* Dựng lại một field length-delimited từ payload mới. */
function rebuildLengthDelimited(fieldNumber, payload) {
    var head = tagBytes(fieldNumber, 2).concat(writeVarint(payload.length));
    var out = new Uint8Array(head.length + payload.length);
    out.set(head, 0);
    out.set(payload, head.length);
    return out;
}

function protoString(buf, field) {
    var p = fieldPayload(buf, field);
    var out = "";
    for (var i = 0; i < p.length; i++) out += String.fromCharCode(p[i]);
    try {
        return decodeURIComponent(escape(out));
    } catch (e) {
        return out;
    }
}

function protoBytes(str) {
    var utf8 = unescape(encodeURIComponent(str));
    var out = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) out[i] = utf8.charCodeAt(i);
    return out;
}

/* --------------------------------------------------------------- encoding */

function encodeVarintField(fieldNumber, value) {
    var body = writeVarint(value);
    var head = tagBytes(fieldNumber, 0);
    var out = new Uint8Array(head.length + body.length);
    out.set(head, 0);
    out.set(body, head.length);
    return out;
}

function encodeBoolField(fieldNumber, value) {
    return encodeVarintField(fieldNumber, value ? 1 : 0);
}

function encodeStringField(fieldNumber, value) {
    return rebuildLengthDelimited(fieldNumber, protoBytes(value));
}

/* ------------------------------------------------------------ map helpers */

/* map<string, AccountAttribute> là repeated field 1 = {1: key, 2: value}.
 * Chuyển thành object { key: Uint8Array của AccountAttribute } để sửa. */
function decodeAttributeMap(buf, mapFieldNumber) {
    var fields = decodeFields(buf);
    var map = {};
    var order = [];
    for (var i = 0; i < fields.length; i++) {
        if (fields[i].number !== mapFieldNumber || fields[i].wireType !== 2) continue;
        var entryBuf = fieldPayload(buf, fields[i]);
        var entryFields = decodeFields(entryBuf);
        var key = null;
        var val = null;
        for (var j = 0; j < entryFields.length; j++) {
            if (entryFields[j].number === 1) key = protoString(entryBuf, entryFields[j]);
            if (entryFields[j].number === 2) val = fieldPayload(entryBuf, entryFields[j]);
        }
        if (key === null) continue;
        if (!Object.prototype.hasOwnProperty.call(map, key)) order.push(key);
        map[key] = val;
    }
    return { map: map, order: order };
}

function encodeAttributeMap(map, order) {
    var chunks = [];
    for (var i = 0; i < order.length; i++) {
        var key = order[i];
        if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
        var val = map[key];
        var parts = [];
        parts.push(encodeStringField(1, key));
        if (val) parts.push(rebuildLengthDelimited(2, val));
        var entry = concatArrays(parts);
        chunks.push(rebuildLengthDelimited(1, entry));
    }
    return concatArrays(chunks);
}

function concatArrays(arrays) {
    var total = 0;
    var i;
    for (i = 0; i < arrays.length; i++) total += arrays[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (i = 0; i < arrays.length; i++) {
        out.set(arrays[i], off);
        off += arrays[i].length;
    }
    return out;
}

/* -------------------------------------------------- AccountAttribute value */

/* boolValue = field 2, longValue = field 3, stringValue = field 4.
 * oneof: chỉ một field được set - nên dựng message mới hoàn toàn. */
function buildAccountAttribute(spec) {
    if (spec === null || spec === undefined) return null;
    if (typeof spec === "boolean") return encodeBoolField(2, spec);
    if (typeof spec === "number") {
        return encodeVarintField(3, spec < 0 ? spec : spec);
    }
    if (typeof spec === "string") return encodeStringField(4, spec);
    if (spec.boolValue !== undefined) return encodeBoolField(2, !!spec.boolValue);
    if (spec.longValue !== undefined) return encodeVarintField(3, spec.longValue);
    if (spec.stringValue !== undefined) return encodeStringField(4, spec.stringValue);
    return null;
}

/* -------------------------------------------------------------- ISO dates */

function isoOneYearFromNow() {
    var d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + 1);
    return d.toISOString();
}

/* ============================== UCS RESPONSE ============================== */

/* Nội dung UcsResponse mặc định cho tài khoản "Premium".
 * Nguyên tắc: chỉ đặt những gì EeveeSpotify đặt và Spotify thực sự đọc ở
 * client. Các attribute do server quyết định (offline, audio-quality,
 * social-session...) KHÔNG bao giờ bị spoof - xem docs/ucs-patching.md. */
function premiumAttributeOverrides() {
    var expiry = isoOneYearFromNow();
    var overrides = {
        ads: false,
        "ab-ad-player-targeting": "0",
        "allow-advertising-id-transmission": false,
        "restrict-advertising-id-transmission": true,
        "can_use_superbird": true,
        catalogue: "premium",
        "financial-product": "pr:premium,tc:0",
        "is-eligible-premium-unboxing": true,
        name: "Spotify Premium",
        "nft-disabled": "1",
        "on-demand": true,
        "payments-initial-campaign": "default",
        "player-license": "premium",
        "player-license-v2": "premium",
        "product-expiry": expiry,
        "subscription-enddate": expiry,
        "shuffle-eligible": true,
        "streaming-rules": "",
        type: "premium",
        unrestricted: true,
        "high-bitrate": true,
        "loudness-levels": "1:-5.0,0.0,3.0:-2.0",
        "pick-and-shuffle": false,
        "mixing-tools": "EDIT",
        "your-library-tags": true,
        libspotify: true,
        mobile: true,
        "enable-crossfade-product-state": "1",
        "enable-gapless-product-state": "1"
    };
    for (var key in SPOTIFY_ATTRIBUTE_OVERRIDES) {
        if (Object.prototype.hasOwnProperty.call(SPOTIFY_ATTRIBUTE_OVERRIDES, key)) {
            overrides[key] = SPOTIFY_ATTRIBUTE_OVERRIDES[key];
        }
    }
    return overrides;
}

/* Attribute mà server là nguồn sự thật - không client-side spoof có ý nghĩa. */
function isServerAuthoritative(key) {
    for (var i = 0; i < SERVER_AUTHORITATIVE_ATTRIBUTES.length; i++) {
        if (SERVER_AUTHORITATIVE_ATTRIBUTES[i] === key) return true;
    }
    return false;
}

function patchAttributeMap(map, order, mode) {
    var touched = 0;

    function applyOverride(key, spec) {
        /* offline / audio-quality / social-session... do server quyết định:
         * giả chúng chỉ làm UI sai (server vẫn từ chối) nên bỏ qua hoàn toàn. */
        if (isServerAuthoritative(key)) return;
        var built = buildAccountAttribute(spec);
        if (!built) return;
        if (!Object.prototype.hasOwnProperty.call(map, key)) order.push(key);
        map[key] = built;
        touched++;
    }

    if (mode === "ads") {
        applyOverride("ads", false);
        applyOverride("ab-ad-player-targeting", "0");
        applyOverride("allow-advertising-id-transmission", false);
        applyOverride("restrict-advertising-id-transmission", true);
        return touched;
    }

    var overrides = premiumAttributeOverrides();
    for (var key in overrides) {
        if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
        applyOverride(key, overrides[key]);
    }

    var removals = SPOTIFY_ATTRIBUTE_REMOVALS.slice();
    for (var i = 1; i <= 100; i++) removals.push("is-premium-eligible-v" + i);
    for (var r = 0; r < removals.length; r++) {
        if (Object.prototype.hasOwnProperty.call(map, removals[r])) {
            delete map[removals[r]];
            touched++;
        }
    }
    return touched;
}

/* ------------------------------------------------------------------ rules */

/* UML/UC S rule: {name, scope, action, value}. Áp lên repeated AssignedValue. */
function assignedValueMatches(entry, rule) {
    var raw = entry.payload;
    var fields = entry.fields;
    var scope = null;
    var name = null;
    for (var i = 0; i < fields.length; i++) {
        if (fields[i].number !== 1 || fields[i].wireType !== 2) continue;
        var idBuf = fieldPayload(raw, fields[i]);
        var idFields = decodeFields(idBuf);
        for (var j = 0; j < idFields.length; j++) {
            if (idFields[j].number === 1) scope = protoString(idBuf, idFields[j]);
            if (idFields[j].number === 2) name = protoString(idBuf, idFields[j]);
        }
    }
    if (rule.scope !== null && rule.scope !== undefined && scope !== rule.scope) return false;
    if (rule.name !== null && rule.name !== undefined && name !== rule.name) return false;
    return true;
}

function rebuildAssignedValue(payload, fields, rule) {
    var out = [];
    var replaced = false;
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.number === 3 || f.number === 4 || f.number === 5) {
            // structuredValue oneof - bỏ hết rồi ghi lại đúng loại mới ở dưới.
            continue;
        }
        out.push(f.raw);
    }
    /* Cẩn thận: AssignedValue.boolValue là MESSAGE BoolValue{1:bool}, không phải
     * varint trần. Tương tự IntValue{1:int32} và EnumValue{1:string}. */
    /* forceBool xử lý y như setBool khi flag đã tồn tại (đúng ngữ nghĩa Eevee;
     * khác biệt duy nhất là forceBool còn được THÊM MỚI khi vắng mặt). */
    if (rule.action === "setBool" || rule.action === "forceBool") {
        out.push(rebuildLengthDelimited(3, encodeBoolField(1, !!rule.value)));
        replaced = true;
    } else if (rule.action === "setEnum") {
        out.push(rebuildLengthDelimited(5, encodeStringField(1, String(rule.value))));
        replaced = true;
    } else if (rule.action === "setInt") {
        out.push(rebuildLengthDelimited(4, encodeVarintField(1, rule.value)));
        replaced = true;
    }
    return replaced ? concatArrays(out) : null;
}

/* Port của EeveeSpotify `isCohortAdOrUpsellFlag`. Spotify bật quảng cáo theo
 * cohort bằng các flag bool riêng, không nằm trong danh sách rule cố định.
 * Luật: bỏ qua flag "disable_/dismissible/skip_button" (tắt chúng sẽ bật
 * quảng cáo), còn lại nếu scope/tên chứa token quảng cáo thì set false. */
var COHORT_EXEMPT_PREFIX = "disable_";
var COHORT_EXEMPT_CONTAINS = ["dismissible", "skip_button"];
var COHORT_AD_TOKENS = [
    "ad", "ads", "adsbase", "adsswift", "adonappopen", "instreamads",
    "leavebehind", "leavebehinds", "leavebehindadsbase", "marquee",
    "upsell", "upsells", "sponsored", "adssponsoredcontext", "realtimead"
];

function isCohortAdOrUpsellFlag_(scope, name) {
    if (!scope) scope = "";
    if (!name) name = "";
    var lowerName = name.toLowerCase();
    if (lowerName.indexOf(COHORT_EXEMPT_PREFIX) === 0) return false;
    for (var i = 0; i < COHORT_EXEMPT_CONTAINS.length; i++) {
        if (lowerName.indexOf(COHORT_EXEMPT_CONTAINS[i]) >= 0) return false;
    }
    var tokens = (scope + "." + name)
        .toLowerCase()
        .split(/[^a-z0-9]+/);
    for (var t = 0; t < tokens.length; t++) {
        for (var a = 0; a < COHORT_AD_TOKENS.length; a++) {
            if (tokens[t] === COHORT_AD_TOKENS[a]) return true;
        }
    }
    return false;
}

/* Đọc {scope, name} của một AssignedValue từ payload thô. */
function assignedValueID(entry) {
    var raw = entry.payload;
    var fields = entry.fields;
    var scope = null;
    var name = null;
    for (var i = 0; i < fields.length; i++) {
        if (fields[i].number !== 1 || fields[i].wireType !== 2) continue;
        var idBuf = fieldPayload(raw, fields[i]);
        var idFields = decodeFields(idBuf);
        for (var j = 0; j < idFields.length; j++) {
            if (idFields[j].number === 1) scope = protoString(idBuf, idFields[j]);
            if (idFields[j].number === 2) name = protoString(idBuf, idFields[j]);
        }
    }
    return { scope: scope, name: name };
}

/* Đọc giá trị bool hiện tại; null nếu field không phải boolValue. */
function assignedValueBool(entry) {
    var fields = entry.fields;
    for (var i = 0; i < fields.length; i++) {
        if (fields[i].number !== 3 || fields[i].wireType !== 2) continue;
        var inner = fieldPayload(entry.payload, fields[i]);
        var innerFields = decodeFields(inner);
        for (var j = 0; j < innerFields.length; j++) {
            if (innerFields[j].number === 1) {
                return readVarint(inner, innerFields[j].payloadStart).value === 1;
            }
        }
        return false;
    }
    return null;
}

/* AssignedValue mới cho rule forceBool khi flag chưa tồn tại. */
function buildAssignedValue(scope, name, boolValue) {
    return concatArrays([
        rebuildLengthDelimited(1, concatArrays([
            encodeStringField(1, scope),
            encodeStringField(2, name)
        ])),
        rebuildLengthDelimited(3, encodeBoolField(1, boolValue))
    ]);
}

function patchAssignedValues(buf, mode) {
    var fields = decodeFields(buf);
    var out = [];
    var removed = 0;
    var changed = 0;

    /* Gom index của AssignedValue để xử lý remove theo lô. */
    var entries = [];
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.number !== 3 || f.wireType !== 2) {
            out.push({ fixed: f.raw });
            continue;
        }
        var payload = fieldPayload(buf, f);
        entries.push({ payload: payload, fields: decodeFields(payload) });
        out.push({ entry: entries.length - 1, field: f });
    }

    var drop = {};
    for (var r = 0; r < UCS_RULES.length; r++) {
        var rule = UCS_RULES[r];
        var spec = {
            name: rule[0],
            scope: rule[1],
            action: rule[2],
            value: rule[3]
        };
        if (spec.name === null && spec.scope === null) continue;
        for (var e = 0; e < entries.length; e++) {
            if (drop[e]) continue;
            if (!assignedValueMatches(entries[e], spec)) continue;
            if (spec.action === "remove") {
                drop[e] = true;
                removed++;
            } else {
                var rebuilt = rebuildAssignedValue(entries[e].payload, entries[e].fields, spec);
                if (rebuilt) {
                    entries[e].payload = rebuilt;
                    entries[e].fields = decodeFields(rebuilt);
                    changed++;
                }
            }
        }
    }

    /* forceBool: nếu flag chưa tồn tại thì thêm mới (EeveeSpotify làm vậy để
     * crossfade/automix hiện đủ UI ngay cả khi tài khoản chưa có cohort). */
    for (var fr = 0; fr < UCS_RULES.length; fr++) {
        var frule = UCS_RULES[fr];
        if (frule[2] !== "forceBool") continue;
        if (frule[0] === null || frule[1] === null) continue;
        var exists = false;
        for (var ex = 0; ex < entries.length; ex++) {
            if (drop[ex]) continue;
            var ids = assignedValueID(entries[ex]);
            if (ids.scope === frule[1] && ids.name === frule[0]) {
                exists = true;
                break;
            }
        }
        if (exists) continue;
        var builtValue = buildAssignedValue(frule[1], frule[0], !!frule[3]);
        entries.push({
            payload: builtValue,
            fields: decodeFields(builtValue),
            appended: true
        });
        out.push({ entry: entries.length - 1, appended: true });
        changed++;
    }

    /* Cohort ad/upsell flags: tắt mọi bool flag còn bật mà mang token quảng cáo.
     * Áp cho cả mode "full" và "ads" vì đây thuần là chặn quảng cáo. */
    for (var c = 0; c < entries.length; c++) {
        if (drop[c] || entries[c].appended) continue;
        if (!entries[c].fields) entries[c].fields = decodeFields(entries[c].payload);
        if (assignedValueBool(entries[c]) !== true) continue;
        var id = assignedValueID(entries[c]);
        if (!isCohortAdOrUpsellFlag_(id.scope, id.name)) continue;
        entries[c].payload = rebuildAssignedValue(
            entries[c].payload, entries[c].fields, { action: "setBool", value: false }
        );
        entries[c].fields = decodeFields(entries[c].payload);
        changed++;
    }

    var result = [];
    for (var k = 0; k < out.length; k++) {
        if (out[k].fixed) {
            result.push(out[k].fixed);
        } else if (!drop[out[k].entry]) {
            result.push(rebuildLengthDelimited(3, entries[out[k].entry].payload));
        }
    }
    return { data: concatArrays(result), removed: removed, changed: changed };
}

/* ================================================================= PATCHERS */

/* Chạy một hàm patch mà lỗi decode không làm hỏng cả request. */
function safe(fn, arg, mode) {
    try {
        return fn(arg, mode);
    } catch (e) {
        spotifyLog("bỏ qua nhánh patch: " + e);
        return null;
    }
}

/* Key của attribute map là chuỗi ASCII in được. */
function isPrintableKey(buf) {
    if (!buf || buf.length === 0 || buf.length > 128) return false;
    for (var i = 0; i < buf.length; i++) {
        if (buf[i] < 0x20 || buf[i] > 0x7e) return false;
    }
    return true;
}

/* Nhận diện AccountAttributesResponse thật: chỉ có field 1 (map entry), mỗi
 * entry có key in được + value là message. Không dùng heuristic lỏng, vì
 * entry của map trông rất giống một lớp wrapper. */
function looksLikeAttributeMap(buf) {
    var fields;
    try {
        fields = decodeFields(buf);
    } catch (e) {
        return false;
    }
    if (fields.length === 0) return false;
    for (var i = 0; i < fields.length; i++) {
        if (fields[i].number !== 1 || fields[i].wireType !== 2) return false;
    }
    /* Kiểm tra tối đa 3 entry đầu là đủ phân biệt. */
    var limit = Math.min(fields.length, 3);
    for (var j = 0; j < limit; j++) {
        var entry = fieldPayload(buf, fields[j]);
        var entryFields;
        try {
            entryFields = decodeFields(entry);
        } catch (e) {
            return false;
        }
        var key = null;
        var hasValue = false;
        for (var k = 0; k < entryFields.length; k++) {
            if (entryFields[k].number === 1 && entryFields[k].wireType === 2) {
                key = fieldPayload(entry, entryFields[k]);
                if (!isPrintableKey(key)) return false;
            }
            if (entryFields[k].number === 2 && entryFields[k].wireType === 2) hasValue = true;
        }
        if (key === null || !hasValue) return false;
    }
    return true;
}

function patchAccountAttributes(data, mode) {
    var fields = decodeFields(data);

    /* Trường hợp chuẩn: chính buffer là map. */
    var target = null;
    var mapFields = null;
    if (looksLikeAttributeMap(data)) {
        target = data;
        mapFields = fields;
    } else {
        /* Một số build bọc map trong 1 lớp field 1 (BootstrapResponse kiểu mới).
         * Chỉ nhận khi lớp trong thật sự là map hợp lệ. */
        for (var i = 0; i < fields.length; i++) {
            if (fields[i].number !== 1 || fields[i].wireType !== 2) continue;
            var inner = fieldPayload(data, fields[i]);
            if (!looksLikeAttributeMap(inner)) continue;
            target = inner;
            mapFields = decodeFields(inner);
            break;
        }
    }

    if (target === null) {
        spotifyLog("attributes: không nhận diện được map");
        return null;
    }
    var wrapper = target !== data;
    var decoded = decodeAttributeMap(target, 1);
    if (decoded.order.length === 0) {
        spotifyLog("attributes: map rỗng, bỏ qua");
        return null;
    }

    var touched = patchAttributeMap(decoded.map, decoded.order, mode);
    var newMap = encodeAttributeMap(decoded.map, decoded.order);

    /* Ghép lại: map (field 1) đặt lại đúng vị trí đầu - AccountAttributesResponse
     * chỉ có đúng một field nên mọi field khác (nếu có) giữ nguyên thứ tự sau nó. */
    var rebuiltTarget = [newMap];
    for (var m = 0; m < mapFields.length; m++) {
        if (mapFields[m].number === 1 && mapFields[m].wireType === 2) {
            continue;
        }
        rebuiltTarget.push(mapFields[m].raw);
    }
    var finalTarget = concatArrays(rebuiltTarget);

    if (!wrapper) return { data: finalTarget, touched: touched };
    return {
        data: rebuildLengthDelimited(1, finalTarget),
        touched: touched
    };
}

/* UcsResponse { 1: resolve, 2: resolveError, 3: attributes, 4: attributesError, 5: fetchTimeMillis } */
function patchUcsResponse(data, mode) {
    var fields = decodeFields(data);
    var out = [];
    var touched = 0;
    var sawAttributes = false;

    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.number === 3 && f.wireType === 2) {
            var attrs = safe(patchAccountAttributes, fieldPayload(data, f), mode);
            if (attrs) {
                out.push(rebuildLengthDelimited(3, attrs.data));
                touched += attrs.touched;
            } else {
                out.push(f.raw);
            }
            sawAttributes = true;
            continue;
        }
        if (f.number === 1 && f.wireType === 2) {
            var resolved = safe(patchResolve, fieldPayload(data, f), mode);
            if (resolved) {
                out.push(rebuildLengthDelimited(1, resolved.data));
                touched += resolved.removed + resolved.changed;
            } else {
                out.push(f.raw);
            }
            continue;
        }
        out.push(f.raw);
    }

    if (!sawAttributes && touched === 0) return null;
    return { data: concatArrays(out), touched: touched };
}

/* ResolveResponse { 1: Configuration } */
function patchResolve(data, mode) {
    var fields = decodeFields(data);
    if (fields.length === 0 || fields[0].number !== 1 || fields[0].wireType !== 2) {
        return null;
    }
    var configBuf = fieldPayload(data, fields[0]);
    var patched = patchAssignedValues(configBuf, mode);
    if (!patched.data) return null;
    /* Configuration không đổi cấu trúc ngoài field 3 - patchAssignedValues đã
     * giữ nguyên các field khác, nên chỉ cần bọc lại. */
    return {
        data: rebuildLengthDelimited(1, patched.data),
        removed: patched.removed,
        changed: patched.changed
    };
}

/* CustomizeMessage { 1: UcsResponse | 2: error } */
function patchCustomizeMessage(data, mode) {
    var fields = decodeFields(data);
    var out = [];
    var touched = 0;
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.number === 1 && f.wireType === 2) {
            var res = safe(patchUcsResponse, fieldPayload(data, f), mode);
            if (res) {
                out.push(rebuildLengthDelimited(1, res.data));
                touched += res.touched;
            } else {
                out.push(f.raw);
            }
        } else {
            out.push(f.raw);
        }
    }
    return touched > 0 ? concatArrays(out) : null;
}

/* BootstrapMessage { 2: wrapper{1: oneMoreWrapper{1: message{CustomizeMessage}}} } */
function patchBootstrap(data, mode) {
    var fields = decodeFields(data);
    var out = [];
    var touched = 0;
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.number !== 2 || f.wireType !== 2) {
            out.push(f.raw);
            continue;
        }
        var wrapperBuf = fieldPayload(data, f);
        var wrapperFields = decodeFields(wrapperBuf);
        var wrapperOut = [];
        var wrapperTouched = 0;
        for (var j = 0; j < wrapperFields.length; j++) {
            var wf = wrapperFields[j];
            if (wf.number !== 1 || wf.wireType !== 2) {
                wrapperOut.push(wf.raw);
                continue;
            }
            var moreBuf = fieldPayload(wrapperBuf, wf);
            var moreFields = decodeFields(moreBuf);
            var moreOut = [];
            var moreTouched = 0;
            for (var k = 0; k < moreFields.length; k++) {
                var mf = moreFields[k];
                if (mf.number !== 1 || mf.wireType !== 2) {
                    moreOut.push(mf.raw);
                    continue;
                }
                var patched = safe(patchCustomizeMessage, fieldPayload(moreBuf, mf), mode);
                if (patched) {
                    moreOut.push(rebuildLengthDelimited(1, patched));
                    moreTouched++;
                } else {
                    moreOut.push(mf.raw);
                }
            }
            wrapperOut.push(moreTouched
                ? rebuildLengthDelimited(1, concatArrays(moreOut))
                : wf.raw);
            wrapperTouched += moreTouched;
        }
        out.push(wrapperTouched
            ? rebuildLengthDelimited(2, concatArrays(wrapperOut))
            : f.raw);
        touched += wrapperTouched;
    }
    return touched > 0 ? concatArrays(out) : null;
}

/* UcsResponseWrapper { 1: success{1: UcsResponse} | 2: error } */
function patchUcsWrapper(data, mode) {
    var fields = decodeFields(data);
    var out = [];
    var touched = 0;
    for (var i = 0; i < fields.length; i++) {
        var f = fields[i];
        if (f.number !== 1 || f.wireType !== 2) {
            out.push(f.raw);
            continue;
        }
        var successBuf = fieldPayload(data, f);
        var successFields = decodeFields(successBuf);
        var successOut = [];
        var successTouched = 0;
        for (var j = 0; j < successFields.length; j++) {
            var sf = successFields[j];
            if (sf.number !== 1 || sf.wireType !== 2) {
                successOut.push(sf.raw);
                continue;
            }
            var res = safe(patchUcsResponse, fieldPayload(successBuf, sf), mode);
            if (res) {
                successOut.push(rebuildLengthDelimited(1, res.data));
                successTouched += res.touched;
            } else {
                successOut.push(sf.raw);
            }
        }
        out.push(successTouched
            ? rebuildLengthDelimited(1, concatArrays(successOut))
            : f.raw);
        touched += successTouched;
    }
    return touched > 0 ? concatArrays(out) : null;
}

/* ---------------------------------------------------------------- routing */

function detectKind(path) {
    if (path.indexOf("v1/bootstrap") >= 0) return "bootstrap";
    if (path.indexOf("v1/customize") >= 0) return "customize";
    if (path.indexOf("nebula/v1/configuration/attributes") >= 0) return "attributes";
    if (path.indexOf("remote-config-resolver/") >= 0) return "remoteConfig";
    return null;
}

function patchProtobuf(kind, bytes, mode) {
    if (kind === "bootstrap") return patchBootstrap(bytes, mode);
    if (kind === "customize") {
        /* Customize có thể là UcsResponseWrapper (chính chủ) hoặc UcsResponse trần. */
        var wrapped = patchUcsWrapper(bytes, mode);
        if (wrapped) return wrapped;
        var plain = patchUcsResponse(bytes, mode);
        return plain ? plain.data : null;
    }
    if (kind === "attributes") {
        var attrs = patchAccountAttributes(bytes, mode);
        return attrs ? attrs.data : null;
    }
    if (kind === "remoteConfig") {
        var resolved = patchResolve(bytes, mode);
        return resolved ? resolved.data : null;
    }
    return null;
}

/* ------------------------------------------------------------------- JSON */

function patchJsonObject(kind, obj, mode) {
    var attributes = null;
    var assigned = null;

    if (kind === "attributes") {
        attributes = obj.accountAttributes || obj.account_attributes || null;
    } else if (kind === "remoteConfig") {
        var conf = obj.configuration || (obj.resolve && obj.resolve.configuration);
        assigned = conf && conf.assignedValues ? conf.assignedValues : null;
    } else {
        var ucs = obj;
        if (ucs.ucsResponseV0) ucs = ucs.ucsResponseV0.success.customization.success;
        else if (ucs.success) ucs = ucs.success;
        if (!ucs) return null;
        attributes = ucs.accountAttributesSuccess
            ? ucs.accountAttributesSuccess.accountAttributes
            : null;
        assigned = ucs.resolveSuccess
            ? ucs.resolveSuccess.configuration.assignedValues
            : null;
    }

    var changed = 0;

    if (attributes && mode !== "off") {
        var overrides = mode === "ads"
            ? { ads: false, "ab-ad-player-targeting": "0",
                "allow-advertising-id-transmission": false,
                "restrict-advertising-id-transmission": true }
            : premiumAttributeOverrides();
        for (var key in overrides) {
            if (!Object.prototype.hasOwnProperty.call(overrides, key)) continue;
            if (isServerAuthoritative(key)) continue;
            var v = overrides[key];
            attributes[key] = typeof v === "boolean"
                ? { boolValue: v }
                : typeof v === "number"
                    ? { longValue: v }
                    : { stringValue: v };
            changed++;
        }
        if (mode !== "ads") {
            var removals = SPOTIFY_ATTRIBUTE_REMOVALS.slice();
            for (var i = 1; i <= 100; i++) removals.push("is-premium-eligible-v" + i);
            for (var r = 0; r < removals.length; r++) {
                if (Object.prototype.hasOwnProperty.call(attributes, removals[r])) {
                    delete attributes[removals[r]];
                    changed++;
                }
            }
        }
    }

    if (assigned && Array.isArray(assigned)) {
        for (var ri = 0; ri < UCS_RULES.length; ri++) {
            var rule = UCS_RULES[ri];
            var spec = { name: rule[0], scope: rule[1], action: rule[2], value: rule[3] };
            if (spec.name === null && spec.scope === null) continue;
            for (var ai = assigned.length - 1; ai >= 0; ai--) {
                var value = assigned[ai];
                var pid = value.propertyId || value.property_id || {};
                if (spec.scope != null && pid.scope !== spec.scope) continue;
                if (spec.name != null && pid.name !== spec.name) continue;
                if (spec.action === "remove") {
                    assigned.splice(ai, 1);
                } else if (spec.action === "setBool") {
                    value.boolValue = { value: !!spec.value };
                    changed++;
                } else if (spec.action === "setEnum") {
                    value.enumValue = { value: String(spec.value) };
                    changed++;
                } else if (spec.action === "setInt") {
                    value.intValue = { value: spec.value };
                    changed++;
                }
            }
        }
    }

    return changed > 0 ? obj : null;
}

/* ================================================================ ENTRY === */

/* Chuyển body ($response.body của Shadowrocket) về Uint8Array. Binary body
 * thường về dạng string ISO-8859-1; một số client trả ArrayBuffer/base64. */
function bodyToBytes(body) {
    if (!body) return null;
    if (body instanceof Uint8Array) return body;
    if (typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer) {
        return new Uint8Array(body);
    }
    if (typeof body === "object" && body.byteLength !== undefined && body.buffer) {
        return new Uint8Array(body.buffer, body.byteOffset || 0, body.byteLength);
    }
    if (typeof body === "string") {
        var out = new Uint8Array(body.length);
        for (var i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
        return out;
    }
    return null;
}

function bytesToBodyString(bytes) {
    var chunk = 8192;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
        parts.push(String.fromCharCode.apply(
            null, Array.prototype.slice.call(bytes.subarray(i, i + chunk))
        ));
    }
    return parts.join("");
}

/* Gửi body protobuf đã patch về Shadowrocket.
 *
 * ĐÂY LÀ CHỖ DỄ HỎNG NHẤT và cũng là lý do module từng "không có tác dụng".
 * Quy tắc rút ra từ runtime thật + các module binary đang chạy được:
 *
 *   1. KHÔNG BAO GIỜ dùng `$done({})` cho một request binary-body-mode.
 *      Trong Shadowrocket, `$done({})` nghĩa là "thay body bằng rỗng", không
 *      phải "giữ nguyên". Body rỗng -> Spotify nhận response 200 không nội
 *      dung -> coi như chưa đăng nhập / loading mãi.
 *   2. Chỉ trả `{ body: <binary> }`. TUYỆT ĐỐI không kèm `status`/`headers`
 *      khi body đã bị giải nén: header gốc còn `content-encoding: gzip` và
 *      `content-length` cũ, kèm vào là app giải nén sai -> hỏng body.
 *   3. Kiểu của `body` phải khớp engine:
 *        - `webview` (mặc định của Shadowrocket cho http-response): truyền
 *          thẳng `Uint8Array`. Đây là kiểu an toàn nhất, không phụ thuộc
 *          bảng mã.
 *        - `jsc`: `Uint8Array` không được bridge qua Objective-C, phải đổi
 *          sang `ArrayBuffer` (cũng có thể dùng string latin1, nhưng
 *          ArrayBuffer không mất byte nào).
 *
 * Vì vậy hàm này trả ArrayBuffer khi phát hiện môi trường jsc, còn lại trả
 * nguyên Uint8Array. */
function buildDoneResponse(bytes) {
    var isJsc = typeof $environment !== "undefined" && $environment &&
        typeof $environment["engine"] === "string" &&
        $environment["engine"].toLowerCase().indexOf("jsc") >= 0;

    if (!isJsc) return { body: bytes };

    /* jsc: copy sang ArrayBuffer có đúng độ dài. Không dùng bytes.buffer trực
     * tiếp vì subarray có thể trỏ vào buffer lớn hơn (byteOffset != 0) và
     * runtime sẽ đọc thừa byte rác ở đầu/cuối. */
    var ab = new ArrayBuffer(bytes.length);
    var view = new Uint8Array(ab);
    for (var i = 0; i < bytes.length; i++) view[i] = bytes[i];
    return { body: ab };
}

/* Passthrough đúng nghĩa: trả lại nguyên body gốc. Dùng cho mọi nhánh "không
 * sửa gì" của script binary - xem quy tắc 1 ở trên. */
function donePassthrough(bytes, reason) {
    if (reason) spotifyLog("passthrough: " + reason);
    if (!bytes || bytes.length === 0) {
        /* Không có body để trả (ví dụ 304). Trường hợp này buộc phải dùng {}
         * vì không có gì để giữ; body vốn đã rỗng nên không làm hỏng gì. */
        return $done({});
    }
    return $done(buildDoneResponse(bytes));
}

function spotifyUcsMain() {
    var url = (typeof $request !== "undefined" && $request && $request.url) ? $request.url : "";
    var path = url.split("?")[0];
    var kind = detectKind(path);

    /* Đọc body TRƯỚC mọi nhánh return. Mọi nhánh "bỏ qua" đều phải trả lại
     * nguyên body: với binary-body-mode, $done({}) = body rỗng = hỏng response. */
    var status = ($response && ($response.status || $response.statusCode)) || 0;
    var rawBody = $response ? $response.body : null;
    var bytes = bodyToBytes(rawBody);

    /* Đọc argument TRƯỚC khi log, để `argument=debug` tự bật log ngay từ dòng
     * đầu tiên. Trên điện thoại đây là cách duy nhất để biết hook có chạy. */
    var mode = SPOTIFY_PATCH_MODE;
    if (typeof $argument !== "undefined" && $argument) {
        var arg = String($argument).toLowerCase();
        if (arg === "off" || arg === "ads" || arg === "full") mode = arg;
        /* Chấp nhận cả dạng "mode=ads&debug=true" như các module khác. */
        if (/(^|[&,;\s])mode\s*[=:]\s*(off|ads|full)/.test(arg)) {
            mode = arg.match(/(^|[&,;\s])mode\s*[=:]\s*(off|ads|full)/)[2];
        }
        if (arg.indexOf("debug") >= 0) SPOTIFY_DEBUG = true;
    }

    if (SPOTIFY_DEBUG) {
        spotifyLog("hook chạy: " + (kind || "endpoint lạ") + " | " + path);
        spotifyLog("status=" + status + ", body=" + describeBodyForLog(bytes));
        spotifyLog("engine=" + (typeof $environment !== "undefined" && $environment && $environment["engine"] ? $environment["engine"] : "không rõ") +
            ", mode=" + mode + ", argument=" + (typeof $argument === "undefined" ? "(không set)" : String($argument)));
    }

    if (!kind) return donePassthrough(bytes, "endpoint không khớp: " + path);
    if (mode === "off") return donePassthrough(bytes, "mode=off");

    if (status && status !== 200) {
        /* 304 = body rỗng, không có gì để patch. [Header Rewrite] trong module
         * đã xoá validator nên trường hợp này chỉ xảy ra khi server vẫn ép 304. */
        return donePassthrough(bytes, "status " + status);
    }

    if (!bytes || bytes.length < 2) return donePassthrough(bytes, "body rỗng");

    /* Payload protobuf không bao giờ bắt đầu bằng "{" (0x7b). */
    if (bytes[0] === 0x7b) {
        if (!SPOTIFY_TRY_JSON) return donePassthrough(bytes, "JSON, không xử lý");
        var patchedObj = null;
        try {
            patchedObj = patchJsonObject(kind, JSON.parse(bytesToBodyString(bytes)), mode);
        } catch (e) {
            spotifyLog("JSON lỗi: " + e);
            return donePassthrough(bytes, "JSON lỗi");
        }
        if (!patchedObj) return donePassthrough(bytes, kind + ": JSON không có gì để sửa");
        spotifyLog(kind + ": JSON đã patch");
        /* JSON là text: trả string như bình thường, runtime tự tính lại
         * content-length. */
        return $done({ body: JSON.stringify(patchedObj) });
    }

    var patched = null;
    try {
        patched = patchProtobuf(kind, bytes, mode);
    } catch (e) {
        spotifyLog("decode/patch lỗi: " + e + " | " + (e && e.stack));
        return donePassthrough(bytes, "decode/patch lỗi");
    }
    if (!patched) return donePassthrough(bytes, kind + ": không có thay đổi");

    spotifyLog(kind + ": " + bytes.length + " -> " + patched.length + " bytes");
    return $done(buildDoneResponse(patched));
}

/* ============================================ GENERATED DATA (DO NOT EDIT) */
/* Khối dưới đây được tools/sync_ucs_rules.py ghi đè. */

// BEGIN GENERATED RULES (sinh bởi tools/sync_ucs_rules.py - KHÔNG sửa tay)
var UCS_RULES = [
[
"crossfade_enabled",
"ios-feature-settings",
"forceBool",
true
],
[
"automix_enabled",
"ios-feature-settings",
"forceBool",
true
],
[
"crossfade_enabled",
"core-playback-setup",
"forceBool",
true
],
[
"use_playback_settings_crossfade",
"ios-feature-settings",
"forceBool",
false
],
[
"use_playback_settings_gapless",
"ios-feature-settings",
"forceBool",
false
],
[
"enable_common_capping",
null,
"remove",
""
],
[
"enable_pns_common_capping",
null,
"remove",
""
],
[
"enable_pick_and_shuffle_common_capping",
null,
"remove",
""
],
[
"enable_pick_and_shuffle_dynamic_cap",
null,
"remove",
""
],
[
"pick_and_shuffle_timecap",
null,
"remove",
""
],
[
null,
"ios-feature-queue",
"remove",
""
],
[
"enable_free_on_demand_experiment",
null,
"remove",
""
],
[
"enable_free_on_demand_context_menu_experiment",
null,
"remove",
""
],
[
"enable_mft_plus_queue",
null,
"remove",
""
],
[
"enable_mft_plus_extended_queue",
null,
"remove",
""
],
[
"enable_playback_timeout_service",
null,
"setBool",
false
],
[
"enable_playback_timeout_error_ui",
null,
"setBool",
false
],
[
"playback_timeout_action",
null,
"setEnum",
"Nothing"
],
[
"is_remove_from_queue_enabled_for_mft_plus",
null,
"remove",
""
],
[
"is_reordering_for_mft_plus_allowed",
null,
"remove",
""
],
[
"ads",
null,
"setBool",
false
],
[
"ad_metadata",
null,
"remove",
""
],
[
"ad_slots",
null,
"remove",
""
],
[
"enable_ads",
null,
"setBool",
false
],
[
"enable_audio_ads",
null,
"setBool",
false
],
[
"enable_display_ads",
null,
"setBool",
false
],
[
"enable_video_ads",
null,
"setBool",
false
],
[
"enable_premium_upsell",
null,
"setBool",
false
],
[
"enable_upsell",
null,
"setBool",
false
],
[
"show_upsell",
null,
"setBool",
false
],
[
"show_premium_upsell",
null,
"setBool",
false
],
[
"enable_campaigns",
null,
"setBool",
false
],
[
"enable_promotions",
null,
"setBool",
false
],
[
"enable_search_ad",
null,
"setBool",
false
],
[
"enable_search_ads",
null,
"setBool",
false
],
[
"enable_search_banner_ad",
null,
"setBool",
false
],
[
"enable_search_banner_ads",
null,
"setBool",
false
],
[
"enable_search_sponsored_ad",
null,
"setBool",
false
],
[
"enable_search_sponsored_ads",
null,
"setBool",
false
],
[
"enable_search_upsell",
null,
"setBool",
false
],
[
"enable_home_ad",
null,
"setBool",
false
],
[
"enable_home_ads",
null,
"setBool",
false
],
[
"enable_home_banner_ad",
null,
"setBool",
false
],
[
"enable_home_banner_ads",
null,
"setBool",
false
],
[
"enable_home_sponsored_ad",
null,
"setBool",
false
],
[
"enable_home_sponsored_ads",
null,
"setBool",
false
],
[
"enable_home_upsell",
null,
"setBool",
false
],
[
"is_enabled_pt2",
"ios-feature-shuffletoggleupsell",
"forceBool",
false
],
[
"linear_upsell_new_style_experiment_enabled",
"ios-feature-shuffletoggleupsell",
"forceBool",
false
],
[
"play_modes_upsell_new_style_experiment_enabled",
"ios-feature-shuffletoggleupsell",
"forceBool",
false
],
[
"free_user_shuffle_upsell_sheet_enabled",
"ios-jam-freeusershuffleupsellsheetpage-impl",
"forceBool",
false
],
[
"free_user_skip_upsell_sheet_enabled",
"ios-jam-freeuserskipupsellpage-impl",
"forceBool",
false
],
[
"free_hosted_jams_upsell_enabled",
"ios-jam-freehostedjamsupsell-impl",
"forceBool",
false
],
[
"premium_gated_start_jam_buttons_enabled",
"ios-sociallistening-configuration-impl",
"forceBool",
false
],
[
"is_promo_cta_enabled",
"ios-reinventfree-contextualupsellpremiumpromo-impl",
"forceBool",
false
],
[
"show_time_cap_upsell_with_premium_badge",
"ios-reinventfree-contextualupsellpremiumpromo-impl",
"forceBool",
false
],
[
"enable_video_time_cap_upsell",
"ios-reinventfree-controllerui-impl",
"forceBool",
false
],
[
"enable_video_time_cap_upsell_on_search",
"ios-reinventfree-controllerui-impl",
"forceBool",
false
],
[
"music_video_upsell_enabled",
"ios-reinventfree-timecappivot-impl",
"forceBool",
false
],
[
"is_gbb_upsell_enabled",
"ios-settings-mediaqualitypageplugin-impl",
"forceBool",
false
],
[
"should_show_pigeon_upsell",
"ios-settings-mediaqualitypageplugin-impl",
"forceBool",
false
],
[
"preview_ended_upsell_enabled",
"ios-system-listeningparties",
"forceBool",
false
],
[
"enable_now_playing_ad",
null,
"setBool",
false
],
[
"enable_now_playing_ads",
null,
"setBool",
false
],
[
"enable_now_playing_banner_ad",
null,
"setBool",
false
],
[
"enable_now_playing_banner_ads",
null,
"setBool",
false
],
[
"enable_now_playing_sponsored_ad",
null,
"setBool",
false
],
[
"enable_now_playing_sponsored_ads",
null,
"setBool",
false
],
[
"enable_now_playing_upsell",
null,
"setBool",
false
],
[
"enable_artist_ad",
null,
"setBool",
false
],
[
"enable_artist_ads",
null,
"setBool",
false
],
[
"enable_artist_banner_ad",
null,
"setBool",
false
],
[
"enable_artist_banner_ads",
null,
"setBool",
false
],
[
"enable_artist_sponsored_ad",
null,
"setBool",
false
],
[
"enable_artist_sponsored_ads",
null,
"setBool",
false
],
[
"enable_artist_upsell",
null,
"setBool",
false
],
[
"enable_playlist_ad",
null,
"setBool",
false
],
[
"enable_playlist_ads",
null,
"setBool",
false
],
[
"enable_playlist_banner_ad",
null,
"setBool",
false
],
[
"enable_playlist_banner_ads",
null,
"setBool",
false
],
[
"enable_playlist_sponsored_ad",
null,
"setBool",
false
],
[
"enable_playlist_sponsored_ads",
null,
"setBool",
false
],
[
"enable_playlist_upsell",
null,
"setBool",
false
],
[
"enable_album_ad",
null,
"setBool",
false
],
[
"enable_album_ads",
null,
"setBool",
false
],
[
"enable_album_banner_ad",
null,
"setBool",
false
],
[
"enable_album_banner_ads",
null,
"setBool",
false
],
[
"enable_album_sponsored_ad",
null,
"setBool",
false
],
[
"enable_album_sponsored_ads",
null,
"setBool",
false
],
[
"enable_album_upsell",
null,
"setBool",
false
],
[
"enable_library_ad",
null,
"setBool",
false
],
[
"enable_library_ads",
null,
"setBool",
false
],
[
"enable_library_banner_ad",
null,
"setBool",
false
],
[
"enable_library_banner_ads",
null,
"setBool",
false
],
[
"enable_library_sponsored_ad",
null,
"setBool",
false
],
[
"enable_library_sponsored_ads",
null,
"setBool",
false
],
[
"enable_library_upsell",
null,
"setBool",
false
],
[
"enable_audiobook_ad",
null,
"setBool",
false
],
[
"enable_audiobook_ads",
null,
"setBool",
false
],
[
"enable_audiobook_banner_ad",
null,
"setBool",
false
],
[
"enable_audiobook_banner_ads",
null,
"setBool",
false
],
[
"enable_audiobook_sponsored_ad",
null,
"setBool",
false
],
[
"enable_audiobook_sponsored_ads",
null,
"setBool",
false
],
[
"enable_audiobook_upsell",
null,
"setBool",
false
],
[
"enable_podcast_ad",
null,
"setBool",
false
],
[
"enable_podcast_ads",
null,
"setBool",
false
],
[
"enable_podcast_banner_ad",
null,
"setBool",
false
],
[
"enable_podcast_banner_ads",
null,
"setBool",
false
],
[
"enable_podcast_sponsored_ad",
null,
"setBool",
false
],
[
"enable_podcast_sponsored_ads",
null,
"setBool",
false
],
[
"enable_podcast_upsell",
null,
"setBool",
false
],
[
"enable_sponsored_content",
null,
"setBool",
false
],
[
"enable_sponsored_playlists",
null,
"setBool",
false
],
[
"enable_sponsored_sessions",
null,
"setBool",
false
],
[
"enable_sponsored_stories",
null,
"setBool",
false
],
[
"enable_sponsored_videos",
null,
"setBool",
false
],
[
"enable_sponsored_artist",
null,
"setBool",
false
],
[
"enable_sponsored_artists",
null,
"setBool",
false
],
[
"enable_sponsored_album",
null,
"setBool",
false
],
[
"enable_sponsored_albums",
null,
"setBool",
false
],
[
"enable_sponsored_track",
null,
"setBool",
false
],
[
"enable_sponsored_tracks",
null,
"setBool",
false
],
[
"enable_sponsored_show",
null,
"setBool",
false
],
[
"enable_sponsored_shows",
null,
"setBool",
false
],
[
"enable_sponsored_episode",
null,
"setBool",
false
],
[
"enable_sponsored_episodes",
null,
"setBool",
false
],
[
"enable_sponsored_audiobook",
null,
"setBool",
false
],
[
"enable_sponsored_audiobooks",
null,
"setBool",
false
],
[
"enable_sponsored_podcast",
null,
"setBool",
false
],
[
"enable_sponsored_podcasts",
null,
"setBool",
false
],
[
"enable_sponsored_search",
null,
"setBool",
false
],
[
"enable_sponsored_search_results",
null,
"setBool",
false
],
[
"enable_sponsored_search_banner",
null,
"setBool",
false
],
[
"enable_sponsored_search_banners",
null,
"setBool",
false
],
[
"enable_sponsored_home",
null,
"setBool",
false
],
[
"enable_sponsored_home_banner",
null,
"setBool",
false
],
[
"enable_sponsored_home_banners",
null,
"setBool",
false
],
[
"enable_sponsored_now_playing",
null,
"setBool",
false
],
[
"enable_sponsored_now_playing_banner",
null,
"setBool",
false
],
[
"enable_sponsored_now_playing_banners",
null,
"setBool",
false
],
[
"enable_sponsored_artist_banner",
null,
"setBool",
false
],
[
"enable_sponsored_artist_banners",
null,
"setBool",
false
],
[
"enable_sponsored_playlist_banner",
null,
"setBool",
false
],
[
"enable_sponsored_playlist_banners",
null,
"setBool",
false
],
[
"enable_sponsored_album_banner",
null,
"setBool",
false
],
[
"enable_sponsored_album_banners",
null,
"setBool",
false
],
[
"enable_sponsored_library_banner",
null,
"setBool",
false
],
[
"enable_sponsored_library_banners",
null,
"setBool",
false
],
[
"enable_sponsored_audiobook_banner",
null,
"setBool",
false
],
[
"enable_sponsored_audiobook_banners",
null,
"setBool",
false
],
[
"enable_sponsored_podcast_banner",
null,
"setBool",
false
],
[
"enable_sponsored_podcast_banners",
null,
"setBool",
false
],
[
"enable_sponsored_search_sponsored_ad",
null,
"setBool",
false
],
[
"enable_sponsored_search_sponsored_ads",
null,
"setBool",
false
],
[
"enable_sponsored_home_sponsored_ad",
null,
"setBool",
false
],
[
"enable_sponsored_home_sponsored_ads",
null,
"setBool",
false
],
[
"enable_sponsored_now_playing_sponsored_ad",
null,
"setBool",
false
],
[
"enable_sponsored_now_playing_sponsored_ads",
null,
"setBool",
false
],
[
"enable_sponsored_artist_sponsored_ad",
null,
"setBool",
false
],
[
"enable_sponsored_artist_sponsored_ads",
null,
"setBool",
false
],
[
"enable_sponsored_playlist_sponsored_ad",
null,
"setBool",
false
],
[
"enable_sponsored_playlist_sponsored_ads",
null,
"setBool",
false
],
[
"enable_sponsored_album_sponsored_ad",
null,
"setBool",
false
],
[
"enable_sponsored_album_sponsored_ads",
null,
"setBool",
false
],
[
"enable_sponsored_library_sponsored_ad",
null,
"setBool",
false
],
[
"enable_sponsored_library_sponsored_ads",
null,
"setBool",
false
],
[
"enable_sponsored_audiobook_sponsored_ad",
null,
"setBool",
false
],
[
"enable_sponsored_audiobook_sponsored_ads",
null,
"setBool",
false
],
[
"enable_sponsored_podcast_sponsored_ad",
null,
"setBool",
false
],
[
"enable_sponsored_podcast_sponsored_ads",
null,
"setBool",
false
],
[
null,
"ios-ad-on-app-open",
"remove",
""
],
[
null,
"ios-feature-adonappopen",
"remove",
""
],
[
"enabled",
"ios-feature-adonappopen",
"setBool",
false
],
[
"background_refresh_frequency_seconds",
"ios-feature-adonappopen",
"setBool",
false
],
[
"is_ad_on_app_open_enabled",
null,
"setBool",
false
],
[
"ad_on_app_open_enabled",
null,
"setBool",
false
],
[
"adonappopen_enabled",
null,
"setBool",
false
],
[
null,
"marquee",
"remove",
""
],
[
null,
"ios-feature-marquee",
"remove",
""
],
[
null,
"leavebehindadsbase",
"remove",
""
],
[
null,
"ios-feature-leavebehindadsbase",
"remove",
""
],
[
"unified_leavebehind_npv_scroll_music_enabled",
"ios-nowplaying-scroll-impl",
"forceBool",
false
],
[
"unified_leavebehind_npv_scroll_podcast_enabled",
"ios-nowplaying-scroll-impl",
"forceBool",
false
],
[
"use_unified_leavebehind_fetch",
"ios-feature-embeddedplaylist",
"forceBool",
false
],
[
"foreground_enabled",
"ios-adsnowplaying-embeddednpv-impl",
"forceBool",
false
],
[
"music_track_change_enabled",
"ios-adsnowplaying-embeddednpv-impl",
"forceBool",
false
],
[
"enable_ads_on_podcast",
"ios-adsnowplaying-embeddednpv-impl",
"forceBool",
false
],
[
null,
"ios-feature-instreamads",
"remove",
""
],
[
null,
"ios-adsembedded-embeddedctaelements-impl",
"remove",
""
],
[
null,
"ios-adsnowplaying-embeddednpv-impl",
"remove",
""
],
[
null,
"ios-adsplatform-elementimpl",
"remove",
""
],
[
null,
"ios-system-adssponsoredcontext",
"remove",
""
],
[
"enable_ads_connect_state_observer",
"ios-feature-adsbase",
"setBool",
false
],
[
"enable_minimal_preroll_management",
"ios-feature-adsbase",
"setBool",
false
],
[
"enable_swift_ads_base_movement_logger",
"ios-feature-adsbase",
"setBool",
false
],
[
null,
"ios-feature-adsswift",
"remove",
""
],
[
"embedded_npv_video_show_with_canvas",
"ios-feature-adsnowplayingui",
"forceBool",
false
],
[
"sponsored_context_mismatch_aderror_enabled",
"ios-feature-adssponsoredcontext",
"setBool",
false
],
[
"sponsored_playlist_v2_enabled",
"ios-feature-adssponsoredcontext",
"setBool",
false
],
[
"sponsored_npb_slot_fetch_enabled",
"ios-feature-adssponsoredcontextnpbattachment",
"setBool",
false
],
[
null,
"ios-feature-adsidentitytracking",
"remove",
""
],
[
"prompted_playlist_merchandizing_enabled",
"ios-feature-search",
"setBool",
false
],
[
"social_proof_playlist_enabled",
"ios-feature-search",
"setBool",
false
],
[
"social_proof_plays_in_search_enabled",
"ios-feature-search",
"setBool",
false
],
[
"video_carousel_section_enabled",
"ios-feature-search",
"setBool",
false
],
[
"watch_feed_section_enabled",
"ios-feature-search",
"setBool",
false
],
[
"enable_popups",
null,
"setBool",
false
],
[
"enable_leave_behind_ads_card_element",
null,
"setBool",
false
],
[
"music_npv_leavebehinds_enabled",
null,
"setBool",
false
],
[
"enable_ads_on_podcast",
null,
"setBool",
false
],
[
"enable_display_element",
null,
"setBool",
false
],
[
"enable_video_element",
null,
"setBool",
false
],
[
"is_promo_cta_enabled",
null,
"setBool",
false
],
[
"show_time_cap_upsell_with_premium_badge",
null,
"setBool",
false
],
[
"enable_video_time_cap_upsell",
null,
"setBool",
false
],
[
"enable_video_time_cap_upsell_on_search",
null,
"setBool",
false
],
[
"music_video_upsell_enabled",
null,
"setBool",
false
],
[
"is_gbb_upsell_enabled",
null,
"setBool",
false
],
[
"should_show_pigeon_upsell",
null,
"setBool",
false
],
[
"disable_suggested_tracks_upsell",
null,
"setBool",
true
],
[
"is_enabled_pt2",
null,
"setBool",
false
],
[
"show_skip_button_during_skippable_ads",
null,
"setBool",
true
],
[
"sponsored_playlist_v2_header_dismissible",
null,
"setBool",
true
],
[
"use_mock_sponsorship_endpoint",
null,
"setBool",
false
],
[
"enable_popup",
null,
"setBool",
false
],
[
"show_popups",
null,
"setBool",
false
],
[
"show_popup",
null,
"setBool",
false
],
[
"enable_interstitials",
null,
"setBool",
false
],
[
"enable_interstitial",
null,
"setBool",
false
],
[
"enable_overlays",
null,
"setBool",
false
],
[
"enable_overlay",
null,
"setBool",
false
],
[
"enable_promotions_on_home",
null,
"setBool",
false
],
[
"enable_promotions_on_search",
null,
"setBool",
false
],
[
"enable_search_page_ads",
null,
"setBool",
false
],
[
"enable_home_page_ads",
null,
"setBool",
false
],
[
"enable_billboard",
null,
"setBool",
false
],
[
"enable_billboards",
null,
"setBool",
false
],
[
"enable_audio_ads_player",
null,
"setBool",
false
],
[
"enable_display_ads_player",
null,
"setBool",
false
],
[
"enable_video_ads_player",
null,
"setBool",
false
],
[
"enable_audio_ads_player_v2",
null,
"setBool",
false
],
[
"enable_display_ads_player_v2",
null,
"setBool",
false
],
[
"enable_video_ads_player_v2",
null,
"setBool",
false
],
[
"enable_sponsored_search_results_v2",
null,
"setBool",
false
],
[
"enable_sponsored_home_results_v2",
null,
"setBool",
false
],
[
"should_nova_scroll_use_scrollsita",
null,
"remove",
""
],
[
"enable_lyrics_share",
"ios-feature-lyrics",
"forceBool",
true
],
[
"lyrics_share_enabled",
"ios-feature-lyrics",
"forceBool",
true
],
[
"enable_lyrics_sharing",
"ios-feature-lyrics",
"forceBool",
true
],
[
"is_lyrics_share_enabled",
"ios-feature-lyrics",
"forceBool",
true
],
[
"lyrics_shareable",
"ios-feature-lyrics",
"forceBool",
true
],
[
"enable_share_link_preview_uploads",
"ios-feature-lyrics",
"forceBool",
true
],
[
"enable_sharing_v2",
"ios-feature-lyrics",
"forceBool",
true
],
[
"enable_lyrics_share",
null,
"forceBool",
true
],
[
"lyrics_share_enabled",
null,
"forceBool",
true
],
[
"enable_lyrics_sharing",
null,
"forceBool",
true
],
[
"is_lyrics_share_enabled",
null,
"forceBool",
true
],
[
"lyrics_shareable",
null,
"forceBool",
true
],
[
"enable_share_link_preview_uploads",
null,
"forceBool",
true
],
[
"enable_sharing_v2",
null,
"forceBool",
true
],
// --- 2 key madprops: bổ sung tay 2026-11-18 (app2smile) ---
[
"com.spotify.madprops.use.ucs.product.state",
null,
"setBool",
true
],
[
"com.spotify.madprops.delivered.by.ucs",
null,
"setBool",
true
],
];
var SERVER_AUTHORITATIVE_ATTRIBUTES = ["offline", "can-use-offline", "has-offline-state", "max-offline-downloads-per-device", "max-offline-tracks", "offline-backup", "lyrics-offline", "very-high-bitrate", "audio-quality", "social-session", "social-session-free-tier", "jam-social-session"];
// END GENERATED RULES

/* Engine chạy sau khi dữ liệu đã có. */
try {
    spotifyUcsMain();
} catch (e) {
    console.log("[spotify-ucs] fatal: " + e + " | " + (e && e.stack));
    $done({});
}
