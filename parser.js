/* ============================================================================
   STK 영수증 파서 — OCR 줄(text · conf · bbox)을 받아 영수증 항목으로 나눈다.
   브라우저(index.html)와 Node(테스트)에서 같은 코드를 쓴다.

   원칙
   · 라벨이 깨져도 값의 모양(날짜 · 사업자번호 · 마스킹된 카드번호 · 금액)으로 찾는다.
     실제 OCR 에서 「판매일」 이 HOW, 「영수증번호」 가 SSH 로 읽히는 식의 깨짐이 흔하다.
   · 각 항목에 어디서 왔는지(line) · 어떻게 찾았는지(how: label | pattern | derived)를 남긴다 —
     리뷰 화면이 원본 위치를 짚고, 「확인 필요」 를 표시하는 근거가 된다.
   · 계산으로 채운 값(derived)은 반드시 「추정」 으로 표시해 사람이 확인하게 한다.
   ========================================================================== */
(function (root) {
  "use strict";

  // ── 필드 정의 — 리뷰 화면의 순서 · 묶음 · 이름 ─────────────────────────────
  const FIELD_GROUPS = [
    { id: "store", ko: "가맹점 정보", en: "Merchant", fields: [
      ["storeName", "상호(가맹점명)", "Merchant name"],
      ["bizNo", "사업자등록번호", "Business reg. no."],
      ["ceo", "대표자", "Representative"],
      ["address", "주소", "Address"],
      ["phone", "전화번호", "Phone"],
    ]},
    { id: "txn", ko: "거래 정보", en: "Transaction", fields: [
      ["txnDate", "거래일시", "Transaction date/time"],
      ["receiptNo", "영수증 · 거래번호", "Receipt / txn no."],
      ["pos", "POS · 계산원", "POS / cashier"],
    ]},
    { id: "amount", ko: "금액", en: "Amounts", fields: [
      ["supply", "공급가액(과세물품가액)", "Supply amount (taxable)"],
      ["vat", "부가세", "VAT"],
      ["taxFree", "면세물품가액", "Tax-free amount"],
      ["serviceFee", "봉사료", "Service charge"],
      ["discount", "할인금액", "Discount"],
      ["total", "합계(결제 총액)", "Total"],
      ["received", "받은금액", "Amount received"],
      ["change", "거스름돈", "Change"],
    ]},
    { id: "pay", ko: "결제 정보", en: "Payment", fields: [
      ["payMethod", "결제수단", "Payment method"],
      ["cardIssuer", "카드사(발급사)", "Card issuer"],
      ["cardType", "카드 종류(신용 · 체크)", "Card type"],
      ["cardNo", "카드번호", "Card number"],
      ["installment", "할부개월", "Installments"],
      ["approvalNo", "승인번호", "Approval no."],
      ["approvalDate", "승인일시", "Approval date/time"],
      ["approvalAmount", "승인금액", "Approved amount"],
      ["merchantNo", "가맹점번호", "Merchant no."],
      ["acquirer", "매입사", "Acquirer"],
    ]},
    { id: "cash", ko: "현금 · 계좌", en: "Cash / Transfer", fields: [
      ["cashReceiptNo", "현금영수증 승인번호", "Cash receipt approval no."],
      ["cashReceiptId", "현금영수증 식별번호", "Cash receipt ID"],
      ["bank", "은행", "Bank"],
      ["accountNo", "계좌번호", "Account no."],
      ["accountHolder", "예금주", "Account holder"],
    ]},
  ];
  const MONEY_FIELDS = ["supply", "vat", "taxFree", "serviceFee", "discount", "total", "received", "change", "approvalAmount"];

  // ── 공통 도우미 ─────────────────────────────────────────────────────────────
  // 전각 → 반각, 흔한 OCR 혼동 정리(숫자 문맥의 O/o → 0, l/I → 1 은 숫자 사이에서만)
  function norm(s) {
    let t = String(s || "")
      .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
      .replace(/\u3000/g, " ")
      .replace(/[：﹕]/g, ":")
      .replace(/(?<=\d)[Oo](?=\d)/g, "0")
      .replace(/(?<=\d)[lI|](?=\d)/g, "1")
      .replace(/[ \t]+/g, " ")
      .replace(/※|\u203B/g, "*")
      // 「10, 100」 「35. 000」 — 천 단위 구분 뒤에 끼어든 공백
      .replace(/(\d{1,3})[,.]\s(\d{3})(?!\d)/g, "$1,$2")
      .trim();
    // Tesseract 는 한글 음절마다 띄어 읽는 일이 잦다(「메 가 커 피 오 리 역 점」). 한 글자 한글이 셋 이상 이어지면 붙인다.
    t = t.replace(/(?:^|(?<= ))(?:[가-힣] ){2,}[가-힣](?= |$)/g, (m) => m.replace(/ /g, ""));
    for (const [re, to] of LABEL_FIX) t = t.replace(re, to);
    return t;
  }
  const squash = (s) => s.replace(/\s+/g, "");
  // 감열지 한글 라벨의 흔한 오인식(실제 영수증 8장에서 확인) — 「승인」 → 슴인 · 「번호」 → 번오/번요/번모 ·
  // 「금액」 → 금맥/글액 · 「합계」 → 합게 · 「가액」 → 가맥 · 「물품」 → 불품/룰품 · 「발행」 → 발앵
  const LABEL_FIX = [
    [/[승슴스]\s?[인이]\s?(?=번|일|금|내|정)/g, "승인"], [/번\s?[호오요모]\b|번\s?[호오요모](?=\s|:|\]|$)/g, "번호"],
    [/금\s?[액맥]|글\s?액/g, "금액"], [/합\s?[게계](?!좌)/g, "합계"], [/가\s?맥/g, "가액"], [/[불룰]\s?품/g, "물품"], [/발\s?앵/g, "발행"],
  ];               // 라벨 비교용(「부 가 세」 → 「부가세」)
  // 금액 — 「21,400」 「21.400」(쉼표가 점으로 읽힘) 「21400원」 「₩21,400」 「-1,000」
  const MONEY_RE = /-?\s?[₩\\]?\s?\d{1,3}(?:[,.]\d{3})+(?!\d)|-?\s?[₩\\]?\s?\d{1,9}(?=\s*원?\s*$|\s*원)/g;
  function toMoney(tok) {
    if (tok == null) return null;
    const neg = /-/.test(tok);
    const digits = String(tok).replace(/[^\d]/g, "");
    if (!digits) return null;
    const n = Number(digits);
    return neg ? -n : n;
  }
  function lastMoney(text) {
    const m = String(text).match(MONEY_RE);
    return m ? toMoney(m[m.length - 1]) : null;
  }
  const fmtMoney = (n) => (n == null || isNaN(n) ? "" : Number(n).toLocaleString("ko-KR"));
  // 날짜 · 시각 — 2026-09-22 14:35:12 · 2026.09.22 · 26/09/22 · 2026년 9월 22일
  const DATE_RE = /(20\d{2}|\b\d{2})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?(?:\s*\([^)]{1,3}\)|\s*[월화수목금토일])?(?:\s*(오전|오후|AM|PM)?\s*(\d{1,2})\s*[:시]\s*(\d{2})(?:\s*[:분]\s*(\d{2}))?)?/i;
  function parseDate(text) {
    // 「20260910 12:06:33」 처럼 붙은 날짜
    text = String(text).replace(/\b(20\d{2})(\d{2})(\d{2})(?=\s+\d{1,2}:\d{2})/, "$1-$2-$3");
    const m = String(text).match(DATE_RE);
    if (!m) return null;
    let y = Number(m[1]); if (y < 100) y += 2000;
    const mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2099) return null;
    const p = (n) => String(n).padStart(2, "0");
    let v = `${y}-${p(mo)}-${p(d)}`;
    let hh = m[5] != null ? Number(m[5]) : null;
    if (hh != null && /오후|PM/i.test(m[4] || "") && hh < 12) hh += 12;
    if (hh != null && /오전|AM/i.test(m[4] || "") && hh === 12) hh = 0;
    if (hh != null && hh < 24 && Number(m[6]) < 60) v += ` ${p(hh)}:${m[6]}${m[7] != null ? ":" + m[7] : ""}`;
    return v;
  }
  const afterColon = (t) => { const i = t.indexOf(":"); return i >= 0 ? t.slice(i + 1).trim() : ""; };
  // 카드번호 — 숫자 · * 만 남겨 16자리면 4-4-4-4, 15자리(아멕스)면 4-6-5
  function groupCard(v) {
    const d = String(v).replace(/[xX]/g, "*").replace(/[^\d*]/g, "");
    if (d.length === 16) return d.match(/.{4}/g).join("-");
    if (d.length === 15) return `${d.slice(0, 4)}-${d.slice(4, 10)}-${d.slice(10)}`;
    return String(v).replace(/\s/g, "-").replace(/[xX]/g, "*");
  }
  // 글자 값 — 앞뒤 따옴표 · 쉼표 · 짝 없는 괄호 떼기(「(6525 역삼점」 「비씨카드 '」)
  function cleanText(v) {
    let s = String(v).trim().replace(/^["'`,.;:\s]+|["'`,.;:\s]+$/g, "");
    if (s.startsWith("(") && !s.includes(")")) s = s.slice(1).trim();
    if (s.endsWith(")") && !s.includes("(")) s = s.slice(0, -1).trim();
    return s;
  }

  const CARD_ISSUERS = ["신한", "삼성", "현대", "KB국민", "국민", "롯데", "하나", "우리", "BC", "비씨", "NH농협", "농협", "씨티", "카카오뱅크", "카카오", "토스", "IBK기업", "기업", "수협", "광주", "전북", "제주", "경남", "부산", "대구", "SC제일", "케이뱅크"];
  const BANKS = ["국민은행", "신한은행", "우리은행", "하나은행", "농협", "NH농협", "기업은행", "IBK", "SC제일", "제일은행", "씨티은행", "카카오뱅크", "토스뱅크", "케이뱅크", "수협", "우체국", "새마을금고", "신협", "대구은행", "부산은행", "경남은행", "광주은행", "전북은행", "제주은행", "산업은행"];

  // ── 라벨 사전 — 줄 안에서 찾을 라벨(공백 무시) ─────────────────────────────
  const LABELS = {
    storeName: ["상호", "가맹점명", "매장명", "점포명", "업체명", "상점명"],
    bizNo: ["사업자등록번호", "사업자번호", "사업자No", "등록번호", "사업자"],
    ceo: ["대표자", "대표"],
    address: ["주소", "소재지"],
    phone: ["전화번호", "전화", "TEL", "Tel", "tel", "☎", "연락처"],
    txnDate: ["판매일시", "판매일", "거래일시", "거래일자", "거래일", "매출일", "일시", "일자", "날짜", "주문일시"],
    receiptNo: ["영수증번호", "거래번호", "전표번호", "주문번호", "No.", "NO."],
    pos: ["POS", "포스", "계산원", "캐셔", "담당"],
    supply: ["과세물품가액", "과세물품", "공급가액", "과세금액", "공급가", "과세"],
    vat: ["부가세", "부가가치세", "세액", "VAT"],
    taxFree: ["면세물품가액", "면세물품", "면세"],
    serviceFee: ["봉사료"],
    discount: ["할인금액", "할인액", "할인", "에누리"],
    total: ["합계금액", "총합계", "총결제금액", "결제금액", "받을금액", "판매금액", "이체금액", "입금금액", "입금액", "송금액", "총금액", "총액", "합계", "TOTAL", "Total", "합 계"],
    received: ["받은금액", "받은돈", "현금받음", "현금"],
    change: ["거스름돈", "거스름", "잔돈", "잔액"],
    cardIssuer: ["카드종류", "카드사명", "카드사", "발급사", "카드명"],
    cardNo: ["카드번호", "카드No"],
    installment: ["할부개월", "할부"],
    approvalNo: ["승인번호", "승인No"],
    approvalDate: ["승인일시", "승인일자", "승인일"],
    approvalAmount: ["승인금액", "승인액"],
    merchantNo: ["가맹점번호", "가맹번호", "가맹점No"],
    acquirer: ["매입사", "매입카드사"],
    cashReceiptNo: ["현금영수증승인번호", "현금승인번호"],
    cashReceiptId: ["식별번호", "현금영수증번호", "휴대폰번호"],
    accountNo: ["계좌번호", "입금계좌", "계좌"],
    accountHolder: ["예금주"],
    bank: ["은행명", "입금은행", "은행"],
  };
  const TOTALS_WORDS = ["과세", "부가세", "합계", "면세", "공급가", "결제", "받을", "총액", "봉사료", "할인", "카드", "승인", "현금", "거스름"];

  function findLabel(sq, key) {
    for (const lb of LABELS[key]) {
      const i = sq.indexOf(squash(lb));
      if (i >= 0) return { i, lb: squash(lb) };
    }
    return null;
  }

  // ── 품목 줄 ─────────────────────────────────────────────────────────────────
  // 「상품명 단가 수량 금액」 뒤 이름 + 숫자 1~3개. 숫자 3개면 단가 · 수량 · 금액(단가×수량≈금액으로 확인).
  function parseItemLine(text) {
    const t = norm(text).replace(/\s[_|]+(?=\s|\d)|_(?=\d)/g, " ").replace(/\s+/g, " ");
    const m = t.match(/^(.*?[^\d\s,.\-_][^\d]*?)\s*((?:\s*-?\d[\d,.]*)+)\s*$/);
    if (!m) return null;
    const name = m[1].replace(/[_*·•\-]+$/, "").trim();
    if (!name || name.length < 1) return null;
    const nums = m[2].trim().split(/\s+/).map((x) => x.replace(/[_]/g, "")).filter(Boolean);
    const val = nums.map((x) => (/[,.]\d{3}(?!\d)/.test(x) ? toMoney(x) : Number(x.replace(/[^\d-]/g, ""))));
    if (val.some((v) => isNaN(v))) return null;
    let unitPrice = null, qty = null, amount = null;
    if (val.length >= 3) {
      [unitPrice, qty, amount] = val.slice(-3);
      if (unitPrice * qty !== amount && val.length === 3 && qty * amount === unitPrice) [unitPrice, qty, amount] = [amount, qty, unitPrice];
    } else if (val.length === 2) {
      // 「수량 금액」 또는 「단가 금액」 — 작은 수가 수량이면 수량으로
      if (val[0] > 0 && val[0] < 1000 && val[1] >= val[0]) { qty = val[0]; amount = val[1]; unitPrice = qty ? Math.round(amount / qty) : null; }
      else { unitPrice = val[0]; amount = val[1]; qty = unitPrice ? Math.round(amount / unitPrice) : null; }
    } else { amount = val[0]; qty = 1; unitPrice = amount; }
    if (amount == null || Math.abs(amount) < 10) return null;          // 번호 · 코드 줄 거르기
    return { name, unitPrice, qty, amount };
  }

  // ── 본체 ────────────────────────────────────────────────────────────────────
  function parseReceipt(input) {
    const lines = (Array.isArray(input) ? input : String(input || "").split(/\r?\n/).map((t) => ({ text: t, conf: 90 })))
      .map((l, i) => ({ ...l, i, t: norm(l.text), sq: squash(norm(l.text)) }))
      .filter((l) => l.t.length > 0);
    const F = {};
    const set = (key, value, line, how, conf) => {
      if (value == null || value === "") return;
      if (typeof value === "string" && !MONEY_FIELDS.includes(key)) value = cleanText(value);
      if (value === "") return;
      if (F[key] && F[key].how === "label" && how !== "label") return;   // 라벨로 찾은 값이 우선
      F[key] = { value, line: line == null ? null : line.i, how, conf: conf ?? (line ? line.conf : null) };
    };

    // 1) 라벨이 있는 줄 — 「라벨: 값」 또는 「라벨 … 값」
    for (const l of lines) {
      for (const key of Object.keys(LABELS)) {
        const hit = findLabel(l.sq, key);
        if (!hit) continue;
        // 짧은 라벨의 오탐 막기 — 「현금영수증」 안의 「현금」, 「카드승인내역」 안의 「카드」 등
        if (key === "received" && /현금영수증|현금승인/.test(l.sq)) continue;
        if (key === "supply" && /면세/.test(l.sq)) continue;
        if (key === "total" && /승인|카드/.test(l.sq)) continue;
        if (key === "bizNo" && hit.lb === "등록번호" && !/\d{3}-?\d{2}-?\d{5}/.test(l.t)) continue;
        if (key === "ceo" && !/대표자?\s*[:：]?\s*[가-힣A-Za-z]/.test(l.t)) continue;
        if (key === "txnDate" && /승인/.test(l.sq)) continue;
        if ((key === "approvalNo" || key === "approvalDate" || key === "approvalAmount") && /현금/.test(l.sq)) continue;   // 현금영수증 승인 ≠ 카드 승인
        if (key === "receiptNo" && /승인|가맹|카드/.test(l.sq)) continue;
        if (key === "accountNo" && !/\d{2,6}-\d{2,6}-\d{2,8}|\d{10,14}/.test(l.t)) continue;
        const rest = afterColon(l.t) || l.t.slice(l.t.search(new RegExp(hit.lb.split("").join("\\s*"))) + hit.lb.length).replace(/^[\s:]+/, "");
        if (MONEY_FIELDS.includes(key)) { const v = lastMoney(l.t); if (v != null) set(key, fmtMoney(v), l, "label"); continue; }
        switch (key) {
          case "bizNo": { const m = l.t.match(/(\d{3})\s*-?\s*(\d{2})\s*-?\s*(\d{5})/); if (m) set(key, `${m[1]}-${m[2]}-${m[3]}`, l, "label"); break; }
          case "ceo": { const m = l.t.match(/대표자?\s*:?\s*([가-힣A-Za-z]{2,10})/); if (m) set(key, m[1], l, "label"); break; }
          case "phone": { const m = l.t.match(/(0\d{1,2})\s*[-)\s.]\s*(\d{3,4})\s*[-\s.]\s*(\d{4})/); if (m) set(key, `${m[1]}-${m[2]}-${m[3]}`, l, "label"); break; }
          case "txnDate": case "approvalDate": { const d = parseDate(l.t); if (d) set(key, d, l, "label"); break; }
          case "cardNo": { const m = l.t.match(/[\d*xX]{4}[-\s]?[\d*xX]{2,4}[-\s]?[\d*xX]{2,4}[-\s]?[\d*xX]{2,4}/); if (m) set(key, groupCard(m[0]), l, "label"); break; }
          case "installment": { if (/일시불|일시|00\s*개월|^0$/.test(rest) || /일시불/.test(l.t)) set(key, "일시불", l, "label"); else { const m = l.t.match(/(\d{1,2})\s*개?월?/g); const n = m ? Number(String(m[m.length - 1]).replace(/\D/g, "")) : null; if (n != null) set(key, n === 0 ? "일시불" : `${n}개월`, l, "label"); } break; }
          case "approvalNo": case "merchantNo": case "cashReceiptNo": {
            const after = l.t.slice(l.t.search(new RegExp(hit.lb.split("").join("\\s*"))) + 1).replace(/\((?=\d{7}\b)/, "0");
            const m = after.match(/(?<![\d,])(\d[\d-]{5,14}\d)(?![\d,])/);
            if (m) set(key, m[1].replace(/-/g, ""), l, "label"); break; }
          case "receiptNo": { const m = rest.match(/[A-Za-z0-9][\w\-/]{3,}/); if (m) set(key, m[0], l, "label"); break; }
          case "pos": { const m = l.t.match(/(?:POS|포스)\s*:?\s*([\w-]+)/i); const c = l.t.match(/(?:계산원|캐셔|담당)\s*:?\s*([가-힣\w]+)/); if (m || c) set(key, [m && m[1], c && c[1]].filter(Boolean).join(" · "), l, "label"); break; }
          case "cardIssuer": { if (rest) set(key, rest.replace(/\((신용|체크|기프트|선불|직불)\)/, "").trim() || rest, l, "label"); const ty = l.t.match(/신용|체크|기프트|선불|직불/); if (ty) set("cardType", ty[0], l, "label"); break; }
          case "accountNo": { const m = l.t.match(/(\d{2,6}-\d{2,6}-\d{2,8}(?:-\d{1,4})?|\d{10,14})/); if (m) set(key, m[1], l, "label"); const b = BANKS.find((x) => l.t.includes(x)); if (b) set("bank", b, l, "label"); break; }
          case "cashReceiptId": { const m = l.t.match(/[\d*]{3}[-\s]?[\d*]{3,4}[-\s]?[\d*]{4}|[\d*]{6,}/); if (m) set(key, m[0], l, "label"); break; }
          default: if (rest) set(key, rest, l, "label");
        }
      }
    }

    // 1-2) 라벨이 한 줄, 값이 다음 줄에 칸 맞춰 있는 표
    const HEAD = [["supply", /과세물품|공급가/], ["vat", /부가세|세액/], ["taxFree", /면세/], ["total", /합계|총액|결제금액/], ["discount", /할인/]];
    for (let k = 0; k + 1 < lines.length; k++) {
      const l = lines[k], nx = lines[k + 1];
      if (/\d{2,}/.test(l.t)) continue;
      const hits = [];
      for (const w of l.t.split(/\s+/).filter(Boolean)) { const h = HEAD.find(([, re]) => re.test(w.replace(/\s/g, ""))); if (h) hits.push(h[0]); }
      if (hits.length < 2) continue;
      const vals = (nx.t.match(MONEY_RE) || []).map(toMoney);
      if (vals.length !== hits.length) continue;
      hits.forEach((key, j) => { if (!F[key]) set(key, fmtMoney(vals[j]), nx, "label"); });
    }

    // 2) 값 모양으로 찾기 — 라벨이 깨졌을 때
    for (const l of lines) {
      if (!F.bizNo) { const m = l.t.match(/\b(\d{3})\s?-\s?(\d{2})\s?-\s?(\d{5})\b/); if (m) set("bizNo", `${m[1]}-${m[2]}-${m[3]}`, l, "pattern"); }
      // 하이픈 없는 10자리 — 검증번호가 맞을 때만(전화 · 승인번호 오인 방지)
      if (!F.bizNo) { for (const m of l.t.matchAll(/(?<![\d-])(\d{10})(?![\d-])/g)) { if (bizNoValid(m[1])) { set("bizNo", `${m[1].slice(0, 3)}-${m[1].slice(3, 5)}-${m[1].slice(5)}`, l, "pattern"); break; } } }
      // 라벨 없는 승인번호 — 「[07404100] KICC로 제출」 처럼 8자리 숫자 옆에 VAN 이름
      if (!F.approvalNo) { const m = l.t.match(/\[?\b(\d{8})\b\]?\s*.*\b(KICC|KIS|NICE|KSNET|KOVAN|SMARTRO|JTNET|FDIK|KCP|DAOU|SPC|KFTC)\b/i) || l.t.match(/\b(KICC|KIS|NICE|KSNET|KOVAN|SMARTRO|JTNET|FDIK|KCP|DAOU|SPC|KFTC)\b.*?\b(\d{8})\b/i);
        if (m) set("approvalNo", /^\d{8}$/.test(m[1]) ? m[1] : m[2], l, "pattern"); }
      if (!F.approvalNo) { const m = l.t.match(/^\s*\[\s*(\d{8})\s*\]/); if (m && !/\d{4}[-./]\d{2}/.test(l.t)) set("approvalNo", m[1], l, "pattern"); }
      if (!F.phone) { const m = l.t.match(/\b(0\d{1,2})-(\d{3,4})-(\d{4})\b/); if (m && !/카드|계좌/.test(l.t)) set("phone", `${m[1]}-${m[2]}-${m[3]}`, l, "pattern"); }
      if (!F.cardNo) { const m = l.t.match(/\b\d{4}[-\s]?[\d*]{2,4}\*[\d*]*[-\s]?[\d*]{4}[-\s]?[\d*]{3,4}\b/); if (m) set("cardNo", groupCard(m[0]), l, "pattern"); }
      if (!F.address && /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)[가-힣]*\s/.test(l.t) && /(구|군|시)\s/.test(l.t) && /(로|길|동|읍|면)\s*\d|(로|길)\b/.test(l.t)) set("address", l.t.replace(/^주소\s*:?\s*/, ""), l, "pattern");
      if (!F.cardIssuer) { const iss = CARD_ISSUERS.find((x) => new RegExp(x + "\\s*카드").test(l.t)); if (iss) set("cardIssuer", iss + "카드", l, "pattern"); }
      if (!F.cardType) { const ty = l.t.match(/\((신용|체크)\)|(신용|체크)\s*카드/); if (ty) set("cardType", ty[1] || ty[2], l, "pattern"); }
    }
    // 날짜 — 라벨이 없으면 승인과 무관한 첫 날짜가 거래일시
    // 날짜만 있는 줄 다음 줄이 시각으로 시작하면 이어 붙인다(「판매시간: 2026-08-26」 / 「11:38:23」)
    const dateLines = lines.map((l, k) => {
      let d = parseDate(l.t);
      if (d && d.length === 10) { const nx = lines[k + 1]; const tm = nx && nx.t.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/); if (tm && !parseDate(nx.t)) d += ` ${tm[1].padStart(2, "0")}:${tm[2]}${tm[3] ? ":" + tm[3] : ""}`; }
      return { l, d };
    }).filter((x) => x.d);
    const withTime = dateLines.filter((x) => x.d.length > 10);
    if (F.txnDate && F.txnDate.value.length === 10) { const x = withTime.find((x) => x.d.startsWith(F.txnDate.value)); if (x) F.txnDate = { ...F.txnDate, value: x.d }; }
    if (!F.txnDate) { const x = withTime.find((x) => !/승인/.test(x.l.sq)) || dateLines.find((x) => !/승인/.test(x.l.sq)) || dateLines[0]; if (x) set("txnDate", x.d, x.l, "pattern"); }
    if (!F.approvalDate && (F.approvalNo || F.cardNo)) { const x = dateLines.find((x) => /승인/.test(x.l.sq)) || dateLines[dateLines.length - 1]; if (x && x.l.i !== (F.txnDate && F.txnDate.line)) set("approvalDate", x.d, x.l, "pattern"); }
    if (F.txnDate) {
      const dd = F.txnDate.value.slice(5, 10).replace("-", "");
      for (const l of lines) { const m = l.t.match(/\b(20\d{2})(\d{4})(?=[-_\d])/); if (m && m[2] === dd && m[1] !== F.txnDate.value.slice(0, 4)) { F.txnDate = { ...F.txnDate, value: m[1] + F.txnDate.value.slice(4), how: "pattern" }; break; } }
    }
    // 영수증번호 — 라벨이 깨졌어도 「날짜숫자-..-....」 모양이면
    if (!F.receiptNo) { const l = lines.find((l) => /\b20\d{6}[-_]\d{1,4}[-_]\d{2,6}\b/.test(l.t)); if (l) set("receiptNo", l.t.match(/\b20\d{6}[-_]\d{1,4}[-_]\d{2,6}\b/)[0], l, "pattern"); }
    // 상호 — 라벨이 없으면 맨 위쪽에서 제목(영수증 · 매출전표 등)이 아닌 첫 한글 줄
    if (!F.storeName) {
      // 위쪽 줄 중에서 — 지점 이름처럼 보이는 줄(「…점」 「(…점)」 「…지점 · 매장」)을 먼저. 체인 표어(「재미있는 일상 플랫폼」)나
      // 제목 줄보다 「GS25서울스퀘어점」 같은 줄이 상호다(실제 영수증에서 확인). 없으면 첫 한글 줄.
      // 상호 뒤에 사업자번호 · 대표자 · 전화가 한 줄로 붙는 영수증이 많다 — 줄을 버리지 않고 앞부분만 쓴다
      const storePart = (t) => t.replace(/^(\[영수증\]|상호)\s*:?\s*/, "").split(/\s*\/\s*|\s{2,}|\s(?=\d{3}-?\d{2}-?\d{5}\b)|\s(?=0\d{1,2}-\d{3,4}-\d{4})|\s(?=TEL)/i)[0].trim();
      const cand = lines.slice(0, 8).filter((l) => /[가-힣]{2,}/.test(storePart(l.t)) && !/영\s*수\s*증|매출\s*전표|전표|RECEIPT|고객용|교환권|카드|사업.{0,2}번|주소|^TEL|전화|상품명|품명|수량|단가|금액|합계|대표|하나\s*\(|구외환/i.test(storePart(l.t))
        && !/(대로|[가-힣]로\s?\d|[가-힣]길\s?\d|\s[가-힣]{1,3}구\s)/.test(storePart(l.t)) && !/^\[.*\]$/.test(l.t)
        // 깨진 줄 거르기 — 글자의 절반 이상이 한글(또는 「GS25서울스퀘어점」 같은 영문 체인 + 지점)이고, 문장부호로 시작하지 않을 것
        && !/^[^가-힣A-Za-z0-9(]/.test(storePart(l.t)) && !/공급가/.test(l.t)
        && ((storePart(l.t).match(/[가-힣]/g) || []).length / Math.max(1, storePart(l.t).replace(/\s/g, "").length) >= 0.5 || /^[A-Z]{2,}\d*[가-힣]+점/.test(storePart(l.t))));
      const branch = (t) => /[가-힣A-Za-z0-9)]\s*(점|지점|본점|매장)(\)|\s|\/|$)/.test(t);
      const l = cand.find((l) => branch(storePart(l.t))) || cand[0];
      if (l) set("storeName", storePart(l.t), l, "pattern");
    }

    // 3) 품목 — 머리줄(상품명 · 품명 · 메뉴) 다음부터 합계류 줄 전까지
    const items = [];
    const hdr = lines.findIndex((l) => /(상품명|품명|품목|메뉴|내역)/.test(l.sq) && /(금액|단가|수량|가격)/.test(l.sq));
    const startIdx = hdr >= 0 ? hdr + 1 : -1;
    if (startIdx >= 0) {
      for (let k = startIdx; k < lines.length; k++) {
        const l = lines[k];
        if (TOTALS_WORDS.some((w) => l.sq.startsWith(w)) || /^[-=_*]{5,}$/.test(l.sq) && items.length) { if (/^[-=_*]{5,}$/.test(l.sq)) continue; break; }
        if (/^[-=_*.]{3,}$/.test(l.sq)) continue;
        const it = parseItemLine(l.t);
        if (it) items.push({ ...it, line: l.i, conf: l.conf });
      }
    }

    // 4) 결제수단
    if (!F.payMethod) {
      if (F.cardNo || F.approvalNo || F.cardIssuer) set("payMethod", "카드", null, "derived");
      else if (F.accountNo || lines.some((l) => /계좌이체|무통장/.test(l.sq))) set("payMethod", "계좌이체", null, "derived");
      else if (F.cashReceiptNo || F.received || lines.some((l) => /현금/.test(l.sq))) set("payMethod", "현금", null, "derived");
    }

    // 4-2) 금액 삼각 측량 — 영수증의 모든 금액에서 s + v = t, v ≈ s × 10% 인 세 값을 찾는다.
    //      라벨로 찾은 값이 이 관계를 이미 만족하면 그대로 두고, 아니면 빈 칸 · 틀린 칸을 이 값으로 채운다(「모양으로 찾음」).
    {
      const amts = [];
      lines.forEach((l) => { for (const m of (l.t.match(MONEY_RE) || [])) { const v = toMoney(m); if (v >= 10 && v < 1e9) amts.push({ v, l }); } });
      const uniq = [...new Map(amts.map((a) => [a.v, a])).values()];
      let best = null;
      for (const a of uniq) for (const b of uniq) {
        if (b.v >= a.v || b.v === 0) continue;
        const need = a.v + b.v, t = uniq.find((x) => Math.abs(x.v - need) <= 1);
        if (!t || Math.abs(b.v - Math.round(a.v * 0.1)) > Math.max(2, a.v * 0.003)) continue;
        const cnt = amts.filter((x) => x.v === t.v).length;               // 합계는 영수증에 여러 번 찍힌다
        if (!best || cnt > best.cnt || (cnt === best.cnt && t.v > best.t.v)) best = { s: a, v: b, t, cnt };
      }
      const cur = (k) => (F[k] ? toMoney(F[k].value) : null);
      const okNow = cur("supply") != null && cur("vat") != null && cur("total") != null && Math.abs(cur("supply") + cur("vat") + (cur("taxFree") || 0) + (cur("serviceFee") || 0) - cur("total")) <= 2;
      if (best && !okNow) {
        const put = (key, a) => { if (!F[key] || toMoney(F[key].value) !== a.v) { delete F[key]; set(key, fmtMoney(a.v), a.l, "pattern"); } };
        put("supply", best.s); put("vat", best.v); put("total", best.t);
      }
    }

    // 5) 계산으로 비어 있는 금액 채우기(반드시 「추정」)
    const num = (k) => (F[k] ? toMoney(F[k].value) : null);
    let total = num("total"), supply = num("supply"), vat = num("vat");
    const itemSum = items.reduce((s, it) => s + (it.amount || 0), 0);
    if (total == null && num("approvalAmount") != null) { total = num("approvalAmount"); set("total", fmtMoney(total), null, "derived"); }
    if (total == null && itemSum > 0) { total = itemSum - (num("discount") || 0); set("total", fmtMoney(total), null, "derived"); }
    if (supply == null && total != null && vat != null) { supply = total - vat - (num("taxFree") || 0) - (num("serviceFee") || 0); set("supply", fmtMoney(supply), null, "derived"); }
    if (vat == null && supply != null && total != null) { vat = total - supply - (num("taxFree") || 0) - (num("serviceFee") || 0); set("vat", fmtMoney(vat), null, "derived"); }
    if (F.payMethod && F.payMethod.value === "카드" && !F.approvalAmount && total != null) set("approvalAmount", fmtMoney(total), null, "derived");

    const checks = runChecks(F, items);

    for (const [k, f] of Object.entries(F)) {
      const why = [];
      if (f.how === "derived") why.push("계산으로 채움");
      if (f.conf != null && f.conf < 75) why.push("인식 신뢰도 낮음");
      if (/[<>{}~^|\\]/.test(String(f.value))) why.push("깨진 글자");
      if ((k === "cardIssuer" || k === "acquirer") && !CARD_ISSUERS.some((x) => String(f.value).includes(x)) && !/비씨|BC|VISA|MASTER|AMEX|JCB/i.test(f.value)) why.push("알려진 카드사 이름이 아님");
      if (k === "bizNo" && !bizNoValid(f.value)) why.push("검증번호 불일치");
      // 체크카드는 할부가 안 된다 — 「03개월」 이 「8개월」 로 읽히는 식의 오인식을 잡는다
      if (k === "installment" && f.value !== "일시불" && F.cardType && /체크|직불/.test(F.cardType.value)) why.push("체크카드는 할부가 없습니다");
      if (k === "installment" && /^(\d+)개월$/.test(f.value) && (Number(RegExp.$1) === 1 || Number(RegExp.$1) > 36)) why.push("할부 개월 수가 이상합니다");
      if (why.length) f.suspect = why;
    }
    items.forEach((it) => { const why = []; if (it.conf != null && it.conf < 75) why.push("인식 신뢰도 낮음"); if (it.unitPrice != null && it.qty != null && it.unitPrice * it.qty !== it.amount) why.push("단가 × 수량 ≠ 금액"); if (why.length) it.suspect = why; });
    return { fields: F, items, checks, lines: lines.map(({ i, text, conf, bbox }) => ({ i, text, conf, bbox })) };
  }


  // ── 검산 — 파싱 직후와, 리뷰 화면에서 값을 고칠 때마다 다시 부른다 ─────────────
  function runChecks(F, items) {
    const num = (k) => (F[k] && F[k].value !== "" && F[k].value != null ? toMoney(F[k].value) : null);
    const itemSum = (items || []).reduce((s, it) => s + (Number(it.amount) || 0), 0);
    let total, supply, vat;
    const checks = [];
    const near = (a, b, tol = 1) => a != null && b != null && Math.abs(a - b) <= tol;
    total = num("total"); supply = num("supply"); vat = num("vat");
    if (supply != null && vat != null && total != null) {
      const expect = supply + vat + (num("taxFree") || 0) + (num("serviceFee") || 0);
      checks.push({ id: "sum", ok: near(expect, total, 2), ko: `공급가액 + 부가세${num("taxFree") ? " + 면세" : ""}${num("serviceFee") ? " + 봉사료" : ""} = 합계`, detail: `${fmtMoney(expect)} / ${fmtMoney(total)}` });
    }
    if (supply != null && vat != null && supply > 0)
      checks.push({ id: "vatRate", ok: Math.abs(vat - Math.round(supply * 0.1)) <= Math.max(2, supply * 0.002), ko: "부가세 ≈ 공급가액의 10%", detail: `${fmtMoney(vat)} / ${fmtMoney(Math.round(supply * 0.1))}` });
    if (items.length && total != null)
      checks.push({ id: "items", ok: near(itemSum - (num("discount") || 0), total, 2), ko: "품목 금액 합계 = 합계", detail: `${fmtMoney(itemSum - (num("discount") || 0))} / ${fmtMoney(total)}` });
    items.forEach((it, k) => { if (it.unitPrice != null && it.qty != null && it.amount != null && it.unitPrice * it.qty !== it.amount) checks.push({ id: "item" + k, ok: false, ko: `품목 ${k + 1} 단가 × 수량 = 금액`, detail: `${fmtMoney(it.unitPrice)} × ${it.qty} ≠ ${fmtMoney(it.amount)}` }); });
    if (num("approvalAmount") != null && total != null && F.approvalAmount && F.approvalAmount.how !== "derived")
      checks.push({ id: "approval", ok: near(num("approvalAmount"), total, 0), ko: "승인금액 = 합계", detail: `${fmtMoney(num("approvalAmount"))} / ${fmtMoney(total)}` });
    if (F.bizNo) checks.push({ id: "bizNo", ok: bizNoValid(F.bizNo.value), ko: "사업자등록번호 검증번호", detail: F.bizNo.value });

    return checks;
  }

  // ── 두 읽기 합치기 — 같은 영수증을 서로 다른 방식으로 두 번 읽은 결과(a · b)를 항목마다 고른다 ──────────
  // 같으면 그대로(믿을 만함). 다르면 검증을 통과하는 쪽(사업자번호 검증번호 · 금액 삼각 관계 · 날짜 · 8자리 승인번호).
  // 둘 다 통과하거나 둘 다 못 하면 신뢰도가 높은 쪽을 쓰되 「확인 필요」 로 두고 다른 값을 후보(alt)로 남긴다 — 리뷰에서 한 번에 바꿀 수 있게.
  function mergeReadings(a, b) {
    const year = new Date().getFullYear();
    const ok = {
      bizNo: (v) => bizNoValid(v),
      txnDate: (v) => { const y = Number(String(v).slice(0, 4)); return y >= 2000 && y <= year + 1 && String(v).length > 10; },
      approvalDate: (v) => { const y = Number(String(v).slice(0, 4)); return y >= 2000 && y <= year + 1; },
      approvalNo: (v) => /^\d{8}$/.test(v),
      cardNo: (v) => (String(v).match(/\d/g) || []).length >= 4,
      phone: (v) => /^0\d{1,2}-\d{3,4}-\d{4}$/.test(v),
    };
    const money = (r) => { const g = (k) => (r.fields[k] ? toMoney(r.fields[k].value) : null); return { s: g("supply"), v: g("vat"), t: g("total"), tf: g("taxFree") || 0, sf: g("serviceFee") || 0 }; };
    const tri = (m) => m.s != null && m.v != null && m.t != null && Math.abs(m.s + m.v + m.tf + m.sf - m.t) <= 2 && Math.abs(m.v - Math.round(m.s * 0.1)) <= Math.max(2, m.s * 0.003);
    const conf = (f) => (f && f.conf != null ? f.conf : 60);
    const F = {};
    // 금액 셋은 한 묶음으로 — 삼각 관계가 맞는 쪽을 통째로
    const ma = money(a), mb = money(b), ta = tri(ma), tb = tri(mb);
    const moneyFrom = ta && !tb ? a : tb && !ta ? b : null;
    const keys = new Set([...Object.keys(a.fields), ...Object.keys(b.fields)]);
    for (const k of keys) {
      const fa = a.fields[k], fb = b.fields[k];
      if (moneyFrom && ["supply", "vat", "total"].includes(k)) { const f = moneyFrom.fields[k]; if (f) F[k] = { ...f, how: f.how, agree: false, src: moneyFrom === a ? "a" : "b" }; continue; }
      if (!fa || !fb) { F[k] = { ...(fa || fb), src: fa ? "a" : "b" }; continue; }
      const same = MONEY_FIELDS.includes(k) ? toMoney(fa.value) === toMoney(fb.value) : String(fa.value).replace(/\s/g, "") === String(fb.value).replace(/\s/g, "");
      if (same) { F[k] = { ...fa, agree: true, src: "a", conf: Math.max(conf(fa), conf(fb)) }; delete F[k].suspect; if (fa.suspect && fb.suspect) F[k].suspect = fa.suspect; continue; }
      const va = ok[k] ? ok[k](fa.value) : null, vb = ok[k] ? ok[k](fb.value) : null;
      if (va && !vb) { F[k] = { ...fa, src: "a" }; continue; }
      if (vb && !va) { F[k] = { ...fb, src: "b" }; continue; }
      const [win, lose] = conf(fb) > conf(fa) ? [fb, fa] : [fa, fb];
      F[k] = { ...win, src: win === fa ? "a" : "b", alt: lose.value, suspect: [...(win.suspect || []), "두 번 읽은 값이 다릅니다"] };
    }
    // 품목 — 합계와 맞는 쪽, 아니면 더 많이 읽은 쪽
    const tot = F.total ? toMoney(F.total.value) : null, sum = (r) => r.items.reduce((s, i) => s + (i.amount || 0), 0);
    const fromB = !(tot != null && sum(a) === tot) && ((tot != null && sum(b) === tot) || b.items.length > a.items.length);
    const items = (fromB ? b.items : a.items).map((it) => ({ ...it, src: fromB ? "b" : "a" }));
    return { fields: F, items, checks: runChecks(F, items), lines: a.lines, lines2: b.lines };
  }

  // 사업자등록번호 검증(국세청 가중치 1,3,7,1,3,7,1,3,5)
  function bizNoValid(v) {
    const d = String(v).replace(/\D/g, "");
    if (d.length !== 10) return false;
    const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
    let s = 0;
    for (let i = 0; i < 9; i++) s += Number(d[i]) * w[i];
    s += Math.floor((Number(d[8]) * 5) / 10);
    return (10 - (s % 10)) % 10 === Number(d[9]);
  }

  const api = { FIELD_GROUPS, MONEY_FIELDS, parseReceipt, mergeReadings, runChecks, parseItemLine, parseDate, toMoney, fmtMoney, bizNoValid, norm };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ReceiptParser = api;
})(typeof window !== "undefined" ? window : globalThis);
