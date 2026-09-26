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
  image: ["ThumbnailPath", "drawing", "ImagePath", "bigDrawing"],
  bigImage: ["ImagePath", "bigDrawing", "ThumbnailPath", "drawing"],
  agent: ["AgentName", "agentName"],
  registrant: ["RegistrationRightholderName", "regPrivilegeName"],
  publicNumber: ["PublicNumber", "publicationNumber"],
  publicDate: ["PublicDate", "publicationDate"],
  regPublicNumber: ["RegistrationPublicNumber", "registrationPublicNumber"],
  regPublicDate: ["RegistrationPublicDate", "registrationPublicDate"],
  priorityNumber: ["PriorityClaimNumber", "priorityNumber"],
  priorityDate: ["PriorityClaimDate", "priorityDate"],
  vienna: ["ViennaCode", "viennaCode"],
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

    // KIPRIS 무료 한도(월 1,000건)를 넘지 않도록 실제 호출 횟수를 월별로 센다 (KST 기준)
    const limit = Number(env.MONTHLY_LIMIT) || 950;
    const month = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 7);
    const usageKey = `count:${month}`;
    const readUsed = async () => (env.USAGE ? Number(await env.USAGE.get(usageKey)) || 0 : 0);

    if (url.pathname === "/usage") {
      const used = await readUsed();
      return json({ month, used, limit, remaining: Math.max(limit - used, 0), blocked: used >= limit });
    }

    const name =(url.searchParams.get("name") || "").trim();
    const page = Math.min(Math.max(parseInt(url.searchParams.get("page")) || 1, 1), 50);
    const exact = url.searchParams.get("exact") === "1"; // 상표명 완전일치 검색
    if (!name || name.length > 50) return json({ error: "상표명을 1~50자로 입력하세요." }, 400);

    const cache = caches.default;
    const cacheKey = new Request(`https://cache.local/tm4?name=${encodeURIComponent(name)}&page=${page}&exact=${exact ? 1 : 0}`);
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, { headers: hit.headers });

    const used = await readUsed();
    if (used >= limit) {
      return json({ error: "이번 달 조회 한도에 도달했습니다. 다음 달 1일에 다시 이용할 수 있습니다.", limitReached: true }, 429);
    }
    // 성공·실패와 관계없이 KIPRIS를 부르는 순간 1건으로 센다 (보수적으로)
    if (env.USAGE) await env.USAGE.put(usageKey, String(used + 1), { expirationTtl: 60 * 60 * 24 * 40 });

    const up = new URL((env.KIPRIS_URL || DEFAULT_URL).replace("trademarkNameSearchInfo", exact ? "trademarkNameMatchSearchInfo" : "trademarkNameSearchInfo"));
    up.searchParams.set(exact ? "trademarkNameMatch" : "trademarkName", name);
    // 살아 있는 상표만: 출원·공고·등록. 거절·소멸·취하·포기·무효는 제외
    for (const s of ["application", "publication", "registration"]) up.searchParams.set(s, "true");
    for (const s of ["refused", "expiration", "withdrawal", "abandonment", "cancel"]) up.searchParams.set(s, "false");
    up.searchParams.set("docsStart", String((page - 1) * 20 + 1)); // 페이지 번호가 아닌 시작 항목 번호
    up.searchParams.set("docsCount", "20");
    up.searchParams.set("accessKey", env.KIPRIS_KEY);

    let res;
    try {
      res = await fetch(up.toString(), { signal: AbortSignal.timeout(12000) });
    } catch (e) {
      const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
      return json({ error: timedOut ? "KIPRIS 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요." : "KIPRIS 연결 실패" }, timedOut ? 504 : 502);
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
