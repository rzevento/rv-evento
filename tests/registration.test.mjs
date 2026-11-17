import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8')
const component = source.slice(source.indexOf('function RegistrationPage('), source.indexOf('function TokenRegistrationPage('))
const compiled = ts.transpileModule(component, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText
function setup({ direct = false, cancelError = false, submitError = null, submitData = null, beginResult = { token: 'personal-token', status: 'already_registered' } } = {}) {
  const state = [], effects = [], calls = []
  let cursor = 0, mounted = false
  const details = { name: 'Ana Pérez', email: 'ana@example.com', phone: '', company: 'Empresa', status: submitError || submitData ? 'pending' : 'confirmed' }
  const context = {
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    useState(initial) { const index = cursor++; if (!(index in state)) state[index] = initial; return [state[index], value => { state[index] = value }] },
    useEffect(fn) { if (!mounted) effects.push(fn) },
    getInvitationDetails: async () => ({ data: details, error: null }),
    sendTicket: async () => undefined,
    submitRsvp: async input => { calls.push(['submit', input.token, input.email]); return { data: submitData, error: submitError } },
    beginRsvp: async input => { calls.push(['begin', input.email]); return { data: beginResult, error: null } },
    cancelRsvp: async token => { calls.push(token); return { error: cancelError ? new Error('network') : null } },
    registrationMessages: { notFound: 'No encontramos esta dirección de correo electrónico', phoneNotFound: 'No encontramos este número de teléfono', contactOfAnother: 'corresponde a la invitación de otra persona', linkOfAnother: 'está a nombre de otra persona', phoneInUse: 'Este teléfono ya está registrado con otro invitado', emailInUse: 'Este correo ya está registrado con otro invitado' },
    event: {}, Logo: 'Logo', Aniversario: 'Aniversario', Link: 'Link',
  }
  for (const name of ['Check', 'CalendarDays', 'ShieldCheck', 'Download', 'ArrowRight', 'MapPin', 'LockKeyhole']) context[name] = name
  vm.createContext(context)
  vm.runInContext(compiled, context)
  return {
    calls,
    render() { cursor = 0; const tree = context.RegistrationPage({ token: direct ? 'personal-token' : 'demo' }); mounted = true; return tree },
    async load() { for (const effect of effects) effect(); await new Promise(resolve => setImmediate(resolve)) },
  }
}
function nodes(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...(tree.children || []).flat(Infinity).flatMap(nodes)] }
function text(tree) { return typeof tree === 'string' ? tree : (tree?.children || []).flat(Infinity).map(text).join(' ') }

test('a confirmed personal link shows reserved place and download/cancel actions immediately', async () => {
  const app = setup({ direct: true }); app.render(); await app.load()
  const tree = app.render()
  assert.match(text(tree), /Su asistencia ya está confirmada/)
  assert.match(text(tree), /No necesita registrarse otra vez/)
  assert.ok(nodes(tree).some(n => n.type === 'button' && text(n).trim() === 'Descargar entrada'))
  const cancel = nodes(tree).find(n => n.type === 'button' && text(n) === 'Cancelar mi asistencia')
  cancel.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(app.calls, ['personal-token'])
  assert.match(text(app.render()), /Su cancelación quedó registrada/)
  assert.match(text(app.render()), /Volver a confirmar asistencia/)
})
test('an already registered email retrieves saved guest details before offering the invitation', async () => {
  const app = setup(); let tree = app.render()
  const email = nodes(tree).find(n => n.type === 'input' && n.props.type === 'email')
  email.props.onChange({ target: { value: 'ana@example.com' } })
  tree = app.render()
  nodes(tree).find(n => n.type === 'input' && n.props.autoComplete === 'name').props.onChange({ target: { value: 'Ana Pérez' } })
  tree = app.render()
  await nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.match(text(app.render()), /Su asistencia ya está confirmada/)
})
test('a failed cancellation keeps the invitation available and displays an error', async () => {
  const app = setup({ direct: true, cancelError: true }); app.render(); await app.load()
  await nodes(app.render()).find(n => n.type === 'button' && text(n) === 'Cancelar mi asistencia').props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  const tree = app.render()
  assert.match(text(tree), /No pudimos cancelar su asistencia/)
  assert.match(text(tree), /Descargar entrada/)
  assert.doesNotMatch(text(tree), /Su cancelación quedó registrada/)
})

