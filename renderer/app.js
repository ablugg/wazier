const api = window.wazier

let sessionId = null
let history = []
let isGenerating = false
let voiceMode = false
let recognition = null

// ── Setup flow ─────────────────────────────────────────────────────────────────

async function runSetup() {
  show('setup-screen')
  setStatus('Checking…')
  setActions('')

  let result
  try {
    result = await api.checkSetup()
  } catch (e) {
    setStatus('Something went wrong. Make sure Ollama is installed and try again.')
    setActions(`<button class="btn btn-primary" onclick="runSetup()">Retry</button>`)
    return
  }

  const { status } = result

  if (status === 'no-ollama') {
    setStatus('Ollama isn\'t running. Click Start Ollama — no window will open, it runs quietly in the background.')
    setActions(`
      <button class="btn btn-primary" onclick="launchOllama()">Start Ollama</button>
      <button class="btn btn-ghost" onclick="openOllama()">Download Ollama</button>
    `)
    return
  }

  if (status === 'no-model') {
    setStatus('Almost ready. The AI model needs to download once (~2 GB).')
    setActions(`<button class="btn btn-primary" onclick="pullModel()">Download Model</button>`)
    return
  }

  launchApp()
}

function setStatus(msg) {
  document.getElementById('setup-status').textContent = msg
}

function setActions(html) {
  document.getElementById('setup-actions').innerHTML = html
}

window.openOllama = () => api.openOllama()

window.launchOllama = async () => {
  setActions('')
  setStatus('Starting Ollama in the background…')
  await api.launchOllama()

  let attempts = 0
  const poll = setInterval(async () => {
    attempts++
    const { status } = await api.checkSetup()
    if (status !== 'no-ollama') {
      clearInterval(poll)
      runSetup()
      return
    }
    setStatus(`Starting Ollama… (${attempts}s)`)
    if (attempts >= 20) {
      clearInterval(poll)
      setStatus('Ollama is taking a while. Is it installed? Try downloading it below.')
      setActions(`
        <button class="btn btn-primary" onclick="launchOllama()">Try Again</button>
        <button class="btn btn-ghost" onclick="openOllama()">Download Ollama</button>
      `)
    }
  }, 1000)
}

window.pullModel = async () => {
  setActions('')
  setStatus('Downloading — this only happens once.')
  document.getElementById('progress-wrap').classList.remove('hidden')

  api.onPullProgress(pct => {
    document.getElementById('progress-pct').textContent = pct + '%'
    document.getElementById('progress-fill').style.width = pct + '%'
  })

  await api.pullModel()
  launchApp()
}

// ── App launch ─────────────────────────────────────────────────────────────────

async function launchApp() {
  await api.purgeOld()
  show('app-screen')
  await Promise.all([loadSidebar(), loadDocs()])
  startNewChat()
  checkForUpdate()
}

async function checkForUpdate() {
  const latest = await api.checkForUpdate()
  if (!latest) return
  const btn = document.getElementById('update-btn')
  btn.textContent = `⬇ Update v${latest} available`
  btn.classList.add('visible')
  btn.addEventListener('click', () => api.openUpdate())
}

// ── Sidebar ────────────────────────────────────────────────────────────────────

async function loadSidebar() {
  const sessions = await api.listSessions()
  const list = document.getElementById('session-list')
  list.innerHTML = ''
  ;[...sessions].reverse().forEach(s => {
    const el = document.createElement('div')
    el.className = 'session-item' + (s.id === sessionId ? ' active' : '')
    el.dataset.id = s.id
    const date = new Date(s.startedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    el.innerHTML = `
      <div class="session-date">${date}</div>
      <div class="session-preview">${s.preview || 'New conversation'}</div>
      ${s.important ? '<div class="session-saved">★ Saved</div>' : ''}
    `
    el.addEventListener('click', () => loadSession(s.id))
    list.appendChild(el)
  })
}

async function loadSession(id) {
  if (isGenerating) return
  sessionId = id
  history = await api.getMessages(id)
  renderMessages()
  await loadSidebar()
}

// ── New chat ───────────────────────────────────────────────────────────────────

async function startNewChat() {
  if (isGenerating) return
  sessionId = await api.newSession()
  history = []
  renderMessages()
  await loadSidebar()
  document.getElementById('input').focus()
}

// ── Messages ───────────────────────────────────────────────────────────────────

function renderMessages() {
  const container = document.getElementById('messages')
  container.innerHTML = ''

  if (history.length === 0) {
    container.innerHTML = '<div id="empty-state"><div class="big">WAZIER</div><div class="sub">How can I help you today?</div></div>'
    return
  }

  history.forEach(m => addBubble(m.role, m.content))
  container.scrollTop = container.scrollHeight
}

function addBubble(role, content) {
  const container = document.getElementById('messages')
  const empty = document.getElementById('empty-state')
  if (empty) empty.remove()

  const wrap = document.createElement('div')
  wrap.className = `message ${role}`
  wrap.innerHTML = `
    <div class="avatar">${role === 'user' ? 'YOU' : 'W'}</div>
    <div class="bubble">${escapeHtml(content)}</div>
  `
  container.appendChild(wrap)
  container.scrollTop = container.scrollHeight
  return wrap.querySelector('.bubble')
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// ── Send message ───────────────────────────────────────────────────────────────

async function sendMessage(text) {
  if (!text.trim() || isGenerating) return
  isGenerating = true
  setSendDisabled(true)

  history.push({ role: 'user', content: text })
  await api.appendMessage(sessionId, 'user', text)
  addBubble('user', text)

  const bubble = addBubble('assistant', '')
  const cursor = document.createElement('span')
  cursor.className = 'cursor'
  bubble.appendChild(cursor)

  let response = ''
  api.offToken()
  api.onToken(token => {
    response += token
    bubble.textContent = response
    bubble.appendChild(cursor)
    document.getElementById('messages').scrollTop = document.getElementById('messages').scrollHeight
  })

  await api.sendMessage(history)
  cursor.remove()

  history.push({ role: 'assistant', content: response })
  await api.appendMessage(sessionId, 'assistant', response)
  await loadSidebar()

  if (voiceMode) speak(response)

  isGenerating = false
  setSendDisabled(false)
  document.getElementById('input').focus()
}

function setSendDisabled(val) {
  document.getElementById('send-btn').disabled = val
}

// ── Input handling ─────────────────────────────────────────────────────────────

const inputEl = document.getElementById('input')

inputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const text = inputEl.value.trim()
    inputEl.value = ''
    inputEl.style.height = 'auto'
    sendMessage(text)
  }
})

inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto'
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px'
})

document.getElementById('send-btn').addEventListener('click', () => {
  const text = inputEl.value.trim()
  inputEl.value = ''
  inputEl.style.height = 'auto'
  sendMessage(text)
})

document.getElementById('new-chat-btn').addEventListener('click', startNewChat)

document.getElementById('save-btn').addEventListener('click', async () => {
  await api.markImportant(sessionId)
  await loadSidebar()
  document.getElementById('save-btn').classList.add('active')
  document.getElementById('save-btn').title = 'Saved forever'
})

// ── Sidebar tabs ───────────────────────────────────────────────────────────────

document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'))
    tab.classList.add('active')
    const target = tab.dataset.tab
    document.getElementById('session-list').classList.toggle('hidden', target !== 'chats')
    document.getElementById('docs-panel').classList.toggle('hidden', target !== 'docs')
  })
})

// ── Docs ───────────────────────────────────────────────────────────────────────

async function loadDocs() {
  const docs = await api.listDocs()
  const list = document.getElementById('doc-list')
  list.innerHTML = ''

  if (docs.length) {
    const indicator = document.createElement('div')
    indicator.className = 'rag-indicator'
    indicator.textContent = `${docs.length} doc${docs.length > 1 ? 's' : ''} active in library`
    list.appendChild(indicator)
  }

  docs.forEach(doc => {
    const el = document.createElement('div')
    el.className = 'doc-item'
    const date = new Date(doc.uploadedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    el.innerHTML = `
      <div class="doc-info">
        <div class="doc-name">${doc.name}</div>
        <div class="doc-meta">${doc.chunkCount} chunks · ${date}</div>
      </div>
      <button class="doc-delete" title="Remove">✕</button>
    `
    el.querySelector('.doc-delete').addEventListener('click', async () => {
      await api.deleteDoc(doc.id)
      loadDocs()
    })
    list.appendChild(el)
  })
}

document.getElementById('upload-doc-btn').addEventListener('click', async () => {
  const paths = await api.openDocDialog()
  if (!paths.length) return

  const btn = document.getElementById('upload-doc-btn')
  const progress = document.getElementById('doc-progress')
  btn.disabled = true
  progress.classList.remove('hidden')

  api.offDocProgress()
  api.onDocProgress(msg => { progress.textContent = msg })

  for (const filePath of paths) {
    try {
      await api.addDoc(filePath)
    } catch (e) {
      progress.textContent = `Failed: ${e.message}`
      await new Promise(r => setTimeout(r, 3000))
    }
  }

  btn.disabled = false
  progress.classList.add('hidden')
  api.offDocProgress()
  loadDocs()
})

document.getElementById('clear-btn').addEventListener('click', async () => {
  if (confirm('Delete all non-saved history?')) {
    await api.clearUnimportant()
    sessionId = await api.newSession()
    history = []
    renderMessages()
    await loadSidebar()
  }
})

// ── Voice ──────────────────────────────────────────────────────────────────────

function speak(text) {
  const utter = new SpeechSynthesisUtterance(text)
  utter.rate = 1.05
  window.speechSynthesis.speak(utter)
}

function setupVoice() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SpeechRecognition) return

  recognition = new SpeechRecognition()
  recognition.continuous = false
  recognition.interimResults = false
  recognition.lang = 'en-US'

  recognition.onresult = (e) => {
    const transcript = e.results[0][0].transcript
    inputEl.value = transcript
    document.getElementById('voice-indicator').classList.add('hidden')
    document.getElementById('mic-btn').classList.remove('active')
    sendMessage(transcript)
    inputEl.value = ''
  }

  recognition.onerror = () => {
    document.getElementById('voice-indicator').classList.add('hidden')
    document.getElementById('mic-btn').classList.remove('active')
  }

  recognition.onend = () => {
    document.getElementById('voice-indicator').classList.add('hidden')
    document.getElementById('mic-btn').classList.remove('active')
  }
}

document.getElementById('mic-btn').addEventListener('click', () => {
  if (!recognition) { setupVoice() }
  if (!recognition) return

  voiceMode = !voiceMode
  document.getElementById('mic-btn').classList.toggle('active', voiceMode)

  if (voiceMode) {
    document.getElementById('voice-indicator').classList.remove('hidden')
    recognition.start()
  } else {
    document.getElementById('voice-indicator').classList.add('hidden')
    recognition.stop()
    window.speechSynthesis.cancel()
  }
})

// ── Utilities ──────────────────────────────────────────────────────────────────

function show(id) {
  document.getElementById('setup-screen').classList.add('hidden')
  document.getElementById('app-screen').classList.add('hidden')
  document.getElementById(id).classList.remove('hidden')
}

// ── Boot ───────────────────────────────────────────────────────────────────────

runSetup()
