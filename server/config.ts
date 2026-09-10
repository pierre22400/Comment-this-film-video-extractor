// Configuration du relais serveur. La clé Gemini n'existe QUE côté serveur et
// n'est jamais renvoyée au client ni journalisée.

import { readFileSync } from 'node:fs'

// Modèle Gemini Flash multimodal par défaut. Défini à UN SEUL endroit et
// surchargeable via la variable d'environnement GEMINI_MODEL — jamais dispersé
// dans le code de l'extension.
export const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash'

export interface ServerConfig {
  apiKey: string | undefined
  model: string
  host: string
  port: number
  /** Origine d'extension autorisée pour CORS (ex : chrome-extension://<id>). */
  allowedOrigin: string | undefined
}

/**
 * Parseur `.env` minimal (aucune dépendance). Gère `KEY=value`, les lignes
 * vides, les commentaires `#`, le préfixe optionnel `export ` et les guillemets
 * simples/doubles entourant la valeur. Renvoie une map clé -> valeur.
 */
export function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = withoutExport.indexOf('=')
    if (eq <= 0) continue
    const key = withoutExport.slice(0, eq).trim()
    if (!key) continue
    let value = withoutExport.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Applique un fichier `.env` PAR-DESSUS un environnement de base SANS écraser
 * une variable déjà définie : l'environnement réel reste prioritaire sur le
 * fichier. Fonction pure (aucune E/S), donc directement testable.
 */
export function mergeEnv(
  base: NodeJS.ProcessEnv,
  fileVars: Record<string, string>,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const [key, value] of Object.entries(fileVars)) {
    if (merged[key] === undefined || merged[key] === '') {
      merged[key] = value
    }
  }
  return merged
}

/**
 * Charge `.env` depuis le disque (s'il existe) et le fusionne avec `process.env`
 * en laissant l'environnement réel prioritaire. Ne lève jamais si le fichier est
 * absent, et ne journalise jamais aucune valeur.
 */
export function loadEnvFile(
  path: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return base // pas de fichier .env : on garde l'environnement tel quel.
  }
  return mergeEnv(base, parseDotEnv(content))
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    apiKey: env.GEMINI_API_KEY?.trim() || undefined,
    model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    host: env.RELAY_HOST?.trim() || '127.0.0.1',
    port: Number(env.RELAY_PORT) || 8787,
    allowedOrigin: env.ALLOWED_EXTENSION_ORIGIN?.trim() || undefined,
  }
}
