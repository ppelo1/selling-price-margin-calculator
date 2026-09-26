// Cloudflare Worker: KIPRIS Plus 상표 검색 프록시 (인증키 은닉 + XML→JSON + CORS + 캐시)
// 환경변수(Secrets/Vars): KIPRIS_KEY (필수), KIPRIS_URL (선택), ALLOWED_ORIGIN (선택)

const DEFAULT_URL =
  "http://plus.kipris.or.kr/openapi/rest/trademarkInfoSearchService/trademarkNameSearchInfo";

// 응답 필드명이 서비스 버전마다 다를 수 있어 후보를 넓게 잡는다.
const FIELD_MAP = {
  title: ["Title", "title", "trademarkName", "tradeMarkName"],
  applicant: ["ApplicantName", "applicantName", "applicant"],
  applicationNumber: ["ApplicationNumber", "applicationNumber"],
  applicationDate: ["ApplicationDate", "applicationDate"],
  registrationNumber: ["RegistrationNumber", "registrationNumber", "registerNumber"],
  registrationDate: ["RegistrationDate", "registrationDate", "registerDate"],
  status: ["ApplicationStatus", "applicationStatus", "registerStatus", "status"],
  classification: ["GoodClassificationCode", "classificationCode", "classification", "goodClassificationCode"],
  image: ["ThumbnailPath", "ImagePath", "drawing", "bigDrawing"],
};

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseXml(xml) {
  const tag = (name) => {
    const m = xml.match(new RegExp(`<${name}>([^]*?)</${name}>`));
    return m ? decode(m[1]) : "";
  };
  const items = [];
  const re = /<(item|TradeMarkInfo|trademarkInfo)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(xml))) {
    const fields = {};
    const fre = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let f;
    while ((f = fre.exec(m[2]))) fields[f[1]] = decode(f[2]);
    const row = {};
    for (const [k, cands] of Object.entries(FIELD_MAP)) {
      row[k] = "";
      for (const c of cands) if (fields[c]) { row[k] = fields[c]; break; }
    }
    items.push(row);
  }
  return {
    resultCode: tag("resultCode") || tag("successYN"),
    resultMsg: tag("resultMsg"),
    totalCount: Number(tag("TotalSearchCount") || tag("totalCount")) || items.length,
    items,
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = env.ALLOWED_ORIGIN || "https://tools.cafeodi.store";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Vary": "Origin",
    };
    const json = (obj, status = 200, extra = {}) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json; charset=utf-8", ...cors, ...extra },
      });

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
    if (!env.KIPRIS_KEY) return json({ error: "server not configured" }, 500);

    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "").trim();
    const page = Math.min(Math.max(parseInt(url.searchParams.get("page")) || 1, 1), 50);
    if (!name || name.length > 50) return json({ error: "상표명을 1~50자로 입력하세요." }, 400);

    const cache = caches.default;
    const cacheKey = new Request(`https://cache.local/tm?name=${encodeURIComponent(name)}&page=${page}`);
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { headers: hit.headers });

    const up = new URL(env.KIPRIS_URL || DEFAULT_URL);
    up.searchParams.set("trademarkName", name);
    for (const s of ["application", "publication", "registration", "refused", "expiration", "withdrawal", "abandonment", "cancel"])
      up.searchParams.set(s, "true");
    up.searchParams.set("docsStart", String((page - 1) * 20 + 1)); // 페이지 번호가 아닌 시작 항목 번호
    up.searchParams.set("docsCount", "20");
    up.searchParams.set("accessKey", env.KIPRIS_KEY);

    let res;
    try {
      res = await fetch(up.toString());
    } catch (e) {
      return json({ error: "KIPRIS 연결 실패" }, 502);
    }
    if (!res.ok) return json({ error: `KIPRIS 응답 오류 (${res.status})` }, 502);

    const data = parseXml(await res.text());
    if (data.resultCode && data.resultCode !== "00" && data.resultCode !== "Y") {
      return json({ error: `KIPRIS 오류: ${data.resultMsg || data.resultCode}` }, 502);
    }
    const out = json({ name, page, ...data }, 200, { "Cache-Control": "public, max-age=3600" });
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  },
};
