import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.111.0'
import { jsPDF } from 'npm:jspdf@4.2.1'
import QRCode from 'npm:qrcode@1.5.4'

// Envía por correo (vía Make) la entrada en PDF de un invitado que ya confirmó.
// Con GET ?qr=TOKEN devuelve la imagen PNG del QR para mostrar la entrada dentro del correo.
// Es pública: el token personal de la invitación es la credencial. Sólo se envía
// al correo registrado del invitado, sólo si su RSVP está confirmado y una sola vez.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-rv-impersonation',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!))

const event = {
  title: 'Reformas fiscales',
  accent: '2027',
  date: 'Jueves 3 de diciembre',
  time: '4:00 a 7:30 pm',
  registration: 'Registro 3:30 pm',
  venue: 'Hotel RIU',
  city: 'Guadalajara, Jalisco',
  notice: 'Invitación personal e intransferible',
}
const ticketFilename = 'entrada-reformas-fiscales-2027.pdf'

function toBase64(bytes: Uint8Array) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

async function logoDataUrl(siteOrigin: string) {
  try {
    const response = await fetch(new URL('/brand/rv-logo.png', siteOrigin).href, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) return null
    return `data:image/png;base64,${toBase64(new Uint8Array(await response.arrayBuffer()))}`
  } catch {
    return null
  }
}

// Mismo diseño que la entrada que se descarga desde el sitio (downloadGuestPass en src/main.tsx).
async function ticketPdfBase64(name: string, accessToken: string, logo: string | null) {
  const qrDataUrl = await QRCode.toDataURL(accessToken, { errorCorrectionLevel: 'H', width: 900, margin: 4, color: { dark: '#1a1a1a', light: '#ffffff' } })
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', compress: true })
  const pageWidth = pdf.internal.pageSize.getWidth()
  pdf.setFillColor(251, 248, 241)
  pdf.rect(0, 0, pageWidth, 297, 'F')
  pdf.setFillColor(156, 123, 48)
  pdf.rect(0, 0, pageWidth, 3, 'F')
  if (logo) pdf.addImage(logo, 'PNG', 24, 20, 25, 35.3)
  pdf.setTextColor(156, 123, 48)
  // Proporciones de la invitación (Opción E): el 40 y ANIVERSARIO centrados entre sí, a la altura del logo.
  pdf.setFont('times', 'bold')
  pdf.setFontSize(53)
  const anniversaryWidth = pdf.getTextWidth('40')
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(6.5)
  const labelWidth = pdf.getTextWidth('ANIVERSARIO') + 0.33 * 10
  const anniversaryCenter = pageWidth - 24 - Math.max(anniversaryWidth, labelWidth) / 2
  pdf.text('ANIVERSARIO', anniversaryCenter - labelWidth / 2, 47, { charSpace: 0.33 })
  pdf.setFont('times', 'bold')
  pdf.setFontSize(53)
  pdf.text('40', anniversaryCenter, 42.5, { align: 'center' })
  pdf.setTextColor(26, 26, 26)
  pdf.setFont('times', 'bold')
  pdf.setFontSize(36)
  pdf.text(`${event.title} ${event.accent}`, 24, 82)
  pdf.setDrawColor(156, 123, 48)
  pdf.setLineWidth(0.6)
  pdf.line(24, 90, pageWidth - 24, 90)
  pdf.setTextColor(156, 123, 48)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(9.5)
  pdf.text('ENTRADA PERSONAL', 24, 103, { charSpace: 0.6 })
  pdf.setTextColor(26, 26, 26)
  pdf.setFont('times', 'bold')
  pdf.setFontSize(23)
  pdf.text(pdf.splitTextToSize(name || 'Invitado', pageWidth - 48), 24, 115)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(12)
  pdf.setTextColor(51, 51, 51)
  pdf.text(event.date, 24, 129)
  pdf.text(`Horario ${event.time}`, 24, 136.5)
  pdf.text(event.registration, 24, 144)
  pdf.text(`${event.venue}, ${event.city}`, 24, 151.5)
  pdf.addImage(qrDataUrl, 'PNG', 24, 164, 62, 62)
  pdf.setTextColor(26, 26, 26)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(12)
  pdf.text(pdf.splitTextToSize('Presente este código QR en el acceso del evento.', 80), 98, 182)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(10.5)
  pdf.setTextColor(85, 85, 85)
  pdf.text(pdf.splitTextToSize('No es necesario imprimirlo, ya que puede mostrarlo directamente desde su teléfono celular.', 80), 98, 196, { lineHeightFactor: 1.55 })
  pdf.setTextColor(200, 32, 42)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(7.5)
  pdf.text(event.notice.toUpperCase(), 98, 220, { charSpace: 0.5 })
  return toBase64(new Uint8Array(pdf.output('arraybuffer')))
}

