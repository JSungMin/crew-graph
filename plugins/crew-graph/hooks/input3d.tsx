// The 3D view's input layer: an empty region over the picture that catches the pointer and
// posts it to the hooks module in batches, as fractions of the view (0..1), so it does not
// matter how many pixels a cell holds. The hooks module forwards it to the renderer.
import type { ClientPointerEvent, ClientSurface } from 'claude-code'

type Props = { cols: number; rows: number }
type State = { cols: number; rows: number }
type Ev = { kind: 'down' | 'up' | 'move' | 'leave'; button?: string; x: number; y: number; shift?: boolean; alt?: boolean; ctrl?: boolean }

const FLUSH_MS = 30

export function toEvent(e: ClientPointerEvent, cols: number, rows: number): Ev {
  const fx = e.fine?.x ?? e.x + 0.5
  const fy = e.fine?.y ?? e.y + 0.5
  const kind = e.type === 'down' || e.type === 'up' ? e.type : e.type === 'leave' ? 'leave' : 'move'
  return {
    kind,
    button: e.button,
    x: Math.max(0, Math.min(1, fx / Math.max(1, cols))),
    y: Math.max(0, Math.min(1, fy / Math.max(1, rows))),
    shift: e.shift === true || undefined,
    alt: e.alt === true || undefined,
    ctrl: e.ctrl === true || undefined,
  }
}

export default function Input3d(props: Props, surface: ClientSurface<State>) {
  const { Box } = surface.elements
  const queue: Ev[] = []
  if (surface.state === undefined) {
    surface.setState({ cols: props.cols, rows: props.rows })
    surface.onPointer(e => {
      const st = surface.state ?? { cols: props.cols, rows: props.rows }
      if (e.type === 'enter') surface.post({ type: 'hover', inside: true })
      if (e.type === 'leave') surface.post({ type: 'hover', inside: false })
      const ev = toEvent(e, st.cols, st.rows)
      // Hover moves only keep the latest: the page needs where the pointer is, not its path.
      const last = queue[queue.length - 1]
      if (ev.kind === 'move' && !e.button && last?.kind === 'move' && !last.button) queue[queue.length - 1] = ev
      else queue.push(ev)
      if (e.type === 'move') surface.post({ type: 'at', x: ev.x, y: ev.y })
    })
    surface.every(FLUSH_MS, () => {
      if (queue.length === 0) return
      surface.post({ type: 'input', events: queue.splice(0, queue.length) as unknown as never })
    })
  }
  if (surface.state && (surface.state.cols !== props.cols || surface.state.rows !== props.rows)) {
    surface.setState({ cols: props.cols, rows: props.rows })
  }
  return <Box width={props.cols} height={props.rows} />
}
