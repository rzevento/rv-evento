import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const require = createRequire(import.meta.url)
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
} }).outputText
const permissions = { exports: {}, require }
vm.runInNewContext(compile(readFileSync(new URL('../src/lib/organizer-permissions.ts', import.meta.url), 'utf8')), permissions)
const { OrganizerRoleContext, useCanManageInvitations, useCanSendInvitations } = permissions.exports
function loadDashboardModule(path, dependencies = {}) {
  const context = { exports: {}, require: name => name.endsWith('.css') ? {} : dependencies[name] || require(name) }
  vm.runInNewContext(compile(readFileSync(new URL(path, import.meta.url), 'utf8')), context)
  return context.exports
}
const dashboardModel = loadDashboardModule('../src/lib/dashboard.ts')
const emailQueue = loadDashboardModule('../src/lib/email-queue.ts')
const dailyChart = loadDashboardModule('../src/components/DailyConfirmations.tsx', { '../lib/dashboard': dashboardModel })
const { default: EventDashboard } = loadDashboardModule('../src/components/EventDashboard.tsx', { '../lib/dashboard': dashboardModel, './DailyConfirmations': dailyChart })

const { default: ImpersonationControl } = loadDashboardModule('../src/components/ImpersonationControl.tsx', { '../lib/supabase': {}, '@tanstack/react-query': { useQuery: () => ({ data: [], isPending: false }) } })
const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const ast = ts.createSourceFile('main.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
// Render the actual page components; external data and session are controlled fixtures.
const componentSource = ast.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(ast)).join('\n').replaceAll('import.meta.env', '({})')
const icons = source.match(/import \{ ([^}]+) \} from 'lucide-react'/)[1].split(', ').map(name => name.trim())
const guest = { id: 'guest-1', name: 'Persona de prueba', company: 'Empresa', email: 'test@example.com', phone: '3312345678', invite: 'Pendiente', status: 'Pendiente', checkedIn: false }
function render(component, { emailBatch = null, role = 'staff', actorIsAdmin = role === 'admin', impersonationId = null, profilePending = false, profileError = false, authenticated = true, sent = false, reminded = false, captureButtons, onDownload } = {}) {
  const data = [{ ...guest, invite: sent ? 'Enviada' : 'Pendiente', reminderSentAt: reminded ? '2026-10-20T17:15:46Z' : null }]
  const stateValues = component === 'AdminLayout' ? [true, authenticated, false, 'user-1', false] : []
  let stateIndex = 0
  let exportBlob
  const sandbox = {
    Blob, URL: { createObjectURL(blob) { exportBlob = blob; return "blob:test" }, revokeObjectURL() {} },
    document: { createElement: () => ({ click() { onDownload?.({ blob: exportBlob, filename: this.download }) } }) },
    exports: {}, require: name => {
      const module = require(name)
      if (name !== 'react/jsx-runtime' || !captureButtons) return module
      return Object.fromEntries(Object.entries(module).map(([key, value]) => [key, key === 'jsx' || key === 'jsxs' ? (type, props, ...rest) => {
        if (type === 'button') captureButtons(props)
        return value(type, props, ...rest)
      } : value]))
    }, ...React,
    useState(initial) {
      const index = stateIndex++
      return React.useState(index < stateValues.length ? stateValues[index] : initial)
    },
    OrganizerRoleContext, useCanManageInvitations, useCanSendInvitations, EventDashboard, ImpersonationControl, getImpersonationId: () => null,
    useQuery({ queryKey }) {
      if (queryKey[0] === 'event-members') return { data: [{ userId: 'user-1', displayName: 'Administradora', email: 'admin@example.com', role: 'Administrador', roleCode: 'admin' }, { userId: 'user-2', displayName: 'Integrante', email: 'staff@example.com', role: 'Equipo', roleCode: 'staff' }], isLoading: false }
      if (queryKey[0] === 'email-batch') return { data: emailBatch, isPending: false, isError: false }
      if (queryKey[0] === 'configuration-profile') return { data: { userId: 'user-1', roleCode: 'admin' }, isLoading: false }
      return queryKey[0] === 'organizer-profile'
        ? { data: profilePending || profileError ? undefined : { displayName: 'Persona de prueba', role: 'Equipo', roleCode: role, actorIsAdmin, actorUserId: 'user-1', userId: 'user-1', eventId: 'event-1', impersonationId }, isPending: profilePending, isError: profileError }
        : { data, isPending: false, isError: false }
    },
    useMutation: () => ({ mutate() {} }), useIsMutating: () => 0,
    useNavigate: () => () => {}, guestQuery: () => {},
    Link: ({ children, to }) => React.createElement('a', { href: to }, children),
    Outlet: () => React.createElement('div', null, 'Contenido del panel'),
    ...Object.fromEntries(icons.map(name => [name, () => null])),
    supabase: null, demoGuests: data, canSendPendingEmail: () => true, canSendReminderEmail: item => item.invite === 'Enviada' && item.status === 'Pendiente' && !item.reminderSentAt, whatsappPhone: value => value, canSendPendingTicket: () => true, BULK_EMAIL_PAUSE_MS: 15000, bulkDurationLabel: () => '1 min', getEmailBounces: () => [], recentAccountBlock: () => null, blockWarning: () => '',
    getEmailBatchStatus: () => null, enqueueBulkEmail: () => {}, stopEmailBatch: () => {}, ...emailQueue,
    localStorage: { getItem: () => null },
    event: { title: 'Evento de prueba', date: '3 de diciembre' },
  }
  vm.runInNewContext(compile(componentSource + `\nexports.Component = ${component};`), sandbox)
  return renderToStaticMarkup(React.createElement(OrganizerRoleContext.Provider, { value: role }, React.createElement(sandbox.exports.Component)))
}
const restrictedLabels = ['Nueva invitación', 'Descargar lista de invitados', 'Enviar todas las invitaciones', 'Enviar todos los recordatorios', 'Enviar entradas pendientes', 'Exportar CSV', 'Exportar filtrados', 'Cargar masivamente', 'Agregar invitado', 'Enviar correo', 'Reenviar invitación', 'Abrir WhatsApp', 'Marcar WhatsApp enviado']
for (const role of ['staff', 'viewer', null, 'unexpected']) {
  test(`${role}: summary and guest consultation remain available without invitation controls`, () => {
    const shell = render('AdminLayout', { role })
    assert.match(shell, /> Resumen</)
    assert.match(shell, /> Invitados /)
    assert.match(shell, /<button[^>]*aria-label="Cerrar sesión"[^>]*><span>Cerrar sesión<\/span><\/button>/)
    const summary = render('SummaryPage', { role })
    assert.match(summary, /Detalle de invitados/)
    const guests = render('GuestsPage', { role })
    assert.match(guests, /Persona de prueba/)
    assert.match(guests, /Buscar por nombre/)
    assert.match(guests, /Filtrar por respuesta/)
    assert.match(guests, /Ver entrada/)
    assert.match(guests, /Registrar llegada/)
    for (const sent of [false, true]) {
      const html = shell + summary + render('GuestsPage', { role, sent })
      for (const label of restrictedLabels) assert.ok(!html.includes(label), `${role} sees ${label}`)
    }
  })
}
test('only administrator can open configuration or load guests', () => {
  for (const role of ['leader', 'staff', 'viewer', null, 'unexpected']) {
    assert.doesNotMatch(render('AdminLayout', { role }), /Configuración/)
    assert.doesNotMatch(render('GuestsPage', { role }), /Cargar masivamente|Agregar invitado/)
    const settings = render('ConfigurationPage', { role })
    assert.match(settings, /No tienes acceso a la configuración/)
    assert.doesNotMatch(settings, /Usuarios autorizados/)
  }
  assert.match(render('AdminLayout', { role: 'admin' }), /Configuración/)
  assert.match(render('GuestsPage', { role: 'admin' }), /Cargar masivamente/)
  const adminSettings = render('ConfigurationPage', { role: 'admin' })
  assert.match(adminSettings, /Usuarios autorizados/)
  assert.match(adminSettings, /Guardar rol/)
  assert.match(adminSettings, /Rol de Integrante/)
  assert.doesNotMatch(adminSettings, /Rol de Administradora/)
})