for (const [constraint, message] of [
  ['guests_event_phone_key', 'Este teléfono ya está registrado con otro invitado'],
  ['guests_event_email_key', 'Este correo ya está registrado con otro invitado'],
  ['unrelated_constraint', 'No pudimos completar el registro'],
]) {
  test(`registration reports ${constraint} without confirming the guest`, async () => {
    const app = setup({ direct: true, submitError: { code: '23505', message: `duplicate key value violates unique constraint "${constraint}"` } })
    app.render(); await app.load()
    await nodes(app.render()).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
    const tree = app.render()
    assert.match(text(tree), new RegExp(message))
    assert.doesNotMatch(text(tree), /Su lugar está reservado/)
    assert.equal(nodes(tree).filter(n => n.type === 'form').length, 1)
  })
}

for (const [status, message] of [['not_found', /No encontramos esta dirección de correo electrónico/], ['name_mismatch', /corresponde a la invitación de otra persona/]]) {
  test(`the home page does not hand out another guest's pass when begin_rsvp answers ${status}`, async () => {
    const app = setup({ beginResult: { status } }); let tree = app.render()
    nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.onChange({ target: { value: 'otra@example.com' } })
    tree = app.render()
    nodes(tree).find(n => n.type === 'input' && n.props.autoComplete === 'name').props.onChange({ target: { value: 'Luis Gómez' } })
    tree = app.render()
    await nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
    tree = app.render()
    assert.match(text(tree), message)
    assert.doesNotMatch(text(tree), /Descargar entrada/)
  })
}
test('a personal link typed with another person\'s name is not confirmed', async () => {
  const app = setup({ direct: true, submitError: null, submitData: { status: 'name_mismatch' } })
  app.render(); await app.load()
  await nodes(app.render()).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  const tree = app.render()
  assert.match(text(tree), /está a nombre de otra persona/)
  assert.doesNotMatch(text(tree), /Su lugar está reservado/)
})

async function submitWithEmail(app, email) {
  let tree = app.render()
  nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.onChange({ target: { value: email } })
  tree = app.render()
  await nodes(tree).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  return app.render()
}

test('a personal link with an email that is not on the list is not registered', async () => {
  const app = setup({ direct: true, submitData: { status: 'confirmed' }, beginResult: { status: 'not_found' } })
  app.render(); await app.load()
  const tree = await submitWithEmail(app, 'nadie@ejemplo.com')
  assert.match(text(tree), /No encontramos esta dirección de correo electrónico/)
  assert.doesNotMatch(text(tree), /Su lugar está reservado/)
  assert.deepEqual(app.calls.filter(c => c[0] === 'submit'), [])
  assert.deepEqual(app.calls.filter(c => c[0] === 'begin'), [['begin', 'nadie@ejemplo.com']])
})

test('a personal link with another invited email registers the invitation of that email', async () => {
  const app = setup({ direct: true, submitData: { status: 'confirmed' }, beginResult: { token: 'token-del-correo-nuevo', status: 'pending' } })
  app.render(); await app.load()
  const tree = await submitWithEmail(app, 'ana.nuevo@example.com')
  assert.deepEqual(app.calls.filter(c => c[0] === 'submit'), [['submit', 'token-del-correo-nuevo', 'ana.nuevo@example.com']])
  assert.match(text(tree), /Su lugar está reservado/)
})

test('a personal link keeping the invited email registers without a new lookup', async () => {
  const app = setup({ direct: true, submitData: { status: 'confirmed' } })
  app.render(); await app.load()
  await nodes(app.render()).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} })
  assert.deepEqual(app.calls.filter(c => c[0] === 'begin'), [])
  assert.deepEqual(app.calls.filter(c => c[0] === 'submit'), [['submit', 'personal-token', 'ana@example.com']])
})
