/**
 * Vercel Serverless Function: POST /api/chat
 * Body: { "messages": [{ "role": "user"|"assistant"|"system", "content": string }, ...] }
 * Response: { "message": string } or { "error": string }
 *
 * Env: OPENAI_API_KEY_COMMAND
 */
module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.OPENAI_API_KEY_COMMAND;
  if (!apiKey) {
    return res.status(500).json({ error: "OPENAI_API_KEY_COMMAND is not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body || "{}");
    } catch (e) {
      return res.status(400).json({ error: "Invalid JSON body" });
    }
  }

  const messages = body && body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
    }),
  });

  let data = {};
  try {
    data = await openaiRes.json();
  } catch (e) {
    data = {};
  }

  if (!openaiRes.ok) {
    const msg =
      (data.error && (data.error.message || data.error.code)) ||
      "OpenAI request failed";
    const status =
      openaiRes.status >= 400 && openaiRes.status < 600 ? openaiRes.status : 502;
    return res.status(status).json({ error: String(msg) });
  }

  const text =
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content
      ? data.choices[0].message.content
      : "";
  return res.status(200).json({ message: text || "" });
};