test('administrator retains header, bulk, export, import, creation and individual email actions', () => {
  const html = render('AdminLayout', { role: 'admin' }) + render('SummaryPage', { role: 'admin' }) + render('GuestsPage', { role: 'admin' }) + render('GuestsPage', { role: 'admin', sent: true })
  for (const label of restrictedLabels.filter(label => label !== 'Abrir WhatsApp')) assert.ok(html.includes(label), `admin missing ${label}`)
})
test('pending and failed profile checks never render privileged controls or the panel', () => {
  for (const options of [{ profilePending: true }, { profileError: true }]) {
    const html = render('AdminLayout', { role: 'admin', ...options })
    for (const label of restrictedLabels) assert.ok(!html.includes(label))
    assert.ok(!html.includes('Contenido del panel'))
  }
})
test('effective profile comes from the server authorization context', async () => {
  const source = readFileSync(new URL('../src/lib/supabase.ts', import.meta.url), 'utf8')
  const profileSource = source.slice(source.indexOf('export async function getCurrentOrganizerProfile('), source.indexOf('export async function startOrganizerImpersonation('))
  const sandbox = { exports: {}, supabase: {
    rpc: async name => { assert.equal(name, 'get_organizer_context'); return {data:{roleCode:'staff',role:'Equipo'},error:null} },
  } }
  vm.runInNewContext(compile(profileSource), sandbox)
  const result = await sandbox.exports.getCurrentOrganizerProfile()
  assert.equal(result.data.roleCode, 'staff')
})
test('only the real administrator sees the impersonation control', () => {
  const admin = render('AdminLayout', {role:'admin'})
  assert.match(admin, /<nav[^>]*>.*Ver como usuario.*<\/nav>/)
  assert.doesNotMatch(admin.slice(admin.indexOf('<main')), /Ver como usuario/)
  for (const role of ['staff','viewer',null,'unexpected']) assert.doesNotMatch(render('AdminLayout', {role}), /Ver como usuario/)
  const impersonated = render('AdminLayout', { role: 'staff', actorIsAdmin: true, impersonationId: 'session-1' })
  assert.match(impersonated, /<nav[^>]*>.*Volver a mi cuenta.*<\/nav>/)
  assert.match(impersonated, /Actuando como Persona de prueba/)
})

