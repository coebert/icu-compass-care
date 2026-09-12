import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { callGatewayChat } from "@/lib/ai-gateway.server";

/**
 * AI checklist drafting.
 *
 * The model receives ONLY the clinician's free-text topic — never any patient
 * data, identifiers or notes. Output is a generic, reusable checklist template.
 */

const draftedItem = z.object({
  label: z.string().trim().min(2).max(200),
  hint: z.string().trim().max(300).nullish(),
});

export const draftChecklistSchema = z.object({
  name: z.string().trim().min(2).max(120),
  specialty: z.string().trim().max(120).nullable(),
  description: z.string().trim().max(600).nullable(),
  items: z.array(draftedItem).min(1).max(30),
});

export type DraftedChecklist = z.infer<typeof draftChecklistSchema>;

const SYSTEM_PROMPT = `You are an intensive care consultant writing structured management checklists for an adult ICU in the UK (NHS).

Rules:
- Produce a practical, evidence-informed checklist a bedside clinician can tick through.
- Each item is a single concrete action or decision (e.g. "Send viral respiratory PCR", "Consider CTPA if D-dimer raised or unexplained hypoxia").
- Each item gets a short "hint" giving the criteria, threshold, target or trigger that decides it (e.g. "Target MAP >= 65 mmHg", "Steroids if PaO2/FiO2 < 26.6 kPa"). Keep hints under 140 characters.
- Use UK units and terminology, generic drug names, no brand names, no doses unless standard and safe to state.
- 6 to 18 items. Order them the way a clinician would work through them.
- Never include patient-specific or identifiable content, and never invent local hospital policy.

Reply with JSON only, shaped exactly:
{"name":string,"specialty":string|null,"description":string,"items":[{"label":string,"hint":string}]}`;

export const draftChecklist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        topic: z.string().trim().min(3).max(600),
        specialty: z.string().trim().max(120).nullish(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { content } = await callGatewayChat({
      model: "google/gemini-3.8-flash",
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Draft an ICU management checklist for: ${data.topic}`,
            data.specialty ? `Specialty context: ${data.specialty}` : "",
            "Return JSON only.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });

    const cleaned = content
      .trim()
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/, "")
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start < 0 || end <= start) {
        throw new Error("The AI assistant returned an unreadable checklist. Please try again.");
      }
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    }

    const result = draftChecklistSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error("The AI assistant returned an incomplete checklist. Please try again.");
    }

    return {
      name: result.data.name,
      specialty: result.data.specialty ?? data.specialty ?? null,
      description: result.data.description ?? null,
      items: result.data.items.map((i) => ({ label: i.label, hint: i.hint ?? null })),
    };
  });
