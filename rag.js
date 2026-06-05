const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const CHUNK_SIZE = 800
const CHUNK_OVERLAP = 100
const TOP_K = 5
const EMBED_MODEL = 'nomic-embed-text'

// ── Text extraction ────────────────────────────────────────────────────────────

async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase()

  if (ext === '.txt' || ext === '.md') {
    return fs.readFileSync(filePath, 'utf8')
  }

  if (ext === '.pdf') {
    const PDFParser = require('pdf2json')
    return new Promise((resolve, reject) => {
      const parser = new PDFParser(null, true)
      parser.on('pdfParser_dataReady', () => {
        resolve(parser.getRawTextContent())
      })
      parser.on('pdfParser_dataError', err => reject(err.parserError))
      parser.loadPDF(filePath)
    })
  }

  if (ext === '.docx') {
    const mammoth = require('mammoth')
    const result = await mammoth.extractRawText({ path: filePath })
    return result.value
  }

  throw new Error(`Unsupported file type: ${ext}`)
}

// ── Chunking ───────────────────────────────────────────────────────────────────

function chunkText(text) {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  const chunks = []
  let i = 0
  while (i < cleaned.length) {
    chunks.push(cleaned.slice(i, i + CHUNK_SIZE))
    i += CHUNK_SIZE - CHUNK_OVERLAP
  }
  return chunks.filter(c => c.trim().length > 40)
}

// ── Embeddings via Ollama electron.net ────────────────────────────────────────

function embedText(text, netRequest) {
  return new Promise((resolve, reject) => {
    try {
      const req = netRequest({ method: 'POST', url: 'http://localhost:11434/api/embed' })
      req.setHeader('Content-Type', 'application/json')
      req.on('response', (res) => {
        let raw = ''
        res.on('data', chunk => { raw += chunk.toString() })
        res.on('end', () => {
          try {
            const { embeddings } = JSON.parse(raw)
            resolve(embeddings[0])
          } catch (e) { reject(e) }
        })
      })
      req.on('error', reject)
      req.write(JSON.stringify({ model: EMBED_MODEL, input: text }))
      req.end()
    } catch (e) { reject(e) }
  })
}

// ── Cosine similarity ──────────────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    magA += a[i] * a[i]
    magB += b[i] * b[i]
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB))
}

// ── Doc store (encrypted) ──────────────────────────────────────────────────────

class DocStore {
  constructor(storePath, encryptionKey) {
    this.storePath = storePath
    this.key = crypto.scryptSync(encryptionKey, 'wazier-rag-salt', 32)
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
  }

  _encrypt(data) {
    const iv = crypto.randomBytes(16)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv)
    const enc = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, enc]).toString('base64')
  }

  _decrypt(str) {
    const buf = Buffer.from(str, 'base64')
    const iv = buf.slice(0, 16)
    const tag = buf.slice(16, 32)
    const enc = buf.slice(32)
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv)
    decipher.setAuthTag(tag)
    return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8'))
  }

  load() {
    if (!fs.existsSync(this.storePath)) return { documents: [] }
    try { return this._decrypt(fs.readFileSync(this.storePath, 'utf8')) }
    catch { return { documents: [] } }
  }

  save(data) {
    fs.writeFileSync(this.storePath, this._encrypt(data), 'utf8')
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function addDocument(filePath, docStore, netRequest, onProgress) {
  const name = path.basename(filePath)
  onProgress('Extracting text…')
  const text = await extractText(filePath)

  onProgress('Chunking…')
  const chunks = chunkText(text)

  const embedded = []
  for (let i = 0; i < chunks.length; i++) {
    onProgress(`Embedding ${i + 1} / ${chunks.length}…`)
    const embedding = await embedText(chunks[i], netRequest)
    embedded.push({ text: chunks[i], embedding })
  }

  const data = docStore.load()
  const id = crypto.randomBytes(4).toString('hex')
  data.documents.push({ id, name, uploadedAt: new Date().toISOString(), chunks: embedded })
  docStore.save(data)
  return { id, name, chunkCount: embedded.length }
}

function listDocuments(docStore) {
  const data = docStore.load()
  return data.documents.map(d => ({
    id: d.id, name: d.name, uploadedAt: d.uploadedAt, chunkCount: d.chunks.length,
  }))
}

function deleteDocument(id, docStore) {
  const data = docStore.load()
  data.documents = data.documents.filter(d => d.id !== id)
  docStore.save(data)
}

async function retrieveContext(query, docStore, netRequest) {
  const data = docStore.load()
  if (!data.documents.length) return ''

  const qEmbedding = await embedText(query, netRequest)

  const scored = []
  for (const doc of data.documents) {
    for (const chunk of doc.chunks) {
      scored.push({ text: chunk.text, score: cosine(qEmbedding, chunk.embedding), doc: doc.name })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  const top = scored.slice(0, TOP_K).filter(s => s.score > 0.3)
  if (!top.length) return ''

  return `The following excerpts from the user's documents are relevant to their question:\n\n` +
    top.map(s => `[${s.doc}]\n${s.text}`).join('\n\n---\n\n') + '\n\n'
}

async function addRawText(name, text, docStore, netRequest, onProgress) {
  const chunks = chunkText(text)
  const embedded = []
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(`Embedding ${i + 1}/${chunks.length}…`)
    const embedding = await embedText(chunks[i], netRequest)
    embedded.push({ text: chunks[i], embedding })
  }
  const data = docStore.load()
  const id = crypto.randomBytes(4).toString('hex')
  data.documents.push({ id, name, uploadedAt: new Date().toISOString(), chunks: embedded, auto: true })
  docStore.save(data)
  return id
}

module.exports = { DocStore, addDocument, addRawText, listDocuments, deleteDocument, retrieveContext }
