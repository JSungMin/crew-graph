// A Clawd that animates on the surface's own frame clock, so the pane need not redraw for it.
import type { ClientModule } from 'claude-code'

import type { Verb } from '../types'
import { bigFrame, isMoving, miniFrame, propFrame } from './clawd'

type Props = { verb: Verb; size: 'big' | 'mini'; color: string; propColor: string }
type Ref = { frame: number; verb: Verb }
type State = { ref: Ref }

const STEP_MS = 420

const ClawdAnim: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const ref = surface.state?.ref ?? { frame: 0, verb: props.verb }
  ref.verb = props.verb
  if (surface.state === undefined) {
    surface.setState({ ref })
    surface.every(STEP_MS, () => {
      if (isMoving(ref.verb)) {
        ref.frame += 1
        surface.setState({ ref })
      }
    })
  }
  const f = ref.frame
  if (props.size === 'mini') {
    return (
      <Text>
        <Text color={props.color}>{miniFrame(props.verb, f)}</Text>
        <Text color={props.propColor}>{propFrame(props.verb, f)}</Text>
      </Text>
    )
  }
  const rows = bigFrame(props.verb, f)
  return (
    <Box flexDirection="column">
      {rows.map((r, i) => (
        <Text>
          <Text color={props.color}>{r}</Text>
          <Text color={props.propColor}>{i === 0 ? propFrame(props.verb, f) : '  '}</Text>
        </Text>
      ))}
    </Box>
  )
}

export default ClawdAnim
