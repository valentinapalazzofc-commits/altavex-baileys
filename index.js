import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode'
import { promises as fs } from 'fs'
import path from 'path'
import pino from 'pino'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

const PORT = process.env.PORT || 3000
const API_KEY = process.env.API_KEY || 'altavex-secret-key'
const sessions = new Map()

// Middleware de autenticação por API Key
function auth(req, res, next) {
  const key = req.headers['x-api-key']
  if (key !== API_KEY) {
    return res.status(401).json({ error: 'API Key inválida' })
  }
  next()
}

// Criar pasta de sessões se não existir
async function ensureSessionDir(sessionId) {
  const dir = path.join('./sessions', sessionId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// Iniciar uma sessão Baileys
async function startSession(sessionId) {
  const sessionDir = await ensureSessionDir(sessionId)
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir)
  const { version } = await fetchLatestBaileysVersion()

  const socket = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['ALTAVEX', 'Chrome', '1.0.0']
  })

  const sessionData = {
    socket,
    status: 'connecting',
    qr: null,
    qrBase64: null,
    phone: null,
    name: null,
    error: null,
    connectedAt: null
  }

  sessions.set(sessionId, sessionData)

  socket.ev.on('creds.update', saveCreds)

  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    const session = sessions.get(sessionId)
    if (!session) return

    if (qr) {
      try {
        const qrBase64 = await QRCode.toDataURL(qr)
        session.qr = qr
        session.qrBase64 = qrBase64
        session.status = 'awaiting_scan'
        console.log(`[${sessionId}] QR Code gerado`)
      } catch (err) {
        console.error(`[${sessionId}] Erro ao gerar QR:`, err)
      }
    }

    if (connection === 'open') {
      session.status = 'connected'
      session.qr = null
      session.qrBase64 = null
      session.connectedAt = new Date().toISOString()
      const info = socket.user
      session.phone = info?.id?.split(':')[0] || null
      session.name = info?.name || null
      console.log(`[${sessionId}] Conectado como ${session.name} (${session.phone})`)
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut

      console.log(`[${sessionId}] Desconectado. Código: ${code}. Reconectar: ${shouldReconnect}`)

      if (shouldReconnect) {
        session.status = 'reconnecting'
        setTimeout(() => startSession(sessionId), 5000)
      } else {
        session.status = 'logged_out'
        sessions.delete(sessionId)
        try {
          await fs.rm(sessionDir, { recursive: true, force: true })
        } catch {}
      }
    }
  })

  return sessionData
}

// ─────────────────────────────────────────
// ROTAS
// ─────────────────────────────────────────

// Health check sem autenticação
app.get('/health', (req, res) => {
  res.json({ status: 'ok', sessions: sessions.size })
})

// Criar nova sessão e retornar QR
app.post('/session/create', auth, async (req, res) => {
  const { sessionId } = req.body

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId é obrigatório' })
  }

  if (sessions.has(sessionId)) {
    const existing = sessions.get(sessionId)
    if (existing.status === 'connected') {
      return res.status(409).json({ error: 'Sessão já conectada', status: existing.status })
    }
  }

  try {
    await startSession(sessionId)

    // Aguarda até 15 segundos para o QR aparecer
    let attempts = 0
    while (attempts < 30) {
      const session = sessions.get(sessionId)
      if (session?.qrBase64) {
        return res.json({
          success: true,
          sessionId,
          status: session.status,
          qr: session.qrBase64
        })
      }
      if (session?.status === 'connected') {
        return res.json({
          success: true,
          sessionId,
          status: 'connected',
          phone: session.phone,
          name: session.name
        })
      }
      await new Promise(r => setTimeout(r, 500))
      attempts++
    }

    res.json({
      success: true,
      sessionId,
      status: 'connecting',
      message: 'Aguardando QR. Consulte /session/status/:id'
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao criar sessão', details: err.message })
  }
})

// Status da sessão com QR atualizado
app.get('/session/status/:sessionId', auth, async (req, res) => {
  const { sessionId } = req.params
  const session = sessions.get(sessionId)

  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada', status: 'not_found' })
  }

  res.json({
    sessionId,
    status: session.status,
    qr: session.qrBase64 || null,
    phone: session.phone,
    name: session.name,
    connectedAt: session.connectedAt,
    error: session.error
  })
})

// Listar todas as sessões
app.get('/sessions', auth, (req, res) => {
  const list = []
  sessions.forEach((session, id) => {
    list.push({
      sessionId: id,
      status: session.status,
      phone: session.phone,
      name: session.name,
      connectedAt: session.connectedAt
    })
  })
  res.json({ sessions: list, total: list.length })
})

// Enviar mensagem de texto
app.post('/send/text', auth, async (req, res) => {
  const { sessionId, phone, message } = req.body

  if (!sessionId || !phone || !message) {
    return res.status(400).json({ error: 'sessionId, phone e message são obrigatórios' })
  }

  const session = sessions.get(sessionId)
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Sessão não conectada', status: session?.status })
  }

  try {
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`
    await session.socket.sendMessage(jid, { text: message })
    res.json({ success: true, phone: jid, message })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao enviar mensagem', details: err.message })
  }
})

// Enviar mensagem com imagem
app.post('/send/image', auth, async (req, res) => {
  const { sessionId, phone, imageUrl, caption } = req.body

  if (!sessionId || !phone || !imageUrl) {
    return res.status(400).json({ error: 'sessionId, phone e imageUrl são obrigatórios' })
  }

  const session = sessions.get(sessionId)
  if (!session || session.status !== 'connected') {
    return res.status(400).json({ error: 'Sessão não conectada' })
  }

  try {
    const jid = phone.includes('@') ? phone : `${phone.replace(/\D/g, '')}@s.whatsapp.net`
    await session.socket.sendMessage(jid, {
      image: { url: imageUrl },
      caption: caption || ''
    })
    res.json({ success: true, phone: jid })
  } catch (err) {
    console.error(err)
    res.status(500).json({ error: 'Erro ao enviar imagem', details: err.message })
  }
})

// Desconectar sessão
app.delete('/session/:sessionId', auth, async (req, res) => {
  const { sessionId } = req.params
  const session = sessions.get(sessionId)

  if (!session) {
    return res.status(404).json({ error: 'Sessão não encontrada' })
  }

  try {
    await session.socket.logout()
    sessions.delete(sessionId)
    const sessionDir = path.join('./sessions', sessionId)
    await fs.rm(sessionDir, { recursive: true, force: true })
    res.json({ success: true, message: 'Sessão encerrada' })
  } catch (err) {
    sessions.delete(sessionId)
    res.json({ success: true, message: 'Sessão removida' })
  }
})

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`ALTAVEX Baileys Server rodando na porta ${PORT}`)
})
