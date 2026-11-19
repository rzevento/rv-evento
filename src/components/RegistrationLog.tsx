import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, Download, Repeat, Search, Undo2, UserPlus } from 'lucide-react'
import { getDeletedGuests, getEmailBounces, getRegistrationLog, getTicketLog, markRegistrationReviewed, resolveRegistration, sendTicket } from '../lib/supabase'
import type { RegistrationLogEntry, RegistrationLogResult, RegistrationResolution } from '../lib/supabase'
import { useCanManageInvitations } from '../lib/organizer-permissions'
import { blockWarning, recentAccountBlock, ticketState } from '../lib/email-log'
import { BounceLogTable, TicketLogTable, bounceCsv, ticketCsv } from './EmailLog'
import { DeletedGuestsTable, deletedCsv, deletedState } from './DeletedGuests'
import './RegistrationLog.css'

const resultLabels: Record<RegistrationLogResult, string> = {
  confirmado: 'Confirmó',
  no_encontrado: 'No está en la lista',
  contacto_de_otro: 'Usó el contacto de otro invitado',
  contacto_en_uso: 'Su correo o teléfono ya es de otro invitado',
}
const resolutionLabels: Record<RegistrationResolution, string> = {
  agregado: 'Se agregó como invitado',
  transferido: 'Se le pasó la invitación',
}
export const isOutsideList = (entry: RegistrationLogEntry) => entry.result !== 'confirmado'

const digits = (value: string | null) => (value || '').replace(/\D/g, '')
const sameEmail = (a: string | null, b: string | null) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase())
const samePhone = (a: string | null, b: string | null) => Boolean(digits(a) && digits(a) === digits(b))
type ResolveMode = 'agregar' | 'transferir'

