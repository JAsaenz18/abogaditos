// Servidor chiquito: recibe el texto del juego y se lo pasa a Claude.
// La clave secreta ANTHROPIC_API_KEY vive SOLO en Vercel, nunca en la página.
export const config = { runtime: "edge" };

const MODELS = { quick: "claude-haiku-5-5", default: "claude-sonnet-5-5" };
const MAX_PER_IP_PER_DAY = 200;      // ~5 juicios completos por persona al día
const hits = new Map();               // contador simple en memoria

function tooMany(ip) {
  const day = new Date().toISOString().slice(0, 10);
  const key = ip + "|" + day;
  const n = (hits.get(key) || 0) + 1;
  hits.set(key, n);
  if (hits.size > 5000) hits.clear();
  return n > MAX_PER_IP_PER_DAY;
}

export default async function handler(req) {
  if (req.method !== "POST") return new Response("Solo POST", { status: 405 });
  const ip = (req.headers.get("x-forwarded-for") || "anon").split(",")[0].trim();
  if (tooMany(ip)) return new Response("Se acabaron los juicios gratis de hoy. ¡Vuelve mañana! 🌙", { status: 429 });

  let body;
  try { body = await req.json(); } catch { return new Response("Mal pedido", { status: 400 }); }
  const prompt = String(body.prompt || "").slice(0, 6000);
  if (!prompt) return new Response("Falta el texto", { status: 400 });
  const model = MODELS[body.tier] || MODELS.quick;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: body.tier === "default" ? 700 : 300,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok || !r.body) return new Response("La IA no respondió", { status: 502 });

  // Convierte el stream de Anthropic en texto plano que el juego va mostrando.
  const enc = new TextEncoder(), dec = new TextDecoder();
  let buf = "";
  const stream = new ReadableStream({
    async start(ctrl) {
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop();
        for (const l of lines) {
          if (!l.startsWith("data:")) continue;
          try {
            const ev = JSON.parse(l.slice(5));
            if (ev.type === "content_block_delta" && ev.delta?.text) ctrl.enqueue(enc.encode(ev.delta.text));
          } catch {}
        }
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
