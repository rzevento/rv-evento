export function canSendPendingEmail(guest: { email: string; invite: string; whatsappSentAt?: string | null }): boolean {
  return Boolean(guest.email.trim()) && guest.invite !== 'Enviada' && !guest.whatsappSentAt
}

export function canSendReminderEmail(guest: { email: string; invite: string; status: string; reminderSentAt?: string | null }): boolean {
  return Boolean(guest.email.trim()) && guest.invite === 'Enviada' && guest.status === 'Pendiente' && !guest.reminderSentAt
}

/** Ten-digit local numbers belong to Mexico; other countries need a country code. */
export function whatsappPhone(value: string): string | null {
  const input = value.trim()
  if (!input || !/^\+?[\d\s().-]+$/.test(input)) return null
  let digits = input.replace(/\D/g, '')
  const international = input.startsWith('+') || digits.startsWith('00')
  if (digits.startsWith('00')) digits = digits.slice(2)
  if (!international && digits.length === 10) digits = `52${digits}`
  else if (!international && !digits.startsWith('52')) return null
  return /^[1-9]\d{7,14}$/.test(digits) ? digits : null
}

export function whatsappInvitationUrl(phone: string, name: string, token: string, siteUrl: string, reminder = false): string {
  const recipient = whatsappPhone(phone)
  if (!recipient) throw new Error('Revisa el celular. Usa 10 dígitos para México o + y el código de país para otros países.')
  if (!token) throw new Error('Este invitado todavía no tiene un enlace de invitación.')
  const site = new URL(siteUrl)
  if (!['https:', 'http:'].includes(site.protocol)) throw new Error('La dirección pública del evento no es válida.')
  if (['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(site.hostname)) {
    throw new Error('Configura VITE_PUBLIC_SITE_URL con la dirección publicada del evento para compartir invitaciones.')
  }
  const invitation = new URL(`/registro/${encodeURIComponent(token)}`, site.origin).href
  const greeting = name.trim() && name.trim() !== 'Invitado pendiente' ? `Apreciable ${name.trim()}:` : 'Reciba un cordial saludo.'
  const message = reminder
    ? `${greeting}\n\nLe recordamos con gusto la invitación de Ruvalcaba Villalobos, Consultores Fiscales, a la conferencia *Reformas fiscales 2027*, el jueves 3 de diciembre de 16:00 a 19:30 h en el Hotel RIU, Guadalajara, Jalisco. El registro inicia a las 15:30 h.\n\nAún no hemos recibido su respuesta. Le agradeceremos confirmar su asistencia desde su enlace personal, donde también encontrará los detalles del evento:\n${invitation}\n\nSi ya respondió recientemente, por favor omita este recordatorio. La invitación es personal e intransferible.\n\nSerá un gusto contar con su presencia.\n\n*Ruvalcaba Villalobos* · 40 aniversario`
    : `${greeting}\n\nRuvalcaba Villalobos, Consultores Fiscales, tiene el gusto de invitarle a la conferencia para clientes y amigos:\n\n*Reformas fiscales 2027*\n\nCon ella celebramos también nuestro 40 aniversario.\n\n*Fecha:* jueves 3 de diciembre.\n*Horario:* 16:00 a 19:30 h. Registro a partir de las 15:30 h.\n*Sede:* Hotel RIU, Guadalajara, Jalisco.\n\nRegístrese aquí, a través de su enlace personal:\n${invitation}\n\nEsta invitación es personal e intransferible.\n\nSerá un gusto contar con su presencia.\n\nAtentamente,\n*Ruvalcaba Villalobos*`
  return `https://wa.me/${recipient}?text=${encodeURIComponent(message)}`
}
