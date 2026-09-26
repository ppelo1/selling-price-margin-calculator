# KIPRIS 상표 검색 프록시 (Cloudflare Worker)

1. KIPRIS Plus(plus.kipris.or.kr)에서 상표 검색 API 인증키 발급
2. `cd trademark-worker && npx wrangler login`
3. `npx wrangler secret put KIPRIS_KEY` (발급받은 키 입력)
4. `npx wrangler deploy` → 출력된 `https://....workers.dev` 주소를 `trademark/index.html`의 `API_BASE`에 입력
5. 응답 필드/엔드포인트가 다르면 `KIPRIS_URL` 변수와 `worker.js`의 `FIELD_MAP`을 조정

테스트: `https://<worker>/?name=카페`
