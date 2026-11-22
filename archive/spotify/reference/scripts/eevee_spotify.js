/*
 * Eevee Spotify - Shadowrocket demo script (HTTP response hook)
 *
 * Nguồn dữ liệu/tham chiếu (raw):
 * - Repo: EeveeSpotifyReborn (đã clone tại ../EeveeSpotifyReborn)
 *   - Bootstrap hook: Sources/EeveeSpotify/Premium/DynamicPremium+ModifyBootstrap.x.swift
 *     (URL path chứa "v1/bootstrap", sửa BootstrapMessage/UCSResponse accountAttributes)
 *   - URL check: Sources/EeveeSpotify/Shared/Models/Extensions/URL+Extension.swift (isBootstrap -> path contains "v1/bootstrap")
 *   - Endpoint: https://spclient.wg.spotify.com/pam-view-service/v1/GetPremiumPlanRow
 *     (Sources/EeveeSpotify/Premium/Models/Protobuf/PremiumPlanRow.pb.swift)
 * - Domain raw: ../eevee-doh-demo/spotify-dns-raw-data.txt
 *
 * LƯU Ý: EeveeSpotify gốc là tweak vá trong app và thao tác protobuf (Bootstrap/AccountAttributes).
 * Script này chỉ là KHUNG DEMO cho Shadowrocket: response thường là protobuf nhị phân,
 * nên để "trả kết quả như EeveeSpotify" thực sự cần decode/patch/encode protobuf đúng schema
 * (hoặc dùng gateway/proxy có logic tương ứng). Ở đây chỉ log và passthrough.
 */

const arg = (typeof $argument !== 'undefined' && $argument) ? String($argument) : 'unknown';

function done(body) {
  // $done({ body }) cho http-response; giữ nguyên nếu không sửa
  if (typeof body === 'undefined') $done({});
  else $done({ body });
}

try {
  const url = ($request && $request.url) ? $request.url : '';
  const status = ($response && $response.status) ? $response.status : '';
  console.log(`[eevee-demo] hook=${arg} status=${status} url=${url}`);

  // Body có thể là binary/protobuf khi binary-body-mode=1.
  // TODO: decode protobuf theo schema (BootstrapMessage / UcsResponse / PremiumPlanRow...)
  // rồi chỉnh accountAttributes/product/plan tương tự logic EeveeSpotify, sau đó encode lại.
  // Hiện tại: passthrough nguyên vẹn.
  if ($response && typeof $response.body !== 'undefined') {
    done($response.body);
  } else {
    done();
  }
} catch (e) {
  console.log(`[eevee-demo] error: ${e}`);
  if ($response && typeof $response.body !== 'undefined') done($response.body);
  else done();
}
