/**
 * Vercel Serverless Function: POST /api/ai
 * 社内AIアシスタント用の中継サーバー（APIキーはサーバー側だけで持つ）
 *
 * ブラウザからのヘッダー:
 *   x-aitk-target  : "anthropic:/v1/messages" | "openai:/v1/chat/completions" | "openai:/v1/embeddings"
 *   x-aitk-company : 会社コード（例 demo-basic / sakura-koumuten）
 *   anthropic-beta : （任意）PDF読み込み時のみ
 * Body: 各APIにそのまま渡すJSON（キーは含めない）
 *
 * Vercelの環境変数（Settings → Environment Variables）:
 *   ANTHROPIC_API_KEY          Claude のキー
 *   OPENAI_API_KEY             OpenAI のキー
 *   AITK_COMPANIES             使ってよい会社コード（カンマ区切り）。demo-basic,demo-standard,demo-premium は常に許可
 *   SUPABASE_SERVICE_ROLE_KEY  （任意）使用量の記録用。未設定なら記録しない
 *   AITK_ALLOWED_ORIGINS       （任意）追加で許可するサイト（独自ドメインなど）。aitools-portal / tushig-mn-pod の vercel.app は常に許可
 */
const SUPABASE_URL = "https://obulszmlixpokgewrcli.supabase.co";

const TARGETS = {
  "anthropic:/v1/messages": {
    url: "https://api.anthropic.com/v1/messages",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  },
  "openai:/v1/chat/completions": {
    url: "https://api.openai.com/v1/chat/completions",
    models: ["gpt-4o-mini"],
  },
  "openai:/v1/embeddings": {
    url: "https://api.openai.com/v1/embeddings",
    models: ["text-embedding-3-small"],
  },
};

const DEMO_CODES = [
  "demo-basic", "demo-standard", "demo-premium",          // 日本語版デモ
  "mn-demo-basic", "mn-demo-standard", "mn-demo-premium", // モンゴル語版デモ
];
// 自分のサイト（本番・プレビュー）だけ許可
const ORIGIN_RE = /^https:\/\/(aitools-portal|tushig-mn-pod)(-[a-z0-9-]+)?\.vercel\.app$/;
const MAX_TOKENS_CAP = 4096;

function allowedOrigins() {
  return (process.env.AITK_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function allowedCompanies() {
  return DEMO_CODES.concat(
    (process.env.AITK_COMPANIES || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

async function logUsage(row) {
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!key) {
    console.error("SUPABASE_SERVICE_ROLE_KEY is not set");
    return "nokey";
  }
  try {
    const r = await fetch(SUPABASE_URL + "/rest/v1/ai_usage", {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json", apikey: key, Prefer: "return=minimal" },
        // 新しい sb_secret_ キーは apikey ヘッダーだけで使う（JWT形式の古いキーのみ Authorization も付ける）
        key.indexOf("sb_secret_") === 0 ? {} : { Authorization: "Bearer " + key }
      ),
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const msg = (await r.text()).slice(0, 120);
      console.error("ai_usage insert failed", r.status, msg);
      // キーの「形」だけ返す（中身は返さない）
      const kind = key.indexOf("sb_secret_") === 0 ? "secret" : key.indexOf("sb_publishable_") === 0 ? "publishable" : key.indexOf("eyJ") === 0 ? "jwt" : "other";
      const shape = kind + "/len" + key.length + (/[^\x21-\x7e]/.test(key) ? "/has-odd-chars" : "");
      return "err" + r.status + "[" + shape + "]:" + msg.replace(/[^\x20-\x7e]/g, "");
    }
    return "ok";
  } catch (e) {
    console.error("ai_usage insert error", e && e.message);
    return "exception";
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const okOrigin = ORIGIN_RE.test(origin) || allowedOrigins().indexOf(origin) !== -1;
  if (okOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Expose-Headers", "x-aitk-usage");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, x-aitk-target, x-aitk-company, anthropic-beta, anthropic-version"
    );
    return res.status(204).end();
  }
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (origin && !okOrigin) return res.status(403).json({ error: "このサイトからは利用できません" });

  const targetName = String(req.headers["x-aitk-target"] || "");
  const target = TARGETS[targetName];
  if (!target) return res.status(400).json({ error: "不正なリクエストです" });

  const company = String(req.headers["x-aitk-company"] || "").trim();
  if (!company || allowedCompanies().indexOf(company) === -1) {
    return res.status(403).json({ error: "会社コードが登録されていません。管理者にお問い合わせください。" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }
  if (!body || typeof body !== "object") return res.status(400).json({ error: "Invalid body" });
  if (target.models.indexOf(body.model) === -1) {
    return res.status(400).json({ error: "このモデルは使えません: " + body.model });
  }
  if (typeof body.max_tokens === "number" && body.max_tokens > MAX_TOKENS_CAP) {
    body.max_tokens = MAX_TOKENS_CAP;
  }

  const isAnthropic = targetName.indexOf("anthropic:") === 0;
  const headers = { "Content-Type": "application/json" };
  if (isAnthropic) {
    const k = process.env.ANTHROPIC_API_KEY;
    if (!k) return res.status(500).json({ error: "ANTHROPIC_API_KEY が設定されていません" });
    headers["x-api-key"] = k;
    headers["anthropic-version"] = "2023-06-01";
    const beta = req.headers["anthropic-beta"];
    if (beta === "pdfs-2024-09-25") headers["anthropic-beta"] = beta;
  } else {
    const k = process.env.OPENAI_API_KEY;
    if (!k) return res.status(500).json({ error: "OPENAI_API_KEY が設定されていません" });
    headers.Authorization = "Bearer " + k;
    if (body.stream && targetName === "openai:/v1/chat/completions") {
      body.stream_options = { include_usage: true };
    }
  }

  let upstream;
  try {
    upstream = await fetch(target.url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    return res.status(502).json({ error: "AIサーバーに接続できませんでした" });
  }

  const usage = { company, target: targetName, model: body.model, input_tokens: 0, output_tokens: 0 };

  // ストリーミングでない場合
  if (!body.stream || !upstream.ok) {
    const text = await upstream.text();
    if (upstream.ok) {
      try {
        const data = JSON.parse(text);
        const u = data.usage || {};
        usage.input_tokens = u.input_tokens || u.prompt_tokens || 0;
        usage.output_tokens = u.output_tokens || u.completion_tokens || 0;
        res.setHeader("x-aitk-usage", String(await logUsage(usage)));
      } catch (e) {}
    }
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    return res.end(text);
  }

  // ストリーミング：そのまま流しつつ、使用量だけ読み取る
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line.indexOf("data:") !== 0) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const d = JSON.parse(payload);
          if (d.type === "message_start" && d.message && d.message.usage) {
            usage.input_tokens = d.message.usage.input_tokens || 0;
          } else if (d.type === "message_delta" && d.usage) {
            usage.output_tokens = d.usage.output_tokens || usage.output_tokens;
          } else if (d.usage) {
            usage.input_tokens = d.usage.prompt_tokens || usage.input_tokens;
            usage.output_tokens = d.usage.completion_tokens || usage.output_tokens;
          }
        } catch (e) {}
      }
    }
  } catch (e) {
    /* 途中で切れた場合もここで終了 */
  }
  // Vercelは返信後に処理を止めることがあるため、記録してから終了する
  await logUsage(usage);
  res.end();
};

module.exports.config = { maxDuration: 60 };
