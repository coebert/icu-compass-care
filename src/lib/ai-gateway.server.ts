// Server-only helper for calling the Lovable AI Gateway. Never import from
// client code — `process.env.LOVABLE_API_KEY` is server-only.

export const LOVABLE_GATEWAY_URL = "https://ai.gateway.lovable.dev/v1";

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  >;
};

export async function callGatewayChat(params: {
  model: string;
  messages: ChatMessage[];
  response_format?: { type: "json_object" };
  temperature?: number;
  max_tokens?: number;
}): Promise<{ content: string; raw: unknown }> {
  const key = process.env.LOVABLE_API_KEY;
  if (!key) throw new Error("Missing LOVABLE_API_KEY");
  const res = await fetch(`${LOVABLE_GATEWAY_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Lovable-API-Key": key,
      "X-Lovable-AIG-SDK": "raw-fetch",
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `AI Gateway ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`AI Gateway returned non-JSON: ${text.slice(0, 200)}`);
  }
  const content = json?.choices?.[0]?.message?.content ?? "";
  return { content: String(content), raw: json };
}
