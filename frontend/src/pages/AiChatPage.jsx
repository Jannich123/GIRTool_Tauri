import { useEffect, useRef, useState } from 'react'
import { invoke } from '../tauri-api'

// AI assistant chat (issue #300) — runs in its own pop-out window (App routes
// ?page=ai here with no sidebar).  Provider-agnostic: talks to any
// OpenAI-compatible /chat/completions endpoint configured in the ⚙ panel.

const PROVIDER_HINTS = [
  ['OpenAI',   'https://api.openai.com/v1',        'gpt-4o-mini'],
  ['Groq',     'https://api.groq.com/openai/v1',   'llama-3.3-70b-versatile'],
  ['Together', 'https://api.together.xyz/v1',      'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  ['OpenRouter', 'https://openrouter.ai/api/v1',   'anthropic/claude-3.5-sonnet'],
  ['Ollama (local)', 'http://localhost:11434/v1',  'llama3.1'],
]

const EMPTY_CFG = {
  chat: { base_url: '', api_key: '', model: '' },
  embeddings: { base_url: '', api_key: '', model: '' },
  system_prompt: '',
}

export default function AiChatPage() {
  const [cfg, setCfg]           = useState(EMPTY_CFG)
  const [showConfig, setShowConfig] = useState(false)
  const [savedMsg, setSavedMsg] = useState('')
  const [agentsMd, setAgentsMd] = useState(null) // lazy preprompt preview

  const [messages, setMessages] = useState([])    // [{role, content}]
  const [input, setInput]       = useState('')
  const [attachments, setAttach] = useState([])    // [{name, text, truncated}]
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')
  const [ragStatus, setRagStatus] = useState(null)
  const [embedding, setEmbedding] = useState(false)

  const endRef = useRef(null)

  const refreshRag = () => invoke('ai_rag_status').then(setRagStatus).catch(() => setRagStatus(null))
  useEffect(() => { refreshRag() }, [])

  useEffect(() => {
    invoke('get_ai_config')
      .then(c => {
        const merged = { ...EMPTY_CFG, ...(c || {}) }
        merged.chat = { ...EMPTY_CFG.chat, ...(c?.chat || {}) }
        merged.embeddings = { ...EMPTY_CFG.embeddings, ...(c?.embeddings || {}) }
        setCfg(merged)
        // First run with nothing configured → open the panel so the user sets it up.
        if (!merged.chat.base_url || !merged.chat.model) setShowConfig(true)
      })
      .catch(() => setShowConfig(true))
  }, [])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])

  const patchChat = (patch) => setCfg(c => ({ ...c, chat: { ...c.chat, ...patch } }))
  const patchEmb  = (patch) => setCfg(c => ({ ...c, embeddings: { ...c.embeddings, ...patch } }))

  async function saveConfig() {
    setSavedMsg('')
    try {
      await invoke('save_ai_config', { config: cfg })
      setSavedMsg('Saved ✓')
      refreshRag()
      setTimeout(() => setSavedMsg(''), 2500)
    } catch (e) {
      setSavedMsg(String(e).slice(0, 120))
    }
  }

  // Embed the bundled knowledge so RAG can search it (uses the embeddings API).
  async function buildEmbeddings() {
    setEmbedding(true); setSavedMsg('')
    try {
      await invoke('save_ai_config', { config: cfg })
      const r = await invoke('ai_rebuild_embeddings')
      setSavedMsg(`Embedded ${r.chunk_count} chunks ✓`)
      await refreshRag()
    } catch (e) {
      setSavedMsg(String(e).slice(0, 180))
    } finally {
      setEmbedding(false)
    }
  }

  async function togglePreprompt() {
    if (agentsMd != null) { setAgentsMd(null); return }
    try { setAgentsMd(await invoke('get_agents_md')) }
    catch { setAgentsMd('(could not load AGENTS.md)') }
  }

  async function attachFile() {
    setError('')
    try {
      const f = await invoke('ai_pick_file')
      if (f) setAttach(a => [...a, f])
    } catch (e) {
      setError(String(e).slice(0, 160))
    }
  }

  function buildUserContent(text) {
    if (!attachments.length) return text
    const parts = attachments.map(a =>
      `Attached file "${a.name}"${a.truncated ? ' (truncated)' : ''}:\n\`\`\`\n${a.text}\n\`\`\``)
    return `${parts.join('\n\n')}${text.trim() ? `\n\n${text}` : ''}`
  }

  async function send() {
    const text = input.trim()
    if ((!text && !attachments.length) || busy) return
    setError('')
    const userMsg = { role: 'user', content: buildUserContent(text), display: text || `📎 ${attachments.map(a => a.name).join(', ')}` }
    const next = [...messages, userMsg]
    setMessages(next)
    setInput(''); setAttach([])
    setBusy(true)
    try {
      // Send role/content only (the backend prepends the system preprompt).
      const reply = await invoke('ai_chat', { messages: next.map(m => ({ role: m.role, content: m.content })) })
      setMessages(m => [...m, { role: 'assistant', content: reply }])
    } catch (e) {
      setError(String(e).slice(0, 300))
      setMessages(m => [...m, { role: 'assistant', content: '', error: true }])
    } finally {
      setBusy(false)
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
  }

  const configReady = cfg.chat.base_url.trim() && cfg.chat.model.trim()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', maxHeight: '100vh', background: '#f8fafc' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '.6rem', padding: '.6rem .9rem', borderBottom: '1px solid #e2e8f0', background: '#fff' }}>
        <strong style={{ fontSize: '1rem' }}>🤖 GIRTool assistant</strong>
        <span style={{ fontSize: '.78rem', color: configReady ? '#16a34a' : '#dc2626' }}>
          {configReady ? `${cfg.chat.model}` : 'not configured'}
        </span>
        <div style={{ flex: 1 }} />
        {messages.length > 0 && (
          <button className="btn-secondary btn-sm" onClick={() => { setMessages([]); setError('') }} title="Clear the conversation">🗑 Clear</button>
        )}
        <button className="btn-secondary btn-sm" onClick={() => setShowConfig(s => !s)} title="Connection settings">⚙ Connection</button>
      </div>

      {/* Config panel */}
      {showConfig && (
        <div style={{ padding: '.8rem .9rem', borderBottom: '1px solid #e2e8f0', background: '#fff', fontSize: '.83rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '.45rem .7rem', alignItems: 'center', maxWidth: 760 }}>
            <label>API base URL</label>
            <input value={cfg.chat.base_url} onChange={e => patchChat({ base_url: e.target.value })}
              placeholder="https://api.openai.com/v1" style={{ width: '100%' }} />
            <label>API key</label>
            <input type="password" value={cfg.chat.api_key} onChange={e => patchChat({ api_key: e.target.value })}
              placeholder="sk-…  (left blank for local servers)" style={{ width: '100%' }} />
            <label>Model</label>
            <input value={cfg.chat.model} onChange={e => patchChat({ model: e.target.value })}
              placeholder="gpt-4o-mini" style={{ width: '100%' }} />
            <label style={{ alignSelf: 'start', paddingTop: '.3rem' }}>System prompt</label>
            <textarea value={cfg.system_prompt} onChange={e => setCfg(c => ({ ...c, system_prompt: e.target.value }))}
              placeholder="Optional — appended to AGENTS.md (the base preprompt)."
              rows={2} style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }} />

            {/* Document search (RAG) — separate OpenAI-compatible embeddings endpoint. */}
            <div style={{ gridColumn: '1 / -1', marginTop: '.35rem', fontWeight: 600, color: '#475569' }}>
              Document search (RAG)
              <span className="hint" style={{ marginLeft: '.4rem', fontWeight: 400 }}>embeddings endpoint — searches the bundled knowledge documents</span>
            </div>
            <label>Embeddings URL</label>
            <input value={cfg.embeddings.base_url} onChange={e => patchEmb({ base_url: e.target.value })}
              placeholder="https://api.openai.com/v1  (can match the chat API)" style={{ width: '100%' }} />
            <label>Embeddings key</label>
            <input type="password" value={cfg.embeddings.api_key} onChange={e => patchEmb({ api_key: e.target.value })}
              placeholder="left blank to reuse a local server" style={{ width: '100%' }} />
            <label>Embeddings model</label>
            <input value={cfg.embeddings.model} onChange={e => patchEmb({ model: e.target.value })}
              placeholder="text-embedding-3-small" style={{ width: '100%' }} />
          </div>
          <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.55rem', flexWrap: 'wrap' }}>
            <button className="btn-primary btn-sm" onClick={saveConfig}>Save</button>
            <button className="btn-secondary btn-sm" onClick={togglePreprompt}>{agentsMd != null ? 'Hide' : 'Show'} preprompt</button>
            {savedMsg && <span style={{ color: savedMsg.startsWith('Saved') ? '#16a34a' : '#dc2626' }}>{savedMsg}</span>}
            <span style={{ flex: 1 }} />
            <span className="hint" style={{ margin: 0 }}>Works with any OpenAI-compatible API.</span>
          </div>
          <div className="hint" style={{ marginTop: '.4rem' }}>
            Examples — {PROVIDER_HINTS.map(([n, url, model], i) => (
              <span key={n}>
                {i > 0 ? ' · ' : ''}
                <button
                  onClick={() => patchChat({ base_url: url, model })}
                  title={`${url}  ·  ${model}`}
                  style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', padding: 0, font: 'inherit' }}
                >{n}</button>
              </span>
            ))}
          </div>
          {agentsMd != null && (
            <pre style={{ marginTop: '.5rem', maxHeight: 180, overflow: 'auto', background: '#f1f5f9', padding: '.5rem', borderRadius: 6, fontSize: '.74rem', whiteSpace: 'pre-wrap' }}>{agentsMd || '(no AGENTS.md found)'}</pre>
          )}
          {/* Knowledge / RAG status */}
          {ragStatus && (
            <div className="hint" style={{ marginTop: '.45rem', display: 'flex', alignItems: 'center', gap: '.4rem', flexWrap: 'wrap' }}>
              <span>
                📚 Knowledge: {ragStatus.chunk_count} chunk{ragStatus.chunk_count === 1 ? '' : 's'}
                {ragStatus.sources?.length ? ` from ${ragStatus.sources.length} document${ragStatus.sources.length === 1 ? '' : 's'}` : ''}
                {' · '}
                {ragStatus.chunk_count === 0
                  ? 'add files to resources/ai_knowledge/ then run scripts/index_knowledge.py'
                  : (ragStatus.embedded ? 'embedded ✓ (questions search these docs)' : 'not embedded yet')}
              </span>
              {ragStatus.chunk_count > 0 && (
                <button
                  className="btn-secondary btn-sm"
                  onClick={buildEmbeddings}
                  disabled={embedding || !cfg.embeddings.base_url.trim() || !cfg.embeddings.model.trim()}
                  title={!cfg.embeddings.base_url.trim() || !cfg.embeddings.model.trim() ? 'Set the embeddings URL + model first' : 'Embed the knowledge documents'}
                >
                  {embedding ? 'Embedding…' : (ragStatus.embedded ? 'Re-embed' : 'Build embeddings')}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Transcript */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '.7rem' }}>
        {messages.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', color: '#64748b', maxWidth: 420 }}>
            <div style={{ fontSize: '2rem', marginBottom: '.3rem' }}>🤖</div>
            Ask how to use GIRTool — e.g. <em>"How do I import CSV data in feet?"</em> or
            <em> "What does the CPT reduction do?"</em>
            {!configReady && <div style={{ marginTop: '.6rem', color: '#dc2626' }}>Set the API URL, key and model in ⚙ Connection first.</div>}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
            <div style={{
              padding: '.55rem .8rem', borderRadius: 12,
              background: m.role === 'user' ? '#2563eb' : (m.error ? '#fef2f2' : '#fff'),
              color: m.role === 'user' ? '#fff' : '#0f172a',
              border: m.role === 'user' ? 'none' : '1px solid #e2e8f0',
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '.87rem', lineHeight: 1.5,
            }}>
              {m.role === 'user' ? (m.display ?? m.content) : (m.error ? '⚠ (see error below)' : m.content)}
            </div>
          </div>
        ))}
        {busy && (
          <div style={{ alignSelf: 'flex-start', color: '#64748b', fontSize: '.85rem', padding: '.3rem .5rem' }}>
            <span className="ai-typing">thinking…</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '.4rem .9rem', background: '#fef2f2', color: '#b91c1c', fontSize: '.82rem', borderTop: '1px solid #fecaca' }}>
          {error}
        </div>
      )}

      {/* Attachments */}
      {attachments.length > 0 && (
        <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', padding: '.4rem .9rem 0' }}>
          {attachments.map((a, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '.3rem', background: '#e2e8f0', borderRadius: 999, padding: '.15rem .5rem', fontSize: '.78rem' }}>
              📎 {a.name}{a.truncated ? ' (truncated)' : ''}
              <span onClick={() => setAttach(arr => arr.filter((_, j) => j !== i))} style={{ cursor: 'pointer', opacity: .6 }}>✕</span>
            </span>
          ))}
        </div>
      )}

      {/* Input bar */}
      <div style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-end', padding: '.6rem .9rem', borderTop: '1px solid #e2e8f0', background: '#fff' }}>
        <button className="btn-secondary" onClick={attachFile} disabled={busy} title="Attach a text file as context">📎</button>
        <textarea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={configReady ? 'Ask a question…  (Enter to send, Shift+Enter for a new line)' : 'Configure the API in ⚙ Connection first…'}
          rows={1}
          style={{ flex: 1, resize: 'none', maxHeight: 140, padding: '.5rem .6rem', borderRadius: 8, border: '1px solid #cbd5e1', fontFamily: 'inherit', fontSize: '.9rem' }}
        />
        <button className="btn-primary" onClick={send} disabled={busy || (!input.trim() && !attachments.length)}>
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
