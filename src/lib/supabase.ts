import { createClient } from '@supabase/supabase-js'
import { impersonationFetch, organizerAction } from './impersonation-transport'
import type { OrganizerProfile } from './organizer-permissions'
import type { EmailBounce, TicketLogEntry } from './email-log'
import { parseEmailBatchStatus, type EmailBatchKind, type EmailBatchStatus } from './email-queue'

const url = import.meta.env.VITE_SUPABASE_URL
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

const authStorage = typeof window !== 'undefined' ? window.localStorage : undefined

export const supabase = url && publishableKey
  ? createClient(url, publishableKey, {
      global: { fetch: impersonationFetch(url) },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: authStorage,
      },
    })
  : null

export async function getEventMembers() {
  if (!supabase) return { data: [{ userId: 'demo-user', email: 'maria@ejemplo.com', displayName: 'María Ríos', role: 'Administradora', roleCode: 'admin' }], error: null, demo: true }
  const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (eventError || !activeEvent) return { data: [], error: eventError || new Error('No active event'), demo: false }
  const { data, error } = await supabase.from('event_members').select('user_id, email, display_name, role').eq('event_id', activeEvent.id).order('created_at')
  const roleLabels: Record<string, string> = { admin: 'Administrador', leader: 'Líder', staff: 'Equipo', viewer: 'Consulta' }
  return { data: (data || []).map(member => ({ userId: member.user_id, email: member.email || 'Sin correo', displayName: member.display_name || 'Usuario sin nombre', role: roleLabels[member.role] || member.role, roleCode: String(member.role) })), error, demo: false }
}

export async function addEventMember(input: { email: string; displayName: string; role: string }) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (eventError || !activeEvent) return { data: null, error: eventError || new Error('No active event'), demo: false }
    const { data, error } = await supabase.rpc('add_event_member', { target_event_id: activeEvent.id, member_email: input.email, member_display_name: input.displayName, member_role: input.role })
    return { data, error, demo: false }
  })
}

export async function updateEventMemberRole(userId: string, role: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (eventError || !activeEvent) return { data: null, error: eventError || new Error('No active event'), demo: false }
    const { data, error } = await supabase.rpc('update_event_member_role', {
      target_event_id: activeEvent.id,
      target_user_id: userId,
      new_role: role,
    })
    return { data, error, demo: false }
  })
}

export async function getCurrentOrganizerProfile() {
  if (!supabase) return { data: { displayName: 'María Ríos', role: 'Administradora', roleCode: 'admin', eventId: 'demo-event', userId: 'demo-user', actorUserId: 'demo-user', actorIsAdmin: true, impersonationId: null, expiresAt: null } as OrganizerProfile, error: null, demo: true }
  const { data, error } = await supabase.rpc('get_organizer_context')
  return { data: data as OrganizerProfile | null, error, demo: false }
}

export async function startOrganizerImpersonation(eventId: string, subjectId: string) {
  if (!supabase) throw new Error('Disponible al conectar el evento a Supabase.')
  const { data, error } = await supabase.rpc('start_organizer_impersonation', { target_event_id: eventId, subject_user_id: subjectId })
  if (error) throw error
  if (!data?.id) throw new Error('No se pudo iniciar la sesión.')
  return data as { id: string; expiresAt: string }
}

export async function stopOrganizerImpersonation(id: string) {
  if (!supabase) return
  const { error } = await supabase.rpc('stop_organizer_impersonation', { impersonation_id: id })
  if (error) throw error
}

export async function submitRsvp(input: { token: string; name: string; email: string; phone: string; company: string }) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data, error } = await supabase.rpc('submit_rsvp', {
      invitation_token: input.token,
      guest_name: input.name,
      guest_email: input.email.trim() || null,
      guest_phone: input.phone.trim() || null,
      guest_origin: input.company,
    })
    return { data, error, demo: false }
  })
}

export type BeginRsvpStatus = 'pending' | 'already_registered' | 'not_found' | 'name_mismatch' | 'name_required' | 'name_review'

export async function beginRsvp(input: { name: string; email: string; phone: string; company: string }) {
  if (!supabase) return { data: { token: 'demo-token', status: 'pending' as BeginRsvpStatus }, error: null, demo: true }
  const email = input.email.trim(), phone = input.phone.trim()
  const { data, error } = await supabase.rpc('begin_rsvp', {
    guest_contact: email, // el correo es la llave del registro
    guest_name: input.name.trim(),
    guest_email: email || null,
    guest_phone: phone || null,
    guest_company: input.company.trim() || null,
  })
  return { data: data as { token?: string; status: BeginRsvpStatus } | null, error, demo: false }
}

