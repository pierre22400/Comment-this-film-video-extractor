import { describe, it, expect } from 'vitest'
import { detectPlatform } from '../src/lib/platform'

describe('detectPlatform', () => {
  it('reconnaît YouTube', () => {
    expect(detectPlatform('https://www.youtube.com/watch?v=abc')).toBe('youtube')
    expect(detectPlatform('https://youtu.be/abc')).toBe('youtube')
    expect(detectPlatform('https://m.youtube.com/watch?v=abc')).toBe('youtube')
  })

  it('reconnaît Prime Video', () => {
    expect(detectPlatform('https://www.primevideo.com/detail/xyz')).toBe('prime')
    expect(detectPlatform('https://www.amazon.com/gp/video/detail/xyz')).toBe('prime')
  })

  it('repli HTML5 générique pour les autres URL', () => {
    expect(detectPlatform('https://example.com/video')).toBe('html5')
    expect(detectPlatform('https://vimeo.com/12345')).toBe('html5')
  })

  it('repli HTML5 pour une URL vide, nulle ou invalide', () => {
    expect(detectPlatform('')).toBe('html5')
    expect(detectPlatform(null)).toBe('html5')
    expect(detectPlatform(undefined)).toBe('html5')
    expect(detectPlatform('pas-une-url')).toBe('html5')
  })
})
