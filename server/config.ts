// Configuration du relais serveur. La clé Gemini n'existe QUE côté serveur et
// n'est jamais renvoyée au client ni journalisée.

// Modèle Gemini Flash multimodal par défaut. Défini à UN SEUL endroit et
// surchargeable via la variable d'environnement GEMINI_MODEL — jamais dispersé
// dans le code de l'extension.
export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

export interface ServerConfig {
  apiKey: string | undefined
  model: string
  host: string
  port: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    apiKey: env.GEMINI_API_KEY?.trim() || undefined,
    model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    host: env.RELAY_HOST?.trim() || '127.0.0.1',
    port: Number(env.RELAY_PORT) || 8787,
  }
}
