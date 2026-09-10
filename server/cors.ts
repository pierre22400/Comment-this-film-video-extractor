// Politique CORS du relais local, isolée en fonction PURE pour être testable
// sans serveur HTTP ni navigateur. La clé Gemini n'apparaît jamais ici.

export interface CorsDecision {
  /** true si la requête doit être traitée ; false si l'origine est refusée. */
  allowed: boolean
  /** En-têtes CORS/Vary à écrire sur la réponse (toujours présents). */
  headers: Record<string, string>
}

const BASE_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  // Le résultat CORS dépend de l'origine : indispensable pour les caches/proxys.
  Vary: 'Origin',
}

/**
 * Décide si une requête est acceptée selon son origine et l'origine autorisée.
 *
 * Règles :
 * - Aucune origine dans la requête (curl, tests serveur, appels non-navigateur)
 *   => acceptée, sans en-tête `Access-Control-Allow-Origin`. Cela préserve un
 *   moyen sûr de tester le serveur sans navigateur.
 * - `allowedOrigin` non configurée => on n'autorise AUCUNE origine de navigateur
 *   (posture stricte par défaut), mais les appels sans origine restent permis.
 * - Origine présente et égale à `allowedOrigin` => acceptée + en-tête renvoyé.
 * - Origine présente et différente => refusée. Jamais de joker `*`.
 */
export function resolveCors(
  requestOrigin: string | undefined,
  allowedOrigin: string | undefined,
): CorsDecision {
  const headers = { ...BASE_HEADERS }

  // Appel sans origine (non-navigateur) : autorisé, aucun ACAO renvoyé.
  if (!requestOrigin) {
    return { allowed: true, headers }
  }

  if (allowedOrigin && requestOrigin === allowedOrigin) {
    return {
      allowed: true,
      headers: { ...headers, 'Access-Control-Allow-Origin': allowedOrigin },
    }
  }

  // Origine présente mais non autorisée : refus explicite, sans ACAO.
  return { allowed: false, headers }
}
