import { describe, it, expect } from 'vitest'
import {
  parseDotEnv,
  mergeEnv,
  loadConfig,
  DEFAULT_GEMINI_MODEL,
} from '../server/config'

describe('parseDotEnv', () => {
  it('parse KEY=value, ignore commentaires et lignes vides', () => {
    const vars = parseDotEnv(
      ['# commentaire', '', 'GEMINI_API_KEY=abc123', 'RELAY_PORT=9000', '   '].join('\n'),
    )
    expect(vars.GEMINI_API_KEY).toBe('abc123')
    expect(vars.RELAY_PORT).toBe('9000')
  })

  it('gère le préfixe export et les guillemets', () => {
    const vars = parseDotEnv(
      ['export GEMINI_MODEL="gemini-3.6-flash"', "ALLOWED_EXTENSION_ORIGIN='chrome-extension://xyz'"].join(
        '\n',
      ),
    )
    expect(vars.GEMINI_MODEL).toBe('gemini-3.6-flash')
    expect(vars.ALLOWED_EXTENSION_ORIGIN).toBe('chrome-extension://xyz')
  })
})

describe('mergeEnv — l’environnement réel reste prioritaire', () => {
  it('applique le fichier uniquement pour les variables absentes/vides', () => {
    const base = { GEMINI_API_KEY: 'depuis-env', RELAY_PORT: '' } as NodeJS.ProcessEnv
    const merged = mergeEnv(base, {
      GEMINI_API_KEY: 'depuis-fichier',
      RELAY_PORT: '8787',
      GEMINI_MODEL: 'depuis-fichier',
    })
    // Déjà défini dans l'environnement : NON écrasé par le fichier.
    expect(merged.GEMINI_API_KEY).toBe('depuis-env')
    // Vide dans l'environnement : le fichier peut renseigner.
    expect(merged.RELAY_PORT).toBe('8787')
    // Absent de l'environnement : vient du fichier.
    expect(merged.GEMINI_MODEL).toBe('depuis-fichier')
  })
})

describe('loadConfig', () => {
  it('lit la clé, le modèle par défaut, l’hôte local et l’origine autorisée', () => {
    const cfg = loadConfig({
      GEMINI_API_KEY: '  k  ',
      ALLOWED_EXTENSION_ORIGIN: 'chrome-extension://abc',
    } as NodeJS.ProcessEnv)
    expect(cfg.apiKey).toBe('k')
    expect(cfg.model).toBe(DEFAULT_GEMINI_MODEL)
    expect(cfg.host).toBe('127.0.0.1') // défaut : écoute locale uniquement
    expect(cfg.port).toBe(8787)
    expect(cfg.allowedOrigin).toBe('chrome-extension://abc')
  })

  it('clé et origine absentes => undefined (pas de valeur fabriquée)', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv)
    expect(cfg.apiKey).toBeUndefined()
    expect(cfg.allowedOrigin).toBeUndefined()
    expect(cfg.host).toBe('127.0.0.1')
  })
})