const formatDate = (value: string) => new Date(value).toLocaleString('es-MX', { timeZone: 'America/Mexico_City', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

function changes(entry: RegistrationLogEntry) {
  if (entry.result !== 'confirmado' || entry.historical) return []
  const fields: [string, string | null, string][] = [['Nombre', entry.previousName, entry.name], ['Correo', entry.previousEmail, entry.email], ['Teléfono', entry.previousPhone, entry.phone], ['Empresa', entry.previousCompany, entry.company]]
  return fields.filter(([, before, after]) => (before || '').trim() && (before || '').trim().toLowerCase() !== after.trim().toLowerCase()).map(([label, before, after]) => `${label}: «${before}» → «${after || 'vacío'}»`)
}

function detail(entry: RegistrationLogEntry) {
  const base = baseDetail(entry)
  if (!entry.resolution) return base
  if (entry.result === 'confirmado') return `Lo confirmó el equipo desde la bitácora (${resolutionLabels[entry.resolution].toLowerCase()}).${base ? ' ' + base : ''}`
  return `${base} Resuelto: ${resolutionLabels[entry.resolution].toLowerCase()}.`
}

function baseDetail(entry: RegistrationLogEntry) {
  if (entry.result === 'contacto_de_otro') return `Ese correo o teléfono es de ${entry.previousName || entry.guestName || 'otro invitado'}. No se le entregó entrada.`
  if (entry.result === 'contacto_en_uso') return `Intentaba confirmar la invitación de ${entry.previousName || entry.guestName || 'un invitado'} con un correo o teléfono que ya tiene otro invitado.`
  if (entry.result === 'no_encontrado') return 'Su correo o teléfono no está en la lista de invitados. No se le entregó entrada.'
  const changed = changes(entry)
  if (changed.length) return `Cambió sus datos al confirmar. ${changed.join(' · ')}`
  return entry.historical ? 'Confirmación anterior a la bitácora.' : ''
}

const registrationCsv = (entries: RegistrationLogEntry[]) => [
  ['fecha', 'resultado', 'nombre', 'correo', 'celular', 'empresa', 'invitacion_relacionada', 'detalle', 'revisado'],
  ...entries.map(e => [new Date(e.createdAt).toLocaleString('es-MX', { timeZone: 'America/Mexico_City' }), resultLabels[e.result], e.name, e.email, e.phone, e.company, e.previousName || e.guestName || '', detail(e), e.reviewedAt ? 'Sí' : 'No']),
]

function downloadCsv(rows: string[][], fileName: string) {
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  URL.revokeObjectURL(url)
}

export default function RegistrationLogPage() {
  const canReview = useCanManageInvitations()
  const { data = [], isPending, isError, refetch } = useQuery({ queryKey: ['registration-log'], queryFn: getRegistrationLog, refetchInterval: 60_000 })
  const { data: tickets = [], isPending: ticketsPending, isError: ticketsError } = useQuery({ queryKey: ['ticket-log'], queryFn: getTicketLog, refetchInterval: 60_000 })
  const { data: bounces = [], isPending: bouncesPending, isError: bouncesError } = useQuery({ queryKey: ['email-bounces'], queryFn: getEmailBounces, refetchInterval: 60_000 })
  const { data: deleted = [], isPending: deletedPending, isError: deletedError } = useQuery({ queryKey: ['deleted-guests'], queryFn: getDeletedGuests, refetchInterval: 60_000 })
  const [tab, setTab] = useState<'outside' | 'all' | 'tickets' | 'bounces' | 'deleted'>('outside')
  const [ticketFilter, setTicketFilter] = useState<'problems' | 'all'>('problems')
  const [showReviewed, setShowReviewed] = useState(false)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [resolving, setResolving] = useState<{ entry: RegistrationLogEntry; mode: ResolveMode } | null>(null)
  const outside = data.filter(isOutsideList)
  const pendingOutside = outside.filter(e => !e.reviewedAt)
  const term = normalize(search.trim())
  const visible = (tab === 'outside' ? outside.filter(e => showReviewed || !e.reviewedAt) : data)
    .filter(e => !term || normalize([e.name, e.email, e.phone, e.company, e.previousName || '', e.guestName || ''].join(' ')).includes(term))
  const visibleTickets = tickets.filter(t => !term || normalize([t.name, t.email, t.company].join(' ')).includes(term))
  const visibleBounces = bounces.filter(b => !term || normalize([b.email, b.guestName || ''].join(' ')).includes(term))
  const visibleDeleted = deleted.filter(d => !term || normalize([d.name, d.email, d.phone, d.company, d.reason || '', d.deletedBy || '', deletedState(d)].join(' ')).includes(term))
  const ticketProblems = tickets.filter(t => ['rebotada', 'pendiente'].includes(ticketState(t, bounces).state)).length
  const warning = blockWarning(recentAccountBlock(bounces))
  const emailTab = tab === 'tickets' || tab === 'bounces' || tab === 'deleted'
  const loading = tab === 'tickets' ? ticketsPending || bouncesPending : tab === 'bounces' ? bouncesPending : tab === 'deleted' ? deletedPending : isPending
  const failed = tab === 'tickets' ? ticketsError || bouncesError : tab === 'bounces' ? bouncesError : tab === 'deleted' ? deletedError : isError
  const titles = { outside: 'Registros', all: 'Registros', tickets: 'Entradas por correo', bounces: 'Correos rebotados', deleted: 'Invitados eliminados' }
  const descriptions = {
    outside: 'Cada intento de registro queda guardado, aunque la persona no esté en la lista o use el correo o teléfono de otro invitado. A ellas no se les entrega entrada: aparecen en «Fuera de la lista» para que el equipo las revise.',
    all: 'Cada intento de registro queda guardado, aunque la persona no esté en la lista o use el correo o teléfono de otro invitado. A ellas no se les entrega entrada: aparecen en «Fuera de la lista» para que el equipo las revise.',
    tickets: 'A cada invitado que confirma se le manda su entrada por correo. Aquí se ve si salió, si rebotó y por qué. Aunque el correo rebote, la persona sí ve su QR al confirmar y en su enlace personal.',
    deleted: 'Quienes se eliminaron de la lista ya no cuentan en Pendientes, Confirmados ni Cancelaron, y su enlace personal dejó de funcionar. Aquí queda cuándo se dieron de alta, cuándo y quién los eliminó, el motivo y cómo estaban.',
    bounces: 'Avisos de «correo no entregado» registrados de la bandeja del remitente (se cargan con SQL; no hay registro automático). Si rebotó por el bloqueo de la cuenta remitente, el envío queda pendiente solo para volver a mandarlo; las direcciones inexistentes o rechazadas hay que revisarlas.',
  }
  function exportCsv() {
    if (tab === 'tickets') downloadCsv(ticketCsv(visibleTickets, bounces), 'entradas-por-correo.csv')
    else if (tab === 'bounces') downloadCsv(bounceCsv(visibleBounces), 'correos-rebotados.csv')
    else if (tab === 'deleted') downloadCsv(deletedCsv(visibleDeleted), 'invitados-eliminados.csv')
    else downloadCsv(registrationCsv(visible), tab === 'outside' ? 'registros-fuera-de-lista.csv' : 'bitacora-de-registros.csv')
  }
  async function toggleReviewed(entry: RegistrationLogEntry) {
    setSaving(entry.id)
    setError('')
    const result = await markRegistrationReviewed(entry.id, !entry.reviewedAt)
    setSaving(null)
    if (result.error) { setError('No se pudo guardar. Revisa tus permisos e inténtalo de nuevo.'); return }
    await refetch()
  }
  return <section className="dashboard reglog">
    <div className="page-heading"><div><p className="eyebrow orange">Bitácora</p><h2>{titles[tab]} <span>{tab === 'tickets' ? tickets.length : tab === 'bounces' ? bounces.length : tab === 'deleted' ? deleted.length : data.length}</span></h2><p className="muted">{descriptions[tab]}</p></div>
      <div className="page-actions"><button className="button button-dark" disabled={tab === 'tickets' ? !visibleTickets.length : tab === 'bounces' ? !visibleBounces.length : tab === 'deleted' ? !visibleDeleted.length : !visible.length} onClick={exportCsv}><Download size={16} /> Exportar CSV</button></div></div>
    {warning && <p className="form-error emaillog-warning" role="alert">{warning}</p>}
    <div className="filter-bar"><div className="search-box"><Search size={17} /><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar por nombre, correo, celular o empresa" /></div>
      {tab === 'outside' && <label className="filter-button reglog-toggle"><input type="checkbox" checked={showReviewed} onChange={e => setShowReviewed(e.target.checked)} /> Mostrar revisados</label>}
      {tab === 'tickets' && <label className="filter-button"><select aria-label="Filtrar entradas" value={ticketFilter} onChange={e => setTicketFilter(e.target.value as 'problems' | 'all')}><option value="problems">Rebotadas o sin enviar</option><option value="all">Todas las entradas</option></select></label>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="guest-list-summary reglog-notice" role="status">{notice}</p>}
    <div className="panel guests-table-panel reglog-panel">
      <div className="table-tabs"><button className={tab === 'outside' ? 'selected' : ''} onClick={() => setTab('outside')}>Fuera de la lista <b>{pendingOutside.length}</b></button><button className={tab === 'all' ? 'selected' : ''} onClick={() => setTab('all')}>Todos los registros <b>{data.length}</b></button><button className={tab === 'tickets' ? 'selected' : ''} onClick={() => setTab('tickets')}>Entradas <b>{ticketProblems}</b></button><button className={tab === 'bounces' ? 'selected' : ''} onClick={() => setTab('bounces')}>Rebotes <b>{bounces.length}</b></button><button className={tab === 'deleted' ? 'selected' : ''} onClick={() => setTab('deleted')}>Eliminados <b>{deleted.length}</b></button></div>
      {!emailTab && <div className="reglog-head"><span>FECHA</span><span>PERSONA</span><span>EMPRESA</span><span>RESULTADO</span><span>DETALLE</span><span></span></div>}
      {loading ? <p className="guest-list-empty" role="status">Cargando bitácora…</p>
        : failed ? <p className="guest-list-empty" role="alert">No pudimos cargar la bitácora. Revisa tu conexión.</p>
        : tab === 'tickets' ? <TicketLogTable tickets={visibleTickets} bounces={bounces} filter={ticketFilter} canResend={canReview} onNotice={setNotice} onError={setError} />
        : tab === 'bounces' ? <BounceLogTable bounces={visibleBounces} />
        : tab === 'deleted' ? <DeletedGuestsTable entries={visibleDeleted} />
        : visible.length === 0 ? <p className="guest-list-empty">{tab === 'outside' ? 'No hay personas fuera de la lista pendientes de revisar.' : 'Aún no hay registros.'}</p>
        : visible.map(entry => <div className={`reglog-line ${entry.reviewedAt ? 'reviewed' : ''}`} key={entry.id}>
          <span className="reglog-date">{formatDate(entry.createdAt)}</span>
          <span className="reglog-person"><strong>{entry.name || 'Sin nombre'}</strong><small>{[entry.email, entry.phone].filter(Boolean).join(' · ') || 'Sin contacto'}</small></span>
          <span>{entry.company || '—'}</span>
          <span className={`reglog-result reglog-${entry.result}`}>{resultLabels[entry.result]}</span>
          <span className="reglog-detail">{detail(entry)}</span>
          <span className="reglog-actions">{isOutsideList(entry) && (entry.resolution
            ? <small>{resolutionLabels[entry.resolution]}</small>
            : canReview
            ? <>
              <button className="row-action" disabled={saving !== null} onClick={() => { setNotice(''); setResolving({ entry, mode: 'agregar' }) }}><UserPlus size={14} /> Agregar como invitado</button>
              {entry.guestId && <button className="row-action" disabled={saving !== null} onClick={() => { setNotice(''); setResolving({ entry, mode: 'transferir' }) }}><Repeat size={14} /> Pasarle la invitación</button>}
              <button className="row-action" disabled={saving !== null} onClick={() => void toggleReviewed(entry)}>{entry.reviewedAt ? <><Undo2 size={14} /> Revisado</> : <><Check size={14} /> {saving === entry.id ? 'Guardando…' : 'Marcar revisado'}</>}</button>
            </>
            : entry.reviewedAt ? <small>Revisado</small> : null)}</span>
        </div>)}
    </div>
    {resolving && <ResolveModal key={`${resolving.entry.id}-${resolving.mode}`} entry={resolving.entry} mode={resolving.mode} onClose={() => setResolving(null)} onDone={message => { setResolving(null); setNotice(message) }} />}
  </section>
}

function initialForm(entry: RegistrationLogEntry, mode: ResolveMode) {
  if (mode === 'transferir') return {
    name: entry.name,
    email: entry.email || entry.previousEmail || '',
    phone: entry.phone || entry.previousPhone || '',
    company: entry.company || entry.previousCompany || '',
  }
  // Un invitado nuevo no puede quedarse con el correo o celular del invitado original.
  const owner = entry.result === 'contacto_de_otro'
  return {
    name: entry.name,
    email: owner && sameEmail(entry.email, entry.previousEmail) ? '' : entry.email,
    phone: owner && samePhone(entry.phone, entry.previousPhone) ? '' : entry.phone,
    company: entry.company,
  }
}

const resolveErrors: Record<string, string> = {
  already_resolved: 'Este registro ya se resolvió. Actualiza la página.',
  already_confirmed: 'Este registro ya está confirmado.',
  name_required: 'Captura el nombre de la persona.',
  contact_required: 'Captura un correo o un celular.',
  no_invitation: 'La invitación original ya no existe. Usa «Agregar como invitado».',
  already_checked_in: 'Esa invitación ya registró su llegada al evento; no se puede pasar a otra persona.',
}

function ResolveModal({ entry, mode, onClose, onDone }: { entry: RegistrationLogEntry; mode: ResolveMode; onClose: () => void; onDone: (message: string) => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState(() => initialForm(entry, mode))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const owner = entry.previousName || entry.guestName || 'otro invitado'
  const contactCleared = Boolean(mode === 'agregar' && entry.result === 'contacto_de_otro' && ((entry.email && !form.email && sameEmail(entry.email, entry.previousEmail)) || (entry.phone && !form.phone && samePhone(entry.phone, entry.previousPhone))))
  const close = () => { if (!saving) onClose() }
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (saving) return
    setError('')
    if (!form.name.trim()) { setError(resolveErrors.name_required); return }
    if (!form.email.trim() && !form.phone.trim()) { setError(resolveErrors.contact_required); return }
    setSaving(true)
    try {
      const result = await resolveRegistration(entry.id, mode, form)
      if (result.error) throw result.error
      const data = result.data
      if (data && data.status === 'contact_in_use') { setError(data.field === 'phone' ? 'Ese celular ya es de otro invitado. Captura otro o déjalo vacío si tiene correo.' : 'Ese correo ya es de otro invitado. Captura otro o déjalo vacío si tiene celular.'); return }
      if (data && data.status !== 'ok') { setError(resolveErrors[data.status] || 'No se pudo resolver el registro.'); return }
      const name = form.name.trim()
      let message = `${name} quedó confirmado(a).`
      if (data?.status === 'ok' && data.email) {
        const sent = await sendTicket(data.token).catch(() => ({ error: new Error('fallo') }))
        message += sent.error ? ` No se pudo mandar su entrada a ${data.email}; usa «Reenviar entrada» en Invitados.` : ` Se le mandó su entrada a ${data.email}.`
      } else if (data?.status === 'ok') message += ' No tiene correo: compártele su entrada desde Invitados → Ver entrada.'
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['registration-log'] }), queryClient.invalidateQueries({ queryKey: ['guests'] })])
      onDone(message)
    } catch {
      setError('No se pudo resolver el registro. Revisa tu conexión y tus permisos e inténtalo de nuevo.')
    } finally { setSaving(false) }
  }
  return <div className="modal-backdrop" onMouseDown={close}><div className="modal-card guest-form-modal" role="dialog" aria-modal="true" aria-labelledby="resolve-title" onMouseDown={e => e.stopPropagation()}>
    <button className="modal-close" disabled={saving} onClick={close} aria-label="Cerrar">×</button>
    <p className="eyebrow orange">Fuera de la lista</p>
    <h2 id="resolve-title">{mode === 'agregar' ? 'Agregar como invitado' : 'Pasarle la invitación'}</h2>
    {mode === 'agregar'
      ? <p className="muted">Se crea una invitación nueva a su nombre y queda confirmada. Si tiene correo, se le manda su entrada.</p>
      : <p className="muted">La invitación de <strong>{owner}</strong> pasa a esta persona: cambian el nombre y los datos, queda confirmada y se manda la entrada al correo que captures. <strong>{owner}</strong> pierde su lugar y su entrada anterior.</p>}
    {contactCleared && <p className="muted">El correo o celular que escribió es de {owner}. Captura uno propio de esta persona.</p>}
    <form onSubmit={save}>
      <label>Nombre completo<input disabled={saving} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
      <label>Correo electrónico <small>(opcional si registras celular)</small><input type="email" disabled={saving} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="nombre@empresa.com" /></label>
      <label>Celular <small>(opcional si registras correo)</small><input type="tel" disabled={saving} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} /></label>
      <label>Empresa<input disabled={saving} value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button button-orange" disabled={saving}>{saving ? 'Guardando…' : mode === 'agregar' ? 'Agregar y confirmar' : 'Pasarle la invitación'} <ArrowRight size={16} /></button>
    </form>
  </div></div>
}
