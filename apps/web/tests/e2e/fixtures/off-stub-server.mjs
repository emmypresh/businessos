// Local stand-in for the Open Food Facts API v2, used ONLY by the e2e suite
// (playwright.config.ts starts it and points PRODUCT_LOOKUP_OFF_BASE_URL at
// it), so provider-dependent lookup scenarios are deterministic and never
// touch the real third-party service. Behavior is keyed by barcode:
//   4006381333931 / 5901234123457 -> a product
//   4012345678901                 -> HTTP 500 (provider outage)
//   4001234567891                 -> 429 (rate limited)
//   4000539200007                 -> a product, after a 2s delay (double-submit test)
//   anything else                 -> { status: 0 } (not found)
import http from "node:http";

const PORT = Number(process.env.OFF_STUB_PORT || 3199);

const SLOW_CODE = "4000539200007";
const SLOW_DELAY_MS = 2000;

const PRODUCTS = {
  [SLOW_CODE]: {
    product_name: "Stub Slow Product",
    brands: "SlowCo",
    categories: "Beverages, Slow",
    quantity: "1 L",
    code: SLOW_CODE,
  },
  "4006381333931": {
    product_name: "Stub Highlighter Pen",
    brands: "StubBrand, Other",
    categories: "Stationery, Pens",
    quantity: "4 pack",
    image_url: "https://example.test/pen.jpg",
    code: "4006381333931",
  },
  "5901234123457": {
    product_name: "Stub Orange Juice",
    brands: "JuiceCo",
    categories: "Beverages, Juices",
    quantity: "1 L",
    code: "5901234123457",
  },
};

const server = http.createServer((req, res) => {
  const match = /^\/api\/v2\/product\/([^/.]+)\.json/.exec(req.url ?? "");
  const code = match?.[1];
  res.setHeader("Content-Type", "application/json");
  if (!code) {
    res.statusCode = 404;
    res.end("{}");
    return;
  }
  if (code === "4012345678901") {
    res.statusCode = 500;
    res.end('{"error":"boom"}');
    return;
  }
  if (code === "4001234567891") {
    res.statusCode = 429;
    res.end("{}");
    return;
  }
  const product = PRODUCTS[code];
  const body = JSON.stringify(product ? { status: 1, product } : { status: 0 });
  if (code === SLOW_CODE) {
    setTimeout(() => res.end(body), SLOW_DELAY_MS);
    return;
  }
  res.end(body);
});

server.listen(PORT, "127.0.0.1");
