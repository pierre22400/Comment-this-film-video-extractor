// Relais serveur HTTP local (développement). Écoute uniquement sur l'interface
// locale (127.0.0.1 par défaut). Lit la clé Gemini depuis l'environnement et ne
// la renvoie jamais au client. Ne journalise JAMAIS le contenu base64 des images.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { loadConfig } from './config'
import { createGeminiClient } from './geminiClient'
import { handleDescribe, type RelayResult } from './describeHandler'
import { MAX_REQUEST_BODY_LENGTH } from '../src/lib/analysis'

const config = loadConfig()

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

function sendJson(res: ServerResponse, result: RelayResult): void {
  const payload = JSON.stringify(result.json)
  res.writeHead(result.status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS_HEADERS,
  })
  res.end(payload)
}

function readBody(req: IncomingMessage): Promise<{ tooLarge: boolean; raw: string }> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_REQUEST_BODY_LENGTH) {
        resolve({ tooLarge: true, raw: '' })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve({ tooLarge: false, raw: Buffer.concat(chunks).toString('utf8') }))
    req.on('error', reject)
  })
}

const server = createServer((req, res) => {
  const started = Date.now()
  const method = req.method ?? 'GET'
  const url = req.url ?? '/'

  const done = (result: RelayResult, snapshotId?: number) => {
    sendJson(res, result)
    // Journalisation minimale : jamais d'image, jamais de clé.
    const idPart = snapshotId !== undefined ? ` snapshot=${snapshotId}` : ''
    console.log(`[relay] ${method} ${url} -> ${result.status}${idPart} (${Date.now() - started}ms)`)
  }

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }

  if (url !== '/api/describe') {
    done({ status: 404, json: { error: { code: 'NOT_FOUND', message: 'Route inconnue.', retryable: false } } })
    return
  }

  void (async () => {
    // Clé absente : réponse claire, non retentable. La capture locale n'est pas affectée.
    if (!config.apiKey) {
      done({
        status: 500,
        json: {
          error: {
            code: 'SERVER_NOT_CONFIGURED',
            message: 'GEMINI_API_KEY absente côté serveur.',
            retryable: false,
          },
        },
      })
      return
    }

    let parsed: unknown = undefined
    if (method === 'POST') {
      const { tooLarge, raw } = await readBody(req)
      if (tooLarge) {
        done({
          status: 413,
          json: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'Requête trop volumineuse.', retryable: false } },
        })
        return
      }
      try {
        parsed = raw ? JSON.parse(raw) : undefined
      } catch {
        done({
          status: 400,
          json: { error: { code: 'INVALID_REQUEST', message: 'JSON invalide.', retryable: false } },
        })
        return
      }
    }

    const gemini = createGeminiClient({ apiKey: config.apiKey, model: config.model })
    const result = await handleDescribe(
      { method, contentType: req.headers['content-type'], body: parsed },
      gemini,
    )
    const snapshotId =
      parsed && typeof parsed === 'object' && 'snapshotId' in parsed
        ? (parsed as { snapshotId?: number }).snapshotId
        : undefined
    done(result, snapshotId)
  })()
})

server.listen(config.port, config.host, () => {
  console.log(`[relay] Comment-this-film — relais Gemini`)
  console.log(`[relay] écoute sur http://${config.host}:${config.port}/api/describe`)
  console.log(`[relay] modèle: ${config.model}`)
  console.log(`[relay] clé Gemini: ${config.apiKey ? 'configurée' : 'ABSENTE (définir GEMINI_API_KEY)'}`)
})