export type RegistrationLogResult = 'confirmado' | 'no_encontrado' | 'contacto_de_otro' | 'contacto_en_uso'
export type RegistrationLogEntry = {
  id: number
  createdAt: string
  result: RegistrationLogResult
  guestId: string | null
  guestName: string | null
  name: string
  email: string
  phone: string
  company: string
  previousName: string | null
  previousEmail: string | null
  previousPhone: string | null
  previousCompany: string | null
  historical: boolean
  reviewedAt: string | null
  resolution: RegistrationResolution | null
}
export type RegistrationResolution = 'agregado' | 'transferido'

const demoRegistrationLog: RegistrationLogEntry[] = [
  { id: 3, createdAt: '2026-11-15T19:12:00Z', result: 'contacto_de_otro', guestId: 'demo-1', guestName: 'Mariana González', name: 'Luis Gómez', email: 'mariana@gcobalto.com', phone: '', company: 'Grupo Cobalto', previousName: 'Mariana González', previousEmail: 'mariana@gcobalto.com', previousPhone: null, previousCompany: 'Grupo Cobalto', historical: false, reviewedAt: null, resolution: null },
  { id: 2, createdAt: '2026-11-15T17:40:00Z', result: 'no_encontrado', guestId: null, guestName: null, name: 'Pedro Ruiz', email: 'pedro.ruiz@ejemplo.com', phone: '', company: 'Nueva SA', previousName: null, previousEmail: null, previousPhone: null, previousCompany: null, historical: false, reviewedAt: null, resolution: null },
  { id: 1, createdAt: '2026-11-14T16:05:00Z', result: 'confirmado', guestId: 'demo-2', guestName: 'Andrés Salinas', name: 'Andrés Salinas', email: 'andres@ejemplo.com', phone: '', company: 'Ejemplo SA', previousName: 'Andres Salinas', previousEmail: 'andres@ejemplo.com', previousPhone: null, previousCompany: 'Ejemplo SA', historical: false, reviewedAt: null, resolution: null },
]

