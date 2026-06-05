const { app, BrowserWindow, ipcMain, safeStorage, shell, net } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const Store = require('electron-store')

const MODEL = 'llama3.2:3b'
const SYSTEM_PROMPT = 'You are WAZIER, a personal AI assistant running locally on the user\'s device. You are private, helpful, and direct.'
const RETENTION_DAYS = 7
const OLLAMA = 'http://localhost:11434'

let store = null
let mainWindow = null

// ── Encryption key via OS keychain ────────────────────────────────────────────

function getEncryptionKey() {
  const keyFile = path.join(app.getPath('userData'), '.wazier.key')
  if (fs.existsSync(keyFile)) {
    const buf = fs.readFileSync(keyFile)
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf8')
  }
  const key = crypto.randomBytes(32).toString('hex')
  const toStore = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(key)
    : Buffer.from(key, 'utf8')
  fs.mkdirSync(path.dirname(keyFile), { recursive: true })
  fs.writeFileSync(keyFile, toStore)
  return key
}

function initStore() {
  store = new Store({ encryptionKey: getEncryptionKey(), name: 'history' })
  if (!store.has('sessions')) store.set('sessions', [])
}

// ── Window ─────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 700,
    minHeight: 500,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#111111',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(() => {
  initStore()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ── Ollama helpers using electron.net ──────────────────────────────────────────

function netGet(url) {
  return new Promise((resolve) => {
    try {
      const req = net.request({ method: 'GET', url })
      const timer = setTimeout(() => { try { req.abort() } catch {} resolve(null) }, 3000)
      req.on('response', (res) => {
        clearTimeout(timer)
        let raw = ''
        res.on('data', chunk => { raw += chunk.toString() })
        res.on('end', () => resolve({ status: res.statusCode, body: raw }))
      })
      req.on('error', () => { clearTimeout(timer); resolve(null) })
      req.end()
    } catch (e) { resolve(null) }
  })
}

function netPost(url, body, onChunk) {
  return new Promise((resolve, reject) => {
    try {
      const req = net.request({ method: 'POST', url })
      req.setHeader('Content-Type', 'application/json')
      req.on('response', (res) => {
        let full = ''
        res.on('data', chunk => {
          const str = chunk.toString()
          full += str
          if (onChunk) onChunk(str)
        })
        res.on('end', () => resolve(full))
      })
      req.on('error', reject)
      req.write(JSON.stringify(body))
      req.end()
    } catch (e) { reject(e) }
  })
}

async function checkOllama() {
  const res = await netGet(`${OLLAMA}/`)
  return res !== null && res.status === 200
}

async function checkModel() {
  const res = await netGet(`${OLLAMA}/api/tags`)
  if (!res) return false
  try {
    const { models } = JSON.parse(res.body)
    return models.some(m => m.name.startsWith('llama3.2:3b'))
  } catch { return false }
}

// ── IPC: Setup ─────────────────────────────────────────────────────────────────

ipcMain.handle('setup:check', async () => {
  const ollamaRunning = await checkOllama()
  if (!ollamaRunning) return { status: 'no-ollama' }
  const modelReady = await checkModel()
  if (!modelReady) return { status: 'no-model' }
  return { status: 'ready' }
})

ipcMain.handle('setup:pull-model', async () => {
  await netPost(`${OLLAMA}/api/pull`, { name: MODEL, stream: true }, (chunk) => {
    const lines = chunk.split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        if (obj.total && obj.completed) {
          const pct = Math.round((obj.completed / obj.total) * 100)
          mainWindow.webContents.send('setup:pull-progress', pct)
        }
      } catch {}
    }
  })
})

ipcMain.handle('setup:open-ollama', () => {
  shell.openExternal('https://ollama.com')
})

ipcMain.handle('setup:launch-ollama', () => {
  const { spawn } = require('child_process')
  const ollamaPath = process.platform === 'win32' ? 'ollama.exe' : 'ollama'
  const proc = spawn(ollamaPath, ['serve'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  })
  proc.unref()
})

// ── IPC: Chat ──────────────────────────────────────────────────────────────────

ipcMain.handle('chat:send', async (event, messages) => {
  const full = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
  let fullResponse = ''

  await netPost(`${OLLAMA}/api/chat`, { model: MODEL, messages: full, stream: true }, (chunk) => {
    const lines = chunk.split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const obj = JSON.parse(line)
        const token = obj.message?.content || ''
        if (token) {
          fullResponse += token
          mainWindow.webContents.send('chat:token', token)
        }
      } catch {}
    }
  })

  return fullResponse
})

// ── IPC: Storage ───────────────────────────────────────────────────────────────

ipcMain.handle('storage:new-session', () => {
  const id = crypto.randomBytes(4).toString('hex')
  const sessions = store.get('sessions')
  sessions.push({ id, startedAt: new Date().toISOString(), important: false, messages: [] })
  store.set('sessions', sessions)
  return id
})

ipcMain.handle('storage:append', (event, { sessionId, role, content }) => {
  const sessions = store.get('sessions')
  const s = sessions.find(s => s.id === sessionId)
  if (s) { s.messages.push({ role, content }); store.set('sessions', sessions) }
})

ipcMain.handle('storage:list', () => {
  return store.get('sessions').map(s => ({
    id: s.id,
    startedAt: s.startedAt,
    important: s.important,
    messageCount: s.messages.length,
    preview: s.messages.find(m => m.role === 'user')?.content?.slice(0, 60) || '',
  }))
})

ipcMain.handle('storage:get-messages', (event, sessionId) => {
  const s = store.get('sessions').find(s => s.id === sessionId)
  return s ? s.messages : []
})

ipcMain.handle('storage:mark-important', (event, sessionId) => {
  const sessions = store.get('sessions')
  const s = sessions.find(s => s.id === sessionId)
  if (s) { s.important = true; store.set('sessions', sessions) }
})

ipcMain.handle('storage:clear-unimportant', () => {
  store.set('sessions', store.get('sessions').filter(s => s.important))
})

ipcMain.handle('storage:purge-old', () => {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  store.set('sessions', store.get('sessions').filter(s =>
    s.important || new Date(s.startedAt).getTime() >= cutoff
  ))
})
