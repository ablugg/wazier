const { addRawText } = require('./rag')

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours

const SOURCES = [
  { id: 'wikipedia', name: 'Wikipedia Daily' },
  { id: 'hackernews', name: 'Hacker News' },
]

// ── HTTP helper ────────────────────────────────────────────────────────────────

function get(url, netRequest) {
  return new Promise(resolve => {
    try {
      const req = netRequest({ method: 'GET', url })
      req.setHeader('User-Agent', 'Wazier/1.0')
      req.setHeader('Accept', 'application/json')
      const t = setTimeout(() => { try { req.abort() } catch {} resolve(null) }, 12000)
      req.on('response', res => {
        clearTimeout(t)
        let raw = ''
        res.on('data', c => { raw += c.toString() })
        res.on('end', () => resolve(res.statusCode === 200 ? raw : null))
      })
      req.on('error', () => { clearTimeout(t); resolve(null) })
      req.end()
    } catch { resolve(null) }
  })
}

// ── Fetchers ───────────────────────────────────────────────────────────────────

async function fetchWikipedia(netRequest) {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const raw = await get(`https://en.wikipedia.org/api/rest_v1/feed/featured/${y}/${m}/${d}`, netRequest)
  if (!raw) return ''

  try {
    const data = JSON.parse(raw)
    const parts = []

    if (data.tfa?.extract) {
      parts.push(`Featured Article: ${data.tfa.title}\n${data.tfa.extract}`)
    }
    if (data.news?.length) {
      const stories = data.news.map(n => n.story.replace(/<[^>]*>/g, '').trim()).join('\n')
      parts.push(`In the News (${y}-${m}-${d}):\n${stories}`)
    }
    if (data.mostread?.articles) {
      data.mostread.articles.slice(0, 8).forEach(a => {
        if (a.extract) parts.push(`${a.title}:\n${a.extract}`)
      })
    }

    return parts.join('\n\n---\n\n')
  } catch { return '' }
}

async function fetchHackerNews(netRequest) {
  const raw = await get('https://hacker-news.firebaseio.com/v0/topstories.json', netRequest)
  if (!raw) return ''

  try {
    const ids = JSON.parse(raw).slice(0, 10)
    const stories = []

    for (const id of ids) {
      const s = await get(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, netRequest)
      if (!s) continue
      const item = JSON.parse(s)
      if (!item?.title) continue
      let entry = item.title
      if (item.url) entry += ` — ${item.url}`
      if (item.text) entry += '\n' + item.text.replace(/<[^>]*>/g, '').slice(0, 600)
      stories.push(entry)
    }

    return stories.length ? `Hacker News Top Stories:\n\n${stories.join('\n\n')}` : ''
  } catch { return '' }
}

// ── Sync engine ────────────────────────────────────────────────────────────────

function getSyncState(store) {
  return store.get('sync') || {
    lastSync: null,
    sources: SOURCES.map(s => ({ ...s, enabled: true, docId: null })),
  }
}

function saveSyncState(store, state) {
  store.set('sync', state)
}

async function runSync(store, docStore, netRequest, onProgress) {
  const state = getSyncState(store)

  for (const source of state.sources) {
    if (!source.enabled) continue

    onProgress(`Fetching ${source.name}…`)

    // Remove old synced doc for this source
    if (source.docId) {
      const data = docStore.load()
      data.documents = data.documents.filter(d => d.id !== source.docId)
      docStore.save(data)
      source.docId = null
    }

    let text = ''
    try {
      if (source.id === 'wikipedia') text = await fetchWikipedia(netRequest)
      if (source.id === 'hackernews') text = await fetchHackerNews(netRequest)
    } catch {}

    if (!text.trim()) { onProgress(`${source.name}: nothing to sync`); continue }

    try {
      onProgress(`Embedding ${source.name}…`)
      const id = await addRawText(
        `[Auto] ${source.name} — ${new Date().toLocaleDateString()}`,
        text, docStore, netRequest,
        msg => onProgress(msg)
      )
      source.docId = id
    } catch (e) {
      onProgress(`${source.name} embed failed: ${e.message}`)
    }
  }

  state.lastSync = new Date().toISOString()
  saveSyncState(store, state)
  onProgress('Sync complete')
}

function isDue(store) {
  const state = getSyncState(store)
  if (!state.lastSync) return true
  return Date.now() - new Date(state.lastSync).getTime() > SYNC_INTERVAL_MS
}

function getStatus(store) {
  const state = getSyncState(store)
  return {
    lastSync: state.lastSync,
    sources: state.sources,
  }
}

function toggleSource(store, sourceId, enabled) {
  const state = getSyncState(store)
  const s = state.sources.find(s => s.id === sourceId)
  if (s) s.enabled = enabled
  saveSyncState(store, state)
}

module.exports = { runSync, isDue, getStatus, toggleSource, SOURCES }