export async function getRegistrationLog(): Promise<RegistrationLogEntry[]> {
  if (!supabase) return demoRegistrationLog
  const entries: RegistrationLogEntry[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('registration_log').select('*, guests!registration_log_guest_id_fkey(full_name)').order('created_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + pageSize - 1)
    if (error) throw error
    entries.push(...(data || []).map(row => {
      const guest = Array.isArray(row.guests) ? row.guests[0] : row.guests
      return { id: Number(row.id), createdAt: row.created_at, result: row.result, guestId: row.guest_id, guestName: guest?.full_name || null, name: row.submitted_name || '', email: row.submitted_email || '', phone: row.submitted_phone || '', company: row.submitted_company || '', previousName: row.previous_name, previousEmail: row.previous_email, previousPhone: row.previous_phone, previousCompany: row.previous_company, historical: Boolean(row.historical), reviewedAt: row.reviewed_at, resolution: row.resolution || null }
    }))
    if (!data || data.length < pageSize) break
  }
  return entries
}

const demoBounces: EmailBounce[] = [
  { id: 2, bouncedAt: '2026-11-17T22:30:24Z', email: 'jorge@vhnos.com', guestId: 'demo-2', guestName: 'Jorge Villaseñor', kind: 'entrada', reason: 'cuenta_bloqueada', detail: "Remote server returned '550 5.1.8 Access denied, bad outbound sender AS(42004)'", released: true },
  { id: 1, bouncedAt: '2026-11-17T20:55:00Z', email: 'lucia@ldtcapital.com', guestId: 'demo-3', guestName: 'Lucía de la Torre', kind: 'invitacion', reason: 'direccion_invalida', detail: "Remote Server returned '550 5.1.10 RESOLVER.ADR.RecipientNotFound'", released: false },
]

// Avisos de rebote que registra el escenario de Make que vigila la bandeja del remitente.
export async function getEmailBounces(): Promise<EmailBounce[]> {
  if (!supabase) return demoBounces
  const bounces: EmailBounce[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('email_bounces').select('*, guests!email_bounces_guest_id_fkey(full_name)').order('bounced_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + pageSize - 1)
    if (error) throw error
    bounces.push(...(data || []).map(row => {
      const guest = Array.isArray(row.guests) ? row.guests[0] : row.guests
      return { id: Number(row.id), bouncedAt: row.bounced_at, email: row.email, guestId: row.guest_id, guestName: guest?.full_name || null, kind: row.kind, reason: row.reason, detail: row.detail || '', released: Boolean(row.released) }
    }))
    if (!data || data.length < pageSize) break
  }
  return bounces
}

// Invitados confirmados y cuándo se les mandó la entrada por correo.
export async function getTicketLog(): Promise<TicketLogEntry[]> {
  if (!supabase) return [
    { guestId: 'demo-1', name: 'Mariana González', email: 'mariana@gcobalto.com', company: 'Grupo Cobalto', confirmedAt: '2026-11-17T20:10:00Z', ticketSentAt: '2026-11-17T20:10:05Z', token: null },
    { guestId: 'demo-2', name: 'Jorge Villaseñor', email: 'jorge@vhnos.com', company: 'Villaseñor Hermanos', confirmedAt: '2026-11-17T22:30:00Z', ticketSentAt: null, token: null },
  ]
  const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (eventError) throw eventError
  if (!activeEvent) return []
  const entries: TicketLogEntry[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('guests').select('id, full_name, company, email, invitations(ticket_sent_at, token), rsvps!inner(status, submitted_at)').eq('event_id', activeEvent.id).eq('rsvps.status', 'confirmed').order('id').range(offset, offset + pageSize - 1)
    if (error) throw error
    entries.push(...(data || []).map(row => {
      const invitation = Array.isArray(row.invitations) ? row.invitations[0] : row.invitations
      const rsvp = Array.isArray(row.rsvps) ? row.rsvps[0] : row.rsvps
      return { guestId: String(row.id), name: row.full_name || 'Invitado', email: row.email || '', company: row.company || '', confirmedAt: rsvp?.submitted_at || null, ticketSentAt: invitation?.ticket_sent_at || null, token: invitation?.token || null }
    }))
    if (!data || data.length < pageSize) break
  }
  return entries.sort((a, b) => (b.confirmedAt || '').localeCompare(a.confirmedAt || ''))
}

export async function markRegistrationReviewed(id: number, reviewed: boolean) {
  return organizerAction(async () => {
    if (!supabase) return { error: null, demo: true }
    const { error } = await supabase.rpc('mark_registration_reviewed', { log_id: id, reviewed })
    return { error, demo: false }
  })
}

export type ResolveRegistrationResult =
  | { status: 'ok'; guest_id: string; token: string; email: string | null }
  | { status: 'contact_in_use'; field: 'email' | 'phone' }
  | { status: 'already_resolved' | 'already_confirmed' | 'name_required' | 'contact_required' | 'no_invitation' | 'already_checked_in' }

// Sólo administradores. 'agregar' crea un invitado nuevo; 'transferir' le pasa a esta persona la
// invitación con la que intentó registrarse. En ambos casos queda confirmada.
export async function resolveRegistration(id: number, mode: 'agregar' | 'transferir', input: { name: string; email: string; phone: string; company: string }) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data, error } = await supabase.rpc('resolve_registration', {
      log_id: id, resolve_mode: mode,
      guest_name: input.name.trim(), guest_email: input.email.trim() || null, guest_phone: input.phone.trim() || null, guest_company: input.company.trim() || null,
    })
    return { data: data as ResolveRegistrationResult | null, error, demo: false }
  })
}

export async function getInvitationDetails(token: string) {
  if (!supabase) return { data: { name: 'Mariana González', email: 'mariana@gcobalto.com', phone: '', company: 'Grupo Cobalto', status: 'pending' }, error: null }
  const { data, error } = await supabase.rpc('get_invitation_details', { invitation_token: token })
  return { data: data as { name: string | null; email: string | null; phone: string | null; company: string | null; status: string } | null, error }
}

export async function cancelRsvp(token: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data, error } = await supabase.rpc('cancel_rsvp', { invitation_token: token })
    return { data, error, demo: false }
  })
}

