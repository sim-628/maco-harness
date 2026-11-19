import { validateJsonSchemaValue } from './upstream/json-schema.mjs'
import { requireThat } from './protocol.mjs'

// DSH validates the structural subset. Mail schemas additionally advertise
// size and range limits so a model can respect the adapter's bounded inputs.
export function validateTool(schema,value) {
  requireThat(!validateJsonSchemaValue(schema,value).length,'invalid_tool_arguments')
  const pending = [[schema,value]]
  while (pending.length) {
    const [s,v] = pending.pop()
    if (s.oneOf) {
      const child=s.oneOf.find(candidate=>!validateJsonSchemaValue(candidate,v).length)
      if (child) pending.push([child,v])
    } else if (s.type === 'object') {
      for (const [key,child] of Object.entries(s.properties || {})) {
        if (Object.hasOwn(v,key)) pending.push([child,v[key]])
      }
    } else if (s.type === 'array') {
      requireThat(s.maxItems === undefined || v.length <= s.maxItems,'invalid_tool_arguments')
      for (const item of v) if (s.items) pending.push([s.items,item])
    } else if (s.type === 'string') {
      requireThat((s.minLength === undefined || v.length >= s.minLength) &&
        (s.maxLength === undefined || v.length <= s.maxLength),'invalid_tool_arguments')
    } else if (s.type === 'integer' || s.type === 'number') {
      requireThat((s.minimum === undefined || v >= s.minimum) &&
        (s.maximum === undefined || v <= s.maximum),'invalid_tool_arguments')
    }
  }
}
