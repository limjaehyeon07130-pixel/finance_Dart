require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 5 * 60 * 1000);
const DART_URL = "https://opendart.fss.or.kr/api/fnlttSinglAcnt.json";
const cache = new Map();

app.use(cors());
app.use(express.json());

const ACCOUNT_ALIASES = {
  "매출액": ["매출액"],
  "영업수익": ["영업수익"],
  "영업이익": ["영업이익"],
  "당기순이익": ["당기순이익"],
  "영업활동현금흐름": [
    "영업활동현금흐름",
    "영업현금흐름",
    "영업활동으로인한현금흐름",
  ],
  "현금및현금성자산": [
    "현금및현금성자산",
    "기말의현금및현금성자산",
    "기말현금및현금성자산",
  ],
};

function normalizedName(value) {
  return String(value || "").replace(/\s+/g, "");
}

function normalizeAmount(value) {
  if (value === null || value === undefined || value === "") return 0;

  const amount = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function selectAccount(list, aliases) {
  const matched = list.filter((item) =>
    aliases.includes(normalizedName(item.account_nm))
  );

  // 연결재무제표(CFS)를 우선 사용하고, 없으면 첫 번째 일치 계정을 사용합니다.
  return matched.find((item) => item.fs_div === "CFS") || matched[0] || null;
}

function sanitizeFinancials(list) {
  const sanitized = [];

  for (const [canonicalName, aliases] of Object.entries(ACCOUNT_ALIASES)) {
    const item = selectAccount(list, aliases);

    if (item) {
      sanitized.push({
        account_nm: canonicalName,
        thstrm_amount: normalizeAmount(item.thstrm_amount),
        frmr_amount: normalizeAmount(item.frmtrm_amount || item.frmr_amount),
        fs_div: item.fs_div || null,
      });
    }
  }

  return sanitized;
}

app.get("/api/dart/financials", async (req, res) => {
  const { apiKey, corpCode, year, reprtCode } = req.query;
  const dartApiKey = apiKey || process.env.DART_API_KEY;

  if (!dartApiKey || !corpCode || !year || !reprtCode) {
    return res.status(400).json({
      error: "INVALID_REQUEST",
      message: "apiKey, corpCode, year, reprtCode는 필수입니다.",
    });
  }

  if (!/^\d{8}$/.test(String(corpCode)) || !/^\d{4}$/.test(String(year))) {
    return res.status(400).json({
      error: "INVALID_PARAMETER",
      message: "corpCode는 8자리, year는 4자리 숫자여야 합니다.",
    });
  }

  const cacheKey = `${corpCode}:${year}:${reprtCode}`;
  const cached = cache.get(cacheKey);

  if (cached && cached.expiresAt > Date.now()) {
    return res.json({ ...cached.data, cached: true });
  }

  try {
    const { data } = await axios.get(DART_URL, {
      params: {
        crtfc_key: dartApiKey,
        corp_code: corpCode,
        bsns_year: year,
        reprt_code: reprtCode,
      },
      timeout: 10000,
    });

    if (!data || data.status !== "000") {
      return res.status(400).json({
        error: "DART_API_ERROR",
        dartStatus: data?.status || null,
        message: data?.message || "DART API가 정상 응답을 반환하지 않았습니다.",
      });
    }

    const responseData = {
      status: "000",
      message: "정상",
      corpCode,
      year: String(year),
      reprtCode: String(reprtCode),
      list: sanitizeFinancials(Array.isArray(data.list) ? data.list : []),
      cached: false,
    };

    cache.set(cacheKey, {
      data: responseData,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });

    return res.json(responseData);
  } catch (error) {
    if (error.code === "ECONNABORTED") {
      return res.status(504).json({
        error: "DART_TIMEOUT",
        message: "DART API 응답 시간이 초과되었습니다.",
      });
    }

    console.error("DART proxy error:", error.message);

    return res.status(500).json({
      error: "DART_PROXY_ERROR",
      message: "DART API 요청 중 서버 오류가 발생했습니다.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`DART proxy server is running on http://localhost:${PORT}`);
});
