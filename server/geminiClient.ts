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

export interface GeminiClient {
  readonly model: string
  /** Renvoie la description brute produite par le modèle (texte). */
  describe(input: GeminiDescribeInput): Promise<string>
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
  }
}
