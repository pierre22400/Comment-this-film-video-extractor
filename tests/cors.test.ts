import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolveCors } from '../server/cors'

const ALLOWED = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const OTHER = 'chrome-extension://malicieusextensionxxxxxxxxxxxxxx'

describe('resolveCors — restriction d’origine', () => {
  it('origine autorisée => acceptée + ACAO exact (jamais de joker)', () => {
    const d = resolveCors(ALLOWED, ALLOWED)
    expect(d.allowed).toBe(true)
    expect(d.headers['Access-Control-Allow-Origin']).toBe(ALLOWED)
    expect(d.headers['Access-Control-Allow-Origin']).not.toBe('*')
    expect(d.headers.Vary).toBe('Origin')
  })

  it('origine différente => refusée, sans ACAO', () => {
    const d = resolveCors(OTHER, ALLOWED)
    expect(d.allowed).toBe(false)
    expect(d.headers['Access-Control-Allow-Origin']).toBeUndefined()
    expect(d.headers.Vary).toBe('Origin')
  })

  it('préflight OPTIONS d’une origine autorisée => acceptée (méthodes + en-têtes annoncés)', () => {
    // Le préflight suit exactement la même décision d'origine.
    const d = resolveCors(ALLOWED, ALLOWED)
    expect(d.allowed).toBe(true)
    expect(d.headers['Access-Control-Allow-Methods']).toContain('OPTIONS')
    expect(d.headers['Access-Control-Allow-Methods']).toContain('POST')
    expect(d.headers['Access-Control-Allow-Headers']).toBe('Content-Type')
  })

  it('préflight OPTIONS d’une origine non autorisée => refusée', () => {
    const d = resolveCors(OTHER, ALLOWED)
    expect(d.allowed).toBe(false)
    expect(d.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('aucune origine autorisée configurée => aucune origine de navigateur acceptée', () => {
    expect(resolveCors(ALLOWED, undefined).allowed).toBe(false)
    expect(resolveCors(OTHER, undefined).allowed).toBe(false)
  })

  it('appel SANS origine (curl / test serveur) => accepté, sans ACAO', () => {
    // Préserve un moyen sûr de tester le serveur sans navigateur.
    const d = resolveCors(undefined, ALLOWED)
    expect(d.allowed).toBe(true)
    expect(d.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })
})

describe('absence de fuite de secret côté relais CORS/config', () => {
  const corsSrc = readFileSync(fileURLToPath(new URL('../server/cors.ts', import.meta.url)), 'utf8')
  const configSrc = readFileSync(fileURLToPath(new URL('../server/config.ts', import.meta.url)), 'utf8')

  it('la décision CORS ne renvoie jamais la clé Gemini', () => {
    // La clé ne doit jamais transiter par la couche CORS.
    for (const origin of [ALLOWED, OTHER, undefined]) {
      const d = resolveCors(origin, ALLOWED)
      const serialized = JSON.stringify(d)
      expect(serialized.includes('GEMINI_API_KEY')).toBe(false)
      expect(serialized.toLowerCase().includes('x-goog-api-key')).toBe(false)
    }
  })

  it('cors.ts ne référence jamais la clé ni process.env', () => {
    expect(corsSrc.includes('GEMINI_API_KEY')).toBe(false)
    expect(corsSrc.includes('process.env')).toBe(false)
  })

  it('config.ts ne journalise jamais (aucun console.*)', () => {
    // La configuration ne doit imprimer aucune valeur (dont la clé).
    expect(/console\./.test(configSrc)).toBe(false)
  })
})
