import { check, isObject, jsonBytes, LIMITS } from './policy.mjs'

// A bounded JSON Schema 2020-12 subset. Unsupported validation keywords and
// remote references fail closed. No code generation, network dereferencing or
// attacker-supplied regular expressions are used.
const annotations = new Set(['$schema','$id','$comment','title','description','default','examples','deprecated','readOnly','writeOnly','format','x-mcp-header'])
const keywords = new Set(['$ref','$defs','definitions','type','properties','required','additionalProperties','items','prefixItems',
  'minItems','maxItems','uniqueItems','minProperties','maxProperties','minLength','maxLength','minimum','maximum',
  'exclusiveMinimum','exclusiveMaximum','multipleOf','enum','const','anyOf','oneOf','allOf','not'])
const types = new Set(['object','array','string','number','integer','boolean','null'])
const own = (value,key) => Object.hasOwn(value,key)
function reference(root,ref) {
  check(typeof ref === 'string' && ref.startsWith('#/'),'connector_schema_external_ref',422)
  let value = root
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g,'/').replace(/~0/g,'~')
    check(isObject(value) && own(value,key),'connector_schema_invalid_ref',422)
    value = value[key]
  }
  return value
}
export function inspectSchema(root,{objectRoot=true}={}) {
  jsonBytes(root,LIMITS.schemaBytes,'connector_schema_too_large')
  check(isObject(root) && (!objectRoot || root.type === 'object'),'connector_schema_object_required',422)
  let count = 0
  const headers = [], headerNames = new Set()
  function visit(schema,depth,ancestors,path=null) {
    check(++count <= 2048 && depth <= 24,'connector_schema_too_complex',422)
    if (typeof schema === 'boolean') return
    check(isObject(schema),'connector_schema_invalid',422)
    check(!ancestors.has(schema),'connector_schema_recursive_ref',422)
    const next = new Set(ancestors); next.add(schema)
    for (const key of Object.keys(schema)) check(annotations.has(key) || keywords.has(key),'connector_schema_unsupported_keyword',422)
    if (schema.type !== undefined) check((Array.isArray(schema.type) ? schema.type : [schema.type]).every(type => types.has(type)),'connector_schema_invalid',422)
    if (schema.$ref !== undefined) visit(reference(root,schema.$ref),depth+1,next,null)
    for (const key of ['$defs','definitions']) if (schema[key] !== undefined) {
      check(isObject(schema[key]),'connector_schema_invalid',422)
      for (const item of Object.values(schema[key])) visit(item,depth+1,next,null)
    }
    if (schema.properties !== undefined) {
      check(isObject(schema.properties) && Object.keys(schema.properties).length <= 256,'connector_schema_invalid',422)
      for (const [key,item] of Object.entries(schema.properties)) visit(item,depth+1,next,path === null ? null : [...path,key])
    }
    if (schema.required !== undefined) check(Array.isArray(schema.required) && schema.required.length <= 256 && schema.required.every(key => typeof key === 'string'),'connector_schema_invalid',422)
    for (const key of ['additionalProperties','items','not']) if (schema[key] !== undefined) visit(schema[key],depth+1,next,null)
    for (const key of ['prefixItems','anyOf','oneOf','allOf']) if (schema[key] !== undefined) {
      check(Array.isArray(schema[key]) && schema[key].length <= 32 && (key === 'prefixItems' || schema[key].length > 0),'connector_schema_invalid',422)
      for (const item of schema[key]) visit(item,depth+1,next,null)
    }
    for (const key of ['minItems','maxItems','minProperties','maxProperties','minLength','maxLength']) {
      if (schema[key] !== undefined) check(Number.isSafeInteger(schema[key]) && schema[key] >= 0,'connector_schema_invalid',422)
    }
    for (const key of ['minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf']) {
      if (schema[key] !== undefined) check(Number.isFinite(schema[key]) && (key !== 'multipleOf' || schema[key] > 0),'connector_schema_invalid',422)
    }
    if (schema.enum !== undefined) check(Array.isArray(schema.enum) && schema.enum.length >= 1 && schema.enum.length <= 256,'connector_schema_invalid',422)
    if (schema.uniqueItems !== undefined) check(typeof schema.uniqueItems === 'boolean','connector_schema_invalid',422)
    if (schema['x-mcp-header'] !== undefined) {
      const name = schema['x-mcp-header']
      check(path?.length && ['string','integer','boolean'].includes(schema.type) && typeof name === 'string' &&
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,80}$/.test(name) && !headerNames.has(name.toLowerCase()),'connector_header_schema_invalid',422)
      headerNames.add(name.toLowerCase()); headers.push({name,path})
    }
  }
  visit(root,0,new Set(),[])
  return {headers}
}
const equal = (a,b) => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v,i) => equal(v,b[i]))
  if (isObject(a) && isObject(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => own(b,k) && equal(a[k],b[k]))
  return false
}
export function validateArguments(root,value,{objectRoot=true,maxBytes=LIMITS.argumentsBytes}={}) {
  inspectSchema(root,{objectRoot})
  jsonBytes(value,maxBytes,'connector_arguments_too_large')
  check(!objectRoot || isObject(value),'invalid_connector_arguments')
  const pending=[[value,0]]
  let nodes=0
  while(pending.length) {
    const [item,depth]=pending.pop()
    check(++nodes<=10000 && depth<=32,'connector_validation_budget_exceeded',422)
    if(item && typeof item==='object') for(const child of Object.values(item))pending.push([child,depth+1])
    else check(item===null || ['string','boolean','number'].includes(typeof item),'invalid_connector_arguments')
  }
  let work = 0
  function matches(schema,v,depth=0) {
    check(++work <= 20000 && depth <= 48,'connector_validation_budget_exceeded',422)
    if (typeof schema === 'boolean') return schema
    if (schema.$ref !== undefined && !matches(reference(root,schema.$ref),v,depth+1)) return false
    if (schema.type !== undefined) {
      const allowed = Array.isArray(schema.type) ? schema.type : [schema.type]
      if (!allowed.some(type => type === 'null' ? v === null : type === 'object' ? isObject(v) :
        type === 'array' ? Array.isArray(v) : type === 'integer' ? Number.isSafeInteger(v) :
        type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === type)) return false
    }
    if (schema.enum && !schema.enum.some(item => equal(item,v))) return false
    if (own(schema,'const') && !equal(schema.const,v)) return false
    if (schema.allOf && !schema.allOf.every(s => matches(s,v,depth+1))) return false
    if (schema.anyOf && !schema.anyOf.some(s => matches(s,v,depth+1))) return false
    if (schema.oneOf && schema.oneOf.filter(s => matches(s,v,depth+1)).length !== 1) return false
    if (schema.not !== undefined && matches(schema.not,v,depth+1)) return false
    if (isObject(v)) {
      const keys = Object.keys(v)
      if (schema.minProperties !== undefined && keys.length < schema.minProperties || schema.maxProperties !== undefined && keys.length > schema.maxProperties) return false
      if (schema.required?.some(k => !own(v,k))) return false
      for (const key of keys) {
        if (own(schema.properties || {},key)) { if (!matches(schema.properties[key],v[key],depth+1)) return false }
        else if (schema.additionalProperties !== undefined && !matches(schema.additionalProperties,v[key],depth+1)) return false
      }
    }
    if (Array.isArray(v)) {
      if (schema.minItems !== undefined && v.length < schema.minItems || schema.maxItems !== undefined && v.length > schema.maxItems) return false
      if (schema.uniqueItems && v.some((item,i) => v.slice(0,i).some(other => {
        check(++work<=20000,'connector_validation_budget_exceeded',422)
        return equal(item,other)
      }))) return false
      for (let i=0;i<v.length;i++) {
        const item = schema.prefixItems?.[i] ?? schema.items
        if (item !== undefined && !matches(item,v[i],depth+1)) return false
      }
    }
    if (typeof v === 'string') {
      const length = [...v].length
      if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) return false
    }
    if (typeof v === 'number') {
      if (schema.minimum !== undefined && v < schema.minimum || schema.maximum !== undefined && v > schema.maximum ||
        schema.exclusiveMinimum !== undefined && v <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && v >= schema.exclusiveMaximum) return false
      if (schema.multipleOf !== undefined && Math.abs(v/schema.multipleOf-Math.round(v/schema.multipleOf)) > 1e-10) return false
    }
    return true
  }
  check(matches(root,value),'invalid_connector_arguments')
}
export function headerValue(value) {
  const text = String(value)
  if (/^[\x20-\x7e]*$/.test(text) && text.trim() === text && !(text.startsWith('=?base64?') && text.endsWith('?='))) return text
  const encoded = btoa(Array.from(new TextEncoder().encode(text),x => String.fromCharCode(x)).join(''))
  return '=?base64?' + encoded + '?='
}
export function toolHeaders(schema,args) {
  const headers = {}
  for (const {name,path} of inspectSchema(schema).headers) {
    let value = args
    for (const key of path) { value = isObject(value) && own(value,key) ? value[key] : undefined }
    if (value !== undefined && value !== null) headers['Mcp-Param-' + name] = headerValue(value)
  }
  return headers
}