export async function createGuest(input: { name: string; email: string; phone: string; company: string }) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (eventError || !activeEvent) return { data: null, error: eventError || new Error('No active event'), demo: false }
    const { data: guest, error } = await supabase.from('guests').insert({ event_id: activeEvent.id, full_name: input.name.trim() || null, email: input.email.trim() || null, phone: input.phone.trim() || null, company: input.company.trim() || null }).select().single()
    if (error || !guest) return { data: null, error, demo: false }
    // La base crea la invitación al guardar al invitado (trigger guests_create_invitation); aquí sólo
    // se lee. Si no estuviera (base sin la migración), se crea y se reintenta antes de rendirse.
    const insertInvitation = () => supabase!.from('invitations').insert({ event_id: activeEvent.id, guest_id: guest.id }).select().single()
    let { data: invitation, error: invitationError } = await supabase.from('invitations').select().eq('event_id', activeEvent.id).eq('guest_id', guest.id).maybeSingle()
    if (!invitation && !invitationError) ({ data: invitation, error: invitationError } = await insertInvitation())
    for (let attempt = 1; invitationError && attempt <= 3; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 500 * attempt))
      const existing = await supabase.from('invitations').select().eq('event_id', activeEvent.id).eq('guest_id', guest.id).maybeSingle()
      if (existing.data) {
        invitation = existing.data
        invitationError = null
      } else {
        ({ data: invitation, error: invitationError } = await insertInvitation())
      }
    }
    return { data: { guest, invitation }, error: invitationError, demo: false }
  })
}

export async function updateGuest(guestId: string, input: { name: string; email: string; phone: string; company: string }) {
  return organizerAction(async () => {
    if (!input.email.trim() && !input.phone.trim()) return { data: null, error: new Error('Captura un correo o un celular.'), demo: !supabase }
    if (!supabase) return { data: null, error: null, demo: true }
    const { data, error } = await supabase.from('guests').update({
      full_name: input.name.trim() || null,
      email: input.email.trim() || null,
      phone: input.phone.trim() || null,
      company: input.company.trim() || null,
    }).eq('id', guestId).select('id').single()
    return { data, error: error || (!data ? new Error('No se pudo actualizar al invitado. Revisa tu acceso.') : null), demo: false }
  })
}

// Sólo administradores. La base guarda una copia en la bitácora de eliminados (alta, eliminación,
// quién, motivo y cómo estaba) y después borra al invitado con su invitación, respuesta y llegada.
export async function deleteGuest(guestId: string, reason: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data, error } = await supabase.rpc('delete_guest', { target_guest_id: guestId, reason: reason.trim() || null })
    const status = (data as { status?: string } | null)?.status
    return { data, error: error || (status !== 'ok' ? new Error('No se pudo eliminar al invitado. Actualiza la página.') : null), demo: false }
  })
}

export type DeletedGuest = {
  id: number
  guestId: string
  name: string
  email: string
  phone: string
  company: string
  createdAt: string | null
  deletedAt: string
  deletedBy: string | null
  reason: string | null
  invitationSentAt: string | null
  whatsappSentAt: string | null
  rsvpStatus: string | null
  confirmedAt: string | null
  checkedInAt: string | null
}

export async function getDeletedGuests(): Promise<DeletedGuest[]> {
  if (!supabase) return [
    { id: 1, guestId: 'demo-9', name: 'Pedro Duplicado', email: 'pedro@ejemplo.com', phone: '', company: 'Ejemplo SA', createdAt: '2026-11-17T20:30:00Z', deletedAt: '2026-11-19T17:05:00Z', deletedBy: 'María Ríos', reason: 'Registrado dos veces', invitationSentAt: '2026-11-17T21:00:00Z', whatsappSentAt: null, rsvpStatus: null, confirmedAt: null, checkedInAt: null },
  ]
  const entries: DeletedGuest[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('deleted_guests').select('id, guest_id, full_name, email, phone, company, created_at, deleted_at, deleted_by_name, reason, invitation_sent_at, whatsapp_sent_at, rsvp_status, confirmed_at, checked_in_at').order('deleted_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + pageSize - 1)
    if (error) throw error
    entries.push(...(data || []).map(row => ({ id: Number(row.id), guestId: String(row.guest_id), name: row.full_name || '', email: row.email || '', phone: row.phone || '', company: row.company || '', createdAt: row.created_at, deletedAt: row.deleted_at, deletedBy: row.deleted_by_name, reason: row.reason, invitationSentAt: row.invitation_sent_at, whatsappSentAt: row.whatsapp_sent_at, rsvpStatus: row.rsvp_status, confirmedAt: row.confirmed_at, checkedInAt: row.checked_in_at })))
    if (!data || data.length < pageSize) break
  }
  return entries
}

export async function markGuestCancelled(guestId: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data: guest, error: guestError } = await supabase.from('guests').select('event_id').eq('id', guestId).single()
    if (guestError || !guest) return { data: null, error: guestError || new Error('Invitado no encontrado.'), demo: false }
    const { data, error } = await supabase.from('rsvps').upsert({
      event_id: guest.event_id, guest_id: guestId, status: 'cancelled', updated_at: new Date().toISOString(),
    }, { onConflict: 'event_id,guest_id' }).select('guest_id').single()
    return { data, error: error || (!data ? new Error('No se pudo registrar la cancelación.') : null), demo: false }
  })
}

