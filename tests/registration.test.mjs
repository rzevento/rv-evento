import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const start = source.indexOf('function RegistrationPage(')
const component = source.slice(start, source.indexOf('\n}\n', start) + 3)
const compiled = ts.transpileModule(component, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText
function setup({ cancelError = false, submitError = null, submitData = null, beginResult = { token: 'personal-token', status: 'already_registered' } } = {}) {
  const state = [], calls = []
  let cursor = 0
  const details = { name: 'Ana Pérez', email: 'ana@example.com', phone: '', company: 'Empresa', status: submitError || submitData ? 'pending' : 'confirmed' }
  const context = {
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = value }] },
    getInvitationDetails: async () => ({ data: details, error: null }),
    sendTicket: async () => undefined,
    submitRsvp: async input => { calls.push(['submit', input.token, input.email]); return { data: submitData, error: submitError } },
    beginRsvp: async input => { calls.push(['begin', input.email]); return { data: beginResult, error: null } },
    cancelRsvp: async token => { calls.push(token); return { error: cancelError ? new Error('network') : null } },
    registrationMessages: { notFound: 'No encontramos esta dirección de correo electrónico', phoneNotFound: 'No encontramos este número de teléfono', contactOfAnother: 'corresponde a la invitación de otra persona', phoneInUse: 'Este teléfono ya está registrado con otro invitado', emailInUse: 'Este correo ya está registrado con otro invitado' },
    event: {}, Logo: 'Logo', Aniversario: 'Aniversario', Link: 'Link',
  }
  for (const name of ['Check', 'CalendarDays', 'ShieldCheck', 'Download', 'ArrowRight', 'MapPin', 'LockKeyhole']) context[name] = name
  vm.createContext(context)
  vm.runInContext(compiled, context)
  return {
    calls,
    render() { cursor = 0; return context.RegistrationPage() },
  }
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] }
function text(tree) { return typeof tree === 'string' ? tree : (tree?.children || []).flat(Infinity).map(text).join(' ') }

async function submit(app, { email = 'ana@example.com', name = 'Ana Pérez', company = 'Empresa' } = {}) {
  let tree = app.render()
  nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.onChange({ target: { value: email } })
  tree = app.render()
  nodes(tree).find(n => n.type === 'input' && n.props.autoComplete === 'name').props.onChange({ target: { value: name } })
  tree = app.render()
  nodes(tree).find(n => n.type === 'input' && n.props.autoComplete === 'organization').props.onChange({ target: { value: company } })
  tree = app.render()
  await nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  return app.render()
}

test('the registration page starts empty: a forwarded invitation never shows another guest\'s data', () => {
  const tree = setup().render()
  for (const input of nodes(tree).filter(n => n.type === 'input')) assert.equal(input.props.value, '')
  assert.doesNotMatch(text(tree), /ya está confirmada/)
})
test('an already registered guest gets the reserved place with download/cancel actions', async () => {
  const app = setup()
  const tree = await submit(app)
  assert.match(text(tree), /Su asistencia ya está confirmada/)
  assert.match(text(tree), /No necesita registrarse otra vez/)
  assert.ok(nodes(tree).some(n => n.type === 'button' && text(n).trim() === 'Descargar entrada'))
  nodes(tree).find(n => n.type === 'button' && text(n) === 'Cancelar mi asistencia').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(app.calls.filter(c => typeof c === 'string'), ['personal-token'])
  assert.match(text(app.render()), /Su cancelación quedó registrada/)
  assert.match(text(app.render()), /Volver a confirmar asistencia/)
})
test('a failed cancellation keeps the invitation available and displays an error', async () => {
  const app = setup({ cancelError: true })
  await submit(app)
  await nodes(app.render()).find(n => n.type === 'button' && text(n) === 'Cancelar mi asistencia').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  const tree = app.render()
  assert.match(text(tree), /No pudimos cancelar su asistencia/)
  assert.match(text(tree), /Descargar entrada/)
  assert.doesNotMatch(text(tree), /Su cancelación quedó registrada/)
})
test('a guest who received a forwarded invitation registers with their own email', async () => {
  const app = setup({ submitData: { status: 'confirmed' }, beginResult: { token: 'token-de-luis', status: 'pending' } })
  const tree = await submit(app, { email: 'luis@example.com', name: 'Luis Gómez' })
  assert.deepEqual(app.calls.filter(c => c[0] === 'begin'), [['begin', 'luis@example.com']])
  assert.deepEqual(app.calls.filter(c => c[0] === 'submit'), [['submit', 'token-de-luis', 'luis@example.com']])
  assert.match(text(tree), /Su lugar está reservado/)
})

for (const [constraint, message] of [
  ['guests_event_phone_key', 'Este teléfono ya está registrado con otro invitado'],
  ['guests_event_email_key', 'Este correo ya está registrado con otro invitado'],
  ['unrelated_constraint', 'No pudimos completar el registro'],
]) {
  test(`registration reports ${constraint} without confirming the guest`, async () => {
    const app = setup({ beginResult: { token: 'personal-token', status: 'pending' }, submitError: { code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` } })
    const tree = await submit(app)
    assert.match(text(tree), new RegExp(message))
    assert.doesNotMatch(text(tree), /Su lugar está reservado/)
    assert.equal(nodes(tree).filter(n => n.type === 'form').length, 1)
  })
}

for (const [status, message] of [['not_found', /No encontramos esta dirección de correo electrónico/], ['name_mismatch', /corresponde a la invitación de otra persona/]]) {
  test(`the registration page does not hand out another guest's pass when begin_rsvp answers ${status}`, async () => {
    const app = setup({ beginResult: { status } })
    const tree = await submit(app, { email: 'otra@example.com', name: 'Luis Gómez' })
    assert.match(text(tree), message)
    assert.doesNotMatch(text(tree), /Descargar entrada/)
    assert.deepEqual(app.calls.filter(c => c[0] === 'submit'), [])
  })
}
test('a name that does not match at submit time is not confirmed', async () => {
  const app = setup({ beginResult: { token: 'personal-token', status: 'pending' }, submitData: { status: 'name_mismatch' } })
  const tree = await submit(app)
  assert.match(text(tree), /corresponde a la invitación de otra persona/)
  assert.doesNotMatch(text(tree), /Su lugar está reservado/)
})
