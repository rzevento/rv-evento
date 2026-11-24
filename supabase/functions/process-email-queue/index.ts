import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0'

// Manda, desde el servidor, el siguiente correo de un envío masivo (cola public.email_queue).
// La llama pg_cron cada 15 s (private.kick_email_queue) con la clave de private.email_queue_config;
// sin esa clave la base no entrega nada. Cada llamada manda a lo más un correo:
// claim_email_queue_item aparta uno (y espacia 14 s entre correos) y finish_email_queue_item guarda
// el resultado. Invitaciones y recordatorios van directo a Make con el mismo contenido que
// send-invitation; las entradas se piden a send-ticket (genera el PDF y marca ticket_sent_at).
// Se despliega SIN «Verify JWT»: la clave del cuerpo es su autenticación.

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

type Claim = { result: string; id?: number; kind?: 'invitacion' | 'recordatorio' | 'entrada'; email?: string; full_name?: string | null; invitation_id?: string; token?: string }

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
  const input = await request.json().catch(() => null)
  const secret = input?.secret
  if (typeof secret !== 'string' || secret.length < 32) return json({ error: 'No autorizado' }, 401)

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const publicKey = Deno.env.get('SUPABASE_ANON_KEY') || JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') || '{}').default
  const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
  if (!supabaseUrl || !publicKey || !secretKey) return json({ error: 'Falta la configuración de Supabase' }, 500)
  const service = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })

  const { data, error: claimError } = await service.rpc('claim_email_queue_item', { p_secret: secret })
  if (claimError) return json({ error: claimError.code === '42501' ? 'No autorizado' : 'No se pudo leer la cola' }, claimError.code === '42501' ? 401 : 500)
  const claim = data as Claim
  if (claim?.result !== 'claimed' || !claim.id) return json({ ok: true, result: claim?.result || 'idle' })

  const finish = async (outcome: 'sent' | 'omitted' | 'rejected' | 'failed', detail: string | null = null) => {
    const { error } = await service.rpc('finish_email_queue_item', { p_secret: secret, p_item: claim.id, p_outcome: outcome, p_detail: detail })
    if (error) console.error('process-email-queue: no se guardó el resultado', { item: claim.id, outcome, code: error.code })
    return json({ ok: !error, result: outcome, item: claim.id })
  }
  const uncertain = (what = '') => `${claim.email}: no se confirmó el envío${what ? ` ${what}` : ''}. Revisa el historial de Make antes de volver a enviar.`

  try {
    if (claim.kind === 'entrada') {
      if (!claim.token) return finish('rejected', 'no se encontró su invitación')
      // Mismos encabezados que usa el panel al llamar a send-ticket.
      const response = await fetch(new URL('/functions/v1/send-ticket', supabaseUrl).href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${publicKey}`, apikey: publicKey },
        body: JSON.stringify({ token: claim.token }),
        signal: AbortSignal.timeout(60000),
      })
      const result = await response.json().catch(() => null)
      if (response.ok && result?.ok === true) {
        if (result.already_sent) return finish('omitted', 'ya tenía su entrada')
        if (result.skipped) return finish('rejected', 'Este invitado no tiene correo electrónico')
        return finish('sent')
      }
      if (response.status === 404 || response.status === 409) return finish('omitted', typeof result?.error === 'string' ? result.error : 'ya no está confirmado')
      return finish('failed', uncertain('de la entrada'))
    }

    const reminder = claim.kind === 'recordatorio'
    const webhook = Deno.env.get(reminder ? 'MAKE_REMINDER_WEBHOOK_URL' : 'MAKE_WEBHOOK_URL')?.trim()
    const apiKey = Deno.env.get('MAKE_WEBHOOK_API_KEY')?.trim()
    const publicSite = Deno.env.get('PUBLIC_SITE_URL')?.trim()
    let webhookUrl: URL, siteUrl: URL
    try {
      if (!webhook || !apiKey || !publicSite) throw new Error()
      webhookUrl = new URL(webhook)
      siteUrl = new URL(publicSite)
      if (webhookUrl.protocol !== 'https:' || siteUrl.protocol !== 'https:' || webhookUrl.username || webhookUrl.password || siteUrl.username || siteUrl.password || ['localhost', '127.0.0.1', '[::1]'].includes(siteUrl.hostname)) throw new Error()
    } catch {
      // Nada salió: es seguro reintentar después de corregir los Secrets, pero se detiene el lote.
      return finish('failed', reminder ? 'Configura MAKE_REMINDER_WEBHOOK_URL para enviar recordatorios.' : 'Configura MAKE_WEBHOOK_URL, MAKE_WEBHOOK_API_KEY y PUBLIC_SITE_URL en Secrets.')
    }
    // Enlace general de registro, igual que send-invitation.
    const invitationUrl = new URL('/', siteUrl.origin).href
    const name = claim.full_name?.trim() || ''
    try {
      const response = await fetch(webhookUrl.href, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-make-apikey': apiKey },
        body: JSON.stringify({
          invitation_id: claim.invitation_id,
          guest_name: escapeHtml(name || 'invitado'),
          greeting: name ? `Estimado(a) ${escapeHtml(name)}:` : 'Reciba un cordial saludo.',
          email: claim.email,
          invitation_url: invitationUrl,
          ...(reminder ? { reminder: true } : {}),
        }),
        signal: AbortSignal.timeout(25000),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || result?.ok !== true) return finish('failed', uncertain(reminder ? 'del recordatorio' : 'de la invitación'))
    } catch {
      return finish('failed', uncertain(reminder ? 'del recordatorio' : 'de la invitación'))
    }
    return finish('sent')
  } catch {
    return finish('failed', uncertain())
  }
})
