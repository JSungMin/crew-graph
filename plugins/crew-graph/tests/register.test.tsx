import { describe, expect, mock, test, tier } from 'claude-code/testing'

tier('user')

const PANE_PROPS = {
  title: 'Crew',
  isFocused: false,
  bodyColumns: 70,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

describe('register', () => {
  test('a read of a plan file shows up in the graph with an animated critter', async ($, on) => {
    mock.clock(on)
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('agent.list', () => ({ value: [] }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Read', file_path: '/work/plans/plan.md' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/docs/guide.md', old_string: 'a', new_string: 'b' })

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'crew-graph',
        surface,
        component: 'Pane',
        requestId: 'crew-graph',
        props: PANE_PROPS,
      })
      expect(await ui.find({ type: 'Text', text: /■ plan plans\/plan\.md ◄─ main:r/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /□ doc  docs\/guide\.md ◄─ main:w/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^● \(>\.<\)[/-]~ main {2}edit docs\/guide\.md/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('a running subagent hangs under main and its critter animates', async ($, on) => {
    const clock = mock.clock(on)
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('agent.list', () => ({
      value: [{ id: 'a1', type: 'Explore', description: '훅 위치 찾기', status: 'running' as const }],
    }))
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: '훅 위치 찾기', prompt: 'p' })
    // 서브에이전트 루프의 호출 = agentId 가 붙은 tool.call (세션이 그렇게 보낸다)
    const fromSubagent = { tool: 'Grep', pattern: 'register', agentId: 'a1' } as unknown as Parameters<typeof $.tool.call>[0]
    await $.tool.call(fromSubagent)

    const ui = await $.ui.mount({
      plugin: 'crew-graph',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'crew-graph',
      props: PANE_PROPS,
    })
    const before = await ui.find({ type: 'Text', text: /^└─\(o_o\)\? {3}Explore "훅 위치 찾기" {2}search register/ })
    expect(before).toBeDefined()
    await clock.advance(500)
    expect(await ui.find({ type: 'Text', text: /^└─\(O_O\)! {3}Explore/ })).toBeDefined()
    await ui.unmount()
  })
})