export async function markGuestConfirmed(guestId: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data: guest, error: guestError } = await supabase.from('guests').select('event_id').eq('id', guestId).single()
    if (guestError || !guest) return { data: null, error: guestError || new Error('Invitado no encontrado.'), demo: false }
    const confirmedAt = new Date().toISOString()
    const { data, error } = await supabase.from('rsvps').upsert({
      event_id: guest.event_id, guest_id: guestId, status: 'confirmed', submitted_at: confirmedAt, updated_at: confirmedAt,
    }, { onConflict: 'event_id,guest_id' }).select('guest_id, submitted_at').single()
    return { data, error: error || (!data ? new Error('No se pudo registrar la confirmación.') : null), demo: false }
  })
}

export async function checkInGuest(guestId: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (eventError || !activeEvent) return { data: null, error: eventError || new Error('No active event'), demo: false }
    const profile = await getCurrentOrganizerProfile()
    if (profile.error || !profile.data) return { data: null, error: profile.error || new Error('Sin acceso'), demo: false }
    const { data, error } = await supabase.from('check_ins').upsert({ event_id: activeEvent.id, guest_id: guestId, checked_in_by: profile.data.userId }, { onConflict: 'event_id,guest_id' }).select().single()
    return { data, error, demo: false }
  })
}

export async function undoCheckInGuest(guestId: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (eventError || !activeEvent) return { data: null, error: eventError || new Error('No active event'), demo: false }
    const { data, error } = await supabase.from('check_ins').delete().eq('event_id', activeEvent.id).eq('guest_id', guestId).select('id').single()
    return { data, error, demo: false }
  })
}

export async function getInvitationToken(guestId: string) {
  if (!supabase) return { data: 'demo-token', error: null, demo: true }
  const { data, error } = await supabase.from('invitations').select('token').eq('guest_id', guestId).maybeSingle()
  return { data: data?.token || null, error, demo: false }
}

export async function findGuestByQr(value: string) {
  const code = value.trim()
  if (!code) return { data: null, error: new Error('Código vacío'), demo: !supabase }
  if (!supabase) {
    const demoGuest = demoGuestFromQr(code)
    return { data: demoGuest, error: demoGuest ? null : new Error('Invitación no encontrada'), demo: true }
  }
  const token = extractInvitationToken(code)
  const { data, error } = await supabase
    .from('invitations')
    .select('guest_id, guests(id, full_name, company, email)')
    .eq('token', token)
    .maybeSingle()
  if (error || !data?.guests) return { data: null, error: error || new Error('Invitación no encontrada'), demo: false }
  const guest = Array.isArray(data.guests) ? data.guests[0] : data.guests
  return { data: guest ? { id: String(guest.id), name: guest.full_name, company: guest.company || 'Sin empresa', email: guest.email } : null, error: guest ? null : new Error('Invitación no encontrada'), demo: false }
}

function extractInvitationToken(value: string) {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/\/registro\/([^/]+)/)
    return match?.[1] || value
  } catch {
    return value.replace(/^registro\//, '').replace(/^\//, '')
  }
}

function demoGuestFromQr(value: string) {
  const code = value.trim().replace(/^demo:\/?/, '').replace(/.*\/registro\//, '')
  const guest = [{ id: 'demo-1', name: 'Mariana González', company: 'Grupo Cobalto', email: 'mariana@gcobalto.com' }, { id: 'demo-2', name: 'Jorge Villaseñor', company: 'Villaseñor Hermanos', email: 'jorge@vhnos.com' }].find(item => item.id === code || code === 'demo-token')
  return guest || null
}

export async function markInvitationSent(guestId: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (eventError || !activeEvent) return { data: null, error: eventError || new Error('No active event'), demo: false }
    const { data, error } = await supabase.from('invitations').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('event_id', activeEvent.id).eq('guest_id', guestId).select().single()
    return { data, error, demo: false }
  })
}

