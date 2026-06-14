import { useEffect, useRef, useState } from 'react'
import { invoke } from '../tauri-api'

// AI assistant chat window (issues #300, #304) — its own pop-out (App routes
// ?page=ai here, no sidebar). The user only sees the chat, a list of past
// chats, and file insertion; the API tokens/model are set by the developer in
// the bundled resources/ai_config.json (or a %APPDATA% override), and the RAG
// knowledge lives in the repo — none of that is exposed here.

const newId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
const titleFrom = (text) => {
  const t = (text || '').trim().replace(/\s+/g, ' ')
  return t ? (t.length > 48 ? t.slice(0, 48) + '…' : t) : 'New chat'
}

export default function AiChatPage() {
  const [status, setStatus]     = useState(null) // { configured, model }
  const [chats, setChats]       = useState([])    // [{id, title, updated}]
  const [activeId, setActiveId] = useState(null)
  const [activeTitle, setActiveTitle] = useState('')

  const [messages, setMessages] = useState([])    // [{role, content, display?, error?}]
  const [input, setInput]       = useState('')
  const [attachments, setAttach] = useState([])    // [{name, text, truncated}]
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')

  const endRef = useRef(null)

  const refreshChats = () => invoke('ai_list_chats').then(c => setChats(Array.isArray(c) ? c : [])).catch(() => setChats([]))

  useEffect(() => {
    invoke('ai_status').then(setStatus).catch(() => setStatus({ configured: false, model: '' }))
    refreshChats()
  }, [])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy])

  function startNewChat() {
    setActiveId(null); setActiveTitle(''); setMessages([]); setInput(''); setAttach([]); setError('')
  }

  async function openChat(id) {
    setError('')
    try {
      const c = await invoke('ai_load_chat', { id })
      setActiveId(c.id); setActiveTitle(c.title || '')
      setMessages(Array.isArray(c.messages) ? c.messages : [])
      setInput(''); setAttach([])
    } catch (e) {
      setError(String(e).slice(0, 160))
    }
  }

  async function deleteChat(id, e) {
    e?.stopPropagation()
    try { await invoke('ai_delete_chat', { id }) } catch { /* ignore */ }
    await refreshChats()
    if (id === activeId) startNewChat()
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
    const display = text || `📎 ${attachments.map(a => a.name).join(', ')}`
    const userMsg = { role: 'user', content: buildUserContent(text), display }
    const next = [...messages, userMsg]
    setMessages(next)
    setInput(''); setAttach([])
    setBusy(true)
    try {
      const reply = await invoke('ai_chat', { messages: next.map(m => ({ role: m.role, content: m.content })) })
      const final = [...next, { role: 'assistant', content: reply }]
      setMessages(final)
      // Persist the conversation (create the chat on first reply).
      let id = activeId
      let title = activeTitle
      if (!id) { id = newId(); title = titleFrom(display); setActiveId(id); setActiveTitle(title) }
      await invoke('ai_save_chat', {
        chat: { id, title, messages: final.map(m => ({ role: m.role, content: m.content, display: m.display })) },
      })
      refreshChats()
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

  const configured = status?.configured

  return (
    <div style={{ display: 'flex', height: '100vh', maxHeight: '100vh', background: 'var(--light)' }}>
      {/* ── Left: chat list ─────────────────────────────────────────────── */}
      <aside style={{ width: 230, flex: '0 0 230px', borderRight: '1px solid var(--border)', background: 'var(--light)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '.6rem' }}>
          <button className="btn-primary" style={{ width: '100%' }} onClick={startNewChat}>＋ New chat</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 .4rem .6rem' }}>
          {chats.length === 0 && <div className="hint" style={{ padding: '.4rem .3rem' }}>No saved chats yet.</div>}
          {chats.map(c => (
            <div
              key={c.id}
              onClick={() => openChat(c.id)}
              title={c.title}
              style={{
                display: 'flex', alignItems: 'center', gap: '.3rem',
                padding: '.4rem .45rem', marginBottom: '.2rem', borderRadius: 6, cursor: 'pointer',
                background: c.id === activeId ? 'rgba(37, 99, 235, 0.12)' : 'transparent',
                fontSize: '.82rem',
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.title || 'Untitled'}
              </span>
              <span
                onClick={(e) => deleteChat(c.id, e)}
                title="Delete chat"
                style={{ opacity: 0.45, cursor: 'pointer', padding: '0 .15rem' }}
              >✕</span>
            </div>
          ))}
        </div>
      </aside>

      {/* ── Right: conversation ─────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ padding: '.55rem .9rem', borderBottom: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', alignItems: 'center', gap: '.5rem' }}>
          <strong>🤖 GIRTool assistant</strong>
          {status && (
            <span style={{ fontSize: '.76rem', color: configured ? 'var(--muted)' : '#dc2626' }}>
              {configured ? status.model : 'not set up'}
            </span>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '.7rem' }}>
          {messages.length === 0 && (
            <div style={{ margin: 'auto', textAlign: 'center', color: 'var(--muted)', maxWidth: 440 }}>
              <div style={{ fontSize: '2rem', marginBottom: '.3rem' }}>🤖</div>
              {configured
                ? <>Ask how to use GIRTool — e.g. <em>"How do I import CSV data in feet?"</em></>
                : <span style={{ color: '#dc2626' }}>The assistant isn't set up yet. The developer configures the API in the bundled <code>ai_config.json</code>.</span>}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
              <div style={{
                padding: '.55rem .8rem', borderRadius: 12,
                background: m.role === 'user' ? 'var(--navy)' : (m.error ? '#fef2f2' : 'var(--surface)'),
                color: m.role === 'user' ? '#fff' : 'var(--text)',
                border: m.role === 'user' ? 'none' : '1px solid var(--border)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '.87rem', lineHeight: 1.5,
              }}>
                {m.role === 'user' ? (m.display ?? m.content) : (m.error ? '⚠ (see error below)' : m.content)}
              </div>
            </div>
          ))}
          {busy && <div style={{ alignSelf: 'flex-start', color: 'var(--muted)', fontSize: '.85rem', padding: '.3rem .5rem' }}>thinking…</div>}
          <div ref={endRef} />
        </div>

        {error && (
          <div style={{ padding: '.4rem .9rem', background: '#fef2f2', color: '#b91c1c', fontSize: '.82rem', borderTop: '1px solid #fecaca' }}>{error}</div>
        )}

        {attachments.length > 0 && (
          <div style={{ display: 'flex', gap: '.4rem', flexWrap: 'wrap', padding: '.4rem .9rem 0' }}>
            {attachments.map((a, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: '.3rem', background: 'var(--border)', borderRadius: 999, padding: '.15rem .5rem', fontSize: '.78rem' }}>
                📎 {a.name}{a.truncated ? ' (truncated)' : ''}
                <span onClick={() => setAttach(arr => arr.filter((_, j) => j !== i))} style={{ cursor: 'pointer', opacity: .6 }}>✕</span>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: '.5rem', alignItems: 'flex-end', padding: '.6rem .9rem', borderTop: '1px solid var(--border)', background: 'var(--surface)' }}>
          <button className="btn-secondary" onClick={attachFile} disabled={busy} title="Attach a text file as context">📎</button>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={configured ? 'Ask a question…  (Enter to send, Shift+Enter for a new line)' : 'The assistant is not configured.'}
            rows={1}
            disabled={!configured}
            style={{ flex: 1, resize: 'none', maxHeight: 140, padding: '.5rem .6rem', borderRadius: 8, border: '1px solid var(--border)', fontFamily: 'inherit', fontSize: '.9rem' }}
          />
          <button className="btn-primary" onClick={send} disabled={busy || (!input.trim() && !attachments.length)}>
            {busy ? '…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}
