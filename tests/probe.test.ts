import { describe, it, expect } from 'vitest'
import {
  validateProbeDefinition,
  validateProbeRequest,
  validateProbeStructuredResponse,
  isTerminalProbeStatus,
} from '../src/lib/probe'

describe('validateProbeDefinition', () => {
  it('accepte une définition valide', () => {
    const res = validateProbeDefinition({
      startTime: 10,
      endTime: 15,
      preferredTime: 12,
      purpose: 'vehicle',
      question: 'Quelle est la couleur de la voiture ?',
    })
    expect(res.ok).toBe(true)
  })

  it('rejette endTime <= startTime', () => {
    const res = validateProbeDefinition({
      startTime: 10,
      endTime: 10,
      purpose: 'vehicle',
      question: 'Quelle couleur ?',
    })
    expect(res.ok).toBe(false)
  })

  it('rejette une fenêtre trop longue (> 120s)', () => {
    const res = validateProbeDefinition({
      startTime: 0,
      endTime: 200,
      purpose: 'vehicle',
      question: 'Quelle couleur ?',
    })
    expect(res.ok).toBe(false)
  })

  it('rejette un purpose invalide', () => {
    const res = validateProbeDefinition({
      startTime: 0,
      endTime: 5,
      purpose: 'spaceship',
      question: 'Quelle couleur ?',
    })
    expect(res.ok).toBe(false)
  })

  it('rejette une question trop courte', () => {
    const res = validateProbeDefinition({
      startTime: 0,
      endTime: 5,
      purpose: 'vehicle',
      question: 'Ok',
    })
    expect(res.ok).toBe(false)
  })

  it('rejette preferredTime hors fenêtre', () => {
    const res = validateProbeDefinition({
      startTime: 10,
      endTime: 15,
      preferredTime: 30,
      purpose: 'vehicle',
      question: 'Quelle couleur ?',
    })
    expect(res.ok).toBe(false)
  })

  it('rejette maxCaptures hors bornes', () => {
    const res = validateProbeDefinition({
      startTime: 0,
      endTime: 5,
      purpose: 'vehicle',
      question: 'Quelle couleur ?',
      maxCaptures: 10,
    })
    expect(res.ok).toBe(false)
  })
})

describe('validateProbeRequest (serveur)', () => {
  const valid = {
    probeId: 'p1',
    snapshotId: 3,
    mediaTime: 12.5,
    mimeType: 'image/webp',
    imageBase64: 'AAAA',
    purpose: 'actor',
    question: 'Qui est visible à l’écran ?',
  }

  it('accepte un corps complet et valide', () => {
    expect(validateProbeRequest(valid).ok).toBe(true)
  })

  it('rejette une image manquante', () => {
    expect(validateProbeRequest({ ...valid, imageBase64: '' }).ok).toBe(false)
  })

  it('rejette un purpose invalide', () => {
    expect(validateProbeRequest({ ...valid, purpose: 'unknown' }).ok).toBe(false)
  })

  it('rejette un probeId manquant', () => {
    expect(validateProbeRequest({ ...valid, probeId: '' }).ok).toBe(false)
  })
})

describe('validateProbeStructuredResponse', () => {
  it('accepte une réponse structurée complète', () => {
    const res = validateProbeStructuredResponse({
      answer: 'Une voiture rouge est visible.',
      observations: ['plaque non lisible'],
      confidence: 0.8,
      limitations: ['image floue'],
    })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.answer).toContain('voiture')
      expect(res.value.confidence).toBe(0.8)
    }
  })

  it('rejette une réponse vide (answer manquant)', () => {
    expect(validateProbeStructuredResponse({ confidence: 0.5 }).ok).toBe(false)
  })

  it('rejette answer vide après normalisation', () => {
    expect(validateProbeStructuredResponse({ answer: '   ', confidence: 0.5 }).ok).toBe(false)
  })

  it('borne confidence dans [0,1] plutôt que de rejeter une valeur légèrement hors bornes', () => {
    const res = validateProbeStructuredResponse({ answer: 'x', confidence: 1.4 })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.value.confidence).toBe(1)
  })

  it('tolère observations/limitations absents (tableaux vides par défaut)', () => {
    const res = validateProbeStructuredResponse({ answer: 'x', confidence: 0.3 })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.value.observations).toEqual([])
      expect(res.value.limitations).toEqual([])
    }
  })

  it('rejette confidence manquant ou non numérique', () => {
    expect(validateProbeStructuredResponse({ answer: 'x' }).ok).toBe(false)
    expect(validateProbeStructuredResponse({ answer: 'x', confidence: 'haute' }).ok).toBe(false)
  })
})

describe('isTerminalProbeStatus', () => {
  it('identifie les statuts terminaux', () => {
    expect(isTerminalProbeStatus('succeeded')).toBe(true)
    expect(isTerminalProbeStatus('missed')).toBe(true)
    expect(isTerminalProbeStatus('unavailable')).toBe(true)
    expect(isTerminalProbeStatus('failed')).toBe(true)
    expect(isTerminalProbeStatus('cancelled')).toBe(true)
    expect(isTerminalProbeStatus('scheduled')).toBe(false)
    expect(isTerminalProbeStatus('waiting')).toBe(false)
    expect(isTerminalProbeStatus('analyzing')).toBe(false)
  })
})