export async function sendInvitation(guestId: string, resend = false, reminder = false) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data, error } = await supabase.functions.invoke('send-invitation', { body: { guest_id: guestId, resend, reminder } })
    if (error && 'context' in error && error.context instanceof Response) {
      const details = await error.context.json().catch(() => null)
      if (typeof details?.error === 'string') return { data, error: new Error(details.error), demo: false }
    }
    if (!error && resend && data?.already_sent && !reminder) return { data, error: new Error('El servidor no realizó el reenvío. Actualiza la función de envío antes de reintentar.'), demo: false }
    return { data, error, demo: false }
  })
}

// Pide a la función send-ticket que mande la entrada (PDF) al correo del invitado confirmado.
// Es idempotente: si ya se envió o no hay correo, responde ok sin volver a mandar.
// Sólo administradores: libera el envío para que sendTicket vuelva a mandar la entrada.
export async function releaseGuestTicket(guestId: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { error } = await supabase.rpc('release_guest_ticket_email', { target_guest_id: guestId })
    return { data: null, error, demo: false }
  })
}

export async function sendTicket(token: string) {
  if (!supabase) return { data: null, error: null, demo: true }
  const { data, error } = await supabase.functions.invoke('send-ticket', { body: { token } })
  if (error && 'context' in error && error.context instanceof Response) {
    const details = await error.context.json().catch(() => null)
    if (typeof details?.error === 'string') return { data, error: new Error(details.error), demo: false }
  }
  return { data: data as { ok?: boolean; already_sent?: boolean; skipped?: string } | null, error, demo: false }
}

// Envíos masivos: el servidor los manda (cola public.email_queue); el panel sólo los pone en fila y lee el avance.
export async function enqueueBulkEmail(kind: EmailBatchKind) {
  return organizerAction(async () => {
    if (!supabase) return { data: { status: 'empty' as const }, error: null, demo: true }
    const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (eventError || !activeEvent) return { data: null, error: eventError || new Error('No active event'), demo: false }
    const { data, error } = await supabase.rpc('enqueue_bulk_email', { target_event_id: activeEvent.id, p_kind: kind })
    return { data: data as { status: 'ok' | 'busy' | 'empty'; total?: number; queued?: number; rejected?: number } | null, error, demo: false }
  })
}

export async function stopEmailBatch(batchId: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data, error } = await supabase.rpc('stop_email_batch', { target_batch_id: batchId })
    return { data: data as { cancelled?: number } | null, error, demo: false }
  })
}

export async function getEmailBatchStatus(): Promise<EmailBatchStatus | null> {
  if (!supabase) return null
  const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (eventError) throw eventError
  if (!activeEvent) return null
  const { data, error } = await supabase.rpc('email_batch_status', { target_event_id: activeEvent.id })
  if (error) throw error
  return parseEmailBatchStatus(data)
}

export async function markWhatsAppInvitationSent(guestId: string) {
  return organizerAction(async () => {
    if (!supabase) return { data: new Date().toISOString(), error: null, demo: true }
    const { data, error } = await supabase.rpc('mark_whatsapp_invitation_sent', { target_guest_id: guestId })
    return { data: data as string | null, error, demo: false }
  })
}

export async function getSeatAssignments(): Promise<{ data: Record<string, number> | null; error: { message: string; code?: string } | null; demo: boolean }> {
  if (!supabase) return { data: null, error: null, demo: true }
  const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
  if (eventError || !activeEvent) return { data: null, error: eventError || new Error('No active event'), demo: false }
  const assignments: Record<string, number> = {}
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from('seat_assignments').select('guest_id, table_number').eq('event_id', activeEvent.id).order('guest_id').range(offset, offset + pageSize - 1)
    if (error) return { data: null, error, demo: false }
    for (const row of data || []) assignments[String(row.guest_id)] = Number(row.table_number)
    if (!data || data.length < pageSize) break
  }
  return { data: assignments, error: null, demo: false }
}

export async function saveSeatAssignments(changes: { guestId: string; tableNumber: number | null }[]) {
  return organizerAction(async () => {
    if (!supabase) return { data: null, error: null, demo: true }
    const { data: activeEvent, error: eventError } = await supabase.from('events').select('id').order('created_at', { ascending: false }).limit(1).maybeSingle()
    if (eventError || !activeEvent) return { data: null, error: eventError || new Error('No active event'), demo: false }
    const { data, error } = await supabase.rpc('assign_guest_tables', {
      target_event_id: activeEvent.id,
      assignments: changes.map(change => ({ guest_id: change.guestId, table_number: change.tableNumber })),
    })
    return { data: data as number | null, error, demo: false }
  })
}