// Sólo para invitaciones existentes con asistencia confirmada; el QR contiene el mismo token del enlace del correo.
async function qrImage(token: string) {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
  const notFound = () => new Response('No encontrado', { status: 404, headers: cors })
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) return notFound()
  if (!supabaseUrl || !secretKey) return new Response('Falta la configuración de Supabase', { status: 500, headers: cors })
  const service = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: invitation } = await service.from('invitations').select('event_id, guest_id').eq('token', token).maybeSingle()
  if (!invitation) return notFound()
  const { data: rsvp } = await service.from('rsvps').select('status').eq('event_id', invitation.event_id).eq('guest_id', invitation.guest_id).maybeSingle()
  if (rsvp?.status !== 'confirmed') return notFound()
  const dataUrl: string = await QRCode.toDataURL(token, { errorCorrectionLevel: 'H', width: 600, margin: 4, color: { dark: '#1a1a1a', light: '#ffffff' } })
  const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), char => char.charCodeAt(0))
  return new Response(bytes, { headers: { ...cors, 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method === 'GET') {
    try { return await qrImage(new URL(request.url).searchParams.get('qr') || '') } catch { return new Response('Error', { status: 500, headers: cors }) }
  }
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405)

  try {
    const input = await request.json().catch(() => null)
    const token = input?.token
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(token)) return json({ error: 'Enlace de invitación no válido' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const secretKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default
    const webhook = Deno.env.get('MAKE_TICKET_WEBHOOK_URL')?.trim()
    const apiKey = Deno.env.get('MAKE_WEBHOOK_API_KEY')?.trim()
    const publicSite = Deno.env.get('PUBLIC_SITE_URL')?.trim()
    if (!supabaseUrl || !secretKey) return json({ error: 'Falta la configuración de Supabase' }, 500)
    if (!webhook || !apiKey || !publicSite) return json({ error: 'Configura MAKE_TICKET_WEBHOOK_URL, MAKE_WEBHOOK_API_KEY y PUBLIC_SITE_URL en Secrets' }, 500)
    let webhookUrl: URL, siteUrl: URL
    try {
      webhookUrl = new URL(webhook)
      siteUrl = new URL(publicSite)
      if (webhookUrl.protocol !== 'https:' || siteUrl.protocol !== 'https:' || webhookUrl.username || webhookUrl.password || siteUrl.username || siteUrl.password || ['localhost', '127.0.0.1', '[::1]'].includes(siteUrl.hostname)) throw new Error()
    } catch {
      return json({ error: 'Las URLs de Make y del sitio publicado deben ser direcciones HTTPS válidas' }, 500)
    }

    const service = createClient(supabaseUrl, secretKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const { data: claim, error: claimError } = await service.rpc('claim_ticket_email', { invitation_token: token })
    if (claimError || !claim) return json({ error: 'No se pudo preparar el envío de la entrada.' }, 500)
    if (claim.result === 'not_found') return json({ error: 'Invitación no encontrada' }, 404)
    if (claim.result === 'not_confirmed') return json({ error: 'La asistencia no está confirmada' }, 409)
    if (claim.result === 'no_email') return json({ ok: true, skipped: 'no_email' })
    if (claim.result === 'already_sent') return json({ ok: true, already_sent: true })
    if (claim.result !== 'claimed') return json({ error: 'No se pudo preparar el envío de la entrada.' }, 500)

    const release = () => service.rpc('release_ticket_email', { target_invitation_id: claim.invitation_id }).then(() => undefined, () => undefined)
    const name = typeof claim.guest_name === 'string' ? claim.guest_name.trim() : ''
    const ticketUrl = new URL(`/registro/${encodeURIComponent(token)}`, siteUrl.origin).href
    const ticketQrUrl = new URL(`/functions/v1/send-ticket?qr=${encodeURIComponent(token)}`, supabaseUrl).href

    let ticketPdf: string
    try {
      ticketPdf = await ticketPdfBase64(name, token, await logoDataUrl(siteUrl.origin))
    } catch (cause) {
      console.error('send-ticket: no se generó el PDF', cause instanceof Error ? cause.message : cause)
      await release()
      return json({ error: 'No se pudo generar la entrada.' }, 500)
    }

    // Sólo una respuesta {"ok":true} del escenario cuenta como enviado; si no, se libera para reintentar.
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
          ticket_url: ticketUrl,
          ticket_qr_url: ticketQrUrl,
          ticket_filename: ticketFilename,
          ticket_pdf: ticketPdf,
        }),
        signal: AbortSignal.timeout(25000),
      })
      const result = await response.json().catch(() => null)
      if (!response.ok || result?.ok !== true) { await release(); return json({ error: 'No se confirmó el envío de la entrada.' }, 502) }
    } catch {
      await release()
      return json({ error: 'No se confirmó el envío de la entrada.' }, 502)
    }
    return json({ ok: true })
  } catch {
    return json({ error: 'No se pudo completar la solicitud.' }, 500)
  }
})