test('administrator export button downloads the guest list', async () => {
  const buttons = []
  let downloaded
  render('GuestsPage', { role: 'admin', captureButtons: props => buttons.push(props), onDownload: result => { downloaded = result } })
  const button = buttons.find(props => React.Children.toArray(props.children).some(child => typeof child === 'string' && child.includes('Exportar CSV')))
  assert.ok(button)
  button.onClick()
  assert.equal(downloaded.filename, 'invitados-reformas-fiscales-2027.csv')
  assert.match(await downloaded.blob.text(), /test@example.com/)
})

test('leader can send existing invitations but cannot manage guests or open settings', () => {
  const shell = render('AdminLayout', { role: 'leader' })
  const guests = render('GuestsPage', { role: 'leader' })
  const settings = render('ConfigurationPage', { role: 'leader' })
  assert.doesNotMatch(shell, /Configuración|Nueva invitación|Descargar lista de invitados/)
  for (const label of ['Enviar todas las invitaciones', 'Enviar todos los recordatorios', 'Enviar correo', 'Marcar WhatsApp enviado']) assert.match(guests, new RegExp(label))
  assert.match(render('GuestsPage', { role: 'leader', sent: true }), /Enviar todos los recordatorios \(1\)/)
  const alreadyReminded = render('GuestsPage', { role: 'leader', sent: true, reminded: true })
  assert.match(alreadyReminded, /Enviar todos los recordatorios \(0\)/)
  assert.match(alreadyReminded, /Recordatorio enviado/)
  assert.doesNotMatch(alreadyReminded, />Enviar recordatorio<\/button>/)
  for (const label of ['Exportar CSV', 'Cargar masivamente', 'Agregar invitado', 'Editar', 'Eliminar']) assert.doesNotMatch(guests, new RegExp(label))
  assert.match(settings, /No tienes acceso a la configuración/)
  assert.doesNotMatch(settings, /Usuarios autorizados/)
})

const counts = { total: 10, queued: 6, sending: 1, sent: 3, omitted: 0, rejected: 0, failed: 0, cancelled: 0 }
const activeBatch = { id: 'batch-1', kind: 'invitacion', createdAt: new Date().toISOString(), createdByName: 'Sandra', stoppedAt: null, stopReason: null, lastActivity: new Date().toISOString(), counts, problems: [] }
test('server bulk send shows its progress and stop button on every panel page, only to senders', () => {
  for (const role of ['admin', 'leader']) {
    const shell = render('AdminLayout', { role, emailBatch: activeBatch })
    assert.match(shell, /Enviando invitaciones desde el servidor: 3 de 10/)
    assert.match(shell, /Detener envío/)
    assert.match(shell, /<div class="bulk-email-progress active"[^>]*>.*<\/div><div>Contenido del panel<\/div>/)
  }
  for (const role of ['staff', 'viewer', null]) assert.doesNotMatch(render('AdminLayout', { role, emailBatch: activeBatch }), /bulk-email-progress/)
  const guests = render('GuestsPage', { role: 'admin', emailBatch: activeBatch })
  for (const label of ['Enviar todas las invitaciones', 'Enviar todos los recordatorios', 'Enviar entradas pendientes']) {
    assert.match(guests, new RegExp(`<button[^>]*disabled=""[^>]*>(?:(?!</button>).)*${label}`), `${label} enabled during a server send`)
  }
  assert.doesNotMatch(render('GuestsPage', { role: 'admin' }), /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Enviar todas las invitaciones/)
})
test('a finished server send lists the guests it could not send and can be dismissed', () => {
  const finished = { ...activeBatch, stoppedAt: new Date().toISOString(), stopReason: 'x@y.com: no se confirmó el envío', counts: { ...counts, queued: 0, sending: 0, sent: 8, failed: 1, cancelled: 1 }, problems: [{ email: 'x@y.com', status: 'failed', detail: 'no se confirmó el envío' }] }
  const shell = render('AdminLayout', { role: 'admin', emailBatch: finished })
  assert.match(shell, /Envío de invitaciones detenido: 8 enviado\(s\), 1 con problema, 1 sin enviar\./)
  assert.match(shell, /No se enviaron \(revísalos y vuelve a intentar\): x@y.com: no se confirmó el envío/)
  assert.match(shell, /Cerrar aviso/)
  assert.doesNotMatch(shell, /Detener envío/)
  const old = { ...finished, lastActivity: '2026-01-01T00:00:00Z' }
  assert.doesNotMatch(render('AdminLayout', { role: 'admin', emailBatch: old }), /bulk-email-progress/)
})
