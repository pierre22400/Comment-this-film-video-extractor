import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const srcDir = fileURLToPath(new URL('../src', import.meta.url))

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

describe('sécurité de la clé Gemini', () => {
  const files = walk(srcDir)

  it('9. aucune référence à GEMINI_API_KEY dans le code de l’extension (src/)', () => {
    // Le bundle de l'extension est construit uniquement depuis src/ : si la clé
    // n'y est jamais référencée, elle ne peut pas se retrouver dans dist/.
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('GEMINI_API_KEY'))
    expect(offenders).toEqual([])
  })

  it('src/ n’accède jamais à process.env', () => {
    const offenders = files.filter((f) => /process\.env/.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('src/ ne contient aucune URL d’API Gemini directe', () => {
    const offenders = files.filter((f) =>
      readFileSync(f, 'utf8').includes('generativelanguage.googleapis.com'),
    )
    expect(offenders).toEqual([])
  })
})
