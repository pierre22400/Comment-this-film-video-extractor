// Client Gemini multimodal. Isolé derrière une interface pour être remplaçable
// par un faux client dans les tests (aucun appel réseau payant en test).

/** Erreur d'appel à l'API Gemini, porteuse du statut HTTP pour la classification retry. */
export class GeminiApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'GeminiApiError'
  }
}

export interface GeminiDescribeInput {
  imageBase64: string
  mimeType: string
  snapshotId: number
  mediaTime: number
}

export interface GeminiProbeInput {
  imageBase64: string
  mimeType: string
  purpose: string
  question: string
}

/** Réponse brute (non validée) renvoyée par le modèle pour une sonde visuelle. */
export interface GeminiProbeRawOutput {
  answer?: unknown
  observations?: unknown
  confidence?: unknown
  limitations?: unknown
}

export interface GeminiClient {
  readonly model: string
  /** Renvoie la description brute produite par le modèle (texte). */
  describe(input: GeminiDescribeInput): Promise<string>
  /** Renvoie la réponse structurée brute (NON validée) à une sonde visuelle. */
  probe(input: GeminiProbeInput): Promise<GeminiProbeRawOutput>
}

// Consigne stricte : décrire uniquement le visible, en français, sans identifier
// d'œuvre ni de personne, sans deviner le contexte, sans inventer de nom propre.
const PROMPT = [
  'Tu es un outil de description visuelle.',
  'Décris uniquement ce qui est directement visible dans cette image isolée,',
  'en français, en une ou deux phrases courtes et factuelles.',
  "Distingue clairement l'observation de l'incertitude (emploie « semble » en cas de doute).",
  "N'invente jamais de nom propre.",
  "N'identifie pas le film, la série, l'épisode ni aucune personne.",
  'Ne devine pas le contexte, l\u2019intrigue, le lieu réel ni ce qui se passe hors champ.',
  'Réponds strictement en JSON : {"description": "..."}.',
].join(' ')

// Sonde visuelle ciblée : prompt STRICT en anglais. Le modèle doit répondre
// uniquement à partir de ce qui est visible dans CETTE image isolée, ne jamais
// inventer une marque/un modèle non certain, ne jamais identifier le film, la
// série, l'épisode ni une personne réelle, et ne jamais raconter d'anecdote ou
// d'intrigue. La réponse doit être un JSON structuré strict.
const PROBE_PROMPT_TEMPLATE = (purpose: string, question: string) =>
  [
    'You are a careful visual-inspection tool analyzing a single isolated video frame.',
    `The requester's stated purpose for this probe is: "${purpose}".`,
    `Their specific question is: "${question}"`,
    'Answer ONLY based on what is directly visible in this exact image.',
    'Never invent a brand, model, name, or identity you are not visually certain of.',
    'Never identify the film, show, episode, or any real person.',
    'Never guess the plot, backstory, or anything outside the frame.',
    'If you are uncertain, say so explicitly in your answer and lower your confidence accordingly.',
    'List any limitations that reduce your certainty (e.g. low resolution, motion blur, partial occlusion, poor lighting).',
    'Respond strictly as JSON: {"answer": "...", "observations": ["..."], "confidence": 0.0, "limitations": ["..."]}.',
    '"confidence" is a number between 0 and 1. "observations" and "limitations" are arrays of short strings (can be empty).',
  ].join(' ')

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiPart {
  text?: string
}
interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] } }>
}

/**
 * Crée un client Gemini réel. La clé transite uniquement dans l'en-tête
 * `x-goog-api-key` (jamais dans l'URL, jamais journalisée).
 */
export function createGeminiClient(opts: {
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
}): GeminiClient {
  const doFetch = opts.fetchImpl ?? fetch
  return {
    model: opts.model,
    async describe(input: GeminiDescribeInput): Promise<string> {
      const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent`
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: input.mimeType, data: input.imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { description: { type: 'STRING' } },
            required: ['description'],
          },
        },
      }

      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': opts.apiKey,
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        // On ne relaie pas le corps brut (peut contenir des détails inutiles).
        throw new GeminiApiError(res.status, `Gemini a répondu ${res.status}`)
      }

      const data = (await res.json()) as GeminiResponse
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''

      // Le modèle est censé renvoyer du JSON { description }. On extrait proprement.
      try {
        const parsed = JSON.parse(text) as { description?: unknown }
        return typeof parsed.description === 'string' ? parsed.description : ''
      } catch {
        // Repli : si ce n'est pas du JSON valide, on renvoie le texte brut ;
        // la validation finale (normalizeDescription) décidera de sa validité.
        return text
      }
    },

    async probe(input: GeminiProbeInput): Promise<GeminiProbeRawOutput> {
      const url = `${GEMINI_ENDPOINT}/${encodeURIComponent(opts.model)}:generateContent`
      const payload = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: PROBE_PROMPT_TEMPLATE(input.purpose, input.question) },
              { inline_data: { mime_type: input.mimeType, data: input.imageBase64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: {
              answer: { type: 'STRING' },
              observations: { type: 'ARRAY', items: { type: 'STRING' } },
              confidence: { type: 'NUMBER' },
              limitations: { type: 'ARRAY', items: { type: 'STRING' } },
            },
            required: ['answer', 'confidence'],
          },
        },
      }

      const res = await doFetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': opts.apiKey,
        },
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        throw new GeminiApiError(res.status, `Gemini a répondu ${res.status}`)
      }

      const data = (await res.json()) as GeminiResponse
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''

      try {
        return JSON.parse(text) as GeminiProbeRawOutput
      } catch {
        // JSON invalide : on renvoie un objet vide ; la validation finale
        // (validateProbeStructuredResponse) le rejettera proprement.
        return {}
      }
    },
  }
}
